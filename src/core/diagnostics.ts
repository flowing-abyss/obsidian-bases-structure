// Pure detection of problems a schema-described hierarchy can develop without any code noticing:
// a link the schema doesn't allow, a link to nothing, a note no type recognises, or inherited
// properties a hand-edit left out of sync with the parent. No Obsidian imports, no DOM, no side
// effects — `collectDiagnostics` only ever reads `Schema`/`Snapshot`/`Structure`.

import {
  edgeProperties,
  inheritKeysFor,
  propertyParentsOf,
  ruleBetween,
  unionInheritedTargets,
  type SubtreeContext,
} from './derive.js';
import type { Schema } from './schema.js';
import { displayName, type Snapshot } from './snapshot.js';
import type { Structure, StructureNode } from './structure.js';

export type DiagnosticKind = 'illegal-parent' | 'broken-link' | 'untyped' | 'inherit-mismatch';

export interface Diagnostic {
  readonly kind: DiagnosticKind;
  readonly node: string;
  readonly target?: string;
  readonly property?: string;
  readonly keys?: readonly string[];
  readonly message: string;
}

interface DiagCtx {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly structure: Structure;
  /** `unionInheritedTargets`'s own context, built once with empty overrides — there is no
   * pending action here, so "after" is simply "now". */
  readonly subtree: SubtreeContext;
}

function name(ctx: DiagCtx, path: string): string {
  return displayName(ctx.snapshot, path);
}

/** Every property worth inspecting on any note: the `inherit` keys (every note in the tree
 * carries a flattened copy of these) plus every property any type uses to link to a child. */
function relevantProperties(schema: Schema): ReadonlySet<string> {
  const props = new Set<string>(schema.inherit);
  for (const type of schema.types) {
    for (const property of edgeProperties(type)) {
      props.add(property);
    }
  }
  return props;
}

function brokenLinkDiagnostics(ctx: DiagCtx, node: StructureNode, property: string): Diagnostic[] {
  const raw = ctx.snapshot.notes.get(node.path)?.unresolvedLinks[property] ?? [];
  return raw.map((target) => ({
    kind: 'broken-link',
    node: node.path,
    target,
    property,
    message: `"${name(ctx, node.path)}" links to "${target}" as ${property}, but no such note exists.`,
  }));
}

/** Branch 1 of the four-branch rule: `target` is a legal direct edge into `node` under
 * `property` when a rule connects `target`'s type to `node`'s type and that rule is bound to
 * exactly this property. Shares `ruleBetween`'s "untyped root" fallback with the structure
 * builder itself — an untyped target still reads as a legal stand-in for whatever type would
 * apply there by convention, same as an untyped host qualifies as a root. */
function isDirectLegalEdge(
  ctx: DiagCtx,
  node: StructureNode,
  property: string,
  target: string,
): boolean {
  const targetType = ctx.structure.nodes.get(target)?.type ?? null;
  const rule = ruleBetween(ctx.schema, targetType, node.type as string);
  return rule?.kind === 'property' && rule.property === property;
}

/** What `node` should currently hold for an `inherit` key `property` — the same
 * `unionInheritedTargets`/`propertyParentsOf` pairing the repair action uses, so a diagnostic and
 * "Fix inheritance" can never disagree. Callers only reach this once `property` is confirmed to be
 * an `inherit` key. */
function expectedTargetsFor(
  ctx: DiagCtx,
  node: StructureNode,
  property: string,
): readonly string[] {
  return unionInheritedTargets(ctx.subtree, propertyParentsOf(node), property);
}

/** Cached per `schema` object identity — a parsed schema never changes shape, and every
 * `collectDiagnostics` call in the same render shares it, so there's no reason to re-walk the
 * type graph on every node. */
const inheritableKeysCache = new WeakMap<Schema, ReadonlyMap<string, ReadonlySet<string>>>();

/** `typeName`'s own inheritable keys: the property of every `P → typeName` rule (when it's a
 * `'property'` rule — `links`/`backlinks` never contribute a key of their own) plus everything
 * each such `P` can itself carry, recursively. `visiting` breaks a cycle in the type graph (e.g. a
 * `Hierarchy → Hierarchy` `file.backlinks` rule): a type still being computed contributes nothing
 * further to itself, since whatever it can carry is already flowing in from its other parents. */
