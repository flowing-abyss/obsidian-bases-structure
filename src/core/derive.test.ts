import { describe, expect, it } from 'vitest';
import { note, snapshot } from './__tests__/notes.js';
import {
  bareContext,
  deriveSubtreeWrites,
  edgeKeyPatch,
  edgeProperties,
  inheritedTargets,
  inheritKeysFor,
  listShape,
  ruleBetween,
  unionInheritedTargets,
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
    direction: 'right',
    edgeLabels: false,
  };
}

/** A minimal, self-contained `StructureNode`; callers override only what the scenario needs.
 * Shared by every describe block below that needs a node fixture. */
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

describe('edgeKeyPatch', () => {
  it('removes only what stale names and adds newParent (sameKey-style in-place replace)', () => {
    // meta: [A, B] moving from A to C -> remove A (stale), add C; B is untouched regardless of
    // whether it's "recognized" by the structure — round 2 C1: only stale values are ever removed.
    const result = edgeKeyPatch(['A', 'B'], new Set(['A']), 'C');

    expect(result).toStrictEqual({ remove: ['A'], add: ['C'] });
  });

  it('removes a stale ancestor-contributed value even when it sits in the same property slot', () => {
    // The bug this helper fixes: "information processing" is a stale ancestor-contributed value
    // sitting in the same property slot as the new parent — it must not survive.
    const result = edgeKeyPatch(
      ['information processing'],
      new Set(['information processing']),
      'note taking',
    );

    expect(result).toStrictEqual({ remove: ['information processing'], add: ['note taking'] });
  });

  it('removes a value the caller has determined is stale and adds newParent', () => {
    const result = edgeKeyPatch(['old-value'], new Set(['old-value']), 'P');

    expect(result).toStrictEqual({ remove: ['old-value'], add: ['P'] });
  });

  it('leaves a non-stale old value untouched and adds newParent', () => {
    const result = edgeKeyPatch(['O', 'extra'], new Set(['O']), 'P');

    expect(result).toStrictEqual({ remove: ['O'], add: ['P'] });
  });

  it("round 2 C1: never removes a value the caller hasn't named stale, however unrecognized", () => {
    // The regression this rule fixes: an untagged existing note, a wrong-type note, an "also in"
    // link — none of these are ever removed just because they aren't a recognized parent/extra.
    const result = edgeKeyPatch(['other'], new Set(), 'P');

    expect(result).toStrictEqual({ remove: [], add: ['P'] });
  });

  it('adds newParent with nothing to remove from an empty current value (retype child rewrite shape)', () => {
    const result = edgeKeyPatch([], new Set(), 'N');

    expect(result).toStrictEqual({ remove: [], add: ['N'] });
  });

  it('is a no-op to add newParent when it is already present', () => {
    const result = edgeKeyPatch(['P', 'extra'], new Set(), 'P');

    expect(result).toStrictEqual({ remove: [], add: [] });
  });

  it('dedupes repeated occurrences of a removed value', () => {
    const result = edgeKeyPatch(['A', 'A'], new Set(['A']), 'C');

    expect(result).toStrictEqual({ remove: ['A'], add: ['C'] });
  });

  it('never removes newParent even when it is also stale (moving directly under a grandparent already inherited from)', () => {
    // Discovered while testing round 2 minor 7: moving a node so its new parent is a value the
    // *old* parent had already contributed to this same key (e.g. reparenting a hierarchy note
    // straight under the category its meta-note parent was already filed under) put newParent in
    // both `current` and `stale`. Removing it without re-adding (since it looked "already present"
    // before the removal ran) left the key without its new parent at all.
    const result = edgeKeyPatch(
      ['grandparent.md'],
      new Set(['meta.md', 'grandparent.md']),
      'grandparent.md',
    );

    expect(result).toStrictEqual({ remove: [], add: [] });
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

describe('inheritKeysFor', () => {
  it('keeps every inherit key when the node has no edge at all', () => {
    const schema = { ...schemaOf([]), inherit: ['category', 'meta'] };

    const keys = inheritKeysFor(schema, node({ path: 'n.md', edge: null }));

    expect(keys).toStrictEqual(['category', 'meta']);
  });

  it('keeps every inherit key when the edge is not a property rule (e.g. backlinks)', () => {
    const schema = { ...schemaOf([]), inherit: ['category'] };
    const n = node({ path: 'n.md', edge: { kind: 'backlinks', property: 'file.backlinks' } });

    expect(inheritKeysFor(schema, n)).toStrictEqual(['category']);
  });

  it("excludes the node's own edge property from schema.inherit", () => {
    const schema = { ...schemaOf([]), inherit: ['category', 'meta'] };
    const n = node({ path: 'n.md', edge: { kind: 'property', property: 'category' } });

    expect(inheritKeysFor(schema, n)).toStrictEqual(['meta']);
  });

  // Reviewer-named case (Task 4 fix-up): this exclusion isn't decorative. `inheritedTargets`'s
  // "value is the parent" shortcut (see the `inheritedTargets` suite above) only fires when the
  // parent's own *type* is non-null — an untyped parent (a host that matched no type but still
  // qualified as root) always falls through to the parent's own `links[key]` instead, which is
  // empty unless the parent happens to hold that key directly. Without excluding the node's own
  // edge key here, a node parented by an untyped host would read as a spurious inherit-mismatch
  // on its own edge value: `unionInheritedTargets` says "expected: []" while the node's actual
  // value (the edge itself) is non-empty.
  it('is required to avoid a spurious mismatch when the edge parent is untyped', () => {
    const schema = { ...schemaOf([]), inherit: ['category'] };
    const host = node({ path: 'host.md' }); // type: null — matched no schema type
    const child = node({
      path: 'child.md',
      parent: 'host.md',
      edge: { kind: 'property', property: 'category' },
    });
    const ctx: SubtreeContext = {
      schema,
      snapshot: snapshot([
        note('host.md'),
        note('child.md', { propertyLinks: { category: ['host.md'] } }),
      ]),
      structure: {
        root: 'host.md',
        tops: ['host.md'],
        orphans: [],
        nodes: new Map([
          [host.path, host],
          [child.path, child],
        ]),
        issues: [],
      },
      typeOverrides: new Map(),
      linkOverrides: new Map(),
    };

    // Left unfiltered, comparing "category" directly would see this — a false positive, since
    // "child.md"'s own category value of `['host.md']` *is* the edge, not drift from it.
    expect(unionInheritedTargets(ctx, ['host.md'], 'category')).toStrictEqual([]);
    // `inheritKeysFor` excludes it before any such comparison happens.
    expect(inheritKeysFor(schema, child)).toStrictEqual([]);
  });
});

describe('deriveSubtreeWrites', () => {
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
      direction: 'right',
      edgeLabels: false,
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
      // Round 2 C1: "old-value.md" is a value nobody currently contributes to d.md's `k` — under
      // the pre-round-2 rule it was wiped just for not being "desired"; now it survives, since no
      // old parent ever contributed it (it isn't in `U_old(k)` either).
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
    const oldCtx = bareContext(ctx);

    const result = deriveSubtreeWrites(ctx, oldCtx, 'root.md');

    expect(result).toStrictEqual([
      {
        path: 'd.md',
        writes: [
          {
            key: 'k',
            value: {
              // "old-value.md" survives (round 2 C1): it's in neither U_old(k) (extraProp.md's old
              // contribution was "snapshot-value.md", not this) nor U_new(k). root.md/
              // override-target.md are added: root.md now links children via k (RootNew), and
              // extraProp.md's overridden value is override-target.md.
              kind: 'links',
              remove: [],
              add: ['root.md', 'override-target.md'],
              list: true,
            },
          },
        ],
      },
    ]);
    // "missingChild.md" (a phantom entry in root's own `children`) is omitted: it's absent from
    // `structure.nodes` entirely. "e.md" is also omitted: "old-value.md" is in *both* d.md's old
    // and new contribution to "k" (round 3: `add` only fires for a target the action *newly*
    // contributes, i.e. in U_new but not U_old) — nothing about this action actually changed what
    // e.md should inherit from d.md, so e.md gets no write, even though "old-value.md" isn't yet
    // reflected in e.md's own current value (that gap predates this action).
    expect(result.map((entry) => entry.path)).not.toContain('missingChild.md');
    expect(result.map((entry) => entry.path)).not.toContain('e.md');
  });

  it("reconnects a descendant whose narrowed value only matched its parent's OLD contribution (Fix 1)", () => {
    // "p.md" is the moved/retyped node's own child; its "k" already shows the *new* value (as if
    // its own write, earlier in this same cascade, already landed and got recorded into
    // `ctx.linkOverrides` — exactly what a real `deriveSubtreeWrites` walk does one level up). "k"
    // moved from {v1,v2} to {v2} — a legal narrowing, not drift. "d.md" (p.md's own child, the
    // node actually under test) deliberately narrowed its own "k" down to just "v1.md" — the value
    // p.md *used* to share, not the one it shares now. Without Fix 1, d.md's delta is `remove
    // [v1], add []` (v2.md was already in U_old, so round 3's "only what's newly contributed" rule
    // excludes it) — emptying "k" and stranding d.md from its only parent.
    const schema: Schema = {
      types: [],
      typeByName: new Map([
        ['PType', typeDef('PType', new Map())],
        ['DType', typeDef('DType', new Map())],
      ]),
      inherit: ['k'],
      layout: 'graph',
      direction: 'right',
      edgeLabels: false,
    };
    const structure = structureOf([
      node({ path: 'p.md', type: 'PType', children: ['d.md'] }),
      node({ path: 'd.md', type: 'DType', parent: 'p.md' }),
    ]);
    const snap = snapshot([
      note('p.md', { propertyLinks: { k: ['v1.md', 'v2.md'] } }),
      note('d.md', { propertyLinks: { k: ['v1.md'] } }),
    ]);
    const ctx: SubtreeContext = {
      schema,
      snapshot: snap,
      structure,
      typeOverrides: new Map(),
      linkOverrides: new Map([['p.md', { k: ['v2.md'] }]]),
    };
    const oldCtx = bareContext(ctx);

    const result = deriveSubtreeWrites(ctx, oldCtx, 'p.md');

    expect(result).toStrictEqual([
      {
        path: 'd.md',
        writes: [
          { key: 'k', value: { kind: 'links', remove: ['v1.md'], add: ['v2.md'], list: true } },
        ],
      },
    ]);
  });
});
