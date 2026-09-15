// A faithful, TypeScript port of the edge-building rules from the user's original DataviewJS
// script (`templates/views/structure/view.js`, kept outside this repo) — only the graph
// semantics, not the mermaid-string rendering. Used by `reference.test.ts` as an independent
// oracle to check `buildStructure` against on real-vault-shaped data. Test-only, so it lives
// under `__tests__/` (excluded from coverage) rather than in `src/core` proper — it is not
// itself a spec for the plugin, just a second implementation to diff against.
//
// One deliberate deviation from the original: the script rooted its two graphs at synthetic
// nodes ("🧬 hierarhies", "🔬 meta-notes"); here both graphs hang off the category note itself.
// A second deviation: the original's output-building recursions (`processHierarchy` in both
// `buildHierarchyStructure` and `buildMetaStructure`) had no cycle guard at all. This port adds
// a `visited` set to every recursive walk so a cyclic fixture can't hang the test suite.

import type { NoteData, Snapshot } from '../snapshot.js';

function tagged(note: NoteData, tag: string): boolean {
  return note.tags.includes(tag);
}

function isIgnored(note: NoteData): boolean {
  return tagged(note, 'mark/ignore');
}

/** `[[Name]]` → `Name`; anything not bracketed is returned trimmed, as-is. */
function linkText(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('[[') && trimmed.endsWith(']]') ? trimmed.slice(2, -2) : trimmed;
}

/** Reads `note.frontmatter[key]` the way Dataview would expose a link/link-list property: a
 * list of wikilink strings, a single wikilink string, or absent entirely. */
function linkNames(note: NoteData, key: string): readonly string[] {
  const raw = note.frontmatter[key];
  if (raw === undefined || raw === null) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string').map(linkText);
  }
  return typeof raw === 'string' ? [linkText(raw)] : [];
}

function hasLinkValue(note: NoteData, key: string): boolean {
  return linkNames(note, key).length > 0;
}

/** `note.file.outlinks` in Dataview terms: the basenames of the notes this note's resolved
 * `links` point at (only targets that actually exist in the snapshot resolve to a basename). */
function outlinkBasenames(note: NoteData, notes: ReadonlyMap<string, NoteData>): readonly string[] {
  return note.links
    .map((path) => notes.get(path))
    .filter((target): target is NoteData => target !== undefined)
    .map((target) => target.basename);
}

function inCategory(note: NoteData, categoryName: string): boolean {
  const categoryTag = `category/${categoryName.replaceAll(' ', '_')}`;
  return tagged(note, categoryTag) || linkNames(note, 'category').includes(categoryName);
}

/** Bundles the per-scenario read-only state (the in-category hierarchy pool, the full note
 * table for outlink resolution) with the mutable edge accumulator — keeps every walk/recursion
 * below the project's 4-param budget instead of threading each piece separately. */
interface OracleCtx {
  readonly hierarchies: readonly NoteData[];
  readonly notes: ReadonlyMap<string, NoteData>;
  readonly edges: Set<string>;
}

/** Mirrors `isPartOfAnyChain`'s `findInChain`: walks outlinks transitively (within
 * `ctx.hierarchies`) from `current`, looking for `target`'s basename. Each top-level `start` gets
 * its own fresh `visited` set, matching the original's per-call default parameter. */
function reachableFrom(
  ctx: OracleCtx,
  current: NoteData,
  target: NoteData,
  visited: Set<string>,
): boolean {
  if (visited.has(current.path)) {
    return false;
  }
  visited.add(current.path);
  const outgoing = outlinkBasenames(current, ctx.notes);
  if (outgoing.includes(target.basename)) {
    return true;
  }
  const next = ctx.hierarchies.filter((candidate) => outgoing.includes(candidate.basename));
  return next.some((candidate) => reachableFrom(ctx, candidate, target, visited));
}

function isPartOfAnyChain(ctx: OracleCtx, target: NoteData, starts: readonly NoteData[]): boolean {
  return starts.some((start) => reachableFrom(ctx, start, target, new Set()));
}

/** Shared by both the meta-hierarchy and problem-hierarchy branches of the meta graph: from
 * `parent`, walk every outlinked hierarchy (regardless of its own meta/problem), guarded by
 * `visited` so a cycle in the fixture can't recurse forever. */
function recurseAnyOutlink(ctx: OracleCtx, parent: NoteData, visited: Set<string>): void {
  const outgoing = outlinkBasenames(parent, ctx.notes);
  const children = ctx.hierarchies.filter(
    (candidate) => outgoing.includes(candidate.basename) && !visited.has(candidate.path),
  );
  for (const child of children) {
    ctx.edges.add(`${parent.basename} -> ${child.basename}`);
    visited.add(child.path);
    recurseAnyOutlink(ctx, child, visited);
  }
}

/** The "🧬 hierarhies" graph: hierarchies with no meta/problem that aren't reachable from any
 * other hierarchy are the roots; from there, recursion only follows into further
 * no-meta/no-problem hierarchies. */