function computeInheritableKeys(
  schema: Schema,
  typeName: string,
  visiting: Set<string>,
  memo: Map<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const cached = memo.get(typeName);
  if (cached !== undefined) {
    return cached;
  }
  if (visiting.has(typeName)) {
    return new Set();
  }
  visiting.add(typeName);
  const keys = new Set<string>();
  for (const parentType of schema.types) {
    const rule = parentType.children.get(typeName);
    if (rule === undefined) {
      continue;
    }
    if (rule.kind === 'property') {
      keys.add(rule.property);
    }
    for (const key of computeInheritableKeys(schema, parentType.name, visiting, memo)) {
      keys.add(key);
    }
  }
  visiting.delete(typeName);
  memo.set(typeName, keys);
  return keys;
}

/** Every type's inheritable-key set, per `schema` — see `computeInheritableKeys`. */
function inheritableKeysByType(schema: Schema): ReadonlyMap<string, ReadonlySet<string>> {
  const cached = inheritableKeysCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const memo = new Map<string, ReadonlySet<string>>();
  for (const type of schema.types) {
    computeInheritableKeys(schema, type.name, new Set(), memo);
  }
  inheritableKeysCache.set(schema, memo);
  return memo;
}

/** `true` when `property` is one `typeName` could ever hold by inheritance, per the schema alone
 * — independent of whether any *current* ancestor actually supplies a value right now, so a
 * broken ancestor further up the chain can never turn a schema-legal property red on an otherwise
 * healthy descendant (see `isIllegalTarget`'s branch 3/4 split). */
function typeCanInherit(schema: Schema, typeName: string, property: string): boolean {
  return inheritableKeysByType(schema).get(typeName)?.has(property) ?? false;
}

/** `true` when `target` could ever be the *origin* of `property`'s value — its own type is
 * untyped (tolerated, same as `ruleBetween`'s "untyped root" fallback) or uses `property` as its
 * own edge property (the same `edgeProperties`/`inheritedTargets` shortcut: a note IS the value a
 * descendant inherits for a key exactly when its own type hands that key to *its* children).
 * `typeCanInherit` alone would let *any* typed target ride branch 3 as long as `property` is
 * reachable somewhere in `node`'s type's ancestry — this keeps a target of a structurally
 * unrelated type (e.g. a Problem standing in for a Hierarchy's `category`) out of the amber
 * bucket, so it's still `illegal-parent`. */
function isPlausibleOrigin(ctx: DiagCtx, property: string, target: string): boolean {
  const targetType = ctx.structure.nodes.get(target)?.type ?? null;
  if (targetType === null) {
    return true;
  }
  const typeDef = ctx.schema.typeByName.get(targetType);
  return typeDef !== undefined && edgeProperties(typeDef).has(property);
}

/** Branches 2-4: a non-direct-edge `target` is still legal when it's a flattened inherited copy
 * *right now* (branch 2, `unionInheritedTargets`) or `property` is one `node`'s type could ever
 * hold by inheritance per the schema alone *and* `target` is a plausible origin for it (branch 3,
 * folded into `inherit-mismatch` at the key level rather than flagged per link) — asking "is the
 * *current* expected set non-empty" instead would make a broken ancestor's own violation cascade a
 * hard `illegal-parent` onto every otherwise-healthy descendant sharing that key, with no repair
 * action available for red. Anything left over — a property outside `inherit` (a pure edge
 * property, never a mismatch candidate), a property the schema can never route to `node`'s type at
 * all, or a target whose own type could never have originated it — is illegal (branch 4). The
 * view's own root is exempt outright: nothing parents it by construction, so none of its own links
 * are ever "wrong", the same reasoning `inheritMismatchDiagnostic` already applies via
 * `parents.length === 0`. */
function isIllegalTarget(
  ctx: DiagCtx,
  node: StructureNode,
  property: string,
  target: string,
): boolean {
  if (node.path === ctx.structure.root) {
    return false;
  }
  if (isDirectLegalEdge(ctx, node, property, target)) {
    return false;
  }
  if (!ctx.schema.inherit.includes(property)) {
    return true;
  }
  if (expectedTargetsFor(ctx, node, property).includes(target)) {
    return false;
  }
  if (!typeCanInherit(ctx.schema, node.type as string, property)) {
    return true;
  }
  return !isPlausibleOrigin(ctx, property, target);
}

function illegalTargetsFor(
  ctx: DiagCtx,
  node: StructureNode,
  property: string,
  targets: readonly string[],
): readonly string[] {
  return targets.filter((target) => isIllegalTarget(ctx, node, property, target));
}

/** Both types when the target is typed; falls back to the note's own name otherwise — matches
 * the four-branch rule's message contract ("use type names, not note names, when both are
 * typed"). */
function typeLabel(ctx: DiagCtx, path: string): string {
  return ctx.structure.nodes.get(path)?.type ?? name(ctx, path);
}

