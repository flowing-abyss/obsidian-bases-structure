// Convert planning: turns a `'convert'` `Action` (retype + move, in one transaction) into a
// verified `Plan`, or a rejection with a stable, user-facing reason. Reuses planRetype's recipe
// (tag/property) writes and its child-edge-key cascade for the type change, and the same
// property/text-edge glue plan-move.ts uses for the parent change — merged into one `SubtreeContext`
// and verified once by simulation: N must land under `action.parent` as `action.type`, every
// descendant must keep its own parent, and nothing else may change. No Obsidian imports.

import {
  bareContext,
  deriveSubtreeWrites,
  oldContribOf,
  propertyParentsOf,
  ruleBetween,
  type SubtreeContext,
} from './derive.js';
import { moveTargets } from './plan-move.js';
import {
  bodyOnlyTagReason,
  failingChildren,
  literalRetypeWrites,
  mergeWritesByPath,
  retypedChildWrites,
} from './plan-retype.js';
import {
  buildEdgeWrites,
  computeOldEdgeCleanup,
  firstChangedOtherNode,
  inheritWritesFor,
  recordAllOverrides,
  textEdgeAppend,
  textEdgeRemoval,
} from './plan-shared.js';
import type { Action, KeyWrite, Plan, PlanEnv, PlanResult } from './plan-types.js';
import type { EdgeRule, Schema, TypeDef, TypeMatch } from './schema.js';
import { applyPlan } from './simulate.js';
import { displayName, type Snapshot } from './snapshot.js';
import { buildStructure, type Structure, type StructureNode } from './structure.js';

type ConvertAction = Extract<Action, { kind: 'convert' }>;

const EMPTY_MATCH: TypeMatch = { tags: [], folder: null, properties: [] };

/** `true` when walking up from `path` (inclusive) via primary parents reaches `ancestor` — i.e.
 * `path` is `ancestor` itself or one of its descendants. Local copy of plan-move.ts's own check:
 * not exported there, and this file isn't on the brief's list of files to modify. */
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

// -- Validation -----------------------------------------------------------------------------

interface ConvertFields {
  readonly nNode: StructureNode;
  /** N's current-type recipe — `checkConvertNode` looks it up once `nNode.type` is known
   * non-null (the root/null-type node is rejected first), so it's never re-derived from a
   * nullable `nNode.type` elsewhere in the file. */
  readonly oldMatch: TypeMatch;
  readonly newType: TypeDef;
  readonly rule: EdgeRule;
}

type ConvertValidationResult =
  | { readonly ok: true; readonly fields: ConvertFields }
  | { readonly ok: false; readonly reason: string };

interface NodeCheckFields {
  readonly nNode: StructureNode;
  readonly oldMatch: TypeMatch;
  readonly newType: TypeDef;
}

type NodeCheckResult =
  | { readonly ok: true; readonly fields: NodeCheckFields }
  | { readonly ok: false; readonly reason: string };

/** Rejection steps for N itself: must be a structure node, not the root (the only node whose type
 * can resolve to `null`), and `action.type` must be a real type. */
function checkConvertNode(
  schema: Schema,
  snapshot: Snapshot,
  structure: Structure,
  action: ConvertAction,
): NodeCheckResult {
  const nNode = structure.nodes.get(action.node);
  if (nNode === undefined) {
    return { ok: false, reason: `"${displayName(snapshot, action.node)}" is not in the structure` };
  }
  if (action.node === structure.root || nNode.type === null) {
    return { ok: false, reason: 'The root cannot be moved' };
  }
  const newType = schema.typeByName.get(action.type);
  if (newType === undefined) {
    return { ok: false, reason: `Unknown type "${action.type}"` };
  }
  // `nNode.type` is narrowed to `string` here (the `=== null` check above returned already) —
  // captured now so callers never need to re-narrow it themselves.
  const oldMatch = schema.typeByName.get(nNode.type)?.match ?? EMPTY_MATCH;
  return { ok: true, fields: { nNode, oldMatch, newType } };
}

