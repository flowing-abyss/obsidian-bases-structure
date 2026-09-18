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
  alreadyLinked,
  buildEdgeWrites,
  type EdgeWriteInputs,
  firstChangedOtherNode,
  inheritWritesFor,
  recordAllOverrides,
  recordOverride,
  targetStillHeldByProperty,
  textEdgeAppend,
  textEdgeRemoval,
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
 * `targetType` — the one case a child's edge can never be rewritten into: `targetType` has no rule
 * at all to the child's own type, meaning the child would have to change type too, and a single
 * conversion only ever changes one note's type. A rule that exists but names a different kind
 * (property vs. `file.links`/`file.backlinks`) is no longer a failure here — see
 * `retypedChildWrites` for how that edge actually gets rewritten. */
export function failingChildren(
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
    if (ruleBetween(schema, targetType, childNode.type) === null) {
      failures.push(childPath);
    }
  }
  return failures;
}

/** The rejection reason for a retype/convert that would strand a direct child — named for the
 * first child `failingChildren` finds (mirrors `adoptedChildReason`/`convertChildMismatchReason`'s
 * own "name the first offender" style elsewhere in the planners). `null` when every child
 * survives. Shared by `validateRetype` and `plan-convert.ts`'s `validateConvert` so both refuse
 * this one-type-change-per-operation limit with the exact same wording. */
export function firstFailingChildReason(
  schema: Schema,
  structure: Structure,
  snapshot: Snapshot,
  info: { readonly nNode: StructureNode; readonly node: string; readonly type: string },
): string | null {
  const [firstFailing] = failingChildren(schema, structure, info.nNode, info.type);
  if (firstFailing === undefined) {
    return null;
  }
  const childName = displayName(snapshot, firstFailing);
  const nodeName = displayName(snapshot, info.node);
  return `"${childName}" cannot stay under "${nodeName}" as a "${info.type}"`;
}

export type FolderCheck =
  | { readonly kind: 'no-move' }
  | { readonly kind: 'move'; readonly to: string }
  | { readonly kind: 'occupied'; readonly to: string };

/** Rejection step 7: whether `newType`'s folder requires relocating N, and whether the target
 * path is already taken. Exported: plan-convert.ts's own retype half needs the exact same
 * folder-pin behavior a plain retype gets. */
