// Internal helpers shared by the move and retype planners (plan-move.ts / plan-retype.ts): the
// text-edge rejection message, small array/set comparisons, the edge-key write pair (the write
// itself plus the old-key cleanup), the generic `schema.inherit` recompute for a single node, and
// the "did some other node move too" verification check. Not part of the public planning API —
// planAction/childOptions (planner.ts), planMove/moveTargets (plan-move.ts), and
// planRetype/retypeOptions (plan-retype.ts) are. No Obsidian imports.

import {
  edgeKeyPatch,
  listShape,
  resultingTargets,
  unionInheritedTargets,
  type SubtreeContext,
} from './derive.js';
import type { KeyWrite } from './plan-types.js';
import type { EdgeRule, Schema } from './schema.js';
import { displayName, type Snapshot } from './snapshot.js';
import type { Structure } from './structure.js';

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
  readonly staleForNewKey: ReadonlySet<string>; // round 2 C1: {O} for a move (plus O's own contribution to k, round 3: only when k ∈ schema.inherit); ∅ when k is brand new to N (retype/child key change)
}

/** The edge-key write itself: a patch that removes only what `staleForNewKey` says the action
 * invalidates, and adds the new parent (see `derive.ts`'s `edgeKeyPatch`). `null` when nothing
 * actually changes. Shared by move (`staleForNewKey` = `{O} ∪ U_old(k)`) and retype/child
 * key-change writes (`staleForNewKey` = `∅`, since the key wasn't holding this relationship
 * before — nothing in it is stale, only the new parent needs adding). */
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
