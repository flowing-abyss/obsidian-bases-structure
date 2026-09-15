import { describe, expect, it } from 'vitest';
import { parseSchema } from './schema.js';

function makeRead(config: Record<string, unknown>): (key: string) => unknown {
  return (key: string): unknown => config[key];
}

describe('parseSchema — untyped mode', () => {
  it('creates a single implicit type when only "parent" is set', () => {
    const { schema, issues } = parseSchema(makeRead({ parent: 'up' }));

    expect(issues).toStrictEqual([]);
    expect(schema.types).toHaveLength(1);
    expect(schema.types[0]).toStrictEqual({
      name: '',
      level: 0,
      match: { tags: [], folder: null, properties: [] },
      specificity: 0,
      children: new Map([['', { kind: 'property', property: 'up' }]]),
    });
    expect(schema.typeByName.get('')).toBe(schema.types[0]);
  });

  it.each([
    ['note.up', { kind: 'property', property: 'up' }],
    ['file.links', { kind: 'links', property: 'file.links' }],
    ['file.backlinks', { kind: 'backlinks', property: 'file.backlinks' }],
  ] as const)('normalises the edge rule for parent=%s', (parent, expected) => {
    const { schema, issues } = parseSchema(makeRead({ parent }));

    expect(issues).toStrictEqual([]);
    expect(schema.types[0]?.children.get('')).toStrictEqual(expected);
  });

  it('reports an issue and produces empty types when neither "parent" nor "types" is set', () => {
    const { schema, issues } = parseSchema(makeRead({}));

    expect(issues).toStrictEqual([{ key: '', message: 'Set "parent" or "types"' }]);
    expect(schema.types).toStrictEqual([]);
    expect(schema.typeByName.size).toBe(0);
  });

  it('treats a blank "parent" the same as a missing one', () => {
    const { schema, issues } = parseSchema(makeRead({ parent: '   ' }));

    expect(issues).toStrictEqual([{ key: '', message: 'Set "parent" or "types"' }]);
    expect(schema.types).toStrictEqual([]);
  });

  it('reports an issue and drops the rule when "parent" normalises to an empty property', () => {
    const { schema, issues } = parseSchema(makeRead({ parent: 'note.' }));

    expect(issues).toStrictEqual([{ key: 'parent', message: 'must not be empty' }]);
    expect(schema.types).toHaveLength(1);
    expect(schema.types[0]?.children.size).toBe(0);
  });
});

describe('parseSchema — vault config from the design spec', () => {
  const vaultConfig = {
    inherit: ['category', 'meta', 'problem'],
    types: {
      Category: {
        tag: 'system/category',
        children: { 'Meta-note': 'category', Hierarchy: 'category' },
      },
      'Meta-note': {
        tag: 'system/high/meta',
        children: { Problem: 'meta', Hierarchy: 'meta' },
      },
      Problem: {
        tag: 'system/high/problem',
        children: { Hierarchy: 'problem' },
      },
      Hierarchy: {
        tag: 'system/high/hierarchy',
        children: { Hierarchy: 'file.backlinks' },
      },
    },
  };

  it('parses 4 types with levels 0-3 in declaration order', () => {
    const { schema, issues } = parseSchema(makeRead(vaultConfig));

    expect(issues).toStrictEqual([]);
    expect(schema.types.map((type) => type.name)).toStrictEqual([
      'Category',
      'Meta-note',
      'Problem',
      'Hierarchy',
    ]);
    expect(schema.types.map((type) => type.level)).toStrictEqual([0, 1, 2, 3]);
  });

  it('builds the Category children map via the "category" property', () => {
    const { schema } = parseSchema(makeRead(vaultConfig));

    expect(schema.typeByName.get('Category')?.children).toStrictEqual(
      new Map([
        ['Meta-note', { kind: 'property', property: 'category' }],
        ['Hierarchy', { kind: 'property', property: 'category' }],
      ]),
    );
  });

  it('recognises file.backlinks on the self-referencing Hierarchy child', () => {
    const { schema } = parseSchema(makeRead(vaultConfig));

    expect(schema.typeByName.get('Hierarchy')?.children.get('Hierarchy')).toStrictEqual({
      kind: 'backlinks',
      property: 'file.backlinks',
    });
  });

  it('parses inherit as [category, meta, problem]', () => {
    const { schema } = parseSchema(makeRead(vaultConfig));

    expect(schema.inherit).toStrictEqual(['category', 'meta', 'problem']);
  });
});

