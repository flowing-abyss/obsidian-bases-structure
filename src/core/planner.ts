// The planner: turns a user-facing `Action` into a verified `Plan`, or a rejection with a
// stable, user-facing reason. Only `'create'` is implemented here — `'move'`/`'retype'` are
// rejected with a placeholder reason until a later task fills them in (reusing the same
// `applyPlan`-based verification step). No Obsidian imports.

import { inheritedTargets, listShape } from './derive.js';
import type { EdgeRule, Schema, TypeDef } from './schema.js';
import { applyPlan } from './simulate.js';
import type { NoteData, Snapshot } from './snapshot.js';
import { buildStructure, type Structure, type StructureNode } from './structure.js';

export type Action =
  | {
      readonly kind: 'create';
      readonly parent: string;
      readonly type: string;
      readonly name: string;
    }
  | { readonly kind: 'move'; readonly node: string; readonly parent: string }
  | { readonly kind: 'retype'; readonly node: string; readonly type: string };

export type WriteValue =
  | { readonly kind: 'links'; readonly targets: readonly string[]; readonly list: boolean }
  | { readonly kind: 'literal'; readonly value: unknown };

export interface KeyWrite {
  readonly key: string;
  readonly value: WriteValue | null;
}

export interface Plan {
  readonly creations: ReadonlyArray<{
    readonly path: string;
    readonly writes: readonly KeyWrite[];
    readonly bodyLinks: readonly string[];
  }>;
  readonly changes: ReadonlyArray<{ readonly path: string; readonly writes: readonly KeyWrite[] }>;
  readonly appends: ReadonlyArray<{ readonly path: string; readonly target: string }>;
  readonly moves: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: Plan; readonly focus: string }
  | { readonly ok: false; readonly reason: string };

export interface PlanEnv {
  readonly defaultFolder: string; // '' = vault root
  readonly exists: (path: string) => boolean; // any file in the vault at this path
}

const FORBIDDEN_NAME_CHARS = ['\\', '/', ':', '*', '?', '"', '<', '>', '|', '#', '^', '[', ']'];

/** Every forbidden character actually present in `name`, deduped, in order of first appearance —
 * exactly what the rejection message lists. */
function forbiddenChars(name: string): string {
  const forbidden = new Set(FORBIDDEN_NAME_CHARS);
  const seen = new Set<string>();
  let result = '';
  for (const char of name) {
    if (forbidden.has(char) && !seen.has(char)) {
      seen.add(char);
      result += char;
    }
  }
  return result;
}

/** `'a/b/c.md'` → `'c'`; a path without a `.md` suffix is returned as-is. */
function lastSegmentBasename(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const fileName = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  return fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
}

/** The parent's `NoteData.basename` when known, else the last path segment without `.md`. */
function parentBasename(snapshot: Snapshot, parent: string): string {
  return snapshot.notes.get(parent)?.basename ?? lastSegmentBasename(parent);
}

/** Among the schema's types, the lowest-`level` one whose `children` map has a rule for
 * `childName` — "the recipe that would apply if `childName` were created under an untyped root". */
function lowestLevelRuleFor(
  schema: Schema,
  childName: string,
): { readonly type: TypeDef; readonly rule: EdgeRule } | null {
  let best: { readonly type: TypeDef; readonly rule: EdgeRule } | null = null;
  for (const candidate of schema.types) {
    const rule = candidate.children.get(childName);
    if (rule === undefined) {
      continue;
    }
    if (best === null || candidate.level < best.type.level) {
      best = { type: candidate, rule };
    }
  }
  return best;
}

function ruleForCreate(
  schema: Schema,
  parentTypeName: string | null,
  type: string,
): EdgeRule | null {
  if (parentTypeName !== null) {
    return schema.typeByName.get(parentTypeName)?.children.get(type) ?? null;
  }
  return lowestLevelRuleFor(schema, type)?.rule ?? null;
}

interface CreateFields {
  readonly childType: TypeDef;
  readonly rule: EdgeRule;
  readonly path: string;
  readonly parentNode: StructureNode;
}

type CreateValidation =
  | { readonly ok: true; readonly fields: CreateFields }
  | { readonly ok: false; readonly reason: string };

type CreateAction = Extract<Action, { kind: 'create' }>;

