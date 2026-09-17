import { describe, expect, it } from 'vitest';
import { note, snapshot } from './__tests__/notes.js';
import { collectCandidates } from './candidates.js';
import type { EdgeRule, Schema, TypeDef, TypeMatch } from './schema.js';

const emptyMatch: TypeMatch = { tags: [], folder: null, properties: [] };

function typeDef(
  name: string,
  level: number,
  options: {
    children?: ReadonlyMap<string, EdgeRule>;
    match?: TypeMatch;
    specificity?: number;
  } = {},
): TypeDef {
  return {
    name,
    level,
    match: options.match ?? emptyMatch,
    specificity: options.specificity ?? 0,
    children: options.children ?? new Map(),
  };
}

function schemaOf(types: readonly TypeDef[]): Schema {
  return {
    types,
    typeByName: new Map(types.map((type) => [type.name, type])),
    inherit: [],
    layout: 'graph',
    direction: 'right',
  };
}

function nodeTypesOf(
  entries: ReadonlyArray<readonly [string, TypeDef | null]>,
): Map<string, TypeDef | null> {
  return new Map(entries);
}

describe('collectCandidates — basics', () => {
  it('returns no candidates and no external targets when nothing matches', () => {
    const leaf = typeDef('Leaf', 0);
    const schema = schemaOf([leaf]);
    const snap = snapshot([note('leaf.md')]);

    const result = collectCandidates(schema, snap, nodeTypesOf([['leaf.md', leaf]]));

    expect(result.byChild.size).toBe(0);
    expect(result.external.size).toBe(0);
  });

  it('excludes a self-referencing target from its own candidate list', () => {
    // T is self-referencing (its own children map points back to T), so a note of type T whose
    // "p" property lists itself would otherwise qualify by type alone.
    const t: TypeDef = typeDef('T', 0, {
      children: new Map([['T', { kind: 'property', property: 'p' }]]),
    });
    const schema = schemaOf([t]);
    const snap = snapshot([note('n.md', { propertyLinks: { p: ['n.md'] } })]);
    const nodeTypes = nodeTypesOf([['n.md', t]]);

    const result = collectCandidates(schema, snap, nodeTypes);

    expect(result.byChild.has('n.md')).toBe(false);
  });

  it('collects a single property candidate', () => {
    const category = typeDef('Category', 0, {
      children: new Map([['Leaf', { kind: 'property', property: 'cat' }]]),
    });
    const leaf = typeDef('Leaf', 1);
    const schema = schemaOf([category, leaf]);
    const snap = snapshot([
      note('cat.md'),
      note('leaf.md', { propertyLinks: { cat: ['cat.md'] } }),
    ]);
    const nodeTypes = nodeTypesOf([
      ['cat.md', category],
      ['leaf.md', leaf],
    ]);

    const result = collectCandidates(schema, snap, nodeTypes);

    expect(result.byChild.get('leaf.md')).toStrictEqual([
      {
        parent: 'cat.md',
        rule: { kind: 'property', property: 'cat' },
        parentLevel: 0,
        valueIndex: 0,
      },
    ]);
  });
});

