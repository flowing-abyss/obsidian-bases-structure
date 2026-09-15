// Retype planning: turns a `'retype'` `Action` into a verified `Plan` that changes a node's type
// (recipe writes plus, when the node's own edge property changes, the same cascade move planning
// uses), or a rejection with a stable, user-facing reason. No Obsidian imports.

import {
  deriveSubtreeWrites,
  listShape,
  ruleBetween,
  unionInheritedTargets,
  type SubtreeContext,
} from './derive.js';
import type { Action, KeyWrite, Plan, PlanEnv, PlanResult } from './plan-types.js';
import type { EdgeRule, Schema, TypeDef, TypeMatch } from './schema.js';
import { applyPlan } from './simulate.js';
import { displayName, folderOf, type NoteData, type Snapshot } from './snapshot.js';
import { buildStructure, type Structure, type StructureNode } from './structure.js';

type RetypeAction = Extract<Action, { kind: 'retype' }>;

const EMPTY_MATCH: TypeMatch = { tags: [], folder: null, properties: [] };

function oldMatchOf(schema: Schema, typeName: string | null): TypeMatch {
  if (typeName === null) {
    return EMPTY_MATCH;
  }
  return schema.typeByName.get(typeName)?.match ?? EMPTY_MATCH;
}

function textLinkReason(
  kind: 'links' | 'backlinks',
  snapshot: Snapshot,
  parentPath: string,
  nodePath: string,
): string {
  const parentName = displayName(snapshot, parentPath);
  const nodeName = displayName(snapshot, nodePath);
  return kind === 'backlinks'
    ? `The link from "${parentName}" to "${nodeName}" lives in note text and cannot be written automatically`
    : `The link from "${nodeName}" to "${parentName}" lives in note text and cannot be written automatically`;
}

function dedupeKeepFirst(list: readonly string[], value: string): readonly string[] {
  let seen = false;
  return list.filter((item) => {
    if (item !== value) {
      return true;
    }
    if (seen) {
      return false;
    }
    seen = true;
    return true;
  });
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}

function recordOverride(
  ctx: SubtreeContext,
  path: string,
  key: string,
  targets: readonly string[],
): void {
  const existing = ctx.linkOverrides.get(path) ?? {};
  ctx.linkOverrides.set(path, { ...existing, [key]: targets });
}

// -- Rejection checks -------------------------------------------------------------------------

type ParentCompat =
  | { readonly kind: 'ok'; readonly rule: EdgeRule | null }
  | { readonly kind: 'no-rule'; readonly parent: string }
  | {
      readonly kind: 'text-edge';
      readonly parent: string;
      readonly rule: { readonly kind: 'links' | 'backlinks'; readonly property: string };
    };

/** Rejection steps 4–5: whether `targetType` can be placed under N's current parent (when N has
 * one), and — when the resulting rule isn't a `'property'` rule — whether it at least matches
 * N's current edge kind (so no text-only relationship needs rewriting). Shared by `validateRetype`
 * (which needs the specific failure reason) and `retypeOptions` (which only needs pass/fail). */
function retypeParentCompat(
  schema: Schema,
  structure: Structure,
  nNode: StructureNode,
  targetType: string,
): ParentCompat {
  if (nNode.parent === null) {
    return { kind: 'ok', rule: null };
  }
  const parentType = structure.nodes.get(nNode.parent)?.type ?? null;
  const rule = ruleBetween(schema, parentType, targetType);
  if (rule === null) {
    return { kind: 'no-rule', parent: nNode.parent };
  }
  if (rule.kind !== 'property' && rule.kind !== nNode.edge?.kind) {
    return {
      kind: 'text-edge',
      parent: nNode.parent,
      rule: { kind: rule.kind, property: rule.property },
    };
  }
  return { kind: 'ok', rule };
}

/** Rejection step 6: every primary child of N that couldn't stay a child once N becomes
 * `targetType` — a null rule, or a non-`'property'` rule that doesn't match the child's current
 * edge kind. */