function recurseTopOutlink(ctx: OracleCtx, parent: NoteData, visited: Set<string>): void {
  const outgoing = outlinkBasenames(parent, ctx.notes);
  const children = ctx.hierarchies.filter(
    (candidate) =>
      !hasLinkValue(candidate, 'meta') &&
      !hasLinkValue(candidate, 'problem') &&
      outgoing.includes(candidate.basename) &&
      !visited.has(candidate.path),
  );
  for (const child of children) {
    ctx.edges.add(`${parent.basename} -> ${child.basename}`);
    visited.add(child.path);
    recurseTopOutlink(ctx, child, visited);
  }
}

function buildTopGraph(ctx: OracleCtx, category: NoteData): void {
  const noMetaProblem = ctx.hierarchies.filter(
    (candidate) => !hasLinkValue(candidate, 'meta') && !hasLinkValue(candidate, 'problem'),
  );
  const main = noMetaProblem.filter(
    (candidate) =>
      !ctx.hierarchies.some((other) =>
        outlinkBasenames(other, ctx.notes).includes(candidate.basename),
      ),
  );
  const visited = new Set<string>(main.map((top) => top.path));
  for (const top of main) {
    ctx.edges.add(`${category.basename} -> ${top.basename}`);
    recurseTopOutlink(ctx, top, visited);
  }
}

function processMetaHierarchies(
  ctx: OracleCtx,
  meta: NoteData,
  metaNoProblemStarts: readonly NoteData[],
): void {
  const candidates = ctx.hierarchies.filter(
    (candidate) =>
      linkNames(candidate, 'meta').includes(meta.basename) && !hasLinkValue(candidate, 'problem'),
  );
  const metaHier = candidates.filter(
    (candidate) => !isPartOfAnyChain(ctx, candidate, metaNoProblemStarts),
  );
  for (const child of metaHier) {
    ctx.edges.add(`${meta.basename} -> ${child.basename}`);
    recurseAnyOutlink(ctx, child, new Set([child.path]));
  }
}

function processMetaProblems(
  ctx: OracleCtx,
  meta: NoteData,
  problemsAll: readonly NoteData[],
): void {
  const problems = problemsAll.filter((problem) =>
    linkNames(problem, 'meta').includes(meta.basename),
  );
  for (const problem of problems) {
    ctx.edges.add(`${meta.basename} -> ${problem.basename}`);
    const candidates = ctx.hierarchies.filter((candidate) =>
      linkNames(candidate, 'problem').includes(problem.basename),
    );
    const problemsHierarchies = candidates.filter(
      (candidate) => !isPartOfAnyChain(ctx, candidate, candidates),
    );
    for (const child of problemsHierarchies) {
      ctx.edges.add(`${problem.basename} -> ${child.basename}`);
      recurseAnyOutlink(ctx, child, new Set([child.path]));
    }
  }
}

function buildMetaGraph(
  ctx: OracleCtx,
  category: NoteData,
  metas: readonly NoteData[],
  problemsAll: readonly NoteData[],
): void {
  const metaNoProblemStarts = ctx.hierarchies.filter(
    (candidate) => hasLinkValue(candidate, 'meta') && !hasLinkValue(candidate, 'problem'),
  );
  for (const meta of metas) {
    ctx.edges.add(`${category.basename} -> ${meta.basename}`);
    processMetaHierarchies(ctx, meta, metaNoProblemStarts);
    processMetaProblems(ctx, meta, problemsAll);
  }
}

/** Reproduces `view.js`'s two graphs (hierarchy-main graph + meta/problem graph) as a flat set
 * of `"<parent basename> -> <child basename>"` edges, rooted at the category note instead of the
 * script's synthetic mermaid roots. `categoryPath` must name a note present in `snapshot.notes`;
 * an absent category yields an empty edge set. */
export function viewJsEdges(snapshot: Snapshot, categoryPath: string): ReadonlySet<string> {
  const category = snapshot.notes.get(categoryPath);
  if (category === undefined) {
    return new Set();
  }
  const { notes } = snapshot;
  const allNotes = Array.from(notes.values());
  const hierarchies = allNotes.filter(
    (candidate) =>
      tagged(candidate, 'system/high/hierarchy') &&
      !isIgnored(candidate) &&
      inCategory(candidate, category.basename),
  );
  const metas = allNotes.filter(
    (candidate) =>
      tagged(candidate, 'system/high/meta') &&
      !isIgnored(candidate) &&
      inCategory(candidate, category.basename),
  );
  const problemsAll = allNotes.filter(
    (candidate) => tagged(candidate, 'system/high/problem') && !isIgnored(candidate),
  );

  const ctx: OracleCtx = { hierarchies, notes, edges: new Set() };
  buildTopGraph(ctx, category);
  buildMetaGraph(ctx, category, metas, problemsAll);
  return ctx.edges;
}
