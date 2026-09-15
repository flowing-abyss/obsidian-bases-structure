import { describe, expect, it } from 'vitest';
import { note, snapshot } from './__tests__/notes.js';
import { edgeProperties, inheritedTargets, listShape } from './derive.js';
import type { EdgeRule, Schema, TypeDef, TypeMatch } from './schema.js';

const emptyMatch: TypeMatch = { tags: [], folder: null, properties: [] };

function typeDef(name: string, children: ReadonlyMap<string, EdgeRule>): TypeDef {
  return { name, level: 0, match: emptyMatch, specificity: 0, children };
}

function schemaOf(types: readonly TypeDef[]): Schema {
  return {
    types,
    typeByName: new Map(types.map((type) => [type.name, type])),
    inherit: [],
    layout: 'graph',
  };
}

describe('edgeProperties', () => {
  it('collects the property name from every property-kind child rule', () => {
    const children = new Map<string, EdgeRule>([
      ['A', { kind: 'property', property: 'up' }],
      ['B', { kind: 'property', property: 'parent' }],
    ]);

    expect(edgeProperties(typeDef('T', children))).toStrictEqual(new Set(['up', 'parent']));
  });

  it('ignores links/backlinks child rules (no backing property)', () => {
    const children = new Map<string, EdgeRule>([
      ['A', { kind: 'links', property: 'file.links' }],
      ['B', { kind: 'backlinks', property: 'file.backlinks' }],
    ]);

    expect(edgeProperties(typeDef('T', children))).toStrictEqual(new Set());
  });

  it('returns an empty set for a type with no children', () => {
    expect(edgeProperties(typeDef('T', new Map()))).toStrictEqual(new Set());
  });
});

describe('inheritedTargets', () => {
  it("returns the parent's own path when its type links children through this key", () => {
    const children = new Map<string, EdgeRule>([
      ['Child', { kind: 'property', property: 'category' }],
    ]);
    const parentType = typeDef('Parent', children);
    const schema = schemaOf([parentType]);

    const result = inheritedTargets(
      schema,
      { path: 'parent.md', type: parentType, links: {} },
      'category',
    );

    expect(result).toStrictEqual(['parent.md']);
  });

  it("falls back to the parent's own links[key] when its type does not link children through this key", () => {
    const children = new Map<string, EdgeRule>([
      ['Child', { kind: 'backlinks', property: 'file.backlinks' }],
    ]);
    const parentType = typeDef('Parent', children);
    const schema = schemaOf([parentType]);

    const result = inheritedTargets(
      schema,
      { path: 'parent.md', type: parentType, links: { category: ['cat.md'] } },
      'category',
    );

    expect(result).toStrictEqual(['cat.md']);
  });

  it('falls back to links[key] (empty) when the parent has no type at all', () => {
    const schema = schemaOf([]);

    const result = inheritedTargets(schema, { path: 'p.md', type: null, links: {} }, 'category');

    expect(result).toStrictEqual([]);
  });

  it('returns a copy, not the same array reference', () => {
    const schema = schemaOf([]);
    const links = { category: ['cat.md'] };

    const result = inheritedTargets(schema, { path: 'p.md', type: null, links }, 'category');

    expect(result).not.toBe(links.category);
    expect(result).toStrictEqual(['cat.md']);
  });
});

describe('listShape', () => {
  it("uses the note's own array value when present", () => {
    const snap = snapshot([note('a.md', { frontmatter: { category: ['x'] } })]);

    expect(listShape(snap, 'category', 'a.md')).toBe(true);
  });

  it("uses the note's own scalar value when present", () => {
    const snap = snapshot([note('a.md', { frontmatter: { category: 'x' } })]);

    expect(listShape(snap, 'category', 'a.md')).toBe(false);
  });

  it('falls back to scanning when notePath is null: any array use wins', () => {
    const snap = snapshot([
      note('a.md', { frontmatter: { category: 'x' } }),
      note('b.md', { frontmatter: { category: ['y'] } }),
    ]);

    expect(listShape(snap, 'category', null)).toBe(true);
  });

  it('falls back to scanning: a scalar-only vault convention is not a list', () => {
    const snap = snapshot([note('a.md', { frontmatter: { category: 'x' } })]);

    expect(listShape(snap, 'category', null)).toBe(false);
  });

  it('defaults to a list when no note has the key at all', () => {
    const snap = snapshot([note('a.md')]);

    expect(listShape(snap, 'category', null)).toBe(true);
  });

  it("falls back to scanning when notePath's own note lacks the key", () => {
    const snap = snapshot([note('a.md'), note('b.md', { frontmatter: { category: 'x' } })]);

    expect(listShape(snap, 'category', 'a.md')).toBe(false);
  });

  it('falls back to scanning when notePath is not in the snapshot', () => {
    const snap = snapshot([note('b.md', { frontmatter: { category: 'x' } })]);

    expect(listShape(snap, 'category', 'missing.md')).toBe(false);
  });

  it('treats a null frontmatter value the same as a missing one', () => {
    const snap = snapshot([note('a.md', { frontmatter: { category: null } })]);

    expect(listShape(snap, 'category', 'a.md')).toBe(true);
  });
});