function failingChildren(
  schema: Schema,
  structure: Structure,
  nNode: StructureNode,
  targetType: string,
): readonly string[] {
  const failures: string[] = [];
  for (const childPath of nNode.children) {
    const childNode = structure.nodes.get(childPath);
    if (childNode?.type === null || childNode === undefined) {
      continue;
    }
    const rule = ruleBetween(schema, targetType, childNode.type);
    const fails = rule === null || (rule.kind !== 'property' && childNode.edge?.kind !== rule.kind);
    if (fails) {
      failures.push(childPath);
    }
  }
  return failures;
}

type FolderCheck =
  | { readonly kind: 'no-move' }
  | { readonly kind: 'move'; readonly to: string }
  | { readonly kind: 'occupied'; readonly to: string };

/** Rejection step 7: whether `newType`'s folder requires relocating N, and whether the target
 * path is already taken. */
function checkRetypeFolder(
  env: PlanEnv,
  snapshot: Snapshot,
  node: string,
  newType: TypeDef,
): FolderCheck {
  const folder = newType.match.folder;
  if (folder === null) {
    return { kind: 'no-move' };
  }
  const nFolder = folderOf(node);
  if (nFolder === folder || nFolder.startsWith(`${folder}/`)) {
    return { kind: 'no-move' };
  }
  const basename = snapshot.notes.get(node)?.basename ?? displayName(snapshot, node);
  const to = `${folder}/${basename}.md`;
  if (env.exists(to) || snapshot.notes.has(to)) {
    return { kind: 'occupied', to };
  }
  return { kind: 'move', to };
}

interface RetypeFields {
  readonly nNode: StructureNode;
  readonly newType: TypeDef;
  readonly parentRule: EdgeRule | null;
  readonly folderTo: string | null;
}

type RetypeValidationResult =
  | { readonly ok: true; readonly fields: RetypeFields }
  | { readonly ok: false; readonly reason: string };

interface RetypeRequest {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly structure: Structure;
  readonly env: PlanEnv;
}

function validateRetype(request: RetypeRequest, action: RetypeAction): RetypeValidationResult {
  const { schema, snapshot, structure, env } = request;
  const newType = schema.typeByName.get(action.type);
  if (newType === undefined) {
    return { ok: false, reason: `Unknown type "${action.type}"` };
  }
  const nNode = structure.nodes.get(action.node);
  if (nNode === undefined) {
    return { ok: false, reason: `"${displayName(snapshot, action.node)}" is not in the structure` };
  }
  if (nNode.type === action.type) {
    return {
      ok: false,
      reason: `"${displayName(snapshot, action.node)}" is already "${action.type}"`,
    };
  }
  const compat = retypeParentCompat(schema, structure, nNode, action.type);
  if (compat.kind === 'no-rule') {
    return {
      ok: false,
      reason: `"${action.type}" cannot be placed under "${displayName(snapshot, compat.parent)}"`,
    };
  }
  if (compat.kind === 'text-edge') {
    return {
      ok: false,
      reason: textLinkReason(compat.rule.kind, snapshot, compat.parent, action.node),
    };
  }
  const failing = failingChildren(schema, structure, nNode, action.type);
  if (failing.length > 0) {
    const names = failing.map((path) => displayName(snapshot, path)).join(', ');
    return { ok: false, reason: `"${action.type}" cannot contain: ${names}` };
  }
  const folderCheck = checkRetypeFolder(env, snapshot, action.node, newType);
  if (folderCheck.kind === 'occupied') {
    return { ok: false, reason: `A note already exists at "${folderCheck.to}"` };
  }
  return {
    ok: true,
    fields: {
      nNode,
      newType,
      parentRule: compat.rule,
      folderTo: folderCheck.kind === 'move' ? folderCheck.to : null,
    },
  };
}

// -- Writes for N: tags, recipe properties ----------------------------------------------------