interface CreateRequest {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly structure: Structure;
  readonly env: PlanEnv;
}

/** The six rejection checks from the binding decisions, in order — the first one that fires wins.
 * Returns the resolved `childType`/`rule`/`path`/`parentNode` on success, so the caller doesn't
 * have to re-derive them. */
function validateCreate(request: CreateRequest, action: CreateAction): CreateValidation {
  const { schema, snapshot, structure, env } = request;
  const childType = schema.typeByName.get(action.type);
  if (childType === undefined) {
    return { ok: false, reason: `Unknown type "${action.type}"` };
  }
  const trimmedName = action.name.trim();
  if (trimmedName === '') {
    return { ok: false, reason: 'Name is empty' };
  }
  const badChars = forbiddenChars(action.name);
  if (badChars !== '') {
    return { ok: false, reason: `Name contains characters that are not allowed: ${badChars}` };
  }
  const parentNode = structure.nodes.get(action.parent);
  if (parentNode === undefined) {
    return {
      ok: false,
      reason: `"${parentBasename(snapshot, action.parent)}" is not in the structure`,
    };
  }
  const rule = ruleForCreate(schema, parentNode.type, action.type);
  if (rule === null) {
    return {
      ok: false,
      reason: `"${action.type}" cannot be placed under "${parentBasename(snapshot, action.parent)}"`,
    };
  }
  const folder = childType.match.folder ?? env.defaultFolder;
  const path = folder === '' ? `${trimmedName}.md` : `${folder}/${trimmedName}.md`;
  if (env.exists(path) || snapshot.notes.has(path)) {
    return { ok: false, reason: `A note already exists at "${path}"` };
  }
  return { ok: true, fields: { childType, rule, path, parentNode } };
}

interface CreateCtx {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly parent: string;
  readonly parentType: TypeDef | null;
  readonly parentNote: NoteData | undefined;
}

function addTagsWrite(writes: Map<string, WriteValue>, childType: TypeDef): void {
  if (childType.match.tags.length > 0 && !writes.has('tags')) {
    writes.set('tags', { kind: 'literal', value: [...childType.match.tags] });
  }
}

function addPropertyWrites(writes: Map<string, WriteValue>, childType: TypeDef): void {
  for (const [key, value] of childType.match.properties) {
    if (!writes.has(key)) {
      writes.set(key, { kind: 'literal', value });
    }
  }
}

function addRuleWrite(writes: Map<string, WriteValue>, ctx: CreateCtx, rule: EdgeRule): void {
  if (rule.kind !== 'property' || writes.has(rule.property)) {
    return;
  }
  writes.set(rule.property, {
    kind: 'links',
    targets: [ctx.parent],
    list: listShape(ctx.snapshot, rule.property, null),
  });
}

/** Every `schema.inherit` key except the rule's own property (only excluded when the rule is
 * itself a `'property'` rule — that key was already written by `addRuleWrite`). Earlier writes
 * (tags, recipe properties, the rule's own property) always win a key collision, since every
 * `add*Write` here checks `writes.has(key)` before setting it. */
function addInheritWrites(writes: Map<string, WriteValue>, ctx: CreateCtx, rule: EdgeRule): void {
  const parentLinks = ctx.parentNote?.propertyLinks ?? {};
  for (const key of ctx.schema.inherit) {
    if (rule.kind === 'property' && key === rule.property) {
      continue;
    }
    if (writes.has(key)) {
      continue;
    }
    const targets = inheritedTargets(
      ctx.schema,
      { path: ctx.parent, type: ctx.parentType, links: parentLinks },
      key,
    );
    if (targets.length > 0) {
      writes.set(key, { kind: 'links', targets, list: listShape(ctx.snapshot, key, null) });
    }
  }
}

function buildWrites(ctx: CreateCtx, childType: TypeDef, rule: EdgeRule): readonly KeyWrite[] {
  const writes = new Map<string, WriteValue>();
  addTagsWrite(writes, childType);
  addPropertyWrites(writes, childType);
  addRuleWrite(writes, ctx, rule);
  addInheritWrites(writes, ctx, rule);
  return Array.from(writes, ([key, value]) => ({ key, value }));
}

