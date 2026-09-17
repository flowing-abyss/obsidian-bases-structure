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

/** Every property that could legally carry an edge into `childType` — the union, over every
 * type in the schema, of the property each uses to claim `childType` as a child. Scopes
 * `illegal-parent` to a note's own possible parent links, so a flattened `inherit` copy held
 * under some other type's edge property (e.g. a Problem's `category`, copied down from its
 * Meta-note parent) is never mistaken for an illegal edge. */
function edgePropertiesForChild(schema: Schema, childType: string): ReadonlySet<string> {
  const props = new Set<string>();
  for (const type of schema.types) {
    const rule = type.children.get(childType);
    if (rule?.kind === 'property') {
      props.add(rule.property);
    }
  }
  return props;
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

function isIllegalParent(
  ctx: DiagCtx,
  nodeType: string,
  property: string,
  target: string,
): boolean {
  const targetType = ctx.structure.nodes.get(target)?.type ?? null;
  const rule = ruleBetween(ctx.schema, targetType, nodeType);
  return rule?.kind !== 'property' || rule.property !== property;
}

function illegalParentDiagnostics(
  ctx: DiagCtx,
  node: StructureNode,
  property: string,
): Diagnostic[] {
  if (node.type === null || !edgePropertiesForChild(ctx.schema, node.type).has(property)) {
    return [];
  }
  const targets = ctx.snapshot.notes.get(node.path)?.propertyLinks[property] ?? [];
  return targets
    .filter((target) => isIllegalParent(ctx, node.type as string, property, target))
    .map((target) => ({
      kind: 'illegal-parent' as const,
      node: node.path,
      target,
      property,
      message: `"${name(ctx, target)}" cannot be the ${property} of "${name(ctx, node.path)}"`,
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

function mismatchedKeys(ctx: DiagCtx, node: StructureNode, parents: readonly string[]): string[] {
  const keys: string[] = [];
  for (const key of inheritKeysFor(ctx.schema, node)) {
    const expected = unionInheritedTargets(ctx.subtree, parents, key);
    const actual = ctx.snapshot.notes.get(node.path)?.propertyLinks[key] ?? [];
    if (targetsDiffer(expected, actual)) {
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
