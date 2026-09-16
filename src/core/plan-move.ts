// Move planning: turns a `'move'` `Action` into a verified `Plan` that reparents a node and
// cascades link updates to its descendants, or a rejection with a stable, user-facing reason. No
// Obsidian imports.

import { deriveSubtreeWrites, keepTargetsFor, ruleBetween, type SubtreeContext } from './derive.js';
import {
  buildEdgeWrites,
  firstChangedOtherNode,
  inheritWritesFor,
  recordAllOverrides,
  textLinkReason,
} from './plan-shared.js';
import type { Action, Plan, PlanResult } from './plan-types.js';
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
  // Move never renames N, so its own old path still identifies it in `after` too.
  const changedOther = firstChangedOtherNode(before, after, action.node, action.node);
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
    oldParent,
    newParent: action.parent,
    oldEdge,
    key: rule.property,
    keep: keepTargetsFor(nNode, oldParent),
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
