// Pure application of a `Plan` onto a `Snapshot`. Used by the planner's own verification step
// (rebuild the structure after a hypothetical plan) and, later, by the Obsidian-facing layer's
// preview/apply steps. Never mutates its input — always returns a new `Snapshot`. No Obsidian
// imports.

import { patchLinksValue, patchListItem, rawLinkText } from './link-patch.js';
import type { KeyWrite, Plan } from './plan-types.js';
import type { NoteData, Snapshot } from './snapshot.js';

/** A `NoteData` under construction: the same shape, but with mutable collections so the write
 * helpers below can build it up incrementally. */
interface NoteDraft {
  tags: string[];
  frontmatterTags: string[];
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

/** A pure, `Snapshot`-only stand-in for `getFirstLinkpathDest`/`getLinkpath`: extracts a raw
 * frontmatter element's linktext (stripping any `#heading`, which `getLinkpath` itself would
 * strip) and resolves it against every note currently in `notes` — an exact path, an exact path
 * once `.md` is added, or (falling back, same as real link resolution) a case-insensitive
 * basename match. `null` for plain text or a link that doesn't resolve to anything in the
 * snapshot — both are left untouched by `patchLinksValue`, exactly like an unresolved link in the
 * real vault. */
function resolveRawLink(notes: ReadonlyMap<string, NoteData>, raw: string): string | null {
  const linktext = rawLinkText(raw);
  if (linktext === null) {
    return null;
  }
  const bare = linktext.split('#')[0]?.trim() ?? '';
  if (bare === '') {
    return null;
  }
  if (notes.has(bare)) {
    return bare;
  }
  const withExt = bare.endsWith('.md') ? bare : `${bare}.md`;
  if (notes.has(withExt)) {
    return withExt;
  }
  const targetBasename = withExt
    .slice(withExt.lastIndexOf('/') + 1)
    .replace(/\.md$/, '')
    .toLowerCase();
  for (const note of notes.values()) {
    if (note.basename.toLowerCase() === targetBasename) {
      return note.path;
    }
  }
  return null;
}

/** The full resolved target list a `'links'` patch leaves a key holding: `current` minus
 * `remove`, plus any `add` target it didn't already have — mirrors what `patchLinksValue` does to
 * the raw frontmatter value, but over already-resolved paths (`propertyLinks` never holds
 * unresolved/plain-text entries, so no resolver is needed here). */
function resultingTargets(
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

function stripHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

/** `undefined`/`null` → `[]`, an array → itself, anything else → a single-element array wrapping
 * it. */
function asItems(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** Pulls a tag list back out of a literal `tags` write's raw value (already applied — an array of
 * strings, or a single scalar string). Anything else is dropped rather than crashing — the schema
 * recipe / retype planning are the only producers, and always supply a string or an array of
 * strings, but this stays defensive against a malformed `Plan` built by hand (e.g. in a test). */
function tagsFromFrontmatterValue(value: unknown): readonly string[] {
  return asItems(value)
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

/** Applies one `'links'`-kind write to `draft`: patches the raw frontmatter value (preserving
 * unresolved links, plain text, aliases/headings, and links outside the base exactly as written —
 * see `patchLinksValue`) and recomputes `propertyLinks[key]` from the same `remove`/`add` patch
 * over already-resolved targets. */
function applyLinksWrite(
  notes: ReadonlyMap<string, NoteData>,
  draft: NoteDraft,
  key: string,
  value: Extract<KeyWrite['value'], { kind: 'links' }>,
): void {
  // Round 2 minor 1: the key is always kept, even once the patch leaves nothing — `patchLinksValue`
  // itself returns `[]`/`null` (never a "delete" signal), so this always assigns, never deletes.
  draft.frontmatter[key] = patchLinksValue(draft.frontmatter[key], {
    remove: new Set(value.remove),
    add: value.add,
    list: value.list,
    resolve: (raw) => resolveRawLink(notes, raw),
    format: wikilink,
  });
  const newTargets = resultingTargets(draft.propertyLinks[key] ?? [], value.remove, value.add);
  if (newTargets.length === 0) {
    delete draft.propertyLinks[key];
  } else {
    draft.propertyLinks[key] = newTargets;
  }
}

/** Whether `key` is the frontmatter key Obsidian reads tags from — matched case-insensitively
 * (round 2 minor 2: real Obsidian's `parseFrontMatterTags` reads only `tags`, matched
 * case-insensitively, never a singular `tag`; `tagsKeyOf` in plan-retype.ts never targets anything
 * else). */
function isTagsKey(key: string): boolean {
  return /^tags$/i.test(key);
}

/** Applies one `'listItem'`-kind write to `draft`: patches a plain (non-link) list-shaped value by
 * element (see `patchListItem`) — used by retype's recipe-property writes. */
function applyListItemWrite(
  draft: NoteDraft,
  key: string,
  value: Extract<KeyWrite['value'], { kind: 'listItem' }>,
): void {
  // Round 2 minor 1: always assigns, never deletes — see `applyLinksWrite` above.
  draft.frontmatter[key] = patchListItem(draft.frontmatter[key], {
    ...(value.remove === undefined ? {} : { remove: value.remove }),
    ...(value.add === undefined ? {} : { add: value.add }),
  });
}

/** Recomputes `draft.frontmatterTags`/`draft.tags` after a write touched a tags key: `tags` =
 * `frontmatterTags` (freshly read back off the patched frontmatter value) ∪ `bodyTags` — the
 * note's inline/body-only tags, captured once before any writes ran and never themselves rewritten
 * by a plan (I4). */
function refreshTags(draft: NoteDraft, key: string, bodyTags: readonly string[]): void {
  draft.frontmatterTags = [...tagsFromFrontmatterValue(draft.frontmatter[key])];
  draft.tags = [...uniqueInOrder([...draft.frontmatterTags, ...bodyTags])];
}

/** Applies one write's effect to `frontmatter`/`propertyLinks`/`tags`. Shared by creation (fresh
 * draft, `bodyTags: []` — a new note has no body yet) and change (draft seeded from the existing
 * note, `bodyTags` from its inline/body-only tags) application — `links` recomputation for changes
 * happens separately in `applyChangeWrite`, since creation instead rebuilds `links` from scratch
 * once at the end (see `buildCreationLinks`). */
function applyWriteToDraft(
  notes: ReadonlyMap<string, NoteData>,
  draft: NoteDraft,
  write: KeyWrite,
  bodyTags: readonly string[],
): void {
  const { key, value } = write;
  if (value === null) {
    delete draft.frontmatter[key];
    delete draft.propertyLinks[key];
    if (isTagsKey(key)) {
      refreshTags(draft, key, bodyTags);
    }
    return;
  }
  if (value.kind === 'links') {
    applyLinksWrite(notes, draft, key, value);
    return;
  }
  if (value.kind === 'listItem') {
    applyListItemWrite(draft, key, value);
    if (isTagsKey(key)) {
      refreshTags(draft, key, bodyTags);
    }
    return;
  }
  draft.frontmatter[key] = value.value;
  if (isTagsKey(key)) {
    refreshTags(draft, key, bodyTags);
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
    const draft: NoteDraft = {
      tags: [],
      frontmatterTags: [],
      frontmatter: {},
      propertyLinks: {},
      links: [],
    };
    for (const write of creation.writes) {
      applyWriteToDraft(state.notes, draft, write, []);
    }
    const noteData: NoteData = {
      path: creation.path,
      basename: basenameOf(creation.path),
      tags: draft.tags,
      frontmatterTags: draft.frontmatterTags,
      bodyTags: [], // a brand-new note has no body text yet
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
    frontmatterTags: [...note.frontmatterTags],
    frontmatter: { ...note.frontmatter },
    propertyLinks: { ...note.propertyLinks },
    links: [...note.links],
  };
}

/** The note's inline/body-only tags, straight off `NoteData` (round 2 minor 3: read directly from
 * the metadata cache's own inline-tag entries, not derived as a `tags - frontmatterTags`
 * difference — a tag present in *both* places is still body-held) — a plan never rewrites the body
 * text itself (I4), so this is captured once before any writes run for a change. */
function bodyTagsOf(note: NoteData): readonly string[] {
  return note.bodyTags;
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

function applyChangeWrite(
  notes: ReadonlyMap<string, NoteData>,
  draft: NoteDraft,
  write: KeyWrite,
  bodyTags: readonly string[],
): void {
  const oldTargets = draft.propertyLinks[write.key] ?? [];
  const newTargets =
    write.value !== null && write.value.kind === 'links'
      ? resultingTargets(oldTargets, write.value.remove, write.value.add)
      : [];
  applyWriteToDraft(notes, draft, write, bodyTags);
  draft.links = recomputeLinks(draft.links, draft.propertyLinks, oldTargets, newTargets);
}

function applyChanges(state: SimState, changes: Plan['changes']): void {
  for (const change of changes) {
    const existing = state.notes.get(change.path);
    if (existing === undefined) {
      continue;
    }
    const draft = draftFromNote(existing);
    const bodyTags = bodyTagsOf(existing);
    for (const write of change.writes) {
      applyChangeWrite(state.notes, draft, write, bodyTags);
    }
    state.notes.set(change.path, {
      path: existing.path,
      basename: existing.basename,
      tags: draft.tags,
      frontmatterTags: draft.frontmatterTags,
      bodyTags: existing.bodyTags, // never rewritten by a plan (I4)
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
