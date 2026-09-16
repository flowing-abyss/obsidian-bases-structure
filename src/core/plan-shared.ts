// Internal helpers shared by the move and retype planners (plan-move.ts / plan-retype.ts): the
// text-edge rejection message, small array/set comparisons, the edge-key write pair (the write
// itself plus the old-key cleanup), the generic `schema.inherit` recompute for a single node, and
// the "did some other node move too" verification check. Not part of the public planning API —
// planAction/childOptions (planner.ts), planMove/moveTargets (plan-move.ts), and
// planRetype/retypeOptions (plan-retype.ts) are. No Obsidian imports.

import { edgeTargets, listShape, unionInheritedTargets, type SubtreeContext } from './derive.js';
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

/** The full resolved target list a `'links'` patch leaves a key holding: `current` minus `remove`,
 * plus any `add` target it didn't already have. */
export function resultingTargets(
  current: readonly string[],
  remove: readonly string[],
  add: readonly string[],
): readonly string[] {
  const removeSet = new Set(remove);
  const kept: string[] = [];
  let insertIndex: number | null = null;
  for (const target of current) {
    if (removeSet.has(target)) {
      insertIndex ??= kept.length;
      continue;
    }
    kept.push(target);
  }
  const toInsert = add.filter((target) => !kept.includes(target));
  kept.splice(insertIndex ?? kept.length, 0, ...toInsert);
  return kept;
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
  readonly oldParent: string | null; // O
  readonly newParent: string; // P
  readonly oldEdge: EdgeRule | null; // E
  readonly key: string; // k = rule.property
  readonly keep: ReadonlySet<string>; // the node's genuine property-kind extras
}

/** The edge-key write itself: a patch that removes everything except the new parent and genuine
 * extras from the current value, and adds the new parent (see `derive.ts`'s `edgeTargets`). `null`
 * when nothing actually changes. Shared by move (`oldParent`/`newParent` differ) and retype's
 * own-N edge handling (`oldParent === newParent`, since retype never reparents N). */
function computeEdgeWrite(inputs: EdgeWriteInputs, cur: readonly string[]): KeyWrite | null {
  const { remove, add } = edgeTargets(cur, inputs.newParent, inputs.keep);
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

/** Every `schema.inherit` key except `excludeKey` (the node's own, just-written edge property),
 * given the property parents `propertyParents`. Mutates `ctx.linkOverrides` for `node` as writes
 * are found — mirrors `deriveSubtreeWrites`'s per-descendant recompute, applied to the node itself
 * with a caller-supplied parent list instead of the structure's own `parent`/`extras`. */
export function inheritWritesFor(
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
    const remove = current.filter((target) => !desired.includes(target));
    const add = desired.filter((target) => !current.includes(target));
    if (remove.length === 0 && add.length === 0) {
      continue;
    }
    writes.push({
      key,
      value: { kind: 'links', remove, add, list: listShape(ctx.snapshot, key, node) },
    });
    recordOverride(ctx, node, key, desired);
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
