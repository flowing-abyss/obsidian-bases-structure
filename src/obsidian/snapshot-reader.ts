// Builds the pure `Snapshot`/`NoteData` shapes (see `src/core/snapshot.ts`) from the real
// `MetadataCache`/`Vault`: tags via `getAllTags`, frontmatter minus its injected `position` key,
// property-scoped links resolved via `getFirstLinkpathDest`, and outgoing links from
// `resolvedLinks`. This is the only place the pure core learns about a note's actual content.

import type { App, FrontMatterCache, FrontmatterLinkCache, TFile } from 'obsidian';
import { getAllTags, getLinkpath } from 'obsidian';
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

/** `propertyLinks`: property → the resolved, deduped, order-of-appearance targets of every
 * frontmatter link under that property. A link that doesn't resolve to a vault file is skipped
 * entirely (per decisions), not recorded as an unresolved entry. */
function readPropertyLinks(
  app: App,
  file: TFile,
  refs: readonly FrontmatterLinkCache[],
): Record<string, readonly string[]> {
  const result: Record<string, string[]> = {};
  for (const ref of refs) {
    const dest = app.metadataCache.getFirstLinkpathDest(getLinkpath(ref.link), file.path);
    if (dest === null) {
      continue;
    }
    const property = propertyOf(ref.key);
    const list = result[property] ?? [];
    if (!list.includes(dest.path)) {
      list.push(dest.path);
    }
    result[property] = list;
  }
  return result;
}

/** The `NoteData` for a single file: tags, frontmatter, property links and outgoing links, all
 * read from the already-computed `MetadataCache` entry — no vault I/O beyond that. */
export function readNote(app: App, file: TFile): NoteData {
  const cache = app.metadataCache.getFileCache(file) ?? {};
  const tags = uniqueInOrder((getAllTags(cache) ?? []).map(stripHash));
  const frontmatter = copyFrontmatter(cache.frontmatter);
  const propertyLinks = readPropertyLinks(app, file, cache.frontmatterLinks ?? []);
  const links = Object.keys(app.metadataCache.resolvedLinks[file.path] ?? {});
  return {
    path: file.path,
    basename: file.basename,
    tags,
    frontmatter,
    propertyLinks,
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
 * markdown file. `results` in the snapshot is deduped to unique paths in the given order. */
export function readSnapshot(app: App, results: readonly TFile[], host: TFile | null): Snapshot {
  const notes = new Map<string, NoteData>();
  for (const file of results) {
    addNote(app, notes, file);
  }
  if (host !== null) {
    addNote(app, notes, host);
  }
  const primary = host !== null ? [...results, host] : results;
  for (const file of primary) {
    const note = notes.get(file.path);
    if (note !== undefined) {
      addExternalTargetsOf(app, notes, note);
    }
  }
  return {
    notes,
    results: uniqueInOrder(results.map((file) => file.path)),
    host: host?.path ?? null,
  };
}