function computeTagsWrite(
  nTags: readonly string[],
  oldMatch: TypeMatch,
  newType: TypeDef,
): KeyWrite | null {
  const oldTagsLower = new Set(oldMatch.tags.map((tag) => tag.toLowerCase()));
  const kept = nTags.filter((tag) => !oldTagsLower.has(tag.toLowerCase()));
  const keptLower = new Set(kept.map((tag) => tag.toLowerCase()));
  const added = newType.match.tags.filter((tag) => !keptLower.has(tag.toLowerCase()));
  const result = [...kept, ...added];
  if (arraysEqual(result, nTags)) {
    return null;
  }
  return { key: 'tags', value: { kind: 'literal', value: result } };
}

function looseEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** One old-type property's cleanup write, when its name isn't also a `newType` property: `null`
 * (delete) when the note's current scalar value matches the old recipe value; the array without
 * that element when it's a list; otherwise nothing to do. */
function oldPropertyCleanupWrite(
  frontmatter: Readonly<Record<string, unknown>>,
  name: string,
  expected: string,
): KeyWrite | null {
  const value = frontmatter[name];
  if (typeof value === 'string') {
    return looseEqual(value, expected) ? { key: name, value: null } : null;
  }
  if (Array.isArray(value)) {
    const filtered = (value as unknown[]).filter(
      (item) => !(typeof item === 'string' && looseEqual(item, expected)),
    );
    return filtered.length === value.length
      ? null
      : { key: name, value: { kind: 'literal', value: filtered } };
  }
  return null;
}

function oldPropertyCleanupWrites(
  frontmatter: Readonly<Record<string, unknown>>,
  oldMatch: TypeMatch,
  newType: TypeDef,
): readonly KeyWrite[] {
  const newNames = new Set(newType.match.properties.map(([name]) => name));
  const writes: KeyWrite[] = [];
  for (const [name, expected] of oldMatch.properties) {
    if (newNames.has(name)) {
      continue;
    }
    const write = oldPropertyCleanupWrite(frontmatter, name, expected);
    if (write !== null) {
      writes.push(write);
    }
  }
  return writes;
}

function newPropertyWrites(
  frontmatter: Readonly<Record<string, unknown>>,
  newType: TypeDef,
): readonly KeyWrite[] {
  const writes: KeyWrite[] = [];
  for (const [name, value] of newType.match.properties) {
    if (frontmatter[name] !== value) {
      writes.push({ key: name, value: { kind: 'literal', value } });
    }
  }
  return writes;
}

// -- N's own edge + inherit-key recompute (parent unchanged, "move" rule) --------------------

interface EdgeInputs {
  readonly snapshot: Snapshot;
  readonly node: string;
  readonly parent: string;
  readonly oldEdge: EdgeRule | null;
  readonly key: string;
}

function computeEdgeWrite(inputs: EdgeInputs, cur: readonly string[]): KeyWrite | null {
  const replaceInPlace =
    inputs.oldEdge?.kind === 'property' &&
    inputs.oldEdge.property === inputs.key &&
    cur.includes(inputs.parent);
  const newTargets = replaceInPlace
    ? dedupeKeepFirst(
        cur.map((item) => (item === inputs.parent ? inputs.parent : item)),
        inputs.parent,
      )
    : dedupeKeepFirst([inputs.parent, ...cur], inputs.parent);
  if (arraysEqual(newTargets, cur)) {
    return null;
  }
  return {
    key: inputs.key,
    value: {
      kind: 'links',
      targets: newTargets,
      list: listShape(inputs.snapshot, inputs.key, inputs.node),
    },
  };
}

