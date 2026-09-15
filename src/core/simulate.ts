// Pure application of a `Plan` onto a `Snapshot`. Used by the planner's own verification step
// (rebuild the structure after a hypothetical plan) and, later, by the Obsidian-facing layer's
// preview/apply steps. Never mutates its input — always returns a new `Snapshot`. No Obsidian
// imports.

import type { KeyWrite, Plan } from './planner.js';
import type { NoteData, Snapshot } from './snapshot.js';

/** A `NoteData` under construction: the same shape, but with mutable collections so the write
 * helpers below can build it up incrementally. */
interface NoteDraft {
  tags: string[];
  frontmatter: Record<string, unknown>;
  propertyLinks: Record<string, readonly string[]>;
  links: string[];
}

interface SimState {
  readonly notes: Map<string, NoteData>;
  results: string[];
  host: string | null;
}

/** `'a/b/c.md'` → `'c'`; a path without a `.md` suffix is returned as-is (defensive only — real
 * paths always carry the extension). */
function basenameOf(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const fileName = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  return fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
}

function wikilink(path: string): string {
  return `[[${basenameOf(path)}]]`;
}

/** The frontmatter value for a `'links'` write: every target as a wikilink when `list`, otherwise
 * a single wikilink string for the first (and, by construction, only meaningful) target. */
function linksFrontmatterValue(targets: readonly string[], list: boolean): unknown {
  if (list) {
    return targets.map(wikilink);
  }
  const [first] = targets;
  return first === undefined ? '' : wikilink(first);
}

function stripHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

/** Pulls the tag list back out of a literal `tags` write's raw value. Anything that isn't an
 * array, or isn't a string once inside it, is dropped rather than crashing — the schema recipe is
 * the only producer of this value and always supplies an array of strings, but this stays
 * defensive against a malformed `Plan` built by hand (e.g. in a test). */
function literalTags(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return (value as unknown[])
    .filter((item): item is string => typeof item === 'string')
    .map(stripHash);
}