describe('parseSchema — list-form children', () => {
  it('derives the rule from top-level "parent" for each listed child type', () => {
    const { schema, issues } = parseSchema(
      makeRead({
        parent: 'up',
        types: { Project: { children: ['Module'] }, Module: {} },
      }),
    );

    expect(issues).toStrictEqual([]);
    expect(schema.typeByName.get('Project')?.children).toStrictEqual(
      new Map([['Module', { kind: 'property', property: 'up' }]]),
    );
  });

  it('reports an issue and drops all rules when "parent" is missing', () => {
    const { schema, issues } = parseSchema(
      makeRead({
        types: { Project: { children: ['Module'] }, Module: {} },
      }),
    );

    expect(issues).toStrictEqual([
      { key: 'types.Project.children', message: 'list form needs "parent"' },
    ]);
    expect(schema.typeByName.get('Project')?.children.size).toBe(0);
  });

  it('reports an issue for a non-string entry and drops only that entry', () => {
    const { schema, issues } = parseSchema(
      makeRead({
        parent: 'up',
        types: { Project: { children: [42, 'Module'] }, Module: {} },
      }),
    );

    expect(issues).toStrictEqual([
      { key: 'types.Project.children', message: 'child type name must be a string' },
    ]);
    expect(schema.typeByName.get('Project')?.children).toStrictEqual(
      new Map([['Module', { kind: 'property', property: 'up' }]]),
    );
  });

  it('reports an issue and drops all rules when "parent" normalises to an empty property', () => {
    const { schema, issues } = parseSchema(
      makeRead({
        parent: 'note.',
        types: { Project: { children: ['Module'] }, Module: {} },
      }),
    );

    expect(issues).toStrictEqual([{ key: 'types.Project.children', message: 'must not be empty' }]);
    expect(schema.typeByName.get('Project')?.children.size).toBe(0);
  });
});

describe('parseSchema — unknown child types', () => {
  it('reports an issue and drops the rule for an unknown child type (map form)', () => {
    const { schema, issues } = parseSchema(
      makeRead({ types: { A: { children: { Ghost: 'up' } } } }),
    );

    expect(issues).toStrictEqual([{ key: 'types.A.children.Ghost', message: 'unknown type' }]);
    expect(schema.typeByName.get('A')?.children.size).toBe(0);
  });

  it('reports an issue and drops the rule for an unknown child type (list form)', () => {
    const { schema, issues } = parseSchema(
      makeRead({ parent: 'up', types: { A: { children: ['Ghost'] } } }),
    );

    expect(issues).toStrictEqual([{ key: 'types.A.children.Ghost', message: 'unknown type' }]);
    expect(schema.typeByName.get('A')?.children.size).toBe(0);
  });
});

describe('parseSchema — tag', () => {
  it('accepts a single tag string and strips a leading "#"', () => {
    const { schema, issues } = parseSchema(makeRead({ types: { A: { tag: '#foo' } } }));

    expect(issues).toStrictEqual([]);
    expect(schema.typeByName.get('A')?.match.tags).toStrictEqual(['foo']);
  });

  it('accepts a list of tags', () => {
    const { schema, issues } = parseSchema(makeRead({ types: { A: { tag: ['#foo', ' bar '] } } }));

    expect(issues).toStrictEqual([]);
    expect(schema.typeByName.get('A')?.match.tags).toStrictEqual(['foo', 'bar']);
  });

  it('reports an issue when a tag is not a string or list', () => {
    const { schema, issues } = parseSchema(makeRead({ types: { A: { tag: 42 } } }));

    expect(issues).toStrictEqual([{ key: 'types.A.tag', message: 'tag must be a string or list' }]);
    expect(schema.typeByName.get('A')?.match.tags).toStrictEqual([]);
  });

  it('reports an issue for a non-string element in a tag list', () => {
    const { schema, issues } = parseSchema(makeRead({ types: { A: { tag: ['foo', 7] } } }));

    expect(issues).toStrictEqual([{ key: 'types.A.tag.1', message: 'tag must be a string' }]);
    expect(schema.typeByName.get('A')?.match.tags).toStrictEqual(['foo']);
  });
});

