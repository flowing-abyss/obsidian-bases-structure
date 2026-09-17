// Pure snapshot types — the notes visible to a structure view (already filtered/sorted by
// Bases) and the small pieces of per-note data the matching and structure-building logic need.
// No Obsidian imports: `NoteData` is produced by the Obsidian-facing layer from
// `MetadataCache`/`CachedMetadata`; this module only consumes the already-plain data.

export interface NoteData {
  readonly path: string;
  readonly basename: string;
  /** Every tag the note has, frontmatter and inline body tags alike — used for type matching
   * (`hasTag`), which doesn't care where a tag lives. */
  readonly tags: readonly string[];
  /** Only the tags declared in frontmatter (`tags`, matched case-insensitively; `#` stripped) —
   * the subset retype is allowed to rewrite; a tag that lives in the note's body text never
   * appears here. */
  readonly frontmatterTags: readonly string[];
  /** Only the tags written inline in the note's body/text (`#` stripped) — read directly from the
   * metadata cache's own inline tag entries (round 2 minor 3), not derived as a difference against
   * `frontmatterTags`, so a tag present in *both* places is still correctly reported as body-held
   * (removing it from frontmatter alone would leave it on the note). Captured once and never
   * itself rewritten by a plan (I4). */
  readonly bodyTags: readonly string[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly propertyLinks: Readonly<Record<string, readonly string[]>>;
  readonly links: readonly string[];
}

export interface Snapshot {
  readonly notes: ReadonlyMap<string, NoteData>;
  readonly results: readonly string[];
  readonly host: string | null;
}

/** `'a/b/c.md'` → `'a/b'`; a root-level path such as `'c.md'` → `''`. */
export function folderOf(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash === -1 ? '' : path.slice(0, lastSlash);
}

/** Case-insensitive; a type tag `a/b` matches note tags `a/b` and `a/b/c` (nested), but not
 * `a/bc` — matching is by path segment, not plain string prefix. */
export function hasTag(note: NoteData, tag: string): boolean {
  const target = tag.toLowerCase();
  return note.tags.some((noteTag) => {
    const lower = noteTag.toLowerCase();
    return lower === target || lower.startsWith(`${target}/`);
  });
}

/** `'a/b/c.md'` → `'c'`; a path without a `.md` suffix is returned as-is. Exported for
 * `actions-ui.ts`'s `formatUndoResult` (I1): its skipped-note names need this same fallback in
 * the one context with no `Snapshot` at all to resolve a real display name from (the plugin's
 * global undo command, which has no view). */
export function lastSegmentBasename(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const fileName = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  return fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
}

/** The name to show the user for `path` in planner rejection/verification messages: the note's
 * own `basename` when it's in the snapshot, else the last path segment without `.md` — `path`
 * doesn't have to resolve to a note at all (e.g. a bad parent/node reference). */
export function displayName(snapshot: Snapshot, path: string): string {
  return snapshot.notes.get(path)?.basename ?? lastSegmentBasename(path);
}
