// Small derivation helpers shared by the planner: which properties a type's own `children` rules
// bind (`edgeProperties`), what a new/edited note should inherit through an `inherit` key
// (`inheritedTargets`), whether a property should be written as a YAML list or a scalar
// (`listShape`), which edge rule connects a parent type to a child type (`ruleBetween`), and the
// move/retype link cascade down a subtree (`deriveSubtreeWrites`). No Obsidian imports.

import type { KeyWrite } from './plan-types.js';
import type { EdgeRule, Schema, TypeDef } from './schema.js';
import type { Snapshot } from './snapshot.js';
import type { Structure, StructureNode } from './structure.js';

export interface LinkPatch {
  readonly remove: readonly string[];
  readonly add: readonly string[];
}

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

/** A patch for a brand-new-relationship edge write: nothing is invalidated (`stale` is whatever
 * the caller has determined is genuinely no longer valid — see `oldContribOf`/round 2's C1 rule),
 * `newParent` is added unless already present. Only elements resolving to a path in `stale` are
 * ever removed — a value the action doesn't explain (an untagged existing note, a link outside the
 * base, a genuine sibling candidate, …) is never touched, regardless of whether it's "recognized"
 * by the structure. The actual raw element (wikilink, alias, heading form) is left untouched by
 * this step; the applier/simulator drops it because its *resolved* path is in `remove`, and
 * inserts `add` at that same position — see `patchLinksValue` in `link-patch.ts`. */
export function edgeKeyPatch(
  current: readonly string[],
  stale: ReadonlySet<string>,
  newParent: string,
): LinkPatch {
  // `newParent` is never removed even when it's also (technically) stale — reachable when it was
  // already sitting in `current` as an *inherited* value from the old parent (e.g. moving a node
  // directly under a grandparent it already inherited this same key's value from) — removing it
  // without re-adding would otherwise leave the key without its new parent at all.
  const remove = [...new Set(current.filter((t) => stale.has(t) && t !== newParent))];
  const add = current.includes(newParent) ? [] : [newParent];
  return { remove, add };
}

export interface SubtreeContext {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly structure: Structure;
  readonly typeOverrides: ReadonlyMap<string, string>; // path → type name after the action
  readonly linkOverrides: Map<string, Record<string, readonly string[]>>; // path → key → desired targets
}

/** `ctx` with every override cleared — the "before the action" view of every node's type/links,
 * used to compute what an old parent chain used to contribute to a key (`oldContribOf`,
 * `unionInheritedTargets` called with this in place of the live `ctx`). Shares `schema`/`snapshot`/
 * `structure` (those never change during planning) with the context it's derived from. */
export function bareContext(ctx: SubtreeContext): SubtreeContext {
  return {
    schema: ctx.schema,
    snapshot: ctx.snapshot,
    structure: ctx.structure,
    typeOverrides: new Map(),
    linkOverrides: new Map(),
  };
}

/** What `parentPath` currently (pre-action) contributes to `key`, straight from the *live*
 * `structure`/`snapshot` — the single old parent's own share of round 2's `U_old`, used for the
 * moved/retyped node's own edge-key write (its other old property parents, if any, never
 * contributed to *this* key in a way the action invalidates, so they're deliberately excluded —
 * see the C1 round 2 report for why folding them in here broke the "keeps a genuine extra" case). */
export function oldContribOf(
  live: Pick<SubtreeContext, 'schema' | 'structure' | 'snapshot'>,
  parentPath: string,
  key: string,
): readonly string[] {
  const { schema, structure, snapshot } = live;
  const typeName = structure.nodes.get(parentPath)?.type ?? null;
  const type = typeName === null ? null : (schema.typeByName.get(typeName) ?? null);
  const links = snapshot.notes.get(parentPath)?.propertyLinks ?? {};
  return inheritedTargets(schema, { path: parentPath, type, links }, key);
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

/** The full resolved target list a `'links'` patch leaves a key holding: `current` minus `remove`,
 * plus any `add` target it didn't already have, inserted where the first removed value sat (or at
 * the end, when nothing was removed). Round 2 C1: overrides recorded from this — the *resulting*
 * targets — not from a "desired" value computed independently of what was actually there. */
export function resultingTargets(
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

/** D's "property parents" for inheritance purposes: its primary parent (when any) first, then
 * every `extras` entry that is itself a `'property'`-kind edge — the set of parents whose own
 * `inherit`-key values D's own values should be a union of. Round 2 C1: this same structural list
 * serves as both "old" and "new" property parents for a descendant in a cascade (an ancestor's
 * move/retype doesn't restructure the descendant's own parent/extras) — only the *values* each
 * parent contributes differ, between a bare (`bareContext`) and the live/overridden context. */
export function propertyParentsOf(node: StructureNode): readonly string[] {
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
 * values. `null` when D needs no writes at all (omit D from the plan entirely).
 *
 * Round 2 C1 rule: `remove = (U_old(key) − U_new(key)) ∩ current`, `add = U_new(key) − current` —
 * `U_old` evaluated through `oldCtx` (no overrides — the true pre-action state of D's property
 * parents), `U_new` through the live `ctx`. A value D holds that no property parent ever
 * contributed (a user-added value, an "also in" link) is in neither set and is never removed. */
function writesForDescendant(
  ctx: SubtreeContext,
  oldCtx: SubtreeContext,
  path: string,
  node: StructureNode,
): readonly KeyWrite[] | null {
  const writes: KeyWrite[] = [];
  const overrides: Record<string, readonly string[]> = {};
  let changed = false;
  const parents = propertyParentsOf(node);
  for (const key of inheritKeysFor(ctx.schema, node)) {
    const uOld = unionInheritedTargets(oldCtx, parents, key);
    const uNew = unionInheritedTargets(ctx, parents, key);
    const current = ctx.snapshot.notes.get(path)?.propertyLinks[key] ?? [];
    const staleSet = new Set(uOld.filter((target) => !uNew.includes(target)));
    const remove = current.filter((target) => staleSet.has(target));
    const add = uNew.filter((target) => !current.includes(target));
    if (remove.length === 0 && add.length === 0) {
      continue;
    }
    writes.push({
      key,
      value: { kind: 'links', remove, add, list: listShape(ctx.snapshot, key, path) },
    });
    overrides[key] = resultingTargets(current, remove, add);
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
 * / `ctx.linkOverrides` to see the action's effect on ancestors as the walk proceeds top-down, and
 * `oldCtx` (`bareContext(ctx)`, built once by the caller) as the pre-action baseline for round 2's
 * `U_old`. Descendants that need no change are omitted from the result. */
export function deriveSubtreeWrites(
  ctx: SubtreeContext,
  oldCtx: SubtreeContext,
  start: string,
): ReadonlyArray<{ path: string; writes: readonly KeyWrite[] }> {
  const results: Array<{ path: string; writes: readonly KeyWrite[] }> = [];
  for (const path of collectDescendants(ctx.structure, start)) {
    const node = ctx.structure.nodes.get(path);
    if (node === undefined) {
      continue;
    }
    const writes = writesForDescendant(ctx, oldCtx, path, node);
    if (writes !== null) {
      results.push({ path, writes });
    }
  }
  return results;
}
