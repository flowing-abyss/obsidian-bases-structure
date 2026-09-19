// Fix-inherit planning: turns a `'fix-inherit'` `Action` into a verified `Plan` that rewrites just
// the `inherit`-key values `diagnostics.ts` flags as mismatched for one node, bringing each flagged
// key to what its property parents currently contribute, then cascades that same fix to the node's
// whole subtree — or a rejection with a stable, user-facing reason. A key the diagnostic doesn't
// flag (e.g. a value legally narrowed to a non-empty subset of a parent's values) is left exactly
// as the user set it; a foreign membership within a flagged key survives too. No Obsidian imports.

import {
  bareContext,
  deriveSubtreeWrites,
  isForeignMembership,
  listShape,
  propertyParentsOf,
  typeNameAfter,
  unionInheritedTargets,
  type SubtreeContext,
} from './derive.js';
import { collectDiagnostics, inheritMismatchKeys } from './diagnostics.js';
import { isSelfOrDescendant, recordAllOverrides } from './plan-shared.js';
import type { Action, KeyWrite, Plan, PlanResult } from './plan-types.js';
import type { Schema } from './schema.js';
import { applyPlan } from './simulate.js';
import { displayName, type Snapshot } from './snapshot.js';
import { buildStructure } from './structure.js';

type FixInheritAction = Extract<Action, { kind: 'fix-inherit' }>;

/** Every write needed to bring `node`'s diagnostic-flagged `inherit` keys (`inheritMismatchKeys` —
 * the same predicate `collectDiagnostics` reports, so this can never rewrite a key the diagnostic
 * didn't complain about) to exactly what its property parents currently contribute. `[]` when
 * nothing is flagged — a legally narrowed key (a non-empty subset of a parent's values) is left
 * exactly as the user set it. A value that isn't `expected` is still kept when it's a foreign
 * membership (`isForeignMembership`) — `node`'s own membership in a structure this view can't see,
 * which this repair must never erase; every missing parent value is still added regardless. */
function ownInheritWrites(
  ctx: SubtreeContext,
  node: string,
  parents: readonly string[],
): readonly KeyWrite[] {
  const flaggedKeys = inheritMismatchKeys(ctx.schema, ctx.snapshot, ctx.structure, node);
  if (flaggedKeys.length === 0) {
    return [];
  }
  const current = ctx.snapshot.notes.get(node)?.propertyLinks ?? {};
  const nodeType = typeNameAfter(ctx, node);
  const writes: KeyWrite[] = [];
  for (const key of flaggedKeys) {
    const expected = unionInheritedTargets(ctx, parents, key);
    const currentTargets = current[key] ?? [];
    const remove = currentTargets.filter(
      (target) => !expected.includes(target) && !isForeignMembership(ctx, nodeType, key, target),
    );
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
      diagnostic.kind === 'inherit-mismatch' &&
      isSelfOrDescendant(structure, node, diagnostic.node),
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
  const nWrites = ownInheritWrites(ctx, action.node, parents);
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
