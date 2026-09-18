// Builds the `Structure` tree from a `Schema` and a `Snapshot`: the node set (incl. the host's
// root qualification), primary parents with cycle breaking, and the derived extras/twoWay/alsoIn
// annotations. No Obsidian imports.

import type { Candidate, CandidateSet, ExternalLink } from './candidates.js';
import { collectCandidates } from './candidates.js';
import type { EdgeKind, EdgeRule, Schema, TypeDef } from './schema.js';
import type { Snapshot } from './snapshot.js';
import { resolveType, type TypeResolution } from './typing.js';

export interface ExtraLink {
  readonly parent: string;
  readonly kind: EdgeKind;
}

export interface StructureNode {
  readonly path: string;
  readonly type: string | null;
  readonly parent: string | null;
  readonly edge: EdgeRule | null;
  readonly children: readonly string[];
  readonly extras: readonly ExtraLink[];
  readonly alsoIn: readonly string[];
  readonly twoWay: boolean;
}

export interface StructureIssue {
  readonly path: string | null;
  readonly message: string;
}

export interface Structure {
  readonly root: string | null;
  readonly tops: readonly string[];
  readonly orphans: readonly string[];
  readonly nodes: ReadonlyMap<string, StructureNode>;
  readonly issues: readonly StructureIssue[];
}

/** Every path with a resolved node type, plus the host (which may resolve to `null`). Built
 * before candidate collection so `collectCandidates` knows the full set of potential nodes. */
interface NodeSetResult {
  readonly nodeTypes: Map<string, TypeDef | null>;
  readonly issues: StructureIssue[];
  readonly hostAlreadyNode: boolean;
}

interface Env {
  readonly snapshot: Snapshot;
  readonly resultIndex: ReadonlyMap<string, number>;
}

interface PrimaryInfo {
  readonly parent: Map<string, string | null>;
  readonly edge: Map<string, EdgeRule | null>;
}

interface GraphCtx {
  readonly finalNodeTypes: ReadonlyMap<string, TypeDef | null>;
  readonly candidates: CandidateSet;
  readonly primary: PrimaryInfo;
}

interface DerivedResult {
  readonly extras: Map<string, ExtraLink[]>;
  readonly twoWay: Set<string>;
  readonly alsoIn: Map<string, readonly string[]>;
}

interface NodeExtrasInfo {
  readonly path: string;
  readonly ancestors: ReadonlySet<string>;
}

interface BuildCtx {
  readonly graph: GraphCtx;
  readonly derived: DerivedResult;
  readonly childrenIndex: ReadonlyMap<string, readonly string[]>;
}

function pushConflictIssue(issues: StructureIssue[], path: string, resolved: TypeResolution): void {
  if (resolved.conflict.length >= 2) {
    issues.push({ path, message: `Matches several types: ${resolved.conflict.join(', ')}` });
  }
}

function addHostIfPresent(
  schema: Schema,
  snapshot: Snapshot,
  nodeTypes: Map<string, TypeDef | null>,
  issues: StructureIssue[],
): void {
  const hostPath = snapshot.host;
  if (hostPath === null || nodeTypes.has(hostPath)) {
    return;
  }
  const hostNote = snapshot.notes.get(hostPath);
  if (hostNote === undefined) {
    return;
  }
  const resolved = resolveType(schema, hostNote);
  nodeTypes.set(hostPath, resolved.type);
  if (resolved.type !== null) {
    pushConflictIssue(issues, hostPath, resolved);
  }
}

function buildPotentialNodes(schema: Schema, snapshot: Snapshot): NodeSetResult {
  const issues: StructureIssue[] = [];
  const nodeTypes = new Map<string, TypeDef | null>();
  for (const path of snapshot.results) {
    const note = snapshot.notes.get(path);
    if (note === undefined) {
      continue;
    }
    const resolved = resolveType(schema, note);
    if (resolved.type === null) {
      continue;
    }
    nodeTypes.set(path, resolved.type);
    pushConflictIssue(issues, path, resolved);
  }
  const hostAlreadyNode = snapshot.host !== null && nodeTypes.has(snapshot.host);
  addHostIfPresent(schema, snapshot, nodeTypes, issues);
  return { nodeTypes, issues, hostAlreadyNode };
}

