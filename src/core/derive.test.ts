import { describe, expect, it } from 'vitest';
import { note, snapshot } from './__tests__/notes.js';
import {
  deriveSubtreeWrites,
  edgeProperties,
  inheritedTargets,
  listShape,
  ruleBetween,
  type SubtreeContext,
} from './derive.js';
import type { EdgeRule, Schema, TypeDef, TypeMatch } from './schema.js';
import type { Structure, StructureNode } from './structure.js';

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

describe('ruleBetween', () => {
  it("returns the parent type's own rule when parentType is given and known", () => {
    const rule: EdgeRule = { kind: 'property', property: 'up' };
    const schema = schemaOf([typeDef('A', new Map([['B', rule]])), typeDef('B', new Map())]);

    expect(ruleBetween(schema, 'A', 'B')).toStrictEqual(rule);
  });

  it('returns null when the named parent type has no rule for the child type', () => {
    const schema = schemaOf([typeDef('A', new Map()), typeDef('B', new Map())]);

    expect(ruleBetween(schema, 'A', 'B')).toBeNull();
  });

  it('returns null when parentType names a type absent from the schema', () => {
    const schema = schemaOf([typeDef('B', new Map())]);

    expect(ruleBetween(schema, 'Ghost', 'B')).toBeNull();
  });

  it('finds the lowest-level rule among all types when parentType is null', () => {
    const deep: TypeDef = {
      name: 'Deep',
      level: 5,
      match: emptyMatch,
      specificity: 0,
      children: new Map([['Leaf', { kind: 'property', property: 'viaDeep' }]]),
    };
    const shallow: TypeDef = {
      name: 'Shallow',
      level: 1,
      match: emptyMatch,
      specificity: 0,
      children: new Map([['Leaf', { kind: 'property', property: 'viaShallow' }]]),
    };
    const leaf = typeDef('Leaf', new Map());
    const schema = schemaOf([deep, shallow, leaf]);

    expect(ruleBetween(schema, null, 'Leaf')).toStrictEqual({
      kind: 'property',
      property: 'viaShallow',
    });
  });

  it('returns null when parentType is null and no type claims the child', () => {
    const schema = schemaOf([typeDef('A', new Map())]);

    expect(ruleBetween(schema, null, 'Leaf')).toBeNull();
  });
});

describe('deriveSubtreeWrites', () => {
  /** A minimal, self-contained `StructureNode`; callers override only what the scenario needs. */
  function node(overrides: Partial<StructureNode> & { readonly path: string }): StructureNode {
    return {
      type: null,
      parent: null,
      edge: null,
      children: [],
      extras: [],
      alsoIn: [],
      twoWay: false,
      ...overrides,
    };
  }

  function structureOf(nodes: readonly StructureNode[]): Structure {
    return {
      root: null,
      tops: [],
      orphans: [],
      nodes: new Map(nodes.map((n) => [n.path, n])),
      issues: [],
    };
  }

  it('applies typeOverrides/linkOverrides across property parents, ignores non-property extras and phantom paths, excludes a descendant own-edge key, skips a phantom child, and omits a no-change descendant', () => {
    const schema: Schema = {
      types: [],
      typeByName: new Map([
        ['RootOld', typeDef('RootOld', new Map())],
        ['RootNew', typeDef('RootNew', new Map([['DType', { kind: 'property', property: 'k' }]]))],
        ['ExtraType', typeDef('ExtraType', new Map())],
        ['DType', typeDef('DType', new Map())],
        ['EType', typeDef('EType', new Map())],
      ]),
      inherit: ['k'],
      layout: 'graph',
    };
    const structure = structureOf([
      node({ path: 'root.md', type: 'RootOld', children: ['d.md', 'missingChild.md'] }),
      node({
        path: 'd.md',
        type: 'DType',
        parent: 'root.md',
        edge: { kind: 'links', property: 'file.links' },
        children: ['e.md'],
        extras: [
          { parent: 'extraProp.md', kind: 'property' },
          { parent: 'extraLink.md', kind: 'links' },
          { parent: 'phantom.md', kind: 'property' },
          { parent: 'ghostHost.md', kind: 'property' },
        ],
      }),
      node({
        path: 'e.md',
        type: 'EType',
        parent: 'd.md',
        edge: { kind: 'property', property: 'someKey' },
      }),
      node({ path: 'extraProp.md', type: 'ExtraType' }),
      node({ path: 'extraLink.md', type: 'ExtraType' }),
      node({ path: 'ghostHost.md', type: 'ExtraType' }),
      // "phantom.md" and "missingChild.md" are deliberately absent from `structure.nodes`.
    ]);
    const snap = snapshot([
      note('root.md'),
      note('d.md', { propertyLinks: { k: ['old-value.md'] } }),
      note('e.md', { propertyLinks: { k: ['root.md', 'override-target.md'] } }),
      note('extraProp.md', { propertyLinks: { k: ['snapshot-value.md'] } }),
      note('extraLink.md'),
      note('ghostHost.md'),
    ]);
    const ctx: SubtreeContext = {
      schema,
      snapshot: snap,
      structure,
      typeOverrides: new Map([
        ['root.md', 'RootNew'],
        ['ghostHost.md', 'ImaginaryType'], // absent from schema.typeByName
      ]),
      linkOverrides: new Map([['extraProp.md', { k: ['override-target.md'] }]]),
    };

    const result = deriveSubtreeWrites(ctx, 'root.md');

    expect(result).toStrictEqual([
      {
        path: 'd.md',
        writes: [
          {
            key: 'k',
            value: { kind: 'links', targets: ['root.md', 'override-target.md'], list: true },
          },
        ],
      },
    ]);
    // "missingChild.md" (a phantom entry in root's own `children`) and "e.md" (whose desired value
    // already matches its current one, once d.md's own override is folded in) are both omitted.
    expect(result.map((entry) => entry.path)).not.toContain('missingChild.md');
    expect(result.map((entry) => entry.path)).not.toContain('e.md');
  });
});