describe('parseSchema — folder', () => {
  it('trims and strips leading/trailing slashes', () => {
    const { schema, issues } = parseSchema(
      makeRead({ types: { A: { folder: '/Projects/Active/ ' } } }),
    );

    expect(issues).toStrictEqual([]);
    expect(schema.typeByName.get('A')?.match.folder).toBe('Projects/Active');
  });

  it('normalises an empty folder to null', () => {
    const { schema, issues } = parseSchema(makeRead({ types: { A: { folder: '  /  ' } } }));

    expect(issues).toStrictEqual([]);
    expect(schema.typeByName.get('A')?.match.folder).toBeNull();
  });

  it('reports an issue when folder is not a string', () => {
    const { schema, issues } = parseSchema(makeRead({ types: { A: { folder: 7 } } }));

    expect(issues).toStrictEqual([{ key: 'types.A.folder', message: 'folder must be a string' }]);
    expect(schema.typeByName.get('A')?.match.folder).toBeNull();
  });
});

describe('parseSchema — property', () => {
  it('stringifies number and boolean values', () => {
    const { schema, issues } = parseSchema(
      makeRead({
        types: { A: { property: { status: 'active', priority: 3, archived: true } } },
      }),
    );

    expect(issues).toStrictEqual([]);
    expect(schema.typeByName.get('A')?.match.properties).toStrictEqual([
      ['status', 'active'],
      ['priority', '3'],
      ['archived', 'true'],
    ]);
  });

  it('reports an issue and drops non-scalar property values', () => {
    const { schema, issues } = parseSchema(
      makeRead({ types: { A: { property: { tags: ['x'], meta: { a: 1 }, empty: null } } } }),
    );

    expect(issues).toStrictEqual([
      { key: 'types.A.property.tags', message: 'property value must be a scalar' },
      { key: 'types.A.property.meta', message: 'property value must be a scalar' },
      { key: 'types.A.property.empty', message: 'property value must be a scalar' },
    ]);
    expect(schema.typeByName.get('A')?.match.properties).toStrictEqual([]);
  });

  it('reports an issue when property is not a map', () => {
    const { schema, issues } = parseSchema(makeRead({ types: { A: { property: 'nope' } } }));

    expect(issues).toStrictEqual([{ key: 'types.A.property', message: 'property must be a map' }]);
    expect(schema.typeByName.get('A')?.match.properties).toStrictEqual([]);
  });
});

describe('parseSchema — specificity', () => {
  it('sums tags, folder presence and properties', () => {
    const { schema } = parseSchema(
      makeRead({
        types: {
          A: {
            tag: ['foo', 'bar'],
            folder: 'Projects',
            property: { status: 'active', priority: 1 },
          },
        },
      }),
    );

    expect(schema.typeByName.get('A')?.specificity).toBe(5);
  });

  it('is 0 for a type with no conditions (null value)', () => {
    const { schema, issues } = parseSchema(makeRead({ types: { A: null } }));

    expect(issues).toStrictEqual([]);
    expect(schema.typeByName.get('A')?.specificity).toBe(0);
    expect(schema.typeByName.get('A')?.match).toStrictEqual({
      tags: [],
      folder: null,
      properties: [],
    });
  });

  it('is 0 for a type with an empty object value', () => {
    const { schema, issues } = parseSchema(makeRead({ types: { A: {} } }));

    expect(issues).toStrictEqual([]);
    expect(schema.typeByName.get('A')?.specificity).toBe(0);
  });
});