function uniqueInOrder(items: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

/** Applies one write's effect to `frontmatter`/`propertyLinks`/`tags`. Shared by creation (fresh
 * draft) and change (draft seeded from the existing note) application — `links` recomputation for
 * changes happens separately in `applyChangeWrite`, since creation instead rebuilds `links` from
 * scratch once at the end (see `buildCreationLinks`). */
function applyWriteToDraft(draft: NoteDraft, write: KeyWrite): void {
  const { key, value } = write;
  if (value === null) {
    delete draft.frontmatter[key];
    delete draft.propertyLinks[key];
    return;
  }
  if (value.kind === 'links') {
    draft.frontmatter[key] = linksFrontmatterValue(value.targets, value.list);
    draft.propertyLinks[key] = [...value.targets];
    return;
  }
  draft.frontmatter[key] = value.value;
  if (key === 'tags') {
    draft.tags = [...literalTags(value.value)];
  }
}

function buildCreationLinks(
  bodyLinks: readonly string[],
  propertyLinks: Record<string, readonly string[]>,
): readonly string[] {
  const allTargets = Object.values(propertyLinks).flat();
  return uniqueInOrder([...bodyLinks, ...allTargets]);
}

function applyCreations(state: SimState, creations: Plan['creations']): void {
  for (const creation of creations) {
    const draft: NoteDraft = { tags: [], frontmatter: {}, propertyLinks: {}, links: [] };
    for (const write of creation.writes) {
      applyWriteToDraft(draft, write);
    }
    const noteData: NoteData = {
      path: creation.path,
      basename: basenameOf(creation.path),
      tags: draft.tags,
      frontmatter: draft.frontmatter,
      propertyLinks: draft.propertyLinks,
      links: buildCreationLinks(creation.bodyLinks, draft.propertyLinks),
    };
    state.notes.set(creation.path, noteData);
    state.results.push(creation.path);
  }
}

function draftFromNote(note: NoteData): NoteDraft {
  return {
    tags: [...note.tags],
    frontmatter: { ...note.frontmatter },
    propertyLinks: { ...note.propertyLinks },
    links: [...note.links],
  };
}

/** Removes `oldTargets` no longer held by any property (checked across the *updated*
 * `propertyLinks`, so a target another key still lists survives), then appends any genuinely new
 * `newTargets` that aren't already present — "existing order, then new" as required. */
function recomputeLinks(
  links: readonly string[],
  propertyLinks: Record<string, readonly string[]>,
  oldTargets: readonly string[],
  newTargets: readonly string[],
): string[] {
  const stillHeld = new Set(Object.values(propertyLinks).flat());
  const kept = links.filter((link) => !oldTargets.includes(link) || stillHeld.has(link));
  for (const target of newTargets) {
    if (!kept.includes(target)) {
      kept.push(target);
    }
  }
  return kept;
}

function applyChangeWrite(draft: NoteDraft, write: KeyWrite): void {
  const oldTargets = draft.propertyLinks[write.key] ?? [];
  const newTargets =
    write.value !== null && write.value.kind === 'links' ? write.value.targets : [];
  applyWriteToDraft(draft, write);
  draft.links = recomputeLinks(draft.links, draft.propertyLinks, oldTargets, newTargets);
}

function applyChanges(state: SimState, changes: Plan['changes']): void {
  for (const change of changes) {
    const existing = state.notes.get(change.path);
    if (existing === undefined) {
      continue;
    }
    const draft = draftFromNote(existing);
    for (const write of change.writes) {
      applyChangeWrite(draft, write);
    }
    state.notes.set(change.path, {
      path: existing.path,
      basename: existing.basename,
      tags: draft.tags,
      frontmatter: draft.frontmatter,
      propertyLinks: draft.propertyLinks,
      links: draft.links,
    });
  }
}

function applyAppends(state: SimState, appends: Plan['appends']): void {
  for (const append of appends) {
    const existing = state.notes.get(append.path);
    if (existing === undefined || existing.links.includes(append.target)) {
      continue;
    }
    state.notes.set(append.path, { ...existing, links: [...existing.links, append.target] });
  }
}

function replaceTarget(list: readonly string[], from: string, to: string): readonly string[] {
  return list.includes(from) ? list.map((item) => (item === from ? to : item)) : list;
}

/** Rewrites every reference to `from` as `to`, across every note's `propertyLinks` values and
 * `links` — including the just-renamed note itself, in case it referenced its own old path. */
function rewriteReferences(state: SimState, from: string, to: string): void {
  for (const [path, note] of state.notes) {
    const propertyLinks: Record<string, readonly string[]> = {};
    let changed = false;
    for (const [key, targets] of Object.entries(note.propertyLinks)) {
      const replaced = replaceTarget(targets, from, to);
      propertyLinks[key] = replaced;
      changed = changed || replaced !== targets;
    }
    const links = replaceTarget(note.links, from, to);
    if (changed || links !== note.links) {
      state.notes.set(path, { ...note, propertyLinks, links });
    }
  }
}

function applyOneMove(state: SimState, move: { readonly from: string; readonly to: string }): void {
  const existing = state.notes.get(move.from);
  if (existing !== undefined) {
    state.notes.delete(move.from);
    state.notes.set(move.to, { ...existing, path: move.to, basename: basenameOf(move.to) });
  }
  state.results = state.results.map((path) => (path === move.from ? move.to : path));
  if (state.host === move.from) {
    state.host = move.to;
  }
  rewriteReferences(state, move.from, move.to);
}

function applyMoves(state: SimState, moves: Plan['moves']): void {
  for (const move of moves) {
    applyOneMove(state, move);
  }
}

export function applyPlan(snapshot: Snapshot, plan: Plan): Snapshot {
  const state: SimState = {
    notes: new Map(snapshot.notes),
    results: [...snapshot.results],
    host: snapshot.host,
  };
  applyCreations(state, plan.creations);
  applyChanges(state, plan.changes);
  applyAppends(state, plan.appends);
  applyMoves(state, plan.moves);
  return { notes: state.notes, results: state.results, host: state.host };
}
