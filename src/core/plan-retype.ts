// Retype planning: turns a `'retype'` `Action` into a verified `Plan` that changes a node's type
// (recipe writes plus, when the node's own edge property changes, the same cascade move planning
// uses), or a rejection with a stable, user-facing reason. No Obsidian imports.

import {
  bareContext,
  deriveSubtreeWrites,
  edgeKeyPatch,
  listShape,
  resultingTargets,
  ruleBetween,
  type SubtreeContext,
} from './derive.js';
import { looseEqual } from './link-patch.js';
import {
  buildEdgeWrites,
  type EdgeWriteInputs,
  firstChangedOtherNode,
  inheritWritesFor,
  recordAllOverrides,
  recordOverride,
  textLinkReason,
} from './plan-shared.js';
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

/** The frontmatter key retype's tag writes target: whichever of `tags`/`tag` the note's
 * frontmatter already uses (Obsidian accepts either), defaulting to `tags` for a note with
 * neither — matching `parseFrontMatterTags`'s own reading of both. */
function tagsKeyOf(frontmatter: Readonly<Record<string, unknown>>): string {
  if ('tags' in frontmatter) {
    return 'tags';
  }
  return 'tag' in frontmatter ? 'tag' : 'tags';
}

/** Retype's tag writes: patches — one `'listItem'` write per old/new tag pair — over the note's
 * *frontmatter* tags only (I4). A tag that lives only in the note's body/inline text is never
 * touched here; `bodyOnlyTagReason` rejects the action before this runs if the old type's tag is
 * one of those. When the frontmatter has no tags key at all yet, a single literal write builds it
 * fresh as a list (the vault-wide convention), rather than deferring to `patchListItem`'s
 * scalar-unless-already-a-list rule (which exists for recipe properties, not tags). */
function computeTagsWrites(
  frontmatter: Readonly<Record<string, unknown>>,
  frontmatterTags: readonly string[],
  oldMatch: TypeMatch,
  newType: TypeDef,
): readonly KeyWrite[] {
  const key = tagsKeyOf(frontmatter);
  const currentLower = new Set(frontmatterTags.map((tag) => tag.toLowerCase()));
  const removeTags = oldMatch.tags.filter((tag) => currentLower.has(tag.toLowerCase()));
  const addTags = newType.match.tags.filter((tag) => !currentLower.has(tag.toLowerCase()));
  if (removeTags.length === 0 && addTags.length === 0) {
    return [];
  }
  if (!(key in frontmatter)) {
    return [{ key, value: { kind: 'literal', value: [...addTags] } }];
  }
  const pairCount = Math.max(removeTags.length, addTags.length);
  return Array.from({ length: pairCount }, (_unused, index) => {
    const remove = removeTags[index];
    const add = addTags[index];
    return {
      key,
      value: {
        kind: 'listItem' as const,
        ...(remove !== undefined ? { remove } : {}),
        ...(add !== undefined ? { add } : {}),
      },
    };
  });
}

/** The array-current branch of `propertyPatchWrite`: a single-element patch that only touches the
 * old value's own slot, so an unrelated element already in the list (e.g. `archived` in
 * `type: [project, archived]`) survives instead of the whole array being clobbered by a literal
 * set (the bug C1 fixes). `null` when neither the old value is present nor the new one is
 * missing. */
function arrayPropertyWrite(
  name: string,
  items: readonly unknown[],
  oldExpected: string | undefined,
  newValue: string | undefined,
): KeyWrite | null {
  const hasOld =
    oldExpected !== undefined &&
    items.some((item) => typeof item === 'string' && looseEqual(item, oldExpected));
  const needsNew =
    newValue !== undefined &&
    !items.some((item) => typeof item === 'string' && looseEqual(item, newValue));
  if (!hasOld && !needsNew) {
    return null;
  }
  return {
    key: name,
    value: {
      kind: 'listItem',
      ...(hasOld ? { remove: oldExpected } : {}),
      ...(needsNew ? { add: newValue } : {}),
    },
  };
}

/** The scalar/absent-current branch of `propertyPatchWrite`: today's literal set/delete behaviour,
 * untouched by C1. */
function scalarPropertyWrite(
  name: string,
  current: unknown,
  oldExpected: string | undefined,
  newValue: string | undefined,
): KeyWrite | null {
  if (newValue !== undefined) {
    return current === newValue ? null : { key: name, value: { kind: 'literal', value: newValue } };
  }
  if (
    oldExpected !== undefined &&
    typeof current === 'string' &&
    looseEqual(current, oldExpected)
  ) {
    return { key: name, value: null };
  }
  return null;
}