describe('parseSchema — invalid types config', () => {
  it('reports an issue when "types" is not a map', () => {
    const { schema, issues } = parseSchema(makeRead({ types: 'nope' }));

    expect(issues).toStrictEqual([
      { key: 'types', message: 'types must be a map' },
      { key: '', message: 'Set "parent" or "types"' },
    ]);
    expect(schema.types).toStrictEqual([]);
  });

  it('falls back to untyped mode when "types" is invalid but "parent" is set', () => {
    const { schema, issues } = parseSchema(makeRead({ types: 'nope', parent: 'up' }));

    expect(issues).toStrictEqual([{ key: 'types', message: 'types must be a map' }]);
    expect(schema.types).toHaveLength(1);
    expect(schema.types[0]?.name).toBe('');
  });

  it('reports an issue and skips a type value that is not an object or null', () => {
    const { schema, issues } = parseSchema(makeRead({ types: { A: 'nope', B: {} } }));

    expect(issues).toStrictEqual([{ key: 'types.A', message: 'type must be a map or empty' }]);
    expect(schema.types.map((type) => type.name)).toStrictEqual(['B']);
    expect(schema.types[0]?.level).toBe(0);
    expect(schema.typeByName.has('A')).toBe(false);
  });

  it('reports an issue when children is neither a map nor a list', () => {
    const { schema, issues } = parseSchema(makeRead({ types: { A: { children: 'nope' } } }));

    expect(issues).toStrictEqual([
      { key: 'types.A.children', message: 'children must be a map or list' },
    ]);
    expect(schema.typeByName.get('A')?.children.size).toBe(0);
  });

  it('reports an issue and drops the rule for an empty edge value', () => {
    const { schema, issues } = parseSchema(makeRead({ types: { A: { children: { A: '   ' } } } }));

    expect(issues).toStrictEqual([{ key: 'types.A.children.A', message: 'must not be empty' }]);
    expect(schema.typeByName.get('A')?.children.size).toBe(0);
  });

  it('reports an issue and drops the rule for a non-string edge value', () => {
    const { schema, issues } = parseSchema(makeRead({ types: { A: { children: { A: 42 } } } }));

    expect(issues).toStrictEqual([{ key: 'types.A.children.A', message: 'must be a string' }]);
    expect(schema.typeByName.get('A')?.children.size).toBe(0);
  });

  it('reports an issue and drops the rule when a map-form value normalises to an empty property', () => {
    const { schema, issues } = parseSchema(
      makeRead({ types: { A: { children: { A: 'note.' } } } }),
    );

    expect(issues).toStrictEqual([{ key: 'types.A.children.A', message: 'must not be empty' }]);
    expect(schema.typeByName.get('A')?.children.size).toBe(0);
  });
});

describe('parseSchema — null tag/folder/property (blank YAML key)', () => {
  it('treats explicit null the same as absent, with no issues', () => {
    const { schema, issues } = parseSchema(
      makeRead({ types: { A: { tag: null, folder: null, property: null } } }),
    );

    expect(issues).toStrictEqual([]);
    expect(schema.typeByName.get('A')?.match).toStrictEqual({
      tags: [],
      folder: null,
      properties: [],
    });
  });
});

describe('parseSchema — inherit', () => {
  it('defaults to an empty array when unset', () => {
    const { schema, issues } = parseSchema(makeRead({ parent: 'up' }));

    expect(issues).toStrictEqual([]);
    expect(schema.inherit).toStrictEqual([]);
  });

  it('accepts a single string', () => {
    const { schema, issues } = parseSchema(makeRead({ parent: 'up', inherit: 'note.category' }));

    expect(issues).toStrictEqual([]);
    expect(schema.inherit).toStrictEqual(['category']);
  });

  it('reports an issue for a non-string entry', () => {
    const { schema, issues } = parseSchema(makeRead({ parent: 'up', inherit: ['category', 7] }));

    expect(issues).toStrictEqual([{ key: 'inherit', message: 'inherit values must be strings' }]);
    expect(schema.inherit).toStrictEqual(['category']);
  });

  it('reports an issue and drops an entry that normalises to an empty string', () => {
    const { schema, issues } = parseSchema(
      makeRead({ parent: 'up', inherit: ['category', 'note.', '  '] }),
    );

    expect(issues).toStrictEqual([
      { key: 'inherit', message: 'must not be empty' },
      { key: 'inherit', message: 'must not be empty' },
    ]);
    expect(schema.inherit).toStrictEqual(['category']);
  });
});

describe('parseSchema — layout', () => {
  it.each([
    ['outline', 'outline'],
    ['graph', 'graph'],
    [undefined, 'graph'],
    ['bogus', 'graph'],
    [42, 'graph'],
  ] as const)('normalises layout=%s to %s', (raw, expected) => {
    const { schema } = parseSchema(makeRead({ parent: 'up', layout: raw }));

    expect(schema.layout).toBe(expected);
  });
});
