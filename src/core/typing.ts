// Matches notes against `TypeDef`s from a parsed `Schema`, and resolves each note to at most one
// type using the "more conditions win, ties are a conflict" rule from the design spec's
// "Опознание типа" section. No Obsidian imports — operates purely on `TypeDef`/`Schema`
// (schema.ts) and `NoteData` (snapshot.ts).

import type { Schema, TypeDef, TypeMatch } from './schema.js';
import { folderOf, hasTag, type NoteData } from './snapshot.js';

export interface TypeResolution {
  readonly type: TypeDef | null;
  readonly conflict: readonly string[];
}

function matchesTags(tags: readonly string[], note: NoteData): boolean {
  return tags.every((tag) => hasTag(note, tag));
}

/** Folder match is case-sensitive: the note's folder equals the type's folder, or is one of its
 * subfolders (`folder + '/'` prefix — a bare string prefix would wrongly match a sibling folder
 * like `'hierarchy2'` against a `'hierarchy'` condition). */
function matchesFolder(folder: string, note: NoteData): boolean {
  const noteFolder = folderOf(note.path);
  return noteFolder === folder || noteFolder.startsWith(`${folder}/`);
}

function toComparableString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function isWikilink(value: string): boolean {
  return value.startsWith('[[') && value.endsWith(']]');
}

function beforeFirst(value: string, separator: string): string {
  const index = value.indexOf(separator);
  return index === -1 ? value : value.slice(0, index);
}

/** Reduces a `[[...]]` wikilink to its link text: drops the alias (after `|`), the heading
 * (after `#`), any folder path, and a trailing `.md`. Only called on a string already confirmed
 * bracketed by `isWikilink`. */
function linkText(bracketed: string): string {
  const inner = bracketed.slice(2, -2);
  const withoutAlias = beforeFirst(inner, '|');
  const withoutHeading = beforeFirst(withoutAlias, '#');
  const lastSlash = withoutHeading.lastIndexOf('/');
  const segment = lastSlash === -1 ? withoutHeading : withoutHeading.slice(lastSlash + 1);
  return segment.endsWith('.md') ? segment.slice(0, -3) : segment;
}

/** Case-insensitive after trimming. If either side is a `[[wikilink]]`, that side is reduced to
 * its link text first, so `"[[Project]]"` matches expected `Project` and expected
 * `"[[Project]]"` alike. */
function valuesEqual(actual: string, expected: string): boolean {
  const trimmedActual = actual.trim();
  const trimmedExpected = expected.trim();
  const normalizedActual = isWikilink(trimmedActual) ? linkText(trimmedActual) : trimmedActual;
  const normalizedExpected = isWikilink(trimmedExpected)
    ? linkText(trimmedExpected)
    : trimmedExpected;
  return normalizedActual.toLowerCase() === normalizedExpected.toLowerCase();
}

function elementMatches(value: unknown, expected: string): boolean {
  const text = toComparableString(value);
  return text !== null && valuesEqual(text, expected);
}

/** Missing/null never matches. An array value matches when any element does. */
function matchesPropertyEntry(note: NoteData, name: string, expected: string): boolean {
  const raw = note.frontmatter[name];
  if (raw === null || raw === undefined) {
    return false;
  }
  if (Array.isArray(raw)) {
    return raw.some((item) => elementMatches(item, expected));
  }
  return elementMatches(raw, expected);
}

function matchesProperties(properties: TypeMatch['properties'], note: NoteData): boolean {
  return properties.every(([name, expected]) => matchesPropertyEntry(note, name, expected));
}

/** All conditions in `def.match` must hold (tags AND folder AND properties); a type with no
 * conditions at all matches every note. */
export function matchesType(def: TypeDef, note: NoteData): boolean {
  const { match } = def;
  if (!matchesTags(match.tags, note)) {
    return false;
  }
  if (match.folder !== null && !matchesFolder(match.folder, note)) {
    return false;
  }
  return matchesProperties(match.properties, note);
}

function highestSpecificity(types: readonly TypeDef[], start: number): number {
  return types.reduce((max, type) => Math.max(max, type.specificity), start);
}

function earliestByLevel(types: readonly TypeDef[]): TypeDef {
  return types.reduce((best, type) => (type.level < best.level ? type : best));
}

/** Among the types matching `note`, the highest-`specificity` ones compete; the lowest-`level`
 * one among those wins, and `conflict` lists every tied top type's name when 2 or more are tied
 * (otherwise `[]`). No match → `{ type: null, conflict: [] }`. This is why an empty-conditions
 * type only wins when nothing more specific matches: it always has the lowest possible
 * specificity (0). */
export function resolveType(schema: Schema, note: NoteData): TypeResolution {
  const matches = schema.types.filter((type) => matchesType(type, note));
  const first = matches[0];
  if (first === undefined) {
    return { type: null, conflict: [] };
  }
  const highest = highestSpecificity(matches, first.specificity);
  const top = matches.filter((type) => type.specificity === highest);
  return {
    type: earliestByLevel(top),
    conflict: top.length >= 2 ? top.map((type) => type.name) : [],
  };
}
