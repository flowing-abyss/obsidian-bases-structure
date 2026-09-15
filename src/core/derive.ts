// Small derivation helpers shared by the planner: which properties a type's own `children` rules
// bind (`edgeProperties`), what a new/edited note should inherit through an `inherit` key
// (`inheritedTargets`), and whether a property should be written as a YAML list or a scalar
// (`listShape`). No Obsidian imports.

import type { Schema, TypeDef } from './schema.js';
import type { Snapshot } from './snapshot.js';

/** The property names used by `type.children` rules of kind `'property'` — the keys through
 * which `type`'s own children point back at it. `'links'`/`'backlinks'` rules aren't backed by a
 * frontmatter property at all, so they never contribute here. */
export function edgeProperties(type: TypeDef): ReadonlySet<string> {
  const properties = new Set<string>();
  for (const rule of type.children.values()) {
    if (rule.kind === 'property') {
      properties.add(rule.property);
    }
  }
  return properties;
}

interface InheritParent {
  readonly path: string;
  readonly type: TypeDef | null;
  readonly links: Readonly<Record<string, readonly string[]>>;
}

/** What a child should inherit for `key`: the parent itself, when the parent's own type links its
 * children through `key` (the parent already *is* the value of that property, from the child's
 * point of view); otherwise a copy of whatever `key` already resolves to on the parent, so the
 * value chains down the tree unchanged. `schema` is accepted for symmetry with the rest of the
 * derivation API even though only `parent.type` is needed to resolve this. */
export function inheritedTargets(
  _schema: Schema,
  parent: InheritParent,
  key: string,
): readonly string[] {
  if (parent.type !== null && edgeProperties(parent.type).has(key)) {
    return [parent.path];
  }
  return [...(parent.links[key] ?? [])];
}

/** The note's own current value for `key`, when it has one: `true` for a list, `false` for a
 * scalar. `null` means "no opinion" (missing note, or no such key) — the caller should fall back
 * to scanning the snapshot. */
function ownFrontmatterShape(snapshot: Snapshot, key: string, notePath: string): boolean | null {
  const note = snapshot.notes.get(notePath);
  if (note === undefined) {
    return null;
  }
  const value = note.frontmatter[key];
  if (value === undefined || value === null) {
    return null;
  }
  return Array.isArray(value);
}

/** Scans every note in the snapshot for `key`: any list use anywhere makes it a list, a lone
 * scalar use (and no list use) makes it a scalar, and no use at all defaults to a list. */
function scannedShape(snapshot: Snapshot, key: string): boolean {
  let sawScalar = false;
  for (const note of snapshot.notes.values()) {
    const value = note.frontmatter[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      return true;
    }
    sawScalar = true;
  }
  return !sawScalar;
}

/** `true` = write `key` as a YAML list. `notePath`'s own current value decides it outright when
 * present; otherwise the shape follows the vault's existing convention for `key` (see
 * `scannedShape`). Pass `notePath: null` for a brand-new note, which has no "own value" yet. */
export function listShape(snapshot: Snapshot, key: string, notePath: string | null): boolean {
  if (notePath !== null) {
    const own = ownFrontmatterShape(snapshot, key, notePath);
    if (own !== null) {
      return own;
    }
  }
  return scannedShape(snapshot, key);
}
