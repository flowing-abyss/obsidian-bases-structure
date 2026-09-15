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

function computeInitialPrimary(
  finalNodeTypes: ReadonlyMap<string, TypeDef | null>,
  candidates: CandidateSet,
): PrimaryInfo {
  const parent = new Map<string, string | null>();
  const edge = new Map<string, EdgeRule | null>();
  for (const path of finalNodeTypes.keys()) {
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

/** Walks the parent chain from `start`, marking each node 'visiting' as it goes. A repeat of a
 * 'visiting' node is a cycle (returned as the loop from that repeat onward); reaching `null` or an
 * already-'done' node means this chain is acyclic, so everything walked is marked 'done'. */
function walkChain(
  start: string,
  state: Map<string, 'visiting' | 'done'>,
  parent: ReadonlyMap<string, string | null>,
): readonly string[] | null {
  const path: string[] = [];
  let current: string | null = start;
  while (current !== null && state.get(current) !== 'done') {
    if (state.get(current) === 'visiting') {
      return path.slice(path.indexOf(current));
    }
    state.set(current, 'visiting');
    path.push(current);
    current = parent.get(current) ?? null;
  }
  for (const visited of path) {
    state.set(visited, 'done');
  }
  return null;
}

function findCycle(
  nodes: readonly string[],
  parent: ReadonlyMap<string, string | null>,
): readonly string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  for (const start of nodes) {
    if (state.get(start) === 'done') {
      continue;
    }
    const cycle = walkChain(start, state, parent);
    if (cycle !== null) {
      return cycle;
    }
  }
  return null;
}

/** Nodes reachable from `top` by following "children" edges (the reverse of the primary parent
 * pointer) — includes `top` itself and, since `top` sits on a cycle, every cycle member. Relies
 * on `Set` iteration visiting entries added during iteration. */
function computeSubtree(
  top: string,
  orderedNodes: readonly string[],
  parent: ReadonlyMap<string, string | null>,
): ReadonlySet<string> {
  const childrenOf = buildChildrenIndex(orderedNodes, parent);
  const visited = new Set<string>([top]);
  for (const current of visited) {
    const kids = childrenOf.get(current) ?? [];
    for (const kid of kids) {
      visited.add(kid);
    }
  }
  return visited;
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

interface CycleBreakInputs {
  readonly orderedNodes: readonly string[];
  readonly childCounts: ReadonlyMap<string, number>;
}

function resolveCycle(
  env: Env,
  graph: GraphCtx,
  inputs: CycleBreakInputs,
  cycle: readonly string[],
): void {
  const top = pickTop(env, inputs.childCounts, cycle);
  const subtree = computeSubtree(top, inputs.orderedNodes, graph.primary.parent);
  const list = graph.candidates.byChild.get(top) ?? [];
  const next = list.find(
    (candidate) => graph.finalNodeTypes.has(candidate.parent) && !subtree.has(candidate.parent),
  );
  graph.primary.parent.set(top, next?.parent ?? null);
  graph.primary.edge.set(top, next?.rule ?? null);
}

function breakCycles(env: Env, graph: GraphCtx, orderedNodes: readonly string[]): void {
  const inputs: CycleBreakInputs = {
    orderedNodes,
    childCounts: buildCandidateChildCounts(graph.finalNodeTypes, graph.candidates),
  };
  let cycle = findCycle(orderedNodes, graph.primary.parent);
  while (cycle !== null) {
    resolveCycle(env, graph, inputs, cycle);
    cycle = findCycle(orderedNodes, graph.primary.parent);
  }
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
  const primary = computeInitialPrimary(finalNodeTypes, candidates);
  const graph: GraphCtx = { finalNodeTypes, candidates, primary };
  breakCycles(env, graph, orderedNodes);
  const childrenIndex = buildChildrenIndex(orderedNodes, primary.parent);
  const derived = computeDerived(graph);
  const nodes = buildNodes({ graph, derived, childrenIndex }, orderedNodes);
  const { tops, orphans } = computeTopsAndOrphans(root, orderedNodes, primary.parent);
  return { root, tops, orphans, nodes, issues: nodeSet.issues };
}