function hasIncomingCandidate(candidates: CandidateSet, target: string): boolean {
  for (const [child, list] of candidates.byChild) {
    if (child === target) {
      continue;
    }
    if (list.some((candidate) => candidate.parent === target)) {
      return true;
    }
  }
  return false;
}

/** Decides whether the host becomes the root, and — when it doesn't qualify and wasn't already a
 * normal node (i.e. present in results with a non-null type) — drops it from the node set. */
function determineRoot(
  nodeSet: NodeSetResult,
  snapshot: Snapshot,
  candidates: CandidateSet,
): { root: string | null; finalNodeTypes: Map<string, TypeDef | null> } {
  const finalNodeTypes = new Map(nodeSet.nodeTypes);
  const hostPath = snapshot.host;
  if (hostPath === null || !nodeSet.nodeTypes.has(hostPath)) {
    return { root: null, finalNodeTypes };
  }
  const hostType = nodeSet.nodeTypes.get(hostPath) ?? null;
  const qualifies =
    (hostType !== null && hostType.specificity > 0) || hasIncomingCandidate(candidates, hostPath);
  if (qualifies) {
    return { root: hostPath, finalNodeTypes };
  }
  if (!nodeSet.hostAlreadyNode) {
    finalNodeTypes.delete(hostPath);
  }
  return { root: null, finalNodeTypes };
}

function makeEnv(snapshot: Snapshot): Env {
  const resultIndex = new Map<string, number>();
  snapshot.results.forEach((path, index) => resultIndex.set(path, index));
  return { snapshot, resultIndex };
}

function orderOf(env: Env, path: string): number {
  if (path === env.snapshot.host) {
    return -1;
  }
  return env.resultIndex.get(path) ?? Number.MAX_SAFE_INTEGER;
}

function orderNodes(
  env: Env,
  finalNodeTypes: ReadonlyMap<string, TypeDef | null>,
): readonly string[] {
  return Array.from(finalNodeTypes.keys()).sort((a, b) => orderOf(env, a) - orderOf(env, b));
}

/** The root never gets a primary parent — it's the top of the tree by construction, regardless
 * of what its own candidate list contains. Those candidates aren't discarded: with the root's
 * primary forced to `null`, they flow through the normal extras rules in `processNode` (no
 * ancestors to suppress against, so they surface as extras on the root itself). */
function computeInitialPrimary(
  finalNodeTypes: ReadonlyMap<string, TypeDef | null>,
  candidates: CandidateSet,
  root: string | null,
): PrimaryInfo {
  const parent = new Map<string, string | null>();
  const edge = new Map<string, EdgeRule | null>();
  for (const path of finalNodeTypes.keys()) {
    if (path === root) {
      parent.set(path, null);
      edge.set(path, null);
      continue;
    }
    const list = candidates.byChild.get(path) ?? [];
    const best = list.find((candidate) => finalNodeTypes.has(candidate.parent));
    parent.set(path, best?.parent ?? null);
    edge.set(path, best?.rule ?? null);
  }
  return { parent, edge };
}

function buildChildrenIndex(
  orderedNodes: readonly string[],
  parent: ReadonlyMap<string, string | null>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const path of orderedNodes) {
    const p = parent.get(path) ?? null;
    if (p === null) {
      continue;
    }
    const list = map.get(p);
    if (list === undefined) {
      map.set(p, [path]);
    } else {
      list.push(path);
    }
  }
  return map;
}

/** Everything `breakCyclesOnePass` shares across every `start` in the outer loop: the candidate
 * child counts used to pick a cycle's `top` (computed once — it never changes as cycles are
 * broken, same as before), the visited/done state (now persistent — see the doc comment below),
 * and the children index (now updated incrementally instead of rebuilt). Bundled into one object
 * so the walk/resolve helpers stay within the project's `max-params` budget. */
interface BreakState {
  readonly childCounts: ReadonlyMap<string, number>;
  readonly childrenIndex: Map<string, string[]>;
  readonly visited: Map<string, 'visiting' | 'done'>;
}