interface VerifyTarget {
  readonly path: string;
  readonly type: string;
  readonly parent: string;
  readonly parentBase: string;
}

/** Rebuilds the structure after hypothetically applying `plan` and checks the new note landed
 * exactly where requested. `null` = verified. Otherwise the exact rejection reason: suffixed with
 * "(not recognised as ...)" when the note didn't make it into the graph at all, or "(recognised
 * as ...)" when it did but resolved to a different type; a right-type-wrong-parent outcome gets
 * the bare base message (this can only happen for `'create'`, never for a plain non-node type). */
function verifyCreate(
  schema: Schema,
  snapshot: Snapshot,
  plan: Plan,
  target: VerifyTarget,
): string | null {
  const after = buildStructure(schema, applyPlan(snapshot, plan));
  const afterNode = after.nodes.get(target.path);
  if (afterNode?.type === target.type && afterNode.parent === target.parent) {
    return null;
  }
  const base = `The new note would not appear under "${target.parentBase}"`;
  if (afterNode === undefined) {
    return `${base} (not recognised as "${target.type}")`;
  }
  if (afterNode.type !== null && afterNode.type !== target.type) {
    return `${base} (recognised as "${afterNode.type}")`;
  }
  return base;
}

function planCreate(
  schema: Schema,
  snapshot: Snapshot,
  action: CreateAction,
  env: PlanEnv,
): PlanResult {
  const structure = buildStructure(schema, snapshot);
  const validation = validateCreate({ schema, snapshot, structure, env }, action);
  if (!validation.ok) {
    return validation;
  }
  const { childType, rule, path, parentNode } = validation.fields;
  const parentType =
    parentNode.type === null ? null : (schema.typeByName.get(parentNode.type) ?? null);
  const ctx: CreateCtx = {
    schema,
    snapshot,
    parent: action.parent,
    parentType,
    parentNote: snapshot.notes.get(action.parent),
  };
  const writes = buildWrites(ctx, childType, rule);
  const bodyLinks = rule.kind === 'links' ? [action.parent] : [];
  const appends = rule.kind === 'backlinks' ? [{ path: action.parent, target: path }] : [];
  const plan: Plan = { creations: [{ path, writes, bodyLinks }], changes: [], appends, moves: [] };
  const failure = verifyCreate(schema, snapshot, plan, {
    path,
    type: action.type,
    parent: action.parent,
    parentBase: parentBasename(snapshot, action.parent),
  });
  if (failure !== null) {
    return { ok: false, reason: failure };
  }
  return { ok: true, plan, focus: path };
}

export function planAction(
  schema: Schema,
  snapshot: Snapshot,
  action: Action,
  env: PlanEnv,
): PlanResult {
  switch (action.kind) {
    case 'create':
      return planCreate(schema, snapshot, action, env);
    case 'move':
    case 'retype':
      return { ok: false, reason: 'Not supported yet' };
  }
}

function levelOf(schema: Schema, typeName: string): number {
  return schema.typeByName.get(typeName)?.level ?? Number.MAX_SAFE_INTEGER;
}

function typedChildOptions(
  schema: Schema,
  typeName: string,
): ReadonlyArray<{ type: string; rule: EdgeRule }> {
  const typeDef = schema.typeByName.get(typeName);
  if (typeDef === undefined) {
    return [];
  }
  return Array.from(typeDef.children, ([type, rule]) => ({ type, rule })).sort(
    (a, b) => levelOf(schema, a.type) - levelOf(schema, b.type),
  );
}

function untypedChildOptions(schema: Schema): ReadonlyArray<{ type: string; rule: EdgeRule }> {
  const ordered = [...schema.types].sort((a, b) => a.level - b.level);
  const results: Array<{ type: string; rule: EdgeRule }> = [];
  for (const type of ordered) {
    const found = lowestLevelRuleFor(schema, type.name);
    if (found !== null) {
      results.push({ type: type.name, rule: found.rule });
    }
  }
  return results;
}

export function childOptions(
  schema: Schema,
  structure: Structure,
  parent: string,
): ReadonlyArray<{ type: string; rule: EdgeRule }> {
  const node = structure.nodes.get(parent);
  if (node === undefined) {
    return [];
  }
  return node.type === null ? untypedChildOptions(schema) : typedChildOptions(schema, node.type);
}
