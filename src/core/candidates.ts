// Collects, per node, the ordered list of candidate parents implied by the schema's edge rules,
// plus "external" property targets (right type, but outside the node set). Pure data in, pure
// data out — no notion of "final" node set, root, or cycles; that's `structure.ts`. No Obsidian
// imports.

import type { EdgeKind, EdgeRule, Schema, TypeDef } from './schema.js';
import type { NoteData, Snapshot } from './snapshot.js';
import { resolveType } from './typing.js';

export interface Candidate {
  readonly parent: string;
  readonly rule: EdgeRule;
  readonly parentLevel: number;
  readonly valueIndex: number;
}

export interface ExternalLink {
  readonly target: string;
  readonly valueIndex: number;
}

export interface CandidateSet {
  readonly byChild: ReadonlyMap<string, readonly Candidate[]>;
  readonly external: ReadonlyMap<string, readonly ExternalLink[]>;
}

interface CollectContext {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly nodeTypes: ReadonlyMap<string, TypeDef | null>;
  readonly resultIndex: ReadonlyMap<string, number>;
  readonly rawByChild: Map<string, Candidate[]>;
  readonly externalByChild: Map<string, ExternalLink[]>;
}

interface NodeInfo {
  readonly path: string;
  readonly note: NoteData;
  readonly type: TypeDef;
}

interface RuleInfo {
  readonly rule: EdgeRule;
  readonly parentType: TypeDef;
}

interface TargetMatch {
  readonly target: string;
  readonly valueIndex: number;
}

function buildResultIndex(snapshot: Snapshot): Map<string, number> {
  const map = new Map<string, number>();
  snapshot.results.forEach((path, index) => map.set(path, index));
  return map;
}

/** The host always sorts first ("results order", host = -1); every other node's order is its
 * index in `snapshot.results` (always present there by construction of the node set). */
function orderOf(ctx: CollectContext, path: string): number {
  if (path === ctx.snapshot.host) {
    return -1;
  }
  return ctx.resultIndex.get(path) ?? Number.MAX_SAFE_INTEGER;
}

function pushCandidate(ctx: CollectContext, child: string, candidate: Candidate): void {
  const list = ctx.rawByChild.get(child);
  if (list === undefined) {
    ctx.rawByChild.set(child, [candidate]);
  } else {
    list.push(candidate);
  }
}

function pushExternal(ctx: CollectContext, child: string, link: ExternalLink): void {
  const list = ctx.externalByChild.get(child);
  if (list === undefined) {
    ctx.externalByChild.set(child, [link]);
  } else {
    list.push(link);
  }
}

/** A target qualifies as a candidate parent when it is a potential node other than the child
 * itself, AND either its type is the rule's parent type, or it is the host (the only entry that
 * can carry a `null` type in `nodeTypes`) — "root without a type fits any rule". */
/** Callers only invoke this once `ctx.nodeTypes.has(target)` is already confirmed. */
function qualifiesAsParent(ctx: CollectContext, target: string, parentType: TypeDef): boolean {
  const targetType = ctx.nodeTypes.get(target) ?? null;
  return targetType === null || targetType.name === parentType.name;
}

function collectExternal(
  ctx: CollectContext,
  child: string,
  parentType: TypeDef,
  match: TargetMatch,
): void {
  const targetNote = ctx.snapshot.notes.get(match.target);
  if (targetNote === undefined) {
    return;
  }
  const resolved = resolveType(ctx.schema, targetNote);
  if (resolved.type !== null && resolved.type.name === parentType.name) {
    pushExternal(ctx, child, { target: match.target, valueIndex: match.valueIndex });
  }
}

function handleListTarget(
  ctx: CollectContext,
  nodeInfo: NodeInfo,
  ruleInfo: RuleInfo,
  match: TargetMatch,
): void {
  if (match.target === nodeInfo.path) {
    return;
  }
  if (ctx.nodeTypes.has(match.target)) {
    if (qualifiesAsParent(ctx, match.target, ruleInfo.parentType)) {
      pushCandidate(ctx, nodeInfo.path, {
        parent: match.target,
        rule: ruleInfo.rule,
        parentLevel: ruleInfo.parentType.level,
        valueIndex: match.valueIndex,
      });
    }
    return;
  }
  if (ruleInfo.rule.kind === 'property') {
    collectExternal(ctx, nodeInfo.path, ruleInfo.parentType, match);
  }
}