describe('collectCandidates — sort order tie-breaks', () => {
  it('orders by parentLevel descending (deeper parent type wins)', () => {
    const category = typeDef('Category', 0, {
      children: new Map([['Leaf', { kind: 'property', property: 'cat' }]]),
    });
    const meta = typeDef('Meta', 1, {
      children: new Map([['Leaf', { kind: 'property', property: 'meta' }]]),
    });
    const leaf = typeDef('Leaf', 2);
    const schema = schemaOf([category, meta, leaf]);
    const snap = snapshot([
      note('cat.md'),
      note('meta.md'),
      note('leaf.md', { propertyLinks: { cat: ['cat.md'], meta: ['meta.md'] } }),
    ]);
    const nodeTypes = nodeTypesOf([
      ['cat.md', category],
      ['meta.md', meta],
      ['leaf.md', leaf],
    ]);

    const result = collectCandidates(schema, snap, nodeTypes);

    expect(result.byChild.get('leaf.md')?.map((c) => c.parent)).toStrictEqual([
      'meta.md',
      'cat.md',
    ]);
  });

  it('breaks a parentLevel tie by rule kind: property before links/backlinks', () => {
    const property = typeDef('P1', 5, {
      children: new Map([['T', { kind: 'property', property: 'p' }]]),
    });
    const backlinks = typeDef('P2', 5, {
      children: new Map([['T', { kind: 'backlinks', property: 'file.backlinks' }]]),
    });
    const t = typeDef('T', 6);
    const schema = schemaOf([property, backlinks, t]);
    const snap = snapshot(
      [note('n.md', { propertyLinks: { p: ['host.md'] } }), note('host.md', { links: ['n.md'] })],
      { host: 'host.md' },
    );
    const nodeTypes = nodeTypesOf([
      ['n.md', t],
      ['host.md', null],
    ]);

    const result = collectCandidates(schema, snap, nodeTypes);

    // Deduped to a single candidate for (n.md, host.md); property wins over backlinks.
    expect(result.byChild.get('n.md')).toStrictEqual([
      {
        parent: 'host.md',
        rule: { kind: 'property', property: 'p' },
        parentLevel: 5,
        valueIndex: 0,
      },
    ]);
  });

  it('breaks a parentLevel+kind tie by valueIndex ascending', () => {
    const parent = typeDef('P', 3, {
      children: new Map([['T', { kind: 'property', property: 'p' }]]),
    });
    const t = typeDef('T', 4);
    const schema = schemaOf([parent, t]);
    // b.md is listed first (index 0), a.md second (index 1) — but results order is reversed
    // so a real bug (falling back to results order) would be caught.
    const snap = snapshot(
      [note('n.md', { propertyLinks: { p: ['b.md', 'a.md'] } }), note('a.md'), note('b.md')],
      { results: ['n.md', 'a.md', 'b.md'] },
    );
    const nodeTypes = nodeTypesOf([
      ['n.md', t],
      ['a.md', parent],
      ['b.md', parent],
    ]);

    const result = collectCandidates(schema, snap, nodeTypes);

    expect(result.byChild.get('n.md')?.map((c) => c.parent)).toStrictEqual(['b.md', 'a.md']);
  });

  it('breaks a parentLevel+kind+valueIndex tie by parent results order, host first', () => {
    const p1 = typeDef('P1', 7, {
      children: new Map([['T', { kind: 'property', property: 'p1' }]]),
    });
    const p2 = typeDef('P2', 7, {
      children: new Map([['T', { kind: 'property', property: 'p2' }]]),
    });
    const t = typeDef('T', 8);
    const schema = schemaOf([p1, p2, t]);
    const snap = snapshot(
      [note('n.md', { propertyLinks: { p1: ['x.md'], p2: ['y.md'] } }), note('x.md'), note('y.md')],
      { results: ['n.md', 'y.md', 'x.md'] },
    );
    const nodeTypes = nodeTypesOf([
      ['n.md', t],
      ['x.md', p1],
      ['y.md', p2],
    ]);

    const result = collectCandidates(schema, snap, nodeTypes);

    // Both candidates tie on level/kind/valueIndex(0); y.md sorts before x.md in results.
    expect(result.byChild.get('n.md')?.map((c) => c.parent)).toStrictEqual(['y.md', 'x.md']);
  });

  it('treats the host as sorting before every result on the parent-order tie-break', () => {
    const p1 = typeDef('P1', 2, {
      children: new Map([['T', { kind: 'property', property: 'p1' }]]),
    });
    const p2 = typeDef('P2', 2, {
      children: new Map([['T', { kind: 'property', property: 'p2' }]]),
    });
    const t = typeDef('T', 3);
    const schema = schemaOf([p1, p2, t]);
    const snap = snapshot(
      [
        note('n.md', { propertyLinks: { p1: ['host.md'], p2: ['x.md'] } }),
        note('x.md'),
        note('host.md'),
      ],
      { results: ['n.md', 'x.md'], host: 'host.md' },
    );
    const nodeTypes = nodeTypesOf([
      ['n.md', t],
      ['x.md', p2],
      ['host.md', p1],
    ]);

    const result = collectCandidates(schema, snap, nodeTypes);

    expect(result.byChild.get('n.md')?.map((c) => c.parent)).toStrictEqual(['host.md', 'x.md']);
  });
});

