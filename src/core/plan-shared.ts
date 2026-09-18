// Internal helpers shared by the move, convert, and fix-inherit planners (plan-move.ts /
// plan-convert.ts / plan-fix-inherit.ts / plan-retype.ts): the ancestor-walk used by every
// planner's "not into your own branch" check, the text-edge rejection message, small array/set
// comparisons, the edge-key write pair (the write itself plus the old-key cleanup) shared by
// move/convert's own-N edge handling, the append/removal pair for a text-kind edge, the generic
// `schema.inherit` recompute for a single node, and the "did some other node move too"
// verification check. Not part of the public planning API — planAction/childOptions
// (planner.ts), planMove/moveTargets (plan-move.ts), planConvert/convertOptions
// (plan-convert.ts), planFixInherit (plan-fix-inherit.ts), and planRetype/retypeOptions
// (plan-retype.ts) are. No Obsidian imports.

import {
  edgeKeyPatch,
  listShape,
  oldContribOf,
  resultingTargets,
  unionInheritedTargets,
  type SubtreeContext,
} from './derive.js';
import type { KeyWrite, Plan } from './plan-types.js';
import type { EdgeRule, Schema } from './schema.js';
import { displayName, type Snapshot } from './snapshot.js';
import type { Structure } from './structure.js';

/** `true` when walking up from `path` (inclusive) via primary parents reaches `ancestor` — i.e.
 * `path` is `ancestor` itself or one of its descendants. Shared by every planner that needs to
 * reject "into your own branch": plan-move.ts's `validateMove`, plan-convert.ts's
 * `checkConvertParent`, and plan-fix-inherit.ts's `verifyFixInherit` (there walking from a
 * diagnostic's node up to the branch root being fixed — same walk, different question). */
export function isSelfOrDescendant(structure: Structure, ancestor: string, path: string): boolean {
  let current: string | null = path;
  while (current !== null) {
    if (current === ancestor) {
      return true;
    }
    current = structure.nodes.get(current)?.parent ?? null;
  }
  return false;
}

/** The rejection reason for a required relationship that lives in note text (a `'links'` or
 * `'backlinks'` rule) and so can't be written automatically — `'backlinks'` names the parent
 * first (the text lives on the parent's side), `'links'` names the node first (the text lives on
 * the node's side). */
