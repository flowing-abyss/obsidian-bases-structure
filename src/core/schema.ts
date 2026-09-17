// Pure parsing of the Bases "structure" view config into a `Schema`. No Obsidian imports —
// `read` is a plain `(key: string) => unknown` getter over already-YAML-parsed data, so every
// value here is `unknown` until validated.

export type EdgeKind = 'property' | 'links' | 'backlinks';

/** Which axis the graph layout grows along — `'right'` (the default, depth spreads left to
 * right) or `'down'` (depth spreads top to bottom, siblings spread horizontally). The outline
 * layout ignores this entirely; it only ever affects `layoutTree`/the graph renderer. */
export type Direction = 'right' | 'down';

export interface EdgeRule {
  readonly kind: EdgeKind;
  readonly property: string;
}

export interface TypeMatch {
  readonly tags: readonly string[];
  readonly folder: string | null;
  readonly properties: ReadonlyArray<readonly [string, string]>;
}

export interface TypeDef {
  readonly name: string;
  readonly level: number;
  readonly match: TypeMatch;
  readonly specificity: number;
  readonly children: ReadonlyMap<string, EdgeRule>;
}

export interface Schema {
  readonly types: readonly TypeDef[];
  readonly typeByName: ReadonlyMap<string, TypeDef>;
  readonly inherit: readonly string[];
  readonly layout: 'graph' | 'outline';
  readonly direction: Direction;
  /** D2: label graph edges with the child's type name (`GraphRenderer` only — the outline ignores
   * it entirely). `true` only for the literal boolean `true`, matching `direction`'s own
   * never-an-issue, always-a-safe-fallback treatment of a purely cosmetic option. */
  readonly edgeLabels: boolean;
}

export interface SchemaIssue {
  readonly key: string;
  readonly message: string;
}

type ConfigReader = (key: string) => unknown;

/** Shared "where am I / where do issues go" context threaded through the leaf parsers. */
interface Ctx {
  readonly key: string;
  readonly issues: SchemaIssue[];
}

interface ChildrenCtx extends Ctx {
  readonly knownNames: ReadonlySet<string>;
  readonly parentRaw: unknown;
}

interface RawTypeEntry {
  readonly name: string;
  readonly value: Record<string, unknown> | null;
}

interface TypeSkeleton {
  readonly name: string;
  readonly level: number;
  readonly match: TypeMatch;
  readonly specificity: number;
  readonly rawValue: Record<string, unknown> | null;
}

const NOTE_PREFIX = 'note.';
const LINKS_VALUE = 'file.links';
const BACKLINKS_VALUE = 'file.backlinks';

function child(ctx: Ctx, suffix: string): Ctx {
  return { key: `${ctx.key}.${suffix}`, issues: ctx.issues };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function stripNotePrefix(value: string): string {
  return value.startsWith(NOTE_PREFIX) ? value.slice(NOTE_PREFIX.length) : value;
}

function normalizeTag(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed;
}

/** Strips leading/trailing `/` without regex backtracking risk. */
function stripSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') {
    start += 1;
  }
  while (end > start && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(start, end);
}

/** `file.links`/`file.backlinks` keep their special kind; otherwise a `property` rule with a
 * leading `note.` stripped. Callers must pass an already-trimmed, non-empty string. Returns
 * `null` when stripping `note.` leaves an empty property name (e.g. `'note.'` alone) — that is
 * just as much an empty rule as an empty raw string, so it must be rejected the same way. */
function edgeRuleFromString(trimmed: string): EdgeRule | null {
  if (trimmed === LINKS_VALUE) {
    return { kind: 'links', property: LINKS_VALUE };
  }
  if (trimmed === BACKLINKS_VALUE) {
    return { kind: 'backlinks', property: BACKLINKS_VALUE };
  }
  const property = stripNotePrefix(trimmed);
  return property === '' ? null : { kind: 'property', property };
}

/** Validates and trims `raw`, then delegates to `edgeRuleFromString`. Empty string, before or
 * after `note.` normalisation, is an issue. */
function parseEdgeRule(raw: unknown, ctx: Ctx): EdgeRule | null {
  if (typeof raw !== 'string') {
    ctx.issues.push({ key: ctx.key, message: 'must be a string' });
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    ctx.issues.push({ key: ctx.key, message: 'must not be empty' });
    return null;
  }
  const rule = edgeRuleFromString(trimmed);
  if (rule === null) {
    ctx.issues.push({ key: ctx.key, message: 'must not be empty' });
    return null;
  }
  return rule;
}

function parseTagList(raw: readonly unknown[], ctx: Ctx): string[] {
  const tags: string[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== 'string') {
      ctx.issues.push({ key: `${ctx.key}.${index}`, message: 'tag must be a string' });
      return;
    }
    tags.push(normalizeTag(item));
  });
  return tags;
}