/** Nodes reachable from `top` by following "children" edges (the reverse of the primary parent
 * pointer) — includes `top` itself and, since `top` sits on a cycle, every cycle member. Reads
 * `childrenIndex` as it currently stands (maintained incrementally by `updateChildrenIndex` as
 * cycles are broken, rather than rebuilt from scratch here — see `breakCycles`'s doc comment for
 * why a full rebuild per cycle used to make this quadratic). Relies on `Set` iteration visiting
 * entries added during iteration. */
function computeSubtree(
  top: string,
  childrenIndex: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const visited = new Set<string>([top]);
  for (const current of visited) {
    const kids = childrenIndex.get(current) ?? [];
    for (const kid of kids) {
      visited.add(kid);
    }
  }
  return visited;
}

/** Keeps `childrenIndex` in sync with a single parent-pointer change (`node`'s primary parent
 * moving from `oldParent` to `newParent`) — the incremental counterpart to `buildChildrenIndex`,
 * which would otherwise have to re-scan every node again after each cycle broken in `breakCycles`. */
function updateChildrenIndex(
  childrenIndex: Map<string, string[]>,
  node: string,
  oldParent: string | null,
  newParent: string | null,
): void {
  if (oldParent !== null) {
    const list = childrenIndex.get(oldParent);
    if (list !== undefined) {
      const index = list.indexOf(node);
      if (index !== -1) {
        list.splice(index, 1);
      }
    }
  }
  if (newParent !== null) {
    const list = childrenIndex.get(newParent);
    if (list === undefined) {
      childrenIndex.set(newParent, [node]);
    } else {
      list.push(node);
    }
  }
}

