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

/** Branches 2-4: a non-direct-edge `target` is still legal when it's a flattened inherited copy
 * (branch 2) or `node` has a well-defined (non-empty) expected value for `property` — the types
 * are compatible somewhere up the chain, this is just a stale disagreement (branch 3, folded into
 * `inherit-mismatch` at the key level rather than flagged per link). Anything left over — a
 * property outside `inherit` (a pure edge property, never a mismatch candidate), or `node` has no
 * property parent to explain the value at all — is illegal (branch 4). The view's own root is
 * exempt outright: nothing parents it by construction, so none of its own links are ever "wrong",
 * the same reasoning `inheritMismatchDiagnostic` already applies via `parents.length === 0`. */
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
  const expected = expectedTargetsFor(ctx, node, property);
  return !(expected.includes(target) || expected.length > 0);
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

function targetsDiffer(expected: readonly string[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length) {
    return true;
  }
  const expectedSet = new Set(expected);
  return actual.some((target) => !expectedSet.has(target));
}

/** A key mismatches when what's left after setting aside its own illegal links (already reported
 * separately, one `illegal-parent` per link) still disagrees with what `inherit` expects — an
 * illegal link is never double-counted as a key-level mismatch too. */
function mismatchedKeys(ctx: DiagCtx, node: StructureNode, parents: readonly string[]): string[] {
  const keys: string[] = [];
  for (const key of inheritKeysFor(ctx.schema, node)) {
    const expected = unionInheritedTargets(ctx.subtree, parents, key);
    const actual = ctx.snapshot.notes.get(node.path)?.propertyLinks[key] ?? [];
    const illegal = illegalTargetsFor(ctx, node, key, actual);
    const remaining = actual.filter((target) => !illegal.includes(target));
    if (targetsDiffer(expected, remaining)) {
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
