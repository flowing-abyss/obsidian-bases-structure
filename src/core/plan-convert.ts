// Convert planning: turns a `'convert'` `Action` (retype + move, in one transaction) into a
// verified `Plan`, or a rejection with a stable, user-facing reason. Reuses planRetype's recipe
// (tag/property) writes and its child-edge-key cascade for the type change, and the same
// property/text-edge glue plan-move.ts uses for the parent change — merged into one `SubtreeContext`
// and verified once by simulation: N must land under `action.parent` as `action.type`, every
// descendant must keep its own parent, and nothing else may change. No Obsidian imports.

import {
  bareContext,
  deriveSubtreeWrites,
  propertyParentsOf,
  ruleBetween,
  type SubtreeContext,
} from './derive.js';
import { moveTargets } from './plan-move.js';
import {
  bodyOnlyTagReason,
  checkRetypeFolder,
  failingChildren,
  literalRetypeWrites,
  mergeWritesByPath,
  retypedChildWrites,
} from './plan-retype.js';
import {
  buildTextEdgeChanges,
  firstChangedOtherNode,
  inheritWritesFor,
  isSelfOrDescendant,
  oldEdgeCleanupOnly,
  propertyEdgeWrites,
  recordAllOverrides,
  type RuleEdgeInputs,
} from './plan-shared.js';
import type { Action, KeyWrite, Plan, PlanEnv, PlanResult } from './plan-types.js';
import type { EdgeRule, Schema, TypeDef, TypeMatch } from './schema.js';
import { applyPlan } from './simulate.js';
import { displayName, type Snapshot } from './snapshot.js';
import { buildStructure, type Structure, type StructureNode } from './structure.js';

type ConvertAction = Extract<Action, { kind: 'convert' }>;

/** Everything `convertOptions`/`operationTargets` need to answer honestly (by planning, not just
 * pre-filtering) — bundled so both stay within the project's 4-param budget, and so the
 * `planConvert` call inside `convertOptions` doesn't need its own separately-threaded `env`. */
export interface ConvertContext {
  readonly schema: Schema;
  readonly structure: Structure;
  readonly snapshot: Snapshot;
  readonly env: PlanEnv;
}

const EMPTY_MATCH: TypeMatch = { tags: [], folder: null, properties: [] };

// -- Validation -----------------------------------------------------------------------------