function buildCandidateChildCounts(
  finalNodeTypes: ReadonlyMap<string, TypeDef | null>,
  candidates: CandidateSet,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [child, list] of candidates.byChild) {
    if (!finalNodeTypes.has(child)) {
      continue;
    }
    const parents = new Set(list.map((c) => c.parent).filter((p) => finalNodeTypes.has(p)));
    for (const p of parents) {
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  return counts;
}

function isBetterTop(
  env: Env,
  childCounts: ReadonlyMap<string, number>,
  candidate: string,
  best: string,
): boolean {
  const candidateCount = childCounts.get(candidate) ?? 0;
  const bestCount = childCounts.get(best) ?? 0;
  if (candidateCount !== bestCount) {
    return candidateCount > bestCount;
  }
  return orderOf(env, candidate) < orderOf(env, best);
}

function pickTop(
  env: Env,
  childCounts: ReadonlyMap<string, number>,
  cycle: readonly string[],
): string {
  return cycle.reduce((best, candidate) =>
    isBetterTop(env, childCounts, candidate, best) ? candidate : best,
  );
}

/** Breaks one cycle by redirecting `top`'s (one of the cycle's own members, chosen by `pickTop`)
 * primary parent to the best candidate that isn't in `top`'s own subtree — same rule as before.
 * `top`'s new parent (or its absence) is guaranteed to fall outside `subtree`, which itself always
 * contains the *entire* walk that led to this cycle (every tail node feeding into it, plus every
 * other cycle member — see `breakCyclesOnePass`'s doc comment) — so nothing in that walk can ever
 * be rediscovered as part of a cycle again, however `top`'s new chain continues from here. */
function resolveCycle(
  env: Env,
  graph: GraphCtx,
  state: BreakState,
  cycle: readonly string[],
): void {
  const top = pickTop(env, state.childCounts, cycle);
  const subtree = computeSubtree(top, state.childrenIndex);
  const list = graph.candidates.byChild.get(top) ?? [];
  const next = list.find(
    (candidate) => graph.finalNodeTypes.has(candidate.parent) && !subtree.has(candidate.parent),
  );
  const oldParent = graph.primary.parent.get(top) ?? null;
  const newParent = next?.parent ?? null;
  graph.primary.parent.set(top, newParent);
  graph.primary.edge.set(top, next?.rule ?? null);
  updateChildrenIndex(state.childrenIndex, top, oldParent, newParent);
}

/** Walks the parent chain from `start`, marking each node 'visiting' as it goes, same as before —
 * but `state.visited` now persists across every `start` in the outer loop (`breakCyclesOnePass`)
 * instead of being rebuilt fresh after every single cycle broken. This is safe because breaking a
 * cycle only ever changes `top`'s own parent pointer, and `top`'s new parent is always chosen from
 * outside `computeSubtree(top, ...)` — which provably contains this *entire* walk (`path`) up to
 * and including the cycle itself (every tail node's parent chain leads into the cycle, and every
 * cycle member reaches every other member by definition) — so once a cycle here is resolved, the
 * whole `path` walked to find it can be marked 'done' immediately: nothing in it can ever become
 * part of a *different* cycle later, since `top`'s new outgoing edge can never lead back into it.
 * A node whose chain doesn't touch this walk at all keeps whatever 'done'/unvisited status it
 * already had, unaffected by a fix that only ever touches nodes inside `path`. */
function walkAndBreak(env: Env, graph: GraphCtx, state: BreakState, start: string): void {
  const path: string[] = [];
  let current: string | null = start;
  while (current !== null && state.visited.get(current) !== 'done') {
    if (state.visited.get(current) === 'visiting') {
      const cycle = path.slice(path.indexOf(current));
      resolveCycle(env, graph, state, cycle);
      break;
    }
    state.visited.set(current, 'visiting');
    path.push(current);
    current = graph.primary.parent.get(current) ?? null;
  }
  for (const visited of path) {
    state.visited.set(visited, 'done');
  }
}

/** Breaks every cycle in `graph.primary.parent` in one pass over `orderedNodes`, instead of the
 * previous "find one cycle by a full fresh scan, fix it, repeat" loop — which re-walked every
 * already-settled node from scratch after each single fix, and rebuilt the whole children index
 * (via `computeSubtree`) on every fix too, making both quadratic in the node count (see I6: a
 * spec-shaped 4,000-note vault with mutual links took multiple seconds to build). Both costs are
 * now amortized: `state.visited` persists across the whole pass (see `walkAndBreak`'s doc comment
 * for why that's still correct), and `childrenIndex` is updated incrementally by `resolveCycle`
 * rather than rebuilt. */
function breakCycles(
  env: Env,
  graph: GraphCtx,
  orderedNodes: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const state: BreakState = {
    childCounts: buildCandidateChildCounts(graph.finalNodeTypes, graph.candidates),
    childrenIndex: buildChildrenIndex(orderedNodes, graph.primary.parent),
    visited: new Map(),
  };
  for (const start of orderedNodes) {
    walkAndBreak(env, graph, state, start);
  }
  return state.childrenIndex;
}

function ancestorsOf(
  path: string,
  parent: ReadonlyMap<string, string | null>,
): ReadonlySet<string> {
  const result = new Set<string>();
  let current = parent.get(path) ?? null;
  while (current !== null && !result.has(current)) {
    result.add(current);
    current = parent.get(current) ?? null;
  }
  return result;
}

function isLinkedFromAncestor(
  graph: GraphCtx,
  ancestors: ReadonlySet<string>,
  target: string,
): boolean {
  for (const ancestor of ancestors) {
    const linked = graph.candidates.byChild.get(ancestor);
    if (linked?.some((candidate) => candidate.parent === target) === true) {
      return true;
    }
  }
  return false;
}

function pushExtra(extras: Map<string, ExtraLink[]>, path: string, extra: ExtraLink): void {
  const list = extras.get(path);
  if (list === undefined) {
    extras.set(path, [extra]);
  } else {
    list.push(extra);
  }
}

function handleExtraCandidate(
  graph: GraphCtx,
  derived: DerivedResult,
  info: NodeExtrasInfo,
  candidate: Candidate,
): void {
  const x = candidate.parent;
  if (info.ancestors.has(x)) {
    return;
  }
  if ((graph.primary.parent.get(x) ?? null) === info.path) {
    derived.twoWay.add(x);
    return;
  }
  if (isLinkedFromAncestor(graph, info.ancestors, x)) {
    return;
  }
  pushExtra(derived.extras, info.path, { parent: x, kind: candidate.rule.kind });
}

function computeAlsoIn(
  path: string,
  ancestors: ReadonlySet<string>,
  external: ReadonlyMap<string, readonly ExternalLink[]>,
): readonly string[] {
  const own = external.get(path) ?? [];
  const ancestorTargets = new Set<string>();
  for (const ancestor of ancestors) {
    const list = external.get(ancestor);
    if (list === undefined) {
      continue;
    }
    for (const link of list) {
      ancestorTargets.add(link.target);
    }
  }
  return own.filter((link) => !ancestorTargets.has(link.target)).map((link) => link.target);
}

function processNode(graph: GraphCtx, derived: DerivedResult, path: string): void {
  const ancestors = ancestorsOf(path, graph.primary.parent);
  const info: NodeExtrasInfo = { path, ancestors };
  const ownParent = graph.primary.parent.get(path) ?? null;
  const candidateList = graph.candidates.byChild.get(path) ?? [];
  for (const candidate of candidateList) {
    if (candidate.parent === ownParent) {
      continue;
    }
    if (!graph.finalNodeTypes.has(candidate.parent)) {
      continue;
    }
    handleExtraCandidate(graph, derived, info, candidate);
  }
  derived.alsoIn.set(path, computeAlsoIn(path, ancestors, graph.candidates.external));
}

function computeDerived(graph: GraphCtx): DerivedResult {
  const derived: DerivedResult = { extras: new Map(), twoWay: new Set(), alsoIn: new Map() };
  for (const path of graph.finalNodeTypes.keys()) {
    processNode(graph, derived, path);
  }
  return derived;
}

function buildOneNode(ctx: BuildCtx, path: string): StructureNode {
  const type = ctx.graph.finalNodeTypes.get(path) ?? null;
  return {
    path,
    type: type === null ? null : type.name,
    parent: ctx.graph.primary.parent.get(path) ?? null,
    edge: ctx.graph.primary.edge.get(path) ?? null,
    children: ctx.childrenIndex.get(path) ?? [],
    extras: ctx.derived.extras.get(path) ?? [],
    alsoIn: ctx.derived.alsoIn.get(path) ?? [],
    twoWay: ctx.derived.twoWay.has(path),
  };
}

function buildNodes(ctx: BuildCtx, orderedNodes: readonly string[]): Map<string, StructureNode> {
  const nodes = new Map<string, StructureNode>();
  for (const path of orderedNodes) {
    nodes.set(path, buildOneNode(ctx, path));
  }
  return nodes;
}

function computeTopsAndOrphans(
  root: string | null,
  orderedNodes: readonly string[],
  parent: ReadonlyMap<string, string | null>,
): { tops: readonly string[]; orphans: readonly string[] } {
  if (root !== null) {
    const orphans = orderedNodes.filter(
      (path) => path !== root && (parent.get(path) ?? null) === null,
    );
    return { tops: [root], orphans };
  }
  const tops = orderedNodes.filter((path) => (parent.get(path) ?? null) === null);
  return { tops, orphans: [] };
}

export function buildStructure(schema: Schema, snapshot: Snapshot): Structure {
  const env = makeEnv(snapshot);
  const nodeSet = buildPotentialNodes(schema, snapshot);
  const candidates = collectCandidates(schema, snapshot, nodeSet.nodeTypes);
  const { root, finalNodeTypes } = determineRoot(nodeSet, snapshot, candidates);
  const orderedNodes = orderNodes(env, finalNodeTypes);
  const primary = computeInitialPrimary(finalNodeTypes, candidates, root);
  const graph: GraphCtx = { finalNodeTypes, candidates, primary };
  const childrenIndex = breakCycles(env, graph, orderedNodes);
  const derived = computeDerived(graph);
  const nodes = buildNodes({ graph, derived, childrenIndex }, orderedNodes);
  const { tops, orphans } = computeTopsAndOrphans(root, orderedNodes, primary.parent);
  return { root, tops, orphans, nodes, issues: nodeSet.issues };
}