function computeOldEdgeCleanup(
  schema: Schema,
  inputs: EdgeInputs,
  nLinks: Readonly<Record<string, readonly string[]>>,
): KeyWrite | null {
  if (
    inputs.oldEdge?.kind !== 'property' ||
    inputs.oldEdge.property === inputs.key ||
    schema.inherit.includes(inputs.oldEdge.property)
  ) {
    return null;
  }
  const oldKey = inputs.oldEdge.property;
  const cur2 = nLinks[oldKey] ?? [];
  const filtered = cur2.filter((item) => item !== inputs.parent);
  if (arraysEqual(filtered, cur2)) {
    return null;
  }
  return {
    key: oldKey,
    value: {
      kind: 'links',
      targets: filtered,
      list: listShape(inputs.snapshot, oldKey, inputs.node),
    },
  };
}

function inheritWritesFor(
  ctx: SubtreeContext,
  node: string,
  excludeKey: string,
  propertyParents: readonly string[],
): readonly KeyWrite[] {
  const writes: KeyWrite[] = [];
  const nLinks = ctx.snapshot.notes.get(node)?.propertyLinks ?? {};
  for (const key of ctx.schema.inherit) {
    if (key === excludeKey) {
      continue;
    }
    const desired = unionInheritedTargets(ctx, propertyParents, key);
    const current = nLinks[key] ?? [];
    if (sameSet(desired, current)) {
      continue;
    }
    writes.push({
      key,
      value: { kind: 'links', targets: desired, list: listShape(ctx.snapshot, key, node) },
    });
    recordOverride(ctx, node, key, desired);
  }
  return writes;
}

/** The property parents used to recompute N's own `inherit` keys when its edge key changes: the
 * (unchanged) parent, then N's surviving property-kind extras. */