type ParentCheckResult =
  { readonly ok: true; readonly rule: EdgeRule } | { readonly ok: false; readonly reason: string };

/** Rejection steps for the requested parent: must be a structure node, not N itself or one of
 * N's own descendants, and must have a rule to `action.type`. */
function checkConvertParent(
  schema: Schema,
  snapshot: Snapshot,
  structure: Structure,
  action: ConvertAction,
): ParentCheckResult {
  if (structure.nodes.get(action.parent) === undefined) {
    return {
      ok: false,
      reason: `"${displayName(snapshot, action.parent)}" is not in the structure`,
    };
  }
  if (isSelfOrDescendant(structure, action.node, action.parent)) {
    return {
      ok: false,
      reason: `Cannot move "${displayName(snapshot, action.node)}" into itself or its own branch`,
    };
  }
  const parentType = structure.nodes.get(action.parent)?.type ?? null;
  const rule = ruleBetween(schema, parentType, action.type);
  if (rule === null) {
    return {
      ok: false,
      reason: `"${action.type}" cannot be placed under "${displayName(snapshot, action.parent)}"`,
    };
  }
  return { ok: true, rule };
}

function validateConvert(
  schema: Schema,
  snapshot: Snapshot,
  structure: Structure,
  action: ConvertAction,
): ConvertValidationResult {
  const nodeCheck = checkConvertNode(schema, snapshot, structure, action);
  if (!nodeCheck.ok) {
    return nodeCheck;
  }
  const parentCheck = checkConvertParent(schema, snapshot, structure, action);
  if (!parentCheck.ok) {
    return parentCheck;
  }
  const { nNode, oldMatch, newType } = nodeCheck.fields;
  return { ok: true, fields: { nNode, oldMatch, newType, rule: parentCheck.rule } };
}

// -- N's own edge to the new parent (plan-move.ts's glue, over the *new* type/parent) ---------

interface ConvertEdgeInputs {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly node: string;
  readonly newParent: string;
  readonly rule: EdgeRule;
  readonly oldParent: string | null;
  readonly oldEdge: EdgeRule | null;
}

/** N's own edge-key write for a `'property'`-kind new rule — mirrors plan-move.ts's
 * `propertyEdgeWrites`: the stale set is the old parent, plus (only when the key is a
 * `schema.inherit` key and the old edge wasn't itself through it) the old parent's own
 * contribution to that key. */
function convertPropertyEdgeWrites(
  ctx: SubtreeContext,
  inputs: ConvertEdgeInputs,
): readonly KeyWrite[] {
  const { schema, snapshot, node, newParent, rule, oldParent, oldEdge } = inputs;
  const staleForNewKey = new Set(
    oldParent === null
      ? []
      : [
          oldParent,
          ...(schema.inherit.includes(rule.property) && oldEdge?.property !== rule.property
            ? oldContribOf(ctx, oldParent, rule.property)
            : []),
        ],
  );
  return buildEdgeWrites(schema, {
    snapshot,
    node,
    oldParent,
    newParent,
    oldEdge,
    key: rule.property,
    staleForNewKey,
  });
}

/** The old parent's frontmatter cleanup alone, for a `'convert'` whose *new* rule isn't
 * `'property'`-kind — mirrors plan-move.ts's `oldEdgeCleanupOnly`. */
function convertOldEdgeCleanupOnly(schema: Schema, inputs: ConvertEdgeInputs): readonly KeyWrite[] {
  const { snapshot, node, newParent, rule, oldParent, oldEdge } = inputs;
  const nLinks = snapshot.notes.get(node)?.propertyLinks ?? {};
  const cleanup = computeOldEdgeCleanup(
    schema,
    {
      snapshot,
      node,
      oldParent,
      newParent,
      oldEdge,
      key: rule.property,
      staleForNewKey: new Set(),
    },
    nLinks,
  );
  return cleanup === null ? [] : [cleanup];
}

