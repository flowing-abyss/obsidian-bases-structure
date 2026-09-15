// Move planning: turns a `'move'` `Action` into a verified `Plan` that reparents a node and
// cascades link updates to its descendants, or a rejection with a stable, user-facing reason. No
// Obsidian imports.

import {
  deriveSubtreeWrites,
  edgeTargets,
  listShape,
  ruleBetween,
  unionInheritedTargets,
  type SubtreeContext,
} from './derive.js';
import type { Action, KeyWrite, Plan, PlanResult } from './plan-types.js';
import type { EdgeRule, Schema } from './schema.js';
import { applyPlan } from './simulate.js';
import { displayName, type Snapshot } from './snapshot.js';
import { buildStructure, type Structure, type StructureNode } from './structure.js';

type MoveAction = Extract<Action, { kind: 'move' }>;

/** `true` when walking up from `path` (inclusive) via primary parents reaches `ancestor` — i.e.
 * `path` is `ancestor` itself or one of its descendants. */
function isSelfOrDescendant(structure: Structure, ancestor: string, path: string): boolean {
  let current: string | null = path;
  while (current !== null) {
    if (current === ancestor) {
      return true;
    }
    current = structure.nodes.get(current)?.parent ?? null;
  }
  return false;
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

interface MoveValidation {
  readonly nNode: StructureNode;
  readonly rule: EdgeRule;
}

type MoveValidationResult =
  | { readonly ok: true; readonly fields: MoveValidation }
  | { readonly ok: false; readonly reason: string };

/** Rejection steps 3–5 (the ones about `P` that don't need `N`'s type narrowed to non-null):
 * `P` must be a structure node, not `N` or one of its descendants, and not `N`'s current parent. */
function checkMoveParent(
  structure: Structure,
  snapshot: Snapshot,
  action: MoveAction,
  nNode: StructureNode,
): string | null {
  if (structure.nodes.get(action.parent) === undefined) {
    return `"${displayName(snapshot, action.parent)}" is not in the structure`;
  }
  if (isSelfOrDescendant(structure, action.node, action.parent)) {
    return `Cannot move "${displayName(snapshot, action.node)}" into itself or its own branch`;
  }
  if (nNode.parent === action.parent) {
    return `"${displayName(snapshot, action.node)}" is already under "${displayName(snapshot, action.parent)}"`;
  }
  return null;
}

function validateMove(
  schema: Schema,
  snapshot: Snapshot,
  structure: Structure,
  action: MoveAction,
): MoveValidationResult {
  const nNode = structure.nodes.get(action.node);
  if (nNode === undefined) {
    return { ok: false, reason: `"${displayName(snapshot, action.node)}" is not in the structure` };
  }
  if (action.node === structure.root || nNode.type === null) {
    return { ok: false, reason: 'The root cannot be moved' };
  }
  const parentReason = checkMoveParent(structure, snapshot, action, nNode);
  if (parentReason !== null) {
    return { ok: false, reason: parentReason };
  }
  const parentType = structure.nodes.get(action.parent)?.type ?? null;
  const rule = ruleBetween(schema, parentType, nNode.type);
  if (rule === null) {
    return {
      ok: false,
      reason: `"${nNode.type}" cannot be placed under "${displayName(snapshot, action.parent)}"`,
    };
  }
  if (rule.kind !== 'property') {
    return { ok: false, reason: textLinkReason(rule.kind, snapshot, action.parent, action.node) };
  }
  return { ok: true, fields: { nNode, rule } };
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

interface EdgeWriteInputs {
  readonly snapshot: Snapshot;
  readonly node: string;
  readonly target: string; // P
  readonly oldParent: string | null; // O
  readonly oldEdge: EdgeRule | null; // E
  readonly key: string; // k = rule.property
  readonly keep: ReadonlySet<string>; // N's genuine property-kind extras
}

/** The edge-key write itself: keeps only `O`, `P`, and genuine extras from the current value (see
 * `derive.ts`'s `edgeTargets`), replacing `O` in place when the edge property hasn't changed,
 * otherwise prepending `P`. `null` when nothing actually changes. */
function computeEdgeWrite(inputs: EdgeWriteInputs, cur: readonly string[]): KeyWrite | null {
  const sameKey = inputs.oldEdge?.kind === 'property' && inputs.oldEdge.property === inputs.key;
  const newTargets = edgeTargets(cur, inputs.oldParent, inputs.target, {
    keep: inputs.keep,
    sameKey,
  });
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

/** Drops the old parent from its old edge property, when that property differs from the new edge
 * key and isn't itself a `schema.inherit` key (in which case the generic inherit recompute owns
 * it instead). `null` when there's nothing to clean up. */
function computeOldEdgeCleanup(
  schema: Schema,
  inputs: EdgeWriteInputs,
  nLinks: Readonly<Record<string, readonly string[]>>,
): KeyWrite | null {
  if (
    inputs.oldEdge?.kind !== 'property' ||
    inputs.oldEdge.property === inputs.key ||
    inputs.oldParent === null ||
    schema.inherit.includes(inputs.oldEdge.property)
  ) {
    return null;
  }
  const oldKey = inputs.oldEdge.property;
  const cur2 = nLinks[oldKey] ?? [];
  const filtered = cur2.filter((item) => item !== inputs.oldParent);
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

/** Builds N's own edge-key write plus, when applicable, the write that drops the old parent from
 * its old property. Shared shape used identically by move (`target` is the new parent) and by
 * retype's own-N edge handling (`target` equals N's unchanged parent, so `oldParent === target`). */
function buildEdgeWrites(schema: Schema, inputs: EdgeWriteInputs): readonly KeyWrite[] {
  const nLinks = inputs.snapshot.notes.get(inputs.node)?.propertyLinks ?? {};
  const cur = nLinks[inputs.key] ?? [];
  const writes: KeyWrite[] = [];
  const edgeWrite = computeEdgeWrite(inputs, cur);
  if (edgeWrite !== null) {
    writes.push(edgeWrite);
  }
  const cleanupWrite = computeOldEdgeCleanup(schema, inputs, nLinks);
  if (cleanupWrite !== null) {
    writes.push(cleanupWrite);
  }
  return writes;
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

function recordAllOverrides(ctx: SubtreeContext, path: string, writes: readonly KeyWrite[]): void {
  for (const write of writes) {
    if (write.value !== null && write.value.kind === 'links') {
      recordOverride(ctx, path, write.key, write.value.targets);
    }
  }
}

/** Every `schema.inherit` key except `excludeKey` (N's own, just-written edge property), given the
 * property parents `propertyParents`. Mutates `ctx.linkOverrides` for `node` as writes are found —
 * mirrors `deriveSubtreeWrites`'s per-descendant recompute, applied to N itself with a
 * caller-supplied parent list instead of the structure's own `parent`/`extras`. */
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

interface MoveMismatch {
  readonly node: string;
  readonly actualParent: string | null;
  readonly oldEdge: EdgeRule | null;
  readonly oldParent: string | null;
}

function moveMismatchReason(snapshot: Snapshot, mismatch: MoveMismatch): string {
  const { node, actualParent, oldEdge, oldParent } = mismatch;
  const base =
    actualParent === null
      ? `"${displayName(snapshot, node)}" would have no parent`
      : `"${displayName(snapshot, node)}" would stay under "${displayName(snapshot, actualParent)}"`;
  const isTextEdge = oldEdge !== null && oldEdge.kind !== 'property';
  if (isTextEdge && actualParent === oldParent && oldParent !== null) {
    return `${base} because its link from "${displayName(snapshot, oldParent)}" is in note text`;
  }
  return base;
}

function firstChangedOtherNode(before: Structure, after: Structure, node: string): string | null {
  for (const [path, beforeNode] of before.nodes) {
    if (path === node) {
      continue;
    }
    const afterNode = after.nodes.get(path);
    if (afterNode === undefined) {
      continue;
    }
    if (afterNode.parent !== beforeNode.parent) {
      return path;
    }
  }
  return null;
}

interface VerifyMoveInputs {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly plan: Plan;
  readonly before: Structure;
  readonly action: MoveAction;
  readonly oldEdge: EdgeRule | null;
  readonly oldParent: string | null;
}

function verifyMove(inputs: VerifyMoveInputs): string | null {
  const { schema, snapshot, plan, before, action } = inputs;
  const after = buildStructure(schema, applyPlan(snapshot, plan));
  const afterN = after.nodes.get(action.node);
  const actualParent = afterN?.parent ?? null;
  if (actualParent !== action.parent) {
    return moveMismatchReason(snapshot, {
      node: action.node,
      actualParent,
      oldEdge: inputs.oldEdge,
      oldParent: inputs.oldParent,
    });
  }
  const changedOther = firstChangedOtherNode(before, after, action.node);
  if (changedOther !== null) {
    return `Moving "${displayName(snapshot, action.node)}" would also move "${displayName(snapshot, changedOther)}"`;
  }
  return null;
}

export function planMove(schema: Schema, snapshot: Snapshot, action: MoveAction): PlanResult {
  const structure = buildStructure(schema, snapshot);
  const validation = validateMove(schema, snapshot, structure, action);
  if (!validation.ok) {
    return validation;
  }
  const { nNode, rule } = validation.fields;
  const oldParent = nNode.parent;
  const oldEdge = nNode.edge;
  const ctx: SubtreeContext = {
    schema,
    snapshot,
    structure,
    typeOverrides: new Map(),
    linkOverrides: new Map(),
  };
  const propertyExtras = nNode.extras
    .filter((extra) => extra.kind === 'property' && extra.parent !== oldParent)
    .map((extra) => extra.parent);
  const edgeWrites = buildEdgeWrites(schema, {
    snapshot,
    node: action.node,
    target: action.parent,
    oldParent,
    oldEdge,
    key: rule.property,
    keep: new Set(propertyExtras),
  });
  const propertyParents = [action.parent, ...propertyExtras];
  const inheritWrites = inheritWritesFor(ctx, action.node, rule.property, propertyParents);
  const nWrites = [...edgeWrites, ...inheritWrites];
  recordAllOverrides(ctx, action.node, nWrites);
  const subtreeWrites = deriveSubtreeWrites(ctx, action.node);
  const changes =
    nWrites.length > 0 ? [{ path: action.node, writes: nWrites }, ...subtreeWrites] : subtreeWrites;
  const plan: Plan = { creations: [], changes, appends: [], moves: [] };
  const failure = verifyMove({
    schema,
    snapshot,
    plan,
    before: structure,
    action,
    oldEdge,
    oldParent,
  });
  if (failure !== null) {
    return { ok: false, reason: failure };
  }
  return { ok: true, plan, focus: action.node };
}

export function moveTargets(
  schema: Schema,
  structure: Structure,
  node: string,
): ReadonlySet<string> {
  const nNode = structure.nodes.get(node);
  if (nNode === undefined || node === structure.root || nNode.type === null) {
    return new Set();
  }
  const nodeType = nNode.type;
  const result = new Set<string>();
  for (const [path, candidate] of structure.nodes) {
    if (path === node) {
      continue;
    }
    if (isSelfOrDescendant(structure, node, path)) {
      continue;
    }
    if (path === nNode.parent) {
      continue;
    }
    const rule = ruleBetween(schema, candidate.type, nodeType);
    if (rule?.kind === 'property') {
      result.add(path);
    }
  }
  return result;
}