export function checkRetypeFolder(
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
  const failingReason = firstFailingChildReason(schema, structure, snapshot, {
    nNode,
    node: action.node,
    type: action.type,
  });
  if (failingReason !== null) {
    return { ok: false, reason: failingReason };
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

/** The frontmatter key retype's tag writes target: whichever key already matches `tags`
 * case-insensitively (real Obsidian's `parseFrontMatterTags` reads only that, never `tag` —
 * round 2 minor 2), defaulting to lowercase `tags` for a note with none yet. Never creates a
 * second `tags`-shaped key, and never writes to `tag`. */
function tagsKeyOf(frontmatter: Readonly<Record<string, unknown>>): string {
  const existing = Object.keys(frontmatter).find((key) => /^tags$/i.test(key));
  return existing ?? 'tags';
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
  const newLower = new Set(newType.match.tags.map((tag) => tag.toLowerCase()));
  // Round 3: a tag both the old and new type require (shared) is left untouched — nothing
  // distinguishes old from new for it, so removing it would just break the new type's own match
  // requirement (the same idea as round 2 minor 4 for shared list-property values).
  const removeTags = oldMatch.tags.filter(
    (tag) => currentLower.has(tag.toLowerCase()) && !newLower.has(tag.toLowerCase()),
  );
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
  // Round 2 minor 4: the old and new recipes can share the same name *and* value (e.g. `scope:
  // work` required by both the old and new type, stored as `[work, home]`) — nothing distinguishes
  // old from new here, so there's nothing to change; removing it would be pure churn (and would
  // wrongly touch a value the retype doesn't actually invalidate).
  if (oldExpected !== undefined && newValue !== undefined && looseEqual(oldExpected, newValue)) {
    return null;
  }
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

// -- Children whose edge to N must be rewritten for the new type's rule ----------------------
//
// A direct child's edge can move between *any* of the three rule kinds — property, file.links,
// file.backlinks — in either direction, not just property-to-property (the old, narrower cascade).
// `failingChildren` above has already refused the one case that can't be expressed this way (the
// child's own type has no rule at all under the new type); every other combination is just a
// question of which primitive kind owns which side of the relationship:
//
//   property  -> property : move the value from the old key to the new one (unchanged from before).
//   property  -> text     : append the child's mention in whichever note the new rule's kind
//                            requires, and clear the old key's value.
//   text      -> property : write the new key's value, and remove the stale mention.
//   text      -> text (same kind)      : nothing — the relationship already reads correctly.
//   text      -> text (different kind) : move the mention from one note's body to the other.

interface ChildWriteEntry {
  readonly path: string;
  readonly writes: readonly KeyWrite[];
}

interface ChildEdgeChange {
  readonly oldEdge: EdgeRule;
  readonly newRule: EdgeRule;
}

interface ChildRewrite {
  readonly entries: readonly ChildWriteEntry[];
  readonly appends: Plan['appends'];
  readonly bodyLinkRemovals: Plan['bodyLinkRemovals'];
}

/** Whether `oldEdge` already reads correctly as `newRule` — the same property key, or the same
 * text kind on both sides — nothing a conversion could improve. */
function childEdgeAlreadyCorrect(oldEdge: EdgeRule, newRule: EdgeRule): boolean {
  if (oldEdge.kind === 'property' && newRule.kind === 'property') {
    return oldEdge.property === newRule.property;
  }
  return (
    oldEdge.kind !== 'property' && newRule.kind !== 'property' && oldEdge.kind === newRule.kind
  );
}

/** What `childPath`'s edge to N needs to become under `newTypeName`, or `null` when nothing needs
 * touching: the child isn't a real structure node, `newTypeName` has no rule to its type at all
 * (`failingChildren` already refuses this case before this ever runs), or the relationship already
 * reads correctly as-is (`childEdgeAlreadyCorrect`). */
function childEdgeChange(
  schema: Schema,
  structure: Structure,
  newTypeName: string,
  childPath: string,
): ChildEdgeChange | null {
  const childNode = structure.nodes.get(childPath);
  if (childNode === undefined) {
    return null;
  }
  const { type: childType, edge: oldEdge } = childNode;
  if (childType === null || oldEdge === null) {
    return null;
  }
  const newRule = ruleBetween(schema, newTypeName, childType);
  if (newRule === null || childEdgeAlreadyCorrect(oldEdge, newRule)) {
    return null;
  }
  return { oldEdge, newRule };
}

/** The write that adds N under the child's new property key — `null` when the new rule isn't
 * `'property'`-kind, or N is already there. Round 2 C1: the new key never held this relationship
 * before, so this is add-only (nothing is stale) — a value already sitting there for an unrelated
 * reason survives untouched. */
function childNewKeyWrite(
  ctx: SubtreeContext,
  childPath: string,
  newRule: EdgeRule,
  node: string,
): KeyWrite | null {
  if (newRule.kind !== 'property') {
    return null;
  }
  const cLinks = ctx.snapshot.notes.get(childPath)?.propertyLinks ?? {};
  const cur = cLinks[newRule.property] ?? [];
  const { remove, add } = edgeKeyPatch(cur, new Set(), node);
  if (remove.length === 0 && add.length === 0) {
    return null;
  }
  recordOverride(ctx, childPath, newRule.property, resultingTargets(cur, remove, add));
  return {
    key: newRule.property,
    value: {
      kind: 'links',
      remove,
      add,
      list: listShape(ctx.snapshot, newRule.property, childPath),
    },
  };
}

/** The write that clears N from the child's old property key — `null` when the old edge wasn't
 * `'property'`-kind, that key is also the new one, or N isn't actually in it. Always cleaned up
 * here even when the key is also a `schema.inherit` key, since the generic inherit recompute
 * (`deriveSubtreeWrites`) excludes a descendant's own (pre-action) edge property from its own
 * recompute (see `inheritKeysFor` in `derive.ts`) — so if this step skipped it too, nothing would
 * (I3). */
function childOldKeyCleanup(
  ctx: SubtreeContext,
  childPath: string,
  change: ChildEdgeChange,
  node: string,
): KeyWrite | null {
  const { oldEdge, newRule } = change;
  if (oldEdge.kind !== 'property' || oldEdge.property === newRule.property) {
    return null;
  }
  const cLinks = ctx.snapshot.notes.get(childPath)?.propertyLinks ?? {};
  const cur = cLinks[oldEdge.property] ?? [];
  if (!cur.includes(node)) {
    return null;
  }
  recordOverride(ctx, childPath, oldEdge.property, resultingTargets(cur, [node], []));
  return {
    key: oldEdge.property,
    value: {
      kind: 'links',
      remove: [node],
      add: [],
      list: listShape(ctx.snapshot, oldEdge.property, childPath),
    },
  };
}

/** The child's own frontmatter writes for an edge-kind change: `childNewKeyWrite` plus
 * `childOldKeyCleanup`, whichever of the two actually apply. */
function childPropertyWrites(
  ctx: SubtreeContext,
  childPath: string,
  change: ChildEdgeChange,
  node: string,
): readonly KeyWrite[] {
  const writes = [
    childNewKeyWrite(ctx, childPath, change.newRule, node),
    childOldKeyCleanup(ctx, childPath, change, node),
  ];
  return writes.filter((write): write is KeyWrite => write !== null);
}

interface ChildTextInputs {
  readonly snapshot: Snapshot;
  readonly childPath: string;
  readonly node: string;
  readonly change: ChildEdgeChange;
}

/** The child's text-side changes for an edge-kind change: the append that establishes the new
 * rule's mention (when the new rule is text-kind), and the removal that clears the old one (when
 * the old edge was text-kind) — same per-kind sidedness `buildTextEdgeChanges` uses for a node's
 * own edge, applied here to a child/N pair instead of a moved node and its new parent. Two guards
 * keep this from ever emitting a primitive the simulator/applier would find redundant or missing:
 * `alreadyLinked` skips the append when the target already resolves (property and text can attach
 * the same pair at once — round 2 C1's I4 sibling for this cascade — so the text edge can already
 * be live before this write ever runs); `targetStillHeldByProperty` skips the removal when some
 * other property still resolves the same link, mirroring `buildTextEdgeChanges`'s own guard. */
function childTextChanges(inputs: ChildTextInputs): Pick<Plan, 'appends' | 'bodyLinkRemovals'> {
  const { snapshot, childPath, node, change } = inputs;
  const { oldEdge, newRule } = change;
  const appendTarget =
    newRule.kind === 'property' ? null : textEdgeAppend(newRule.kind, childPath, node);
  const appends: Plan['appends'] =
    appendTarget !== null && !alreadyLinked(snapshot, appendTarget.path, appendTarget.target)
      ? [appendTarget]
      : [];
  const removal =
    oldEdge.kind === 'property' ? null : textEdgeRemoval(oldEdge.kind, childPath, node);
  const bodyLinkRemovals: Plan['bodyLinkRemovals'] =
    removal !== null && !targetStillHeldByProperty(snapshot, removal.path, removal.target)
      ? [removal]
      : [];
  return { appends, bodyLinkRemovals };
}

/** `action` only needs `node`/`type` — accepts a `'retype'` action or the equivalent slice of a
 * `'convert'` one (plan-convert.ts reuses this for its own child-edge cascade). Every direct child
 * whose edge needs rewriting contributes its own frontmatter writes (`entries`) and/or its own
 * text-side append/removal — collected together so both callers can fold them straight into a
 * `Plan` alongside N's own writes. */
export function retypedChildWrites(
  schema: Schema,
  ctx: SubtreeContext,
  nNode: StructureNode,
  action: { readonly node: string; readonly type: string },
): ChildRewrite {
  const entries: ChildWriteEntry[] = [];
  const appends: Array<Plan['appends'][number]> = [];
  const bodyLinkRemovals: Array<Plan['bodyLinkRemovals'][number]> = [];
  for (const childPath of nNode.children) {
    const change = childEdgeChange(schema, ctx.structure, action.type, childPath);
    if (change === null) {
      continue;
    }
    const writes = childPropertyWrites(ctx, childPath, change, action.node);
    if (writes.length > 0) {
      entries.push({ path: childPath, writes });
    }
    const text = childTextChanges({ snapshot: ctx.snapshot, childPath, node: action.node, change });
    appends.push(...text.appends);
    bodyLinkRemovals.push(...text.bodyLinkRemovals);
  }
  return { entries, appends, bodyLinkRemovals };
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
 * recipe) against `newType`'s. Exported: plan-convert.ts reuses this exact recipe-write recipe for
 * its own retype half, rather than re-deriving the tag/property patch rules. */
export function literalRetypeWrites(
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

export interface BodyOnlyTagInputs {
  readonly snapshot: Snapshot;
  readonly node: string;
  readonly nNote: NoteData | undefined;
  readonly oldMatch: TypeMatch;
  readonly newType: TypeDef;
}

/** I4's rejection check: the old type's tag has to actually be rewritable. When it's present in
 * the note's body/inline text, retype can't remove it there — better to say so than to silently
 * leave it and add the new type's tag alongside it. Round 2 minor 3: checked against `bodyTags`
 * directly (read straight from the metadata cache's own inline-tag entries), not derived as a
 * `tags - frontmatterTags` difference — a tag present in *both* frontmatter and body still keeps
 * the note tagged even after a frontmatter-only rewrite, so it's rejected here too. Round 4: a tag
 * the new type's own recipe also requires is excluded from this check, mirroring
 * `computeTagsWrites`'s round 3 fix for the same reason — nothing distinguishes old from new for
 * a shared tag, so it's never actually removed, and rejecting a retype over a value that was never
 * going to be touched only blocks a legitimate change. Exported: plan-convert.ts's retype half
 * needs the same I4 guarantee. */
export function bodyOnlyTagReason(inputs: BodyOnlyTagInputs): string | null {
  const { snapshot, node, nNote, oldMatch, newType } = inputs;
  if (nNote === undefined) {
    return null;
  }
  const bodyTagsLower = new Set(nNote.bodyTags.map((tag) => tag.toLowerCase()));
  const newLower = new Set(newType.match.tags.map((tag) => tag.toLowerCase()));
  for (const tag of oldMatch.tags) {
    if (newLower.has(tag.toLowerCase())) {
      continue;
    }
    if (bodyTagsLower.has(tag.toLowerCase())) {
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
  const nWrites = [
    ...literalRetypeWrites(nNote, oldMatch, newType),
    ...buildNOwnWrites(ctx, oldCtx, validation.fields, action),
  ];
  recordAllOverrides(ctx, action.node, nWrites);

  const childRewrite = retypedChildWrites(schema, ctx, nNode, action);
  const subtreeWrites = deriveSubtreeWrites(ctx, oldCtx, action.node);
  const mergedDescendantWrites = mergeWritesByPath(childRewrite.entries, subtreeWrites);
  const changes =
    nWrites.length > 0
      ? [{ path: action.node, writes: nWrites }, ...mergedDescendantWrites]
      : mergedDescendantWrites;

  const moves = folderTo !== null ? [{ from: action.node, to: folderTo }] : [];
  const focus = folderTo ?? action.node;
  const plan: Plan = {
    creations: [],
    changes,
    appends: childRewrite.appends,
    moves,
    bodyLinkRemovals: childRewrite.bodyLinkRemovals,
  };
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
