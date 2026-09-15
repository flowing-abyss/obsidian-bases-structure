// Pure snapshot types — the notes visible to a structure view (already filtered/sorted by
// Bases) and the small pieces of per-note data the matching and structure-building logic need.
// No Obsidian imports: `NoteData` is produced by the Obsidian-facing layer from
// `MetadataCache`/`CachedMetadata`; this module only consumes the already-plain data.

export interface NoteData {
  readonly path: string;
  readonly basename: string;
  readonly tags: readonly string[];
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

/** `'a/b/c.md'` → `'c'`; a path without a `.md` suffix is returned as-is. */
function lastSegmentBasename(path: string): string {
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