/** One recipe property's retype write, given the old recipe's expected value for `name` (when the
 * old type had one) and the new recipe's value (when the new type has one). `null` when nothing
 * would actually change. */
function propertyPatchWrite(
  frontmatter: Readonly<Record<string, unknown>>,
  name: string,
  oldExpected: string | undefined,
  newValue: string | undefined,
): KeyWrite | null {
  const current = frontmatter[name];
  return Array.isArray(current)
    ? arrayPropertyWrite(name, current as unknown[], oldExpected, newValue)
    : scalarPropertyWrite(name, current, oldExpected, newValue);
}

/** Every recipe-property write for the old-type → new-type transition, over the union of both
 * recipes' property names (old-type names first, in their own order, then any new-type-only
 * names) — a single pass replaces the old `oldPropertyCleanupWrites`/`newPropertyWrites` pair so a
 * name common to both recipes (e.g. `type`) gets one combined remove+add patch instead of a
 * skipped cleanup plus a clobbering literal set. */
function propertyWrites(
  frontmatter: Readonly<Record<string, unknown>>,
  oldMatch: TypeMatch,
  newType: TypeDef,
): readonly KeyWrite[] {
  const oldByName = new Map(oldMatch.properties);
  const newByName = new Map(newType.match.properties);
  const names = new Set([...oldByName.keys(), ...newByName.keys()]);
  const writes: KeyWrite[] = [];
  for (const name of names) {
    const write = propertyPatchWrite(frontmatter, name, oldByName.get(name), newByName.get(name));
    if (write !== null) {
      writes.push(write);
    }
  }
  return writes;
}

// -- N's own edge + inherit-key recompute (parent unchanged, "move" rule) --------------------

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

/** N's own edge + inherit-key writes, only when N has a parent and the new parent rule is a
 * `'property'` rule (a text-only rule means the relationship stays exactly as it was in note
 * text — nothing to write). N's parent never changes during a retype, so `oldParent === newParent`
 * (see `plan-shared.ts`'s `EdgeWriteInputs`/`buildEdgeWrites`).
 *
 * Round 2 C1: when N's edge key isn't actually changing, this emits *no* edge write at all — the
 * relationship is already sitting in the right key, so there's nothing an edge write could
 * legitimately do (the earlier bug: calling `buildEdgeWrites` unconditionally could strip an
 * unrelated value already sitting in that same property). When the key *is* changing, the new key
 * never held this relationship before, so nothing in it is stale — `staleForNewKey` is empty
 * (add-only) — and the inherit recompute only runs in that case too, since nothing downstream of
 * N's own relationship to its parent needs touching otherwise. */
function buildNOwnWrites(
  ctx: SubtreeContext,
  oldCtx: SubtreeContext,
  fields: RetypeFields,
  action: RetypeAction,
): readonly KeyWrite[] {
  const { nNode, parentRule } = fields;
  if (nNode.parent === null || parentRule?.kind !== 'property') {
    return [];
  }
  const parent = nNode.parent;
  const key = parentRule.property;
  if (nNode.edge?.property === key) {
    return [];
  }
  const propertyParents = nOwnPropertyParents(nNode, parent);
  const inputs: EdgeWriteInputs = {
    snapshot: ctx.snapshot,
    node: action.node,
    oldParent: parent,
    newParent: parent,
    oldEdge: nNode.edge,
    key,
    staleForNewKey: new Set(),
  };
  const writes = buildEdgeWrites(ctx.schema, inputs);
  return [
    ...writes,
    ...inheritWritesFor(ctx, oldCtx, {
      node: action.node,
      excludeKey: key,
      oldPropertyParents: propertyParents,
      newPropertyParents: propertyParents,
    }),
  ];
}

// -- Children whose edge property must move from the old key to the new one -----------------

interface ChildWriteEntry {
  readonly path: string;
  readonly writes: readonly KeyWrite[];
}

interface ChildEdgeChange {
  readonly oldKey: string;
  readonly newKey: string;
}

/** Whether `childPath`'s edge property needs to move from its current key to `newType`'s rule for
 * it — `null` when the child doesn't need touching at all (no rule, a non-property edge/rule, or
 * the key hasn't actually changed). */
function childEdgeChange(
  schema: Schema,
  structure: Structure,
  newTypeName: string,
  childPath: string,
): ChildEdgeChange | null {
  const childNode = structure.nodes.get(childPath);
  if (childNode?.type === null || childNode === undefined || childNode.edge?.kind !== 'property') {
    return null;
  }
  const rule = ruleBetween(schema, newTypeName, childNode.type);
  if (rule?.kind !== 'property' || childNode.edge.property === rule.property) {
    return null;
  }
  return { oldKey: childNode.edge.property, newKey: rule.property };
}