function nOwnPropertyParents(nNode: StructureNode, parent: string): readonly string[] {
  return [
    parent,
    ...nNode.extras
      .filter((extra) => extra.kind === 'property' && extra.parent !== parent)
      .map((extra) => extra.parent),
  ];
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

/** N's own edge + inherit-key writes, only when N has a parent and the new parent rule is a
 * `'property'` rule (a text-only rule means the relationship stays exactly as it was in note
 * text — nothing to write). The inherit recompute only runs when N's edge key is actually
 * changing; otherwise nothing downstream of N's own relationship to its parent needs touching. */
function buildNOwnWrites(
  schema: Schema,
  ctx: SubtreeContext,
  fields: RetypeFields,
  action: RetypeAction,
): readonly KeyWrite[] {
  const { nNode, parentRule } = fields;
  if (nNode.parent === null || parentRule?.kind !== 'property') {
    return [];
  }
  const parent = nNode.parent;
  const key = parentRule.property;
  const nLinks = ctx.snapshot.notes.get(action.node)?.propertyLinks ?? {};
  const cur = nLinks[key] ?? [];
  const inputs: EdgeInputs = {
    snapshot: ctx.snapshot,
    node: action.node,
    parent,
    oldEdge: nNode.edge,
    key,
  };
  const writes = [
    computeEdgeWrite(inputs, cur),
    computeOldEdgeCleanup(schema, inputs, nLinks),
  ].filter(isNonNull);
  if (nNode.edge?.property === key) {
    return writes;
  }
  return [
    ...writes,
    ...inheritWritesFor(ctx, action.node, key, nOwnPropertyParents(nNode, parent)),
  ];
}

// -- Children whose edge property must move from the old key to the new one -----------------

interface ChildWriteEntry {
  readonly path: string;
  readonly writes: readonly KeyWrite[];
}

/** Whether `childPath`'s edge property needs to move from its current key to `newType`'s rule for
 * it — `null` when the child doesn't need touching at all (no rule, a non-property edge/rule, or
 * the key hasn't actually changed). */
function childEdgeChange(
  schema: Schema,
  structure: Structure,
  newTypeName: string,
  childPath: string,
): { readonly childNode: StructureNode; readonly newKey: string } | null {
  const childNode = structure.nodes.get(childPath);
  if (childNode?.type === null || childNode === undefined || childNode.edge?.kind !== 'property') {
    return null;
  }
  const rule = ruleBetween(schema, newTypeName, childNode.type);
  if (rule?.kind !== 'property' || childNode.edge.property === rule.property) {
    return null;
  }
  return { childNode, newKey: rule.property };
}

/** The new-key write (N prepended, deduped) and, unless the old key is itself an inherit key, the
 * old-key cleanup write (N removed) for one child whose edge property is moving. */
function childRewriteWrites(
  ctx: SubtreeContext,
  childPath: string,
  change: { readonly childNode: StructureNode; readonly newKey: string },
  node: string,
): readonly KeyWrite[] {
  const { childNode, newKey } = change;
  const oldKey = childNode.edge?.kind === 'property' ? childNode.edge.property : newKey;
  const cLinks = ctx.snapshot.notes.get(childPath)?.propertyLinks ?? {};
  const writes: KeyWrite[] = [];
  const newCur = cLinks[newKey] ?? [];
  const newTargets = dedupeKeepFirst([node, ...newCur], node);
  if (!arraysEqual(newTargets, newCur)) {
    writes.push({
      key: newKey,
      value: {
        kind: 'links',
        targets: newTargets,
        list: listShape(ctx.snapshot, newKey, childPath),
      },
    });
    recordOverride(ctx, childPath, newKey, newTargets);
  }
  if (!ctx.schema.inherit.includes(oldKey)) {
    const oldCur = cLinks[oldKey] ?? [];
    const filtered = oldCur.filter((item) => item !== node);
    if (!arraysEqual(filtered, oldCur)) {
      writes.push({
        key: oldKey,
        value: {
          kind: 'links',
          targets: filtered,
          list: listShape(ctx.snapshot, oldKey, childPath),
        },
      });
      recordOverride(ctx, childPath, oldKey, filtered);
    }
  }
  return writes;
}

function retypedChildWrites(
  schema: Schema,
  ctx: SubtreeContext,
  nNode: StructureNode,
  action: RetypeAction,
): readonly ChildWriteEntry[] {
  const entries: ChildWriteEntry[] = [];
  for (const childPath of nNode.children) {
    const change = childEdgeChange(schema, ctx.structure, action.type, childPath);
    if (change === null) {
      continue;
    }
    const writes = childRewriteWrites(ctx, childPath, change, action.node);
    if (writes.length > 0) {
      entries.push({ path: childPath, writes });
    }
  }
  return entries;
}

/** Merges two per-path write lists into one entry per path, preserving first-seen path order;
 * when both sides write the same key for the same path, `second`'s value wins. */
function mergeWritesByPath(
  first: readonly ChildWriteEntry[],
  second: readonly ChildWriteEntry[],
): readonly ChildWriteEntry[] {
  const order: string[] = [];
  const byPath = new Map<string, Map<string, KeyWrite>>();
  for (const entry of [...first, ...second]) {
    let keyMap = byPath.get(entry.path);
    if (keyMap === undefined) {
      keyMap = new Map();
      byPath.set(entry.path, keyMap);
      order.push(entry.path);
    }
    for (const write of entry.writes) {
      keyMap.set(write.key, write);
    }
  }
  return order.map((path) => ({ path, writes: Array.from(byPath.get(path)?.values() ?? []) }));
}

// -- Verification -------------------------------------------------------------------------------

function firstChangedOtherNode(
  before: Structure,
  after: Structure,
  node: string,
  focus: string,
): string | null {
  for (const [path, beforeNode] of before.nodes) {
    if (path === node) {
      continue;
    }
    const afterNode = after.nodes.get(path);
    if (afterNode === undefined) {
      continue;
    }
    const expectedParent = beforeNode.parent === node ? focus : beforeNode.parent;
    if (afterNode.parent !== expectedParent) {
      return path;
    }
  }
  return null;
}

interface VerifyRetypeInputs {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly plan: Plan;
  readonly before: Structure;
  readonly action: RetypeAction;
  readonly nNode: StructureNode;
  readonly focus: string;
}

function verifyRetype(inputs: VerifyRetypeInputs): string | null {
  const { schema, snapshot, plan, before, action, nNode, focus } = inputs;
  const after = buildStructure(schema, applyPlan(snapshot, plan));
  const afterFocus = after.nodes.get(focus);
  if (afterFocus?.type !== action.type || afterFocus.parent !== nNode.parent) {
    return `"${displayName(snapshot, action.node)}" would not be recognised as "${action.type}"`;
  }
  const changedOther = firstChangedOtherNode(before, after, action.node, focus);
  if (changedOther !== null) {
    return `Changing the type of "${displayName(snapshot, action.node)}" would also move "${displayName(snapshot, changedOther)}"`;
  }
  return null;
}

/** N's `tags`/old-property-cleanup/new-property literal writes, comparing `oldMatch` (N's current
 * type's recipe) against `newType`'s. */
function literalRetypeWrites(
  nNote: NoteData | undefined,
  oldMatch: TypeMatch,
  newType: TypeDef,
): readonly KeyWrite[] {
  const tags = nNote?.tags ?? [];
  const frontmatter = nNote?.frontmatter ?? {};
  const tagsWrite = computeTagsWrite(tags, oldMatch, newType);
  return [
    ...(tagsWrite === null ? [] : [tagsWrite]),
    ...oldPropertyCleanupWrites(frontmatter, oldMatch, newType),
    ...newPropertyWrites(frontmatter, newType),
  ];
}

function recordLinkOverrides(ctx: SubtreeContext, path: string, writes: readonly KeyWrite[]): void {
  for (const write of writes) {
    if (write.value !== null && write.value.kind === 'links') {
      recordOverride(ctx, path, write.key, write.value.targets);
    }
  }
}

export function planRetype(
  schema: Schema,
  snapshot: Snapshot,
  action: RetypeAction,
  env: PlanEnv,
): PlanResult {
  const structure = buildStructure(schema, snapshot);
  const validation = validateRetype({ schema, snapshot, structure, env }, action);
  if (!validation.ok) {
    return validation;
  }
  const { nNode, newType, folderTo } = validation.fields;
  const oldMatch = oldMatchOf(schema, nNode.type);

  const ctx: SubtreeContext = {
    schema,
    snapshot,
    structure,
    typeOverrides: new Map([[action.node, action.type]]),
    linkOverrides: new Map(),
  };
  const nWrites = [
    ...literalRetypeWrites(snapshot.notes.get(action.node), oldMatch, newType),
    ...buildNOwnWrites(schema, ctx, validation.fields, action),
  ];
  recordLinkOverrides(ctx, action.node, nWrites);

  const childWrites = retypedChildWrites(schema, ctx, nNode, action);
  const subtreeWrites = deriveSubtreeWrites(ctx, action.node);
  const mergedDescendantWrites = mergeWritesByPath(childWrites, subtreeWrites);
  const changes =
    nWrites.length > 0
      ? [{ path: action.node, writes: nWrites }, ...mergedDescendantWrites]
      : mergedDescendantWrites;

  const moves = folderTo !== null ? [{ from: action.node, to: folderTo }] : [];
  const focus = folderTo ?? action.node;
  const plan: Plan = { creations: [], changes, appends: [], moves };
  const failure = verifyRetype({ schema, snapshot, plan, before: structure, action, nNode, focus });
  if (failure !== null) {
    return { ok: false, reason: failure };
  }
  return { ok: true, plan, focus };
}

export function retypeOptions(
  schema: Schema,
  structure: Structure,
  node: string,
): readonly string[] {
  const nNode = structure.nodes.get(node);
  if (nNode === undefined) {
    return [];
  }
  const ordered = [...schema.types].sort((a, b) => a.level - b.level);
  const results: string[] = [];
  for (const type of ordered) {
    if (type.name === nNode.type) {
      continue;
    }
    const compat = retypeParentCompat(schema, structure, nNode, type.name);
    if (compat.kind !== 'ok') {
      continue;
    }
    if (failingChildren(schema, structure, nNode, type.name).length > 0) {
      continue;
    }
    results.push(type.name);
  }
  return results;
}