function parseTags(raw: unknown, ctx: Ctx): readonly string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (typeof raw === 'string') {
    return [normalizeTag(raw)];
  }
  const list = toArray(raw);
  if (list === null) {
    ctx.issues.push({ key: ctx.key, message: 'tag must be a string or list' });
    return [];
  }
  return parseTagList(list, ctx);
}

function parseFolder(raw: unknown, ctx: Ctx): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    ctx.issues.push({ key: ctx.key, message: 'folder must be a string' });
    return null;
  }
  const trimmed = stripSlashes(raw.trim());
  return trimmed === '' ? null : trimmed;
}

function parsePropertyEntry(
  name: string,
  raw: unknown,
  ctx: Ctx,
): readonly [string, string] | null {
  if (typeof raw === 'string') {
    return [name, raw];
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return [name, String(raw)];
  }
  ctx.issues.push({ key: ctx.key, message: 'property value must be a scalar' });
  return null;
}

function parseProperties(raw: unknown, ctx: Ctx): ReadonlyArray<readonly [string, string]> {
  if (raw === undefined || raw === null) {
    return [];
  }
  const record = toRecord(raw);
  if (record === null) {
    ctx.issues.push({ key: ctx.key, message: 'property must be a map' });
    return [];
  }
  const entries: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(record)) {
    const entry = parsePropertyEntry(name, value, child(ctx, name));
    if (entry !== null) {
      entries.push(entry);
    }
  }
  return entries;
}

function computeSpecificity(match: TypeMatch): number {
  return match.tags.length + (match.folder === null ? 0 : 1) + match.properties.length;
}

function parseTypeMatch(raw: Record<string, unknown> | null, ctx: Ctx): TypeMatch {
  if (raw === null) {
    return { tags: [], folder: null, properties: [] };
  }
  return {
    tags: parseTags(raw['tag'], child(ctx, 'tag')),
    folder: parseFolder(raw['folder'], child(ctx, 'folder')),
    properties: parseProperties(raw['property'], child(ctx, 'property')),
  };
}

function addListChild(
  item: unknown,
  rule: EdgeRule,
  ctx: ChildrenCtx,
  children: Map<string, EdgeRule>,
): void {
  if (typeof item !== 'string') {
    ctx.issues.push({ key: ctx.key, message: 'child type name must be a string' });
    return;
  }
  if (!ctx.knownNames.has(item)) {
    ctx.issues.push({ key: `${ctx.key}.${item}`, message: 'unknown type' });
    return;
  }
  children.set(item, rule);
}

/** `children: [A, B]` — each entry gets the edge rule derived from the top-level `parent`. */
function parseChildrenListForm(raw: readonly unknown[], ctx: ChildrenCtx): Map<string, EdgeRule> {
  const children = new Map<string, EdgeRule>();
  if (!isNonEmptyString(ctx.parentRaw)) {
    ctx.issues.push({ key: ctx.key, message: 'list form needs "parent"' });
    return children;
  }
  const rule = edgeRuleFromString(ctx.parentRaw.trim());
  if (rule === null) {
    ctx.issues.push({ key: ctx.key, message: 'must not be empty' });
    return children;
  }
  for (const item of raw) {
    addListChild(item, rule, ctx, children);
  }
  return children;
}

/** `children: { ChildType: propertyName }`. */
function parseChildrenMapForm(
  raw: Record<string, unknown>,
  ctx: ChildrenCtx,
): Map<string, EdgeRule> {
  const children = new Map<string, EdgeRule>();
  for (const [childName, value] of Object.entries(raw)) {
    if (!ctx.knownNames.has(childName)) {
      ctx.issues.push({ key: `${ctx.key}.${childName}`, message: 'unknown type' });
      continue;
    }
    const rule = parseEdgeRule(value, { key: `${ctx.key}.${childName}`, issues: ctx.issues });
    if (rule !== null) {
      children.set(childName, rule);
    }
  }
  return children;
}

function parseChildren(raw: unknown, ctx: ChildrenCtx): Map<string, EdgeRule> {
  if (raw === undefined || raw === null) {
    return new Map();
  }
  const list = toArray(raw);
  if (list !== null) {
    return parseChildrenListForm(list, ctx);
  }
  const record = toRecord(raw);
  if (record !== null) {
    return parseChildrenMapForm(record, ctx);
  }
  ctx.issues.push({ key: ctx.key, message: 'children must be a map or list' });
  return new Map();
}

function collectRawTypeEntries(
  record: Record<string, unknown>,
  issues: SchemaIssue[],
): RawTypeEntry[] {
  const entries: RawTypeEntry[] = [];
  for (const [name, value] of Object.entries(record)) {
    if (value === null || value === undefined) {
      entries.push({ name, value: null });
      continue;
    }
    const parsed = toRecord(value);
    if (parsed === null) {
      issues.push({ key: `types.${name}`, message: 'type must be a map or empty' });
      continue;
    }
    entries.push({ name, value: parsed });
  }
  return entries;
}