/** The new-key write (N added) and the old-key cleanup write (N removed) for one child whose edge
 * property is moving — the old key is always cleaned up here, even when it's also a
 * `schema.inherit` key: the generic inherit recompute (`deriveSubtreeWrites`) never touches it
 * either, since it excludes a descendant's *own* (pre-action) edge property from that recompute
 * (see `inheritKeysFor` in `derive.ts`) — so if this step skipped it too, nothing would (I3).
 *
 * Round 2 C1: the new key never held this relationship before, so the write is add-only (nothing
 * is stale, hence the empty set below) — a value already sitting in that property for an unrelated
 * reason (an untagged note, a wrong-type note, an "also in" link) survives untouched. */
function childRewriteWrites(
  ctx: SubtreeContext,
  childPath: string,
  change: ChildEdgeChange,
  node: string,
): readonly KeyWrite[] {
  const { oldKey, newKey } = change;
  const cLinks = ctx.snapshot.notes.get(childPath)?.propertyLinks ?? {};
  const writes: KeyWrite[] = [];
  const newCur = cLinks[newKey] ?? [];
  const { remove: newRemove, add: newAdd } = edgeKeyPatch(newCur, new Set(), node);
  if (newRemove.length > 0 || newAdd.length > 0) {
    writes.push({
      key: newKey,
      value: {
        kind: 'links',
        remove: newRemove,
        add: newAdd,
        list: listShape(ctx.snapshot, newKey, childPath),
      },
    });
    recordOverride(ctx, childPath, newKey, resultingTargets(newCur, newRemove, newAdd));
  }
  const oldCur = cLinks[oldKey] ?? [];
  if (oldCur.includes(node)) {
    writes.push({
      key: oldKey,
      value: {
        kind: 'links',
        remove: [node],
        add: [],
        list: listShape(ctx.snapshot, oldKey, childPath),
      },
    });
    recordOverride(ctx, childPath, oldKey, resultingTargets(oldCur, [node], []));
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
export function mergeWritesByPath(
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

/** N's `tags`/old-property-cleanup/new-property writes, comparing `oldMatch` (N's current type's
 * recipe) against `newType`'s. */
function literalRetypeWrites(
  nNote: NoteData | undefined,
  oldMatch: TypeMatch,
  newType: TypeDef,
): readonly KeyWrite[] {
  const frontmatter = nNote?.frontmatter ?? {};
  const frontmatterTags = nNote?.frontmatterTags ?? [];
  return [
    ...computeTagsWrites(frontmatter, frontmatterTags, oldMatch, newType),
    ...propertyWrites(frontmatter, oldMatch, newType),
  ];
}

/** I4's rejection check: the old type's tag has to actually be rewritable. When it's only present
 * in the note's body/inline text (not its frontmatter), retype can't remove it there — better to
 * say so than to silently leave it and add the new type's tag alongside it. */
function bodyOnlyTagReason(
  snapshot: Snapshot,
  node: string,
  nNote: NoteData | undefined,
  oldMatch: TypeMatch,
): string | null {
  if (nNote === undefined) {
    return null;
  }
  const frontmatterTagsLower = new Set(nNote.frontmatterTags.map((tag) => tag.toLowerCase()));
  const allTagsLower = new Set(nNote.tags.map((tag) => tag.toLowerCase()));
  for (const tag of oldMatch.tags) {
    const lower = tag.toLowerCase();
    if (allTagsLower.has(lower) && !frontmatterTagsLower.has(lower)) {
      return `"${displayName(snapshot, node)}" keeps the tag "${tag}" in its text; remove it there first`;
    }
  }
  return null;
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
  const nNote = snapshot.notes.get(action.node);
  const tagReason = bodyOnlyTagReason(snapshot, action.node, nNote, oldMatch);
  if (tagReason !== null) {
    return { ok: false, reason: tagReason };
  }

  const ctx: SubtreeContext = {
    schema,
    snapshot,
    structure,
    typeOverrides: new Map([[action.node, action.type]]),
    linkOverrides: new Map(),
  };
  const oldCtx = bareContext(ctx);
  const nWrites = [
    ...literalRetypeWrites(nNote, oldMatch, newType),
    ...buildNOwnWrites(ctx, oldCtx, validation.fields, action),
  ];
  recordAllOverrides(ctx, action.node, nWrites);

  const childWrites = retypedChildWrites(schema, ctx, nNode, action);
  const subtreeWrites = deriveSubtreeWrites(ctx, oldCtx, action.node);
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