export function textLinkReason(
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

/** The append that establishes a text-kind (`'backlinks'`/`'links'`) edge to the *new* parent:
 * `'backlinks'` writes to the parent's own body (the parent mentions the child), `'links'` writes
 * to the node's own body (the child mentions the parent) — mirrors `textLinkReason`'s ordering.
 * Keyed off the *new* rule's own kind — see `textEdgeRemoval` for the old-side counterpart, which
 * must be keyed off the *old* edge's kind instead, since the two can differ. Only
 * `textEdgeAppendIfNeeded` calls this directly — every planner (a node's own edge, or
 * `plan-retype.ts`'s direct-child edge rewrite) goes through that instead, so the "already linked"
 * guard can never be forgotten on one path and not the other. */
function textEdgeAppend(
  kind: 'links' | 'backlinks',
  node: string,
  newParent: string,
): Plan['appends'][number] {
  return kind === 'backlinks'
    ? { path: newParent, target: node }
    : { path: node, target: newParent };
}

/** The removal that clears a text-kind (`'backlinks'`/`'links'`) edge from the *old* parent, same
 * per-kind sidedness as `textEdgeAppend`. Callers must key this off the *old* edge's own kind, not
 * the new rule's — a node's possible parent types can mix property and text-kind rules, so a move
 * can freely cross from one kind to the other; conflating the two here would either remove nothing
 * (old edge was actually `'property'`) or target a mention that was never written (old edge was
 * the other text kind). Exported for the same reason as `textEdgeAppend` — `plan-retype.ts`'s
 * direct-child edge rewrite needs the identical sidedness rule over a child/parent pair. */
export function textEdgeRemoval(
  kind: 'links' | 'backlinks',
  node: string,
  oldParent: string,
): Plan['bodyLinkRemovals'][number] {
  return kind === 'backlinks'
    ? { path: oldParent, target: node }
    : { path: node, target: oldParent };
}

export function recordOverride(
  ctx: SubtreeContext,
  path: string,
  key: string,
  targets: readonly string[],
): void {
  const existing = ctx.linkOverrides.get(path) ?? {};
  ctx.linkOverrides.set(path, { ...existing, [key]: targets });
}

/** Records every `'links'`-kind write in `writes` into `ctx.linkOverrides` for `path`, so a later
 * step in the same walk (a descendant's inherit recompute, a sibling's own edge write) sees the
 * new values instead of the stale snapshot ones. Literal/list-item writes carry no link targets
 * and are skipped. */
export function recordAllOverrides(
  ctx: SubtreeContext,
  path: string,
  writes: readonly KeyWrite[],
): void {
  const current = ctx.snapshot.notes.get(path)?.propertyLinks ?? {};
  for (const write of writes) {
    if (write.value !== null && write.value.kind === 'links') {
      const targets = resultingTargets(
        current[write.key] ?? [],
        write.value.remove,
        write.value.add,
      );
      recordOverride(ctx, path, write.key, targets);
    }
  }
}

export interface EdgeWriteInputs {
  readonly snapshot: Snapshot;
  readonly node: string;
  readonly oldParent: string | null; // O — used only for the old-key cleanup (I3)
  readonly newParent: string; // P
  readonly oldEdge: EdgeRule | null; // E
  readonly key: string; // k = rule.property
  readonly staleForNewKey: ReadonlySet<string>; // round 2 C1: {O} for a move (plus O's own contribution to k, round 3: only when k ∈ schema.inherit, round 4: and only when O's old edge to N wasn't through k itself); ∅ when k is brand new to N (retype/child key change)
}

/** The edge-key write itself: a patch that removes only what `staleForNewKey` says the action
 * invalidates, and adds the new parent (see `derive.ts`'s `edgeKeyPatch`). `null` when nothing
 * actually changes. Shared by move (`staleForNewKey` = `{O}`, plus `U_old(k)` only when k is a
 * `schema.inherit` key *and* O's old edge to N wasn't through k itself — see `EdgeWriteInputs`)
 * and retype/child key-change writes (`staleForNewKey` = `∅`, since the key wasn't holding this
 * relationship before — nothing in it is stale, only the new parent needs adding). */
function computeEdgeWrite(inputs: EdgeWriteInputs, cur: readonly string[]): KeyWrite | null {
  const { remove, add } = edgeKeyPatch(cur, inputs.staleForNewKey, inputs.newParent);
  if (remove.length === 0 && add.length === 0) {
    return null;
  }
  return {
    key: inputs.key,
    value: {
      kind: 'links',
      remove,
      add,
      list: listShape(inputs.snapshot, inputs.key, inputs.node),
    },
  };
}

/** Drops the old parent from its old edge property, when that property differs from the new edge
 * key and isn't itself a `schema.inherit` key (in which case the generic inherit recompute owns
 * it instead). `null` when there's nothing to clean up. */
export function computeOldEdgeCleanup(
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
  if (!cur2.includes(inputs.oldParent)) {
    return null;
  }
  return {
    key: oldKey,
    value: {
      kind: 'links',
      remove: [inputs.oldParent],
      add: [],
      list: listShape(inputs.snapshot, oldKey, inputs.node),
    },
  };
}

function isLinksWrite(write: KeyWrite | null): write is KeyWrite {
  return write !== null;
}

/** The node's own edge-key write plus, when applicable, the write that drops the old parent from
 * its old property — the two writes move and retype's own-N edge handling both produce. */
export function buildEdgeWrites(schema: Schema, inputs: EdgeWriteInputs): readonly KeyWrite[] {
  const nLinks = inputs.snapshot.notes.get(inputs.node)?.propertyLinks ?? {};
  const cur = nLinks[inputs.key] ?? [];
  return [computeEdgeWrite(inputs, cur), computeOldEdgeCleanup(schema, inputs, nLinks)].filter(
    isLinksWrite,
  );
}

export interface RuleEdgeInputs {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly node: string;
  readonly newParent: string;
  readonly rule: EdgeRule;
  readonly oldParent: string | null; // O — used only for the old-key cleanup (I3)
  readonly oldEdge: EdgeRule | null; // E
}

/** N's own edge-key write for a `'property'`-kind *new* rule — mirrors `buildEdgeWrites`, over a
 * `rule` rather than a bare `key`. A text-kind new rule (`'backlinks'`/`'links'`) has no
 * frontmatter property to patch here at all; see `oldEdgeCleanupOnly` for that case's old-parent
 * cleanup instead. Shared by move (`planMove`) and convert (`planConvert`)'s own-N edge handling
 * — both need the exact same stale set for the exact same reason, so a fix to one can't silently
 * miss the other.
 *
 * Round 2 C1: the edge key's stale set is the old parent itself plus whatever it used to
 * contribute to this specific key (`U_old(k)`, just the *single* old parent — not the node's
 * other old property parents, which never contributed to `k` in a way this action invalidates).
 * Round 3 fix: `oldContribOf` only ever falls back to O's *own* raw values for `k` when nothing
 * else claims it — that fallback is the `inherit`-cascade mechanism, so it only applies when `k`
 * is actually a `schema.inherit` key. For a plain (non-inherited) edge property, O's own values
 * for that same property name are unrelated data that happens to share a name, not something O
 * ever contributed to N — including them here deleted a value N held for its own reasons (e.g.
 * O and N both happening to link the same third note through a same-named, non-inherited key).
 * Round 4 fix: that fallback also has to be skipped when `k` *is* N's old edge property itself
 * (`oldEdge.property === k`) — the "copy O's own raw value for k" branch exists only to model
 * chain-forwarding through a *different* property than the edge (mirrors `plan-create.ts`'s
 * `addInheritWrites`, which skips this exact copy when `key === rule.property`, and `derive.ts`'s
 * `inheritKeysFor`, which excludes a node's own edge property from the generic recompute). When
 * O was N's old parent through k directly (typically an untyped host or root, whose own type
 * never claims k as an edge property), N's own values under k are N's, not something O
 * contributed — folding O's raw value in here silently deleted it. */
export function propertyEdgeWrites(
  ctx: SubtreeContext,
  inputs: RuleEdgeInputs,
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

/** The old parent's frontmatter cleanup alone, for an action whose *new* rule isn't
 * `'property'`-kind — there's no new-key write to bundle it with (`propertyEdgeWrites`, used when
 * the new rule *is* `'property'`, produces both together via `buildEdgeWrites`). A no-op unless
 * the *old* edge was itself `'property'`-kind (`computeOldEdgeCleanup` returns `null` otherwise)
 * — delegates to it directly. Shared by move and convert, same reason as `propertyEdgeWrites`. */
export function oldEdgeCleanupOnly(schema: Schema, inputs: RuleEdgeInputs): readonly KeyWrite[] {
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

export interface TextEdgeChangeInputs {
  readonly snapshot: Snapshot;
  readonly rule: EdgeRule;
  readonly node: string;
  readonly newParent: string;
  readonly oldParent: string | null;
  readonly oldEdge: EdgeRule | null;
}

/** Whether some frontmatter property on `path` — any key, not just the edge's own — already
 * resolves a link to `target`. A note's `links` (`resolvedLinks`-derived, see
 * `snapshot-reader.ts`'s `readNote`) can't tell that apart from a genuine body mention, so when
 * this is true `target` would stay in `links` regardless of what note text does or doesn't say —
 * matches `simulate.ts`'s own `applyBodyLinkRemovals`, which treats the same condition as a
 * no-op. Exported: `plan-retype.ts`'s direct-child edge rewrite needs the identical no-op guard
 * for a child's stale text mention. */
export function targetStillHeldByProperty(
  snapshot: Snapshot,
  path: string,
  target: string,
): boolean {
  const propertyLinks = snapshot.notes.get(path)?.propertyLinks ?? {};
  return Object.values(propertyLinks).flat().includes(target);
}

/** Whether `path`'s resolved `links` already include `target` — true whenever *any* existing
 * property or body mention already makes the link resolve, since `links` (`resolvedLinks`-derived)
 * can't tell the two apart (same source of truth `targetStillHeldByProperty` reads, viewed from
 * the append side rather than the removal side). A `file.backlinks`/`file.links` edge is resolved
 * from `links` alone (see `structure.ts`'s candidate collection), so once `target` is already
 * there the edge already exists — appending a second body line for it would be a redundant write,
 * not a new relationship.
 *
 * `excludeKey`, when given, ignores whatever *that one property alone* contributes: the property a
 * child-edge rewrite is clearing in this same transition (see `textEdgeAppendIfNeeded`'s
 * `staleProperty`). Without it, a property → `file.links` rewrite would see its own about-to-vanish
 * property as "already linked" and skip the append that's the relationship's only remaining home —
 * the link would simply disappear once the property write lands. Only *other* properties count as
 * proof the link survives; a genuine independent body mention that happens to be the property's
 * only competing source can't be told apart from "nothing else holds it" from this data alone, so
 * (mirroring `targetStillHeldByProperty`'s own "only trust property evidence" rule on the removal
 * side) this favors still writing the append over silently dropping the relationship. Only
 * `textEdgeAppendIfNeeded` calls this directly. */
function alreadyLinked(
  snapshot: Snapshot,
  path: string,
  target: string,
  excludeKey: string | null = null,
): boolean {
  const note = snapshot.notes.get(path);
  if (note?.links.includes(target) !== true) {
    return false;
  }
  if (excludeKey === null) {
    return true;
  }
  return Object.entries(note.propertyLinks).some(
    ([key, targets]) => key !== excludeKey && targets.includes(target),
  );
}

export interface TextEdgeAppendInputs {
  readonly snapshot: Snapshot;
  readonly rule: EdgeRule; // the *new* rule
  readonly node: string;
  readonly newParent: string;
  /** The property this same transition is about to clear, when the old edge was itself
   * `'property'`-kind pointing at `newParent` — excluded from the "already linked" check (see
   * `alreadyLinked`'s own `excludeKey`). `null` for a node's own edge during a move/convert, where
   * the old and new parents are always different notes, so no property being cleared could ever
   * be the thing making the *new* target look already-linked. */
  readonly staleProperty: string | null;
}

/** The append that establishes a text-kind (`'backlinks'`/`'links'`) edge from `node` to
 * `newParent` — keyed off the *new* rule's own kind: `'backlinks'` writes to the new parent's own
 * body (the parent mentions the child), `'links'` writes to the node's own body (the child mentions
 * the parent) — mirrors `textLinkReason`'s ordering. `[]` when the new rule isn't text-kind, or
 * `alreadyLinked` (with `staleProperty` excluded) says the target already resolves — appending a
 * second mention for a link that already exists would be a redundant write, not a new relationship.
 * Single source of truth for both `buildTextEdgeChanges` (a node's own edge, move/convert) and
 * `plan-retype.ts`'s direct-child edge rewrite (`childTextChanges`), so the two guards can't drift
 * apart the way they once did. */
export function textEdgeAppendIfNeeded(inputs: TextEdgeAppendInputs): Plan['appends'] {
  const { snapshot, rule, node, newParent, staleProperty } = inputs;
  if (rule.kind === 'property') {
    return [];
  }
  const append = textEdgeAppend(rule.kind, node, newParent);
  return alreadyLinked(snapshot, append.path, append.target, staleProperty) ? [] : [append];
}

/** The append/removal pair establishing and clearing a text-kind (`'backlinks'`/`'links'`) edge
 * to `node`'s new parent — shared by move (`planMove`) and convert (`planConvert`)'s own-N edge
 * handling. The append is `textEdgeAppendIfNeeded`'s (`staleProperty: null` — the old and new
 * parents are always different notes here, so there's never a property to exclude). The removal is
 * keyed off the *old* edge's own kind instead, since the two can differ — a node's possible parent
 * types can mix property and text-kind rules, so an action can freely cross from one kind to the
 * other; conflating the two would either remove nothing (old edge was actually `'property'`) or
 * target a mention that was never written (old edge was the other text kind). Omitted entirely
 * when there was no old parent, the old edge was itself `'property'`-kind (nothing in note text to
 * clear), or `targetStillHeldByProperty` says the link would survive anyway — a plan never carries
 * a removal the simulator would itself no-op, so the real applier is never asked to go hunting a
 * body mention that may not exist. */
export function buildTextEdgeChanges(
  inputs: TextEdgeChangeInputs,
): Pick<Plan, 'appends' | 'bodyLinkRemovals'> {
  const { snapshot, rule, node, newParent, oldParent, oldEdge } = inputs;
  const appends = textEdgeAppendIfNeeded({ snapshot, rule, node, newParent, staleProperty: null });
  const removal =
    oldParent !== null && oldEdge !== null && oldEdge.kind !== 'property'
      ? textEdgeRemoval(oldEdge.kind, node, oldParent)
      : null;
  const bodyLinkRemovals: Plan['bodyLinkRemovals'] =
    removal !== null && !targetStillHeldByProperty(snapshot, removal.path, removal.target)
      ? [removal]
      : [];
  return { appends, bodyLinkRemovals };
}

export interface InheritWriteInputs {
  readonly node: string;
  readonly excludeKey: string; // the node's own, just-written edge property
  readonly oldPropertyParents: readonly string[]; // evaluated through oldCtx — no overrides, pre-action state
  readonly newPropertyParents: readonly string[]; // evaluated through the live ctx
}

/** Every `schema.inherit` key except `inputs.excludeKey`, given the node's property parents before
 * and after the action. Round 2 C1 rule: `remove = (U_old(q) − U_new(q)) ∩ current` — a value the
 * user added that no old parent contributed (an "also in" link, a value from an untracked source)
 * is in neither `U_old` nor `U_new`'s removal side, so it's never touched. Round 3:
 * `add = (U_new(q) − U_old(q)) − current` — only a target the action *newly* contributes is added;
 * one a property parent could already have contributed before the action, but `current` never
 * happened to reflect, is left alone (a move fixes only what it changes, not pre-existing drift).
 * Mutates `ctx.linkOverrides` for `node` as writes are found — mirrors `deriveSubtreeWrites`'s
 * per-descendant recompute, applied to the node itself with caller-supplied parent lists instead
 * of the structure's own `parent`/`extras`. */
export function inheritWritesFor(
  ctx: SubtreeContext,
  oldCtx: SubtreeContext,
  inputs: InheritWriteInputs,
): readonly KeyWrite[] {
  const { node, excludeKey, oldPropertyParents, newPropertyParents } = inputs;
  const writes: KeyWrite[] = [];
  const nLinks = ctx.snapshot.notes.get(node)?.propertyLinks ?? {};
  for (const key of ctx.schema.inherit) {
    if (key === excludeKey) {
      continue;
    }
    const uOld = unionInheritedTargets(oldCtx, oldPropertyParents, key);
    const uNew = unionInheritedTargets(ctx, newPropertyParents, key);
    const current = nLinks[key] ?? [];
    const staleSet = new Set(uOld.filter((target) => !uNew.includes(target)));
    const remove = current.filter((target) => staleSet.has(target));
    // Round 3: only a target the action *newly* contributes (in U_new but not already in U_old) is
    // added — see derive.ts's `writesForDescendant` for the full rationale (this is the same rule,
    // applied to the moved/retyped node's own inherit-key recompute rather than a descendant's).
    const add = uNew.filter((target) => !uOld.includes(target) && !current.includes(target));
    if (remove.length === 0 && add.length === 0) {
      continue;
    }
    writes.push({
      key,
      value: { kind: 'links', remove, add, list: listShape(ctx.snapshot, key, node) },
    });
    recordOverride(ctx, node, key, resultingTargets(current, remove, add));
  }
  return writes;
}

/** The first node (other than `node`, in `before.nodes`' iteration order) whose parent differs
 * between `before` and `after` — mapping `node`'s own old path to `focus` when checking what an
 * original child of `node` should now point at, so a node whose parent used to be `node` isn't
 * flagged just because `node` itself was renamed. Pass `focus: node` for an action that never
 * renames the node (move never does; retype only does when a folder move applies). */
export function firstChangedOtherNode(
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