function illegalParentDiagnostics(
  ctx: DiagCtx,
  node: StructureNode,
  property: string,
): Diagnostic[] {
  if (node.type === null) {
    return [];
  }
  const targets = ctx.snapshot.notes.get(node.path)?.propertyLinks[property] ?? [];
  return illegalTargetsFor(ctx, node, property, targets).map((target) => ({
    kind: 'illegal-parent' as const,
    node: node.path,
    target,
    property,
    message: `"${typeLabel(ctx, target)}" cannot be the ${property} of "${typeLabel(ctx, node.path)}"`,
  }));
}

function propertyDiagnostics(ctx: DiagCtx, node: StructureNode): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const property of relevantProperties(ctx.schema)) {
    diagnostics.push(...brokenLinkDiagnostics(ctx, node, property));
    diagnostics.push(...illegalParentDiagnostics(ctx, node, property));
  }
  return diagnostics;
}

function untypedDiagnostic(ctx: DiagCtx, node: StructureNode): Diagnostic {
  return {
    kind: 'untyped',
    node: node.path,
    message: `"${name(ctx, node.path)}" does not match any of the schema's types.`,
  };
}

/** `true` when `remaining` holds a target `expected` (the union every property parent
 * contributes) does not — a child may narrow its parents' values, but never add one of its own. */
function hasExtraValue(expected: readonly string[], remaining: readonly string[]): boolean {
  const expectedSet = new Set(expected);
  return remaining.some((target) => !expectedSet.has(target));
}

/** `true` when some single parent passes a non-empty value for `key` that `remaining` shares
 * nothing with — narrowing to a subset of one parent's values is fine, but dropping a parent's
 * contribution entirely (including down to nothing) is not. */
function losesAParent(
  ctx: DiagCtx,
  parents: readonly string[],
  key: string,
  remaining: readonly string[],
): boolean {
  return parents.some((parent) => {
    const provided = unionInheritedTargets(ctx.subtree, [parent], key);
    return provided.length > 0 && !provided.some((target) => remaining.includes(target));
  });
}

/** A key mismatches when what's left after setting aside its own illegal links (already reported
 * separately, one `illegal-parent` per link) either holds a value none of `inherit`'s union
 * supplies, or shares nothing with some parent that supplies something — a child may narrow to a
 * non-empty subset of what each contributing parent passes down, but never add its own value or
 * drop a parent's contribution outright. */
function mismatchedKeys(ctx: DiagCtx, node: StructureNode, parents: readonly string[]): string[] {
  const keys: string[] = [];
  for (const key of inheritKeysFor(ctx.schema, node)) {
    const expected = unionInheritedTargets(ctx.subtree, parents, key);
    const actual = ctx.snapshot.notes.get(node.path)?.propertyLinks[key] ?? [];
    const illegal = illegalTargetsFor(ctx, node, key, actual);
    const remaining = actual.filter((target) => !illegal.includes(target));
    if (hasExtraValue(expected, remaining) || losesAParent(ctx, parents, key, remaining)) {
      keys.push(key);
    }
  }
  return keys;
}

/** `null` when `node` has no property parent at all (the root, or any other parentless top) —
 * there is nothing to inherit from, so its own values are never "wrong", just uninherited. */
function inheritMismatchDiagnostic(ctx: DiagCtx, node: StructureNode): Diagnostic | null {
  const parents = propertyParentsOf(node);
  if (parents.length === 0) {
    return null;
  }
  const keys = mismatchedKeys(ctx, node, parents);
  if (keys.length === 0) {
    return null;
  }
  return {
    kind: 'inherit-mismatch',
    node: node.path,
    keys,
    message: `"${name(ctx, node.path)}" does not match its parent for ${keys.join(', ')}.`,
  };
}

function diagnosticsForNode(ctx: DiagCtx, node: StructureNode): Diagnostic[] {
  if (node.type === null) {
    return [untypedDiagnostic(ctx, node)];
  }
  const diagnostics = propertyDiagnostics(ctx, node);
  const mismatch = inheritMismatchDiagnostic(ctx, node);
  if (mismatch !== null) {
    diagnostics.push(mismatch);
  }
  return diagnostics;
}

export function collectDiagnostics(
  schema: Schema,
  snapshot: Snapshot,
  structure: Structure,
): readonly Diagnostic[] {
  const ctx: DiagCtx = {
    schema,
    snapshot,
    structure,
    subtree: { schema, snapshot, structure, typeOverrides: new Map(), linkOverrides: new Map() },
  };
  const diagnostics: Diagnostic[] = [];
  for (const node of structure.nodes.values()) {
    diagnostics.push(...diagnosticsForNode(ctx, node));
  }
  return diagnostics;
}
