// Fix-inherit planning: turns a `'fix-inherit'` `Action` into a verified `Plan` that rewrites one
// node's own `inherit`-key values to exactly what its property parents currently contribute, then
// cascades that same fix to the node's whole subtree — or a rejection with a stable, user-facing
// reason. Unlike move/retype's conservative "only touch what the action invalidates" cascade, this
// forces every value to match what `diagnostics.ts`'s `inherit-mismatch` check expects, by
// construction (same `unionInheritedTargets`/`inheritKeysFor` pair). No Obsidian imports.

import {
  bareContext,
  deriveSubtreeWrites,
  inheritKeysFor,
  listShape,
  propertyParentsOf,
  unionInheritedTargets,
  type SubtreeContext,
} from './derive.js';
import { collectDiagnostics } from './diagnostics.js';
import { recordAllOverrides } from './plan-shared.js';
import type { Action, KeyWrite, Plan, PlanResult } from './plan-types.js';
import type { Schema } from './schema.js';
import { applyPlan } from './simulate.js';
import { displayName, type Snapshot } from './snapshot.js';
import { buildStructure, type Structure, type StructureNode } from './structure.js';

type FixInheritAction = Extract<Action, { kind: 'fix-inherit' }>;

/** Every `schema.inherit`-key write `node` needs to exactly match what its (unchanged) property
 * parents currently contribute — full replace (`current` -> `expected`), not a delta from an old
 * vs. new state the way move/retype's cascade computes it (nothing here moved or retyped; the
 * whole point is correcting drift a delta would never touch). `[]` when `node` has no property
 * parent at all — mirrors `diagnostics.ts`'s `inheritMismatchDiagnostic` early return, so a
 * parentless node's own values are never treated as "wrong" here either. */
function ownInheritWrites(
  ctx: SubtreeContext,
  node: string,
  nNode: StructureNode,
  parents: readonly string[],
): readonly KeyWrite[] {
  if (parents.length === 0) {
    return [];
  }
  const current = ctx.snapshot.notes.get(node)?.propertyLinks ?? {};
  const writes: KeyWrite[] = [];
  for (const key of inheritKeysFor(ctx.schema, nNode)) {
    const expected = unionInheritedTargets(ctx, parents, key);
    const currentTargets = current[key] ?? [];
    const remove = currentTargets.filter((target) => !expected.includes(target));
    const add = expected.filter((target) => !currentTargets.includes(target));
    if (remove.length === 0 && add.length === 0) {
      continue;
    }
    writes.push({
      key,
      value: { kind: 'links', remove, add, list: listShape(ctx.snapshot, key, node) },
    });
  }
  return writes;
}

/** `true` when walking up from `path` (inclusive) via primary parents reaches `root` — bounds
 * verification to `root`'s own branch, the same "self or descendant" walk `plan-move.ts` uses for
 * its own validation. */
function isInBranch(structure: Structure, root: string, path: string): boolean {
  let current: string | null = path;
  while (current !== null) {
    if (current === root) {
      return true;
    }
    current = structure.nodes.get(current)?.parent ?? null;
  }
  return false;
}

/** `null` on success; otherwise a stable reason naming the first (in `structure.nodes` order)
 * still-mismatched node in `node`'s own branch — the action repairs one branch, not the whole
 * graph, so a mismatch outside it is never a reason to reject. */
function verifyFixInherit(
  schema: Schema,
  snapshot: Snapshot,
  plan: Plan,
  node: string,
): string | null {
  const after = applyPlan(snapshot, plan);
  const structure = buildStructure(schema, after);
  const diagnostics = collectDiagnostics(schema, after, structure);
  const stillMismatched = diagnostics.find(
    (diagnostic) =>
      diagnostic.kind === 'inherit-mismatch' && isInBranch(structure, node, diagnostic.node),
  );
  if (stillMismatched === undefined) {
    return null;
  }
  return `Fixing "${displayName(snapshot, node)}" would still leave "${displayName(snapshot, stillMismatched.node)}" out of sync`;
}

export function planFixInherit(
  schema: Schema,
  snapshot: Snapshot,
  action: FixInheritAction,
): PlanResult {
  const structure = buildStructure(schema, snapshot);
  const nNode = structure.nodes.get(action.node);
  if (nNode === undefined) {
    return { ok: false, reason: `"${displayName(snapshot, action.node)}" is not in the structure` };
  }
  const ctx: SubtreeContext = {
    schema,
    snapshot,
    structure,
    typeOverrides: new Map(),
    linkOverrides: new Map(),
  };
  const oldCtx = bareContext(ctx);
  const parents = propertyParentsOf(nNode);
  const nWrites = ownInheritWrites(ctx, action.node, nNode, parents);
  if (nWrites.length === 0) {
    return {
      ok: false,
      reason: `"${displayName(snapshot, action.node)}" already matches its parent`,
    };
  }
  recordAllOverrides(ctx, action.node, nWrites);
  const subtreeWrites = deriveSubtreeWrites(ctx, oldCtx, action.node);
  const changes = [{ path: action.node, writes: nWrites }, ...subtreeWrites];
  const plan: Plan = { creations: [], changes, appends: [], moves: [], bodyLinkRemovals: [] };
  const failure = verifyFixInherit(schema, snapshot, plan, action.node);
  if (failure !== null) {
    return { ok: false, reason: failure };
  }
  return { ok: true, plan, focus: action.node };
}
