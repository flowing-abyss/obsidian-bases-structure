// Test-only builders for `NoteData`/`Snapshot`, shared across `src/core` test files. Not itself
// a `*.test.ts` suite — it lives under `__tests__/` purely so it can be excluded from coverage
// (see `vitest.config.ts`) while still being reachable from every test file that needs a note or
// a snapshot without hand-building the full interface each time.

import { type NoteData, type Snapshot } from '../snapshot.js';

/** `'a/b/c.md'` → `'c'`; a path without a `.md` suffix is returned as-is (defensive only — real
 * `NoteData.path` values always carry the extension, per the design spec). */
function basenameOf(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const fileName = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  return fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
}

const DEFAULTS: Omit<NoteData, 'path' | 'basename'> = {
  tags: [],
  frontmatterTags: [],
  bodyTags: [],
  frontmatter: {},
  propertyLinks: {},
  unresolvedLinks: {},
  links: [],
};

export function note(path: string, partial: Partial<Omit<NoteData, 'path'>> = {}): NoteData {
  return {
    ...DEFAULTS,
    ...partial,
    path,
    basename: partial.basename ?? basenameOf(path),
    // Defaults to a copy of `tags` when only that's given — everywhere else, callers only care
    // about the (usually identical) combined `tags` list, not the frontmatter/body split.
    frontmatterTags: partial.frontmatterTags ?? partial.tags ?? DEFAULTS.frontmatterTags,
  };
}

export function snapshot(
  notes: readonly NoteData[],
  options: { results?: readonly string[]; host?: string | null } = {},
): Snapshot {
  const notesByPath = new Map<string, NoteData>();
  for (const entry of notes) {
    notesByPath.set(entry.path, entry);
  }
  return {
    notes: notesByPath,
    results: options.results ?? notes.map((entry) => entry.path),
    host: options.host ?? null,
  };
}