function collectListRule(ctx: CollectContext, nodeInfo: NodeInfo, ruleInfo: RuleInfo): void {
  const { rule } = ruleInfo;
  const targets =
    rule.kind === 'links'
      ? nodeInfo.note.links
      : (nodeInfo.note.propertyLinks[rule.property] ?? []);
  targets.forEach((target, valueIndex) => {
    handleListTarget(ctx, nodeInfo, ruleInfo, { target, valueIndex });
  });
}

/** Backlinks candidates come from *any* potential node X (other than N) whose own links include
 * N's path — not from N's own data — so this walks `nodeTypes` rather than a target list. */
function collectBacklinks(ctx: CollectContext, nodeInfo: NodeInfo, ruleInfo: RuleInfo): void {
  for (const [xPath, xType] of ctx.nodeTypes) {
    if (xPath === nodeInfo.path) {
      continue;
    }
    if (xType !== null && xType.name !== ruleInfo.parentType.name) {
      continue;
    }
    const xNote = ctx.snapshot.notes.get(xPath);
    if (!(xNote?.links.includes(nodeInfo.path) ?? false)) {
      continue;
    }
    pushCandidate(ctx, nodeInfo.path, {
      parent: xPath,
      rule: ruleInfo.rule,
      parentLevel: ruleInfo.parentType.level,
      valueIndex: orderOf(ctx, xPath),
    });
  }
}

function collectForNode(ctx: CollectContext, nodeInfo: NodeInfo): void {
  for (const parentType of ctx.schema.types) {
    const rule = parentType.children.get(nodeInfo.type.name);
    if (rule === undefined) {
      continue;
    }
    const ruleInfo: RuleInfo = { rule, parentType };
    if (rule.kind === 'backlinks') {
      collectBacklinks(ctx, nodeInfo, ruleInfo);
    } else {
      collectListRule(ctx, nodeInfo, ruleInfo);
    }
  }
}

function ruleRank(kind: EdgeKind): number {
  return kind === 'property' ? 0 : 1;
}

/** Best-first: deeper parent type first, then property before links/backlinks, then earlier
 * list position, then earlier in results order (host first). */
function compareCandidates(ctx: CollectContext, a: Candidate, b: Candidate): number {
  if (a.parentLevel !== b.parentLevel) {
    return b.parentLevel - a.parentLevel;
  }
  const rankDiff = ruleRank(a.rule.kind) - ruleRank(b.rule.kind);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  if (a.valueIndex !== b.valueIndex) {
    return a.valueIndex - b.valueIndex;
  }
  return orderOf(ctx, a.parent) - orderOf(ctx, b.parent);
}

function dedupeAndSort(ctx: CollectContext, list: readonly Candidate[]): readonly Candidate[] {
  const bestByParent = new Map<string, Candidate>();
  for (const candidate of list) {
    const existing = bestByParent.get(candidate.parent);
    if (existing === undefined || compareCandidates(ctx, candidate, existing) < 0) {
      bestByParent.set(candidate.parent, candidate);
    }
  }
  return Array.from(bestByParent.values()).sort((a, b) => compareCandidates(ctx, a, b));
}

function dedupeExternal(list: readonly ExternalLink[]): readonly ExternalLink[] {
  const seen = new Map<string, ExternalLink>();
  for (const item of list) {
    if (!seen.has(item.target)) {
      seen.set(item.target, item);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.valueIndex - b.valueIndex);
}

function finalizeCandidates(ctx: CollectContext): ReadonlyMap<string, readonly Candidate[]> {
  const result = new Map<string, readonly Candidate[]>();
  for (const [child, list] of ctx.rawByChild) {
    result.set(child, dedupeAndSort(ctx, list));
  }
  return result;
}

function finalizeExternal(ctx: CollectContext): ReadonlyMap<string, readonly ExternalLink[]> {
  const result = new Map<string, readonly ExternalLink[]>();
  for (const [child, list] of ctx.externalByChild) {
    result.set(child, dedupeExternal(list));
  }
  return result;
}

export function collectCandidates(
  schema: Schema,
  snapshot: Snapshot,
  nodeTypes: ReadonlyMap<string, TypeDef | null>,
): CandidateSet {
  const ctx: CollectContext = {
    schema,
    snapshot,
    nodeTypes,
    resultIndex: buildResultIndex(snapshot),
    rawByChild: new Map(),
    externalByChild: new Map(),
  };
  for (const [path, type] of nodeTypes) {
    if (type === null) {
      continue;
    }
    const note = snapshot.notes.get(path);
    if (note === undefined) {
      continue;
    }
    collectForNode(ctx, { path, note, type });
  }
  return {
    byChild: finalizeCandidates(ctx),
    external: finalizeExternal(ctx),
  };
}
