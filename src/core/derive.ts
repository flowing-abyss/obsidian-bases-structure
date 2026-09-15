// Small derivation helpers shared by the planner: which properties a type's own `children` rules
// bind (`edgeProperties`), what a new/edited note should inherit through an `inherit` key
// (`inheritedTargets`), whether a property should be written as a YAML list or a scalar
// (`listShape`), which edge rule connects a parent type to a child type (`ruleBetween`), and the
// move/retype link cascade down a subtree (`deriveSubtreeWrites`). No Obsidian imports.

import type { KeyWrite } from './plan-types.js';
import type { EdgeRule, Schema, TypeDef } from './schema.js';
import type { Snapshot } from './snapshot.js';
import type { Structure, StructureNode } from './structure.js';

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

/** Among the schema's types, the lowest-`level` one whose `children` map has a rule for
 * `childType` — "the recipe that would apply if `childType` sat under an untyped root". */
function lowestLevelRuleFor(schema: Schema, childType: string): EdgeRule | null {
  let best: { readonly level: number; readonly rule: EdgeRule } | null = null;
  for (const candidate of schema.types) {
    const rule = candidate.children.get(childType);
    if (rule === undefined) {
      continue;
    }
    if (best === null || candidate.level < best.level) {
      best = { level: candidate.level, rule };
    }
  }
  return best?.rule ?? null;
}

/** The edge rule connecting a parent of type `parentType` to a child of type `childType`: a plain
 * lookup in the parent type's own `children` map when the parent is typed, otherwise (an untyped
 * root) the rule of the lowest-level type that claims `childType` as a child anywhere in the
 * schema — the same "what would apply here" resolution `planCreate` and the move/retype planners
 * share. */
export function ruleBetween(
  schema: Schema,
  parentType: string | null,
  childType: string,
): EdgeRule | null {
  if (parentType !== null) {
    return schema.typeByName.get(parentType)?.children.get(childType) ?? null;
  }
  return lowestLevelRuleFor(schema, childType);
}

export interface SubtreeContext {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly structure: Structure;
  readonly typeOverrides: ReadonlyMap<string, string>; // path → type name after the action
  readonly linkOverrides: Map<string, Record<string, readonly string[]>>; // path → key → desired targets
}

/** `path`'s `TypeDef` as it will be after the action: `typeOverrides` wins when it names a path,
 * otherwise the type it already resolves to in the (pre-action) `structure`. */
function typeDefAfter(ctx: SubtreeContext, path: string): TypeDef | null {
  const overrideName = ctx.typeOverrides.get(path);
  const typeName = overrideName ?? ctx.structure.nodes.get(path)?.type ?? null;
  return typeName === null ? null : (ctx.schema.typeByName.get(typeName) ?? null);
}

/** `path`'s `propertyLinks` as they will be after the action: the snapshot's own value merged
 * under any keys already overridden earlier in the walk (an override always wins for its key). */
function linksAfter(
  ctx: SubtreeContext,
  path: string,
): Readonly<Record<string, readonly string[]>> {
  const base = ctx.snapshot.notes.get(path)?.propertyLinks ?? {};
  const overrides = ctx.linkOverrides.get(path);
  return overrides === undefined ? base : { ...base, ...overrides };
}

/** The unique-in-order union, over every entry of `propertyParents`, of what each would pass down
 * for `key` via `inheritedTargets` (post-action type/links). Shared by the move/retype planners'
 * own-node inherit recompute and by `deriveSubtreeWrites`'s per-descendant recompute below — both
 * are "union what every property-parent contributes for this key", just over a different parent
 * list. */
export function unionInheritedTargets(
  ctx: SubtreeContext,
  propertyParents: readonly string[],
  key: string,
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const parentPath of propertyParents) {
    const targets = inheritedTargets(
      ctx.schema,
      { path: parentPath, type: typeDefAfter(ctx, parentPath), links: linksAfter(ctx, parentPath) },
      key,
    );
    for (const target of targets) {
      if (!seen.has(target)) {
        seen.add(target);
        result.push(target);
      }
    }
  }
  return result;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}

/** D's "property parents" for inheritance purposes: its primary parent (when any) first, then
 * every `extras` entry that is itself a `'property'`-kind edge — the set of parents whose own
 * `inherit`-key values D's own values should be a union of. */
function propertyParentsOf(node: StructureNode): readonly string[] {
  const parents: string[] = [];
  if (node.parent !== null) {
    parents.push(node.parent);
  }
  for (const extra of node.extras) {
    if (extra.kind === 'property') {
      parents.push(extra.parent);
    }
  }
  return parents;
}

/** `schema.inherit`, minus D's own edge property when D sits under its primary parent via a
 * `'property'` rule — that key is owned by the edge write itself, never by the generic inherit
 * recompute. */
function inheritKeysFor(schema: Schema, node: StructureNode): readonly string[] {
  const edgeProperty = node.edge?.kind === 'property' ? node.edge.property : null;
  return schema.inherit.filter((key) => key !== edgeProperty);
}

/** Every `inherit`-key write D needs given the (possibly overridden) state of its property
 * parents, in `schema.inherit` order; records each changed key into `ctx.linkOverrides` as it
 * goes, so a later descendant that treats D as one of its own property parents sees D's new
 * values. `null` when D needs no writes at all (omit D from the plan entirely). */
function writesForDescendant(
  ctx: SubtreeContext,
  path: string,
  node: StructureNode,
): readonly KeyWrite[] | null {
  const writes: KeyWrite[] = [];
  const overrides: Record<string, readonly string[]> = {};
  let changed = false;
  for (const key of inheritKeysFor(ctx.schema, node)) {
    const desired = unionInheritedTargets(ctx, propertyParentsOf(node), key);
    const current = ctx.snapshot.notes.get(path)?.propertyLinks[key] ?? [];
    if (sameSet(desired, current)) {
      continue;
    }
    writes.push({
      key,
      value: { kind: 'links', targets: desired, list: listShape(ctx.snapshot, key, path) },
    });
    overrides[key] = desired;
    changed = true;
  }
  if (!changed) {
    return null;
  }
  ctx.linkOverrides.set(path, { ...(ctx.linkOverrides.get(path) ?? {}), ...overrides });
  return writes;
}

/** The primary-tree descendants of `start` (not `start` itself), breadth-first in `children`
 * order — the traversal order `deriveSubtreeWrites` walks in. */
function collectDescendants(structure: Structure, start: string): readonly string[] {
  const result: string[] = [];
  const queue: string[] = [...(structure.nodes.get(start)?.children ?? [])];
  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined) {
      break;
    }
    result.push(path);
    const node = structure.nodes.get(path);
    if (node !== undefined) {
      queue.push(...node.children);
    }
  }
  return result;
}

/** The cascade step shared by move and retype planning: recomputes every `schema.inherit` key for
 * each descendant of `start` in the *original* (pre-action) primary tree, using `ctx.typeOverrides`
 * / `ctx.linkOverrides` to see the action's effect on ancestors as the walk proceeds top-down.
 * Descendants that need no change are omitted from the result. */
export function deriveSubtreeWrites(
  ctx: SubtreeContext,
  start: string,
): ReadonlyArray<{ path: string; writes: readonly KeyWrite[] }> {
  const results: Array<{ path: string; writes: readonly KeyWrite[] }> = [];
  for (const path of collectDescendants(ctx.structure, start)) {
    const node = ctx.structure.nodes.get(path);
    if (node === undefined) {
      continue;
    }
    const writes = writesForDescendant(ctx, path, node);
    if (writes !== null) {
      results.push({ path, writes });
    }
  }
  return results;
}