interface ConvertFields {
  readonly nNode: StructureNode;
  /** N's current-type recipe — `checkConvertNode` looks it up once `nNode.type` is known
   * non-null (the root/null-type node is rejected first), so it's never re-derived from a
   * nullable `nNode.type` elsewhere in the file. */
  readonly oldMatch: TypeMatch;
  readonly newType: TypeDef;
  readonly rule: EdgeRule;
  /** `newType`'s pinned folder, when it requires relocating N and N isn't already there —
   * `checkRetypeFolder`, the exact mechanism a plain retype uses. `null` = no move needed. */
  readonly folderTo: string | null;
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

function validateConvert(context: ConvertContext, action: ConvertAction): ConvertValidationResult {
  const { schema, snapshot, structure, env } = context;
  const nodeCheck = checkConvertNode(schema, snapshot, structure, action);
  if (!nodeCheck.ok) {
    return nodeCheck;
  }
  const parentCheck = checkConvertParent(schema, snapshot, structure, action);
  if (!parentCheck.ok) {
    return parentCheck;
  }
  const { nNode, oldMatch, newType } = nodeCheck.fields;
  const folderCheck = checkRetypeFolder(env, snapshot, action.node, newType);
  if (folderCheck.kind === 'occupied') {
    return { ok: false, reason: `A note already exists at "${folderCheck.to}"` };
  }
  const folderTo = folderCheck.kind === 'move' ? folderCheck.to : null;
  return { ok: true, fields: { nNode, oldMatch, newType, rule: parentCheck.rule, folderTo } };
}

// -- N's own edge to the new parent (plan-move.ts's glue, over the *new* type/parent) ---------

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
  const edgeInputs: RuleEdgeInputs = {
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
      ? propertyEdgeWrites(ctx, edgeInputs)
      : oldEdgeCleanupOnly(ctx.schema, edgeInputs);

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
  /** N's post-plan path — `action.node` unless the new type's folder relocated it (see
   * `ConvertFields.folderTo`), same "focus may rename N" shape `verifyRetype` uses. */
  readonly focus: string;
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
  const { schema, snapshot, plan, before, action, focus } = inputs;
  const after = buildStructure(schema, applyPlan(snapshot, plan));
  const afterFocus = after.nodes.get(focus);
  if (afterFocus?.type !== action.type || afterFocus.parent !== action.parent) {
    return `"${displayName(snapshot, action.node)}" would not become "${action.type}" under "${displayName(snapshot, action.parent)}"`;
  }
  const changed = firstChangedOtherNode(before, after, action.node, focus);
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

interface BuildConvertChangesInputs {
  readonly ctx: SubtreeContext;
  readonly oldCtx: SubtreeContext;
  readonly nNote: ReturnType<Snapshot['notes']['get']>;
  readonly validation: Extract<ConvertValidationResult, { ok: true }>;
  readonly action: ConvertAction;
}

/** N's own writes plus the merged child/subtree cascade, as a single `changes` list — the part of
 * `planConvert` shared regardless of whether N's folder also moves. */
function buildConvertChanges(inputs: BuildConvertChangesInputs): Plan['changes'] {
  const { ctx, oldCtx, nNote, validation, action } = inputs;
  const { nNode } = validation.fields;
  const nWrites = buildNWrites({ ctx, oldCtx, nNote, fields: validation.fields, action });
  recordAllOverrides(ctx, action.node, nWrites);

  const childWrites = retypedChildWrites(ctx.schema, ctx, nNode, {
    node: action.node,
    type: action.type,
  });
  const subtreeWrites = deriveSubtreeWrites(ctx, oldCtx, action.node);
  const mergedDescendantWrites = mergeWritesByPath(childWrites, subtreeWrites);
  return nWrites.length > 0
    ? [{ path: action.node, writes: nWrites }, ...mergedDescendantWrites]
    : mergedDescendantWrites;
}

export function planConvert(
  schema: Schema,
  snapshot: Snapshot,
  action: ConvertAction,
  env: PlanEnv,
): PlanResult {
  const structure = buildStructure(schema, snapshot);
  const validation = validateConvert({ schema, structure, snapshot, env }, action);
  if (!validation.ok) {
    return validation;
  }
  const { nNode, oldMatch, newType, rule, folderTo } = validation.fields;
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
  const changes = buildConvertChanges({ ctx, oldCtx, nNote, validation, action });
  const { appends, bodyLinkRemovals } = buildTextEdgeChanges({
    snapshot,
    rule,
    node: action.node,
    newParent: action.parent,
    oldParent: nNode.parent,
    oldEdge: nNode.edge,
  });
  const moves: Plan['moves'] = folderTo !== null ? [{ from: action.node, to: folderTo }] : [];
  const focus = folderTo ?? action.node;

  const plan: Plan = { creations: [], changes, appends, moves, bodyLinkRemovals };
  const failure = verifyConvert({ schema, snapshot, plan, before: structure, action, focus });
  if (failure !== null) {
    return { ok: false, reason: failure };
  }
  return { ok: true, plan, focus };
}

// -- convertOptions / operationTargets ---------------------------------------------------------

interface ConvertCandidateCheck {
  readonly context: ConvertContext;
  readonly nNode: StructureNode;
  readonly parentType: string | null;
  readonly node: string;
  readonly parent: string;
}

/** Whether `typeName` is a genuine option for `check.node`: a rule must connect the parent's type
 * to it and every direct child must survive the retype (`failingChildren`) — two cheap structural
 * pre-filters — then, only for a candidate that clears both, `planConvert` itself confirms it
 * (a body-only tag, or an untouched higher-priority candidate surviving the simulation, can each
 * still reject a candidate neither pre-filter catches). */
function convertCandidateSurvives(check: ConvertCandidateCheck, typeName: string): boolean {
  const { context, nNode, parentType, node, parent } = check;
  const { schema, snapshot, structure, env } = context;
  if (ruleBetween(schema, parentType, typeName) === null) {
    return false;
  }
  if (failingChildren(schema, structure, nNode, typeName).length > 0) {
    return false;
  }
  const action: ConvertAction = { kind: 'convert', node, parent, type: typeName };
  return planConvert(schema, snapshot, action, env).ok;
}

/** Type names N could become while moving under `parent`, filtered to those that keep the whole
 * branch valid — see `convertCandidateSurvives` for what "valid" means. */
export function convertOptions(
  context: ConvertContext,
  node: string,
  parent: string,
): readonly string[] {
  const { schema, structure } = context;
  const nNode = structure.nodes.get(node);
  const parentNode = structure.nodes.get(parent);
  if (nNode === undefined || parentNode === undefined || nNode.type === null) {
    return [];
  }
  if (node === structure.root || isSelfOrDescendant(structure, node, parent)) {
    return [];
  }
  const check: ConvertCandidateCheck = {
    context,
    nNode,
    parentType: parentNode.type,
    node,
    parent,
  };
  const ordered = [...schema.types].sort((a, b) => a.level - b.level);
  return ordered
    .map((type) => type.name)
    .filter((name) => name !== nNode.type && convertCandidateSurvives(check, name));
}

/** What the UI highlights as valid drop targets for `node`, for either gesture: `moveTargets` for
 * a plain move, or every candidate parent that offers at least one `convertOptions` type — the
 * single source of truth for both, so a target only ever lights up when the whole branch survives
 * the actual conversion. */
export function operationTargets(
  context: ConvertContext,
  node: string,
  mode: 'move' | 'convert',
): ReadonlySet<string> {
  if (mode === 'move') {
    return moveTargets(context.schema, context.structure, node);
  }
  const result = new Set<string>();
  for (const path of context.structure.nodes.keys()) {
    if (convertOptions(context, node, path).length > 0) {
      result.add(path);
    }
  }
  return result;
}