function buildSkeleton(entry: RawTypeEntry, level: number, issues: SchemaIssue[]): TypeSkeleton {
  const key = `types.${entry.name}`;
  const match = parseTypeMatch(entry.value, { key, issues });
  return {
    name: entry.name,
    level,
    match,
    specificity: computeSpecificity(match),
    rawValue: entry.value,
  };
}

function attachChildren(
  skeleton: TypeSkeleton,
  knownNames: ReadonlySet<string>,
  parentRaw: unknown,
  issues: SchemaIssue[],
): TypeDef {
  const childrenRaw = skeleton.rawValue === null ? undefined : skeleton.rawValue['children'];
  const ctx: ChildrenCtx = {
    key: `types.${skeleton.name}.children`,
    issues,
    knownNames,
    parentRaw,
  };
  return {
    name: skeleton.name,
    level: skeleton.level,
    match: skeleton.match,
    specificity: skeleton.specificity,
    children: parseChildren(childrenRaw, ctx),
  };
}

function parseTypedMode(
  record: Record<string, unknown>,
  parentRaw: unknown,
  issues: SchemaIssue[],
): TypeDef[] {
  const entries = collectRawTypeEntries(record, issues);
  const skeletons = entries.map((entry, index) => buildSkeleton(entry, index, issues));
  const knownNames = new Set(skeletons.map((skeleton) => skeleton.name));
  return skeletons.map((skeleton) => attachChildren(skeleton, knownNames, parentRaw, issues));
}

/** `parentRaw` must already be a non-empty string (checked by the caller via
 * `isNonEmptyString`), but normalising it (e.g. `note.` alone strips to `''`) can still fail. */
function buildImplicitType(parentRaw: string, issues: SchemaIssue[]): TypeDef {
  const rule = edgeRuleFromString(parentRaw.trim());
  const children = new Map<string, EdgeRule>();
  if (rule === null) {
    issues.push({ key: 'parent', message: 'must not be empty' });
  } else {
    children.set('', rule);
  }
  return {
    name: '',
    level: 0,
    match: { tags: [], folder: null, properties: [] },
    specificity: 0,
    children,
  };
}

function resolveTypesRecord(raw: unknown, issues: SchemaIssue[]): Record<string, unknown> | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const record = toRecord(raw);
  if (record === null) {
    issues.push({ key: 'types', message: 'types must be a map' });
  }
  return record;
}

function resolveTypes(read: ConfigReader, issues: SchemaIssue[]): TypeDef[] {
  const parentRaw = read('parent');
  const typesRecord = resolveTypesRecord(read('types'), issues);
  if (typesRecord !== null) {
    return parseTypedMode(typesRecord, parentRaw, issues);
  }
  if (isNonEmptyString(parentRaw)) {
    return [buildImplicitType(parentRaw, issues)];
  }
  issues.push({ key: '', message: 'Set "parent" or "types"' });
  return [];
}

function normalizeInheritItem(item: unknown, issues: SchemaIssue[]): string | null {
  if (typeof item !== 'string') {
    issues.push({ key: 'inherit', message: 'inherit values must be strings' });
    return null;
  }
  const normalized = stripNotePrefix(item.trim());
  if (normalized === '') {
    issues.push({ key: 'inherit', message: 'must not be empty' });
    return null;
  }
  return normalized;
}

function parseInherit(raw: unknown, issues: SchemaIssue[]): readonly string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  const items = toArray(raw) ?? [raw];
  const result: string[] = [];
  for (const item of items) {
    const normalized = normalizeInheritItem(item, issues);
    if (normalized !== null) {
      result.push(normalized);
    }
  }
  return result;
}

function parseLayout(raw: unknown): 'graph' | 'outline' {
  return raw === 'outline' ? 'outline' : 'graph';
}

/** Anything other than the literal `'down'` is `'right'` — unlike every other config key, an
 * invalid `direction` is never worth a `SchemaIssue`: it's a purely cosmetic option with an
 * obviously safe fallback, not something that changes what the tree contains. */
function parseDirection(raw: unknown): Direction {
  return raw === 'down' ? 'down' : 'right';
}

/** Anything other than the literal `true` is `false` — mirrors `parseDirection`'s own
 * never-an-issue treatment: a toggle option Bases always writes as a real boolean, so an
 * unexpected shape here only ever means "not set yet," never a config mistake worth flagging. */
function parseEdgeLabels(raw: unknown): boolean {
  return raw === true;
}

export function parseSchema(read: ConfigReader): { schema: Schema; issues: SchemaIssue[] } {
  const issues: SchemaIssue[] = [];
  const types = resolveTypes(read, issues);
  const typeByName = new Map<string, TypeDef>();
  for (const type of types) {
    typeByName.set(type.name, type);
  }
  const schema: Schema = {
    types,
    typeByName,
    inherit: parseInherit(read('inherit'), issues),
    layout: parseLayout(read('layout')),
    direction: parseDirection(read('direction')),
    edgeLabels: parseEdgeLabels(read('edgeLabels')),
  };
  return { schema, issues };
}