describe('collectCandidates — backlinks', () => {
  it('collects a backlinks candidate from the host, whose type is null, using its results order (-1)', () => {
    const parent = typeDef('P', 0, {
      children: new Map([['T', { kind: 'backlinks', property: 'file.backlinks' }]]),
    });
    const t = typeDef('T', 1);
    const schema = schemaOf([parent, t]);
    const snap = snapshot([note('n.md'), note('host.md', { links: ['n.md'] })], {
      host: 'host.md',
    });
    const nodeTypes = nodeTypesOf([
      ['n.md', t],
      ['host.md', null],
    ]);

    const result = collectCandidates(schema, snap, nodeTypes);

    expect(result.byChild.get('n.md')).toStrictEqual([
      {
        parent: 'host.md',
        rule: { kind: 'backlinks', property: 'file.backlinks' },
        parentLevel: 0,
        valueIndex: -1,
      },
    ]);
  });

  it('does not collect a backlinks candidate from a node of the wrong type', () => {
    const parent = typeDef('P', 0, {
      children: new Map([['T', { kind: 'backlinks', property: 'file.backlinks' }]]),
    });
    const other = typeDef('Other', 1);
    const t = typeDef('T', 2);
    const schema = schemaOf([parent, other, t]);
    const snap = snapshot([note('n.md'), note('other.md', { links: ['n.md'] })]);
    const nodeTypes = nodeTypesOf([
      ['n.md', t],
      ['other.md', other],
    ]);

    const result = collectCandidates(schema, snap, nodeTypes);

    expect(result.byChild.has('n.md')).toBe(false);
  });
});

describe('collectCandidates — external targets', () => {
  it('records a property target outside the node set as external when its type matches', () => {
    const parent = typeDef('P', 0, {
      match: { tags: ['p'], folder: null, properties: [] },
      specificity: 1,
      children: new Map([['T', { kind: 'property', property: 'link' }]]),
    });
    const t = typeDef('T', 1);
    const schema = schemaOf([parent, t]);
    const snap = snapshot([
      note('n.md', { propertyLinks: { link: ['outside.md'] } }),
      note('outside.md', { tags: ['p'] }),
    ]);
    const nodeTypes = nodeTypesOf([['n.md', t]]);

    const result = collectCandidates(schema, snap, nodeTypes);

    expect(result.byChild.has('n.md')).toBe(false);
    expect(result.external.get('n.md')).toStrictEqual([{ target: 'outside.md', valueIndex: 0 }]);
  });

  it('does not record an external target whose resolved type does not match the rule parent', () => {
    const parent = typeDef('P', 0, {
      match: { tags: ['p'], folder: null, properties: [] },
      specificity: 1,
      children: new Map([['T', { kind: 'property', property: 'link' }]]),
    });
    const t = typeDef('T', 1);
    const schema = schemaOf([parent, t]);
    const snap = snapshot([
      note('n.md', { propertyLinks: { link: ['outside.md'] } }),
      note('outside.md'),
    ]);
    const nodeTypes = nodeTypesOf([['n.md', t]]);

    const result = collectCandidates(schema, snap, nodeTypes);

    expect(result.external.size).toBe(0);
  });

  it('does not record external targets for links or backlinks rules', () => {
    const parent = typeDef('Q', 0, {
      match: { tags: ['q'], folder: null, properties: [] },
      specificity: 1,
      children: new Map([['T', { kind: 'links', property: 'file.links' }]]),
    });
    const t = typeDef('T', 1);
    const schema = schemaOf([parent, t]);
    const snap = snapshot([
      note('n.md', { links: ['outside2.md'] }),
      note('outside2.md', { tags: ['q'] }),
    ]);
    const nodeTypes = nodeTypesOf([['n.md', t]]);

    const result = collectCandidates(schema, snap, nodeTypes);

    expect(result.byChild.has('n.md')).toBe(false);
    expect(result.external.size).toBe(0);
  });

  it('keeps the first occurrence per external target and orders the list by valueIndex', () => {
    const parent = typeDef('P', 0, {
      match: { tags: ['p'], folder: null, properties: [] },
      specificity: 1,
      children: new Map([['T', { kind: 'property', property: 'link' }]]),
    });
    const t = typeDef('T', 1);
    const schema = schemaOf([parent, t]);
    const snap = snapshot([
      note('n.md', { propertyLinks: { link: ['b.md', 'a.md', 'b.md'] } }),
      note('a.md', { tags: ['p'] }),
      note('b.md', { tags: ['p'] }),
    ]);
    const nodeTypes = nodeTypesOf([['n.md', t]]);

    const result = collectCandidates(schema, snap, nodeTypes);

    expect(result.external.get('n.md')).toStrictEqual([
      { target: 'b.md', valueIndex: 0 },
      { target: 'a.md', valueIndex: 1 },
    ]);
  });
});
