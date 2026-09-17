// Builds the pure `Snapshot`/`NoteData` shapes (see `src/core/snapshot.ts`) from the real
// `MetadataCache`/`Vault`: tags via `getAllTags`, frontmatter minus its injected `position` key,
// property-scoped links resolved via `getFirstLinkpathDest`, and outgoing links from
// `resolvedLinks`. This is the only place the pure core learns about a note's actual content.

import type { App, FrontMatterCache, FrontmatterLinkCache, TFile } from 'obsidian';
import { getAllTags, getLinkpath, parseFrontMatterTags } from 'obsidian';
import type { NoteData, Snapshot } from '../core/snapshot.js';

/** First-occurrence order, duplicates dropped. */
function uniqueInOrder(items: readonly string[]): string[] {
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

function stripHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

/** A shallow copy of `frontmatter` without the `position` key Obsidian injects to record where
 * the frontmatter block sits in the file — that's file-layout metadata, not user data. `{}` when
 * there is no frontmatter at all. */
function copyFrontmatter(frontmatter: FrontMatterCache | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (frontmatter === undefined) {
    return result;
  }
  for (const key of Object.keys(frontmatter)) {
    if (key !== 'position') {
      result[key] = frontmatter[key];
    }
  }
  return result;
}

/** The property a `FrontmatterLinkCache.key` belongs to: `'category.0'` → `'category'`,
 * `'up'` → `'up'` (a scalar key has no index suffix to strip). */
function propertyOf(key: string): string {
  const dotIndex = key.indexOf('.');
  return dotIndex === -1 ? key : key.slice(0, dotIndex);
}

interface LinkResolution {
  readonly propertyLinks: Record<string, readonly string[]>;
  readonly unresolvedLinks: Record<string, readonly string[]>;
}

function pushUnique(bucket: Record<string, string[]>, key: string, value: string): void {
  const list = bucket[key] ?? [];
  if (!list.includes(value)) {
    list.push(value);
  }
  bucket[key] = list;
}

/** `propertyLinks`: property → the resolved, deduped, order-of-appearance targets of every
 * frontmatter link under that property. `unresolvedLinks`: property → the raw link text (same
 * `getLinkpath` value used to resolve it) of every link under that property that resolves to no
 * vault file — recorded instead of silently dropped, so a hand-typed typo surfaces as a
 * diagnostic rather than vanishing. */
function readPropertyLinks(
  app: App,
  file: TFile,
  refs: readonly FrontmatterLinkCache[],
): LinkResolution {
  const propertyLinks: Record<string, string[]> = {};
  const unresolvedLinks: Record<string, string[]> = {};
  for (const ref of refs) {
    const property = propertyOf(ref.key);
    const linkpath = getLinkpath(ref.link);
    const dest = app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
    if (dest === null) {
      pushUnique(unresolvedLinks, property, linkpath);
    } else {
      pushUnique(propertyLinks, property, dest.path);
    }
  }
  return { propertyLinks, unresolvedLinks };
}

/** The `NoteData` for a single file: tags, frontmatter, property links and outgoing links, all
 * read from the already-computed `MetadataCache` entry — no vault I/O beyond that. */
export function readNote(app: App, file: TFile): NoteData {
  const cache = app.metadataCache.getFileCache(file) ?? {};
  const tags = uniqueInOrder((getAllTags(cache) ?? []).map(stripHash));
  const frontmatter = copyFrontmatter(cache.frontmatter);
  // Real Obsidian 1.13's `parseFrontMatterTags` reads only the `tags` frontmatter key (matched
  // case-insensitively — never `tag`, singular), adds a leading `#` to any element missing one
  // (rather than returning it exactly as written), and drops any element containing a space
  // (never a valid tag). We strip the `#` back off here so `frontmatterTags` (the frontmatter-only
  // subset of `tags` retype is allowed to rewrite — see `NoteData.frontmatterTags`) is always bare
  // names, matching `tags`'s own convention.
  const frontmatterTags = uniqueInOrder((parseFrontMatterTags(frontmatter) ?? []).map(stripHash));
  // `cache.tags` is the metadata cache's own inline-tag list — tags written in the note's body
  // text, distinct from `cache.frontmatter`'s (round 2 minor 3): read straight from there instead
  // of deriving it as `tags - frontmatterTags`, so a tag present in *both* places still correctly
  // reports as body-held.
  const bodyTags = uniqueInOrder((cache.tags ?? []).map((entry) => stripHash(entry.tag)));
  const { propertyLinks, unresolvedLinks } = readPropertyLinks(
    app,
    file,
    cache.frontmatterLinks ?? [],
  );
  const links = Object.keys(app.metadataCache.resolvedLinks[file.path] ?? {});
  return {
    path: file.path,
    basename: file.basename,
    tags,
    frontmatterTags,
    bodyTags,
    frontmatter,
    propertyLinks,
    unresolvedLinks,
    links,
  };
}

/** Adds `file`'s `NoteData` to `notes` under its path, unless already present. */
function addNote(app: App, notes: Map<string, NoteData>, file: TFile): void {
  if (!notes.has(file.path)) {
    notes.set(file.path, readNote(app, file));
  }
}

/** Adds the note at `path` to `notes` when it resolves to an existing markdown file, unless
 * already present — the "one level, no recursion" external-target inclusion `readSnapshot` does
 * for `results`/`host` property-link targets. */
function addExternalTarget(app: App, notes: Map<string, NoteData>, path: string): void {
  if (notes.has(path)) {
    return;
  }
  const file = app.vault.getFileByPath(path);
  if (file !== null && file.extension === 'md') {
    notes.set(path, readNote(app, file));
  }
}

/** Every external target of `note`'s property links, added to `notes` (one level, no recursion —
 * this never looks at the newly added notes' own property links). */
function addExternalTargetsOf(app: App, notes: Map<string, NoteData>, note: NoteData): void {
  for (const targets of Object.values(note.propertyLinks)) {
    for (const target of targets) {
      addExternalTarget(app, notes, target);
    }
  }
}

/** The visible notes for a structure view: every `results` note, the `host` (when given), and —
 * one level only — every property-link target of those notes that resolves to an existing
 * markdown file. `results` in the snapshot is deduped to unique paths in the given order.
 *
 * `results` comes straight from a Bases query, which isn't guaranteed to hand back only markdown
 * notes — a folder-scoped filter (`file.inFolder(...)`) matches every file under it, including a
 * `.base`/`.canvas` file that happens to live there too. `addExternalTarget` already guards its own
 * (property-link) intake with `file.extension === 'md'`; `results` needs the same guard so a
 * non-markdown file can't become a "note" here — `host` doesn't, since `findHostFile` already only
 * ever returns a markdown file or `null`. */
export function readSnapshot(app: App, results: readonly TFile[], host: TFile | null): Snapshot {
  const notes = new Map<string, NoteData>();
  const noteResults = results.filter((file) => file.extension === 'md');
  for (const file of noteResults) {
    addNote(app, notes, file);
  }
  if (host !== null) {
    addNote(app, notes, host);
  }
  const primary = host !== null ? [...noteResults, host] : noteResults;
  for (const file of primary) {
    const note = notes.get(file.path);
    if (note !== undefined) {
      addExternalTargetsOf(app, notes, note);
    }
  }
  return {
    notes,
    results: uniqueInOrder(noteResults.map((file) => file.path)),
    host: host?.path ?? null,
  };
}