interface BuildNWritesInputs {
  readonly ctx: SubtreeContext;
  readonly oldCtx: SubtreeContext;
  readonly nNote: ReturnType<Snapshot['notes']['get']>;
  readonly fields: ConvertFields;
  readonly action: ConvertAction;
}

/** N's own writes: the retype recipe (tags/properties for the new type) plus the move glue (the
 * edge to the new parent, and N's own `schema.inherit` recompute against its new property
 * parents). */
function buildNWrites(inputs: BuildNWritesInputs): readonly KeyWrite[] {
  const { ctx, oldCtx, nNote, fields, action } = inputs;
  const { nNode, oldMatch, newType, rule } = fields;
  const oldParent = nNode.parent;
  const oldEdge = nNode.edge;
  const edgeInputs: ConvertEdgeInputs = {
    schema: ctx.schema,
    snapshot: ctx.snapshot,
    node: action.node,
    newParent: action.parent,
    rule,
    oldParent,
    oldEdge,
  };
  const edgeWrites =
    rule.kind === 'property'
      ? convertPropertyEdgeWrites(ctx, edgeInputs)
      : convertOldEdgeCleanupOnly(ctx.schema, edgeInputs);

  const propertyExtras = nNode.extras
    .filter((extra) => extra.kind === 'property' && extra.parent !== oldParent)
    .map((extra) => extra.parent);
  const inheritWrites = inheritWritesFor(ctx, oldCtx, {
    node: action.node,
    excludeKey: rule.property,
    oldPropertyParents: propertyParentsOf(nNode),
    newPropertyParents: [action.parent, ...propertyExtras],
  });

  const recipeWrites = literalRetypeWrites(nNote, oldMatch, newType);
  return [...recipeWrites, ...edgeWrites, ...inheritWrites];
}

// -- Verification -----------------------------------------------------------------------------

interface VerifyConvertInputs {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly plan: Plan;
  readonly before: Structure;
  readonly action: ConvertAction;
}

/** The reason a specific stranded child produces: whether it ends up parentless, or lands
 * somewhere other than N — mirrors plan-move.ts's `moveMismatchReason` phrasing. */
function convertChildMismatchReason(
  snapshot: Snapshot,
  childPath: string,
  afterParent: string | null,
): string {
  const childName = displayName(snapshot, childPath);
  return afterParent === null
    ? `"${childName}" would have no parent`
    : `"${childName}" would move to "${displayName(snapshot, afterParent)}"`;
}

/** Verifies by simulation: N must resolve to `action.type` under `action.parent`, and the first
 * node (other than N) whose parent changed must be `null` — either a direct child of N that the
 * new type can no longer carry (reported against N and that child together), or, failing that, an
 * unrelated node the plan touched by mistake. */
function verifyConvert(inputs: VerifyConvertInputs): string | null {
  const { schema, snapshot, plan, before, action } = inputs;
  const after = buildStructure(schema, applyPlan(snapshot, plan));
  const afterFocus = after.nodes.get(action.node);
  if (afterFocus?.type !== action.type || afterFocus.parent !== action.parent) {
    return `"${displayName(snapshot, action.node)}" would not become "${action.type}" under "${displayName(snapshot, action.parent)}"`;
  }
  const changed = firstChangedOtherNode(before, after, action.node, action.node);
  if (changed === null) {
    return null;
  }
  if (before.nodes.get(changed)?.parent === action.node) {
    const afterParent = after.nodes.get(changed)?.parent ?? null;
    const childReason = convertChildMismatchReason(snapshot, changed, afterParent);
    return `"${displayName(snapshot, action.node)}" cannot become "${action.type}": ${childReason}`;
  }
  return `Converting "${displayName(snapshot, action.node)}" would also move "${displayName(snapshot, changed)}"`;
}

// -- planConvert ------------------------------------------------------------------------------

// `env` isn't read: unlike retype, convert never relocates N's folder (no type in this schema
// pins one, and folder-on-convert is out of scope for this task — see the task report). Kept in
// the signature for parity with `planAction`'s uniform per-kind call shape.
export function planConvert(
  schema: Schema,
  snapshot: Snapshot,
  action: ConvertAction,
  _env: PlanEnv,
): PlanResult {
  const structure = buildStructure(schema, snapshot);
  const validation = validateConvert(schema, snapshot, structure, action);
  if (!validation.ok) {
    return validation;
  }
  const { nNode, oldMatch, newType, rule } = validation.fields;
  const nNote = snapshot.notes.get(action.node);
  const tagReason = bodyOnlyTagReason({ snapshot, node: action.node, nNote, oldMatch, newType });
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

  const nWrites = buildNWrites({ ctx, oldCtx, nNote, fields: validation.fields, action });
  recordAllOverrides(ctx, action.node, nWrites);

  const childWrites = retypedChildWrites(schema, ctx, nNode, {
    node: action.node,
    type: action.type,
  });
  const subtreeWrites = deriveSubtreeWrites(ctx, oldCtx, action.node);
  const mergedDescendantWrites = mergeWritesByPath(childWrites, subtreeWrites);
  const changes =
    nWrites.length > 0
      ? [{ path: action.node, writes: nWrites }, ...mergedDescendantWrites]
      : mergedDescendantWrites;

  const oldParent = nNode.parent;
  const oldEdge = nNode.edge;
  const appends: Plan['appends'] =
    rule.kind === 'property' ? [] : [textEdgeAppend(rule.kind, action.node, action.parent)];
  const bodyLinkRemovals: Plan['bodyLinkRemovals'] =
    oldParent !== null && oldEdge !== null && oldEdge.kind !== 'property'
      ? [textEdgeRemoval(oldEdge.kind, action.node, oldParent)]
      : [];

  const plan: Plan = { creations: [], changes, appends, moves: [], bodyLinkRemovals };
  const failure = verifyConvert({ schema, snapshot, plan, before: structure, action });
  if (failure !== null) {
    return { ok: false, reason: failure };
  }
  return { ok: true, plan, focus: action.node };
}

// -- convertOptions / operationTargets ---------------------------------------------------------

/** Type names N could become while moving under `parent`, filtered to those that keep the whole
 * branch valid: a rule must connect `parent`'s type to the candidate, and every direct child of N
 * must survive the retype (`failingChildren`) — the same two checks `retypeOptions` relies on, so
 * this can't call `planConvert` itself (no `Snapshot` reaches this signature). */
export function convertOptions(
  schema: Schema,
  structure: Structure,
  node: string,
  parent: string,
): readonly string[] {
  const nNode = structure.nodes.get(node);
  const parentNode = structure.nodes.get(parent);
  if (nNode === undefined || parentNode === undefined || nNode.type === null) {
    return [];
  }
  if (node === structure.root || isSelfOrDescendant(structure, node, parent)) {
    return [];
  }
  const ordered = [...schema.types].sort((a, b) => a.level - b.level);
  const results: string[] = [];
  for (const type of ordered) {
    if (type.name === nNode.type) {
      continue;
    }
    if (ruleBetween(schema, parentNode.type, type.name) === null) {
      continue;
    }
    if (failingChildren(schema, structure, nNode, type.name).length > 0) {
      continue;
    }
    results.push(type.name);
  }
  return results;
}

/** What the UI highlights as valid drop targets for `node`, for either gesture: `moveTargets` for
 * a plain move, or every candidate parent that offers at least one `convertOptions` type. */
export function operationTargets(
  schema: Schema,
  structure: Structure,
  node: string,
  mode: 'move' | 'convert',
): ReadonlySet<string> {
  if (mode === 'move') {
    return moveTargets(schema, structure, node);
  }
  const result = new Set<string>();
  for (const path of structure.nodes.keys()) {
    if (convertOptions(schema, structure, node, path).length > 0) {
      result.add(path);
    }
  }
  return result;
}
