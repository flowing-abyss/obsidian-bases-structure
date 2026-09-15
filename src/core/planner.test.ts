import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_BASE_CONFIG,
  knowledgeBaseSnapshot,
} from './__tests__/knowledge-base.fixture.js';
import { note, snapshot } from './__tests__/notes.js';
import type { PlanEnv } from './plan-types.js';
import { childOptions, planAction } from './planner.js';
import type { EdgeRule, Schema, TypeDef } from './schema.js';
import { parseSchema } from './schema.js';
import type { Snapshot } from './snapshot.js';
import { buildStructure } from './structure.js';

function makeRead(config: Record<string, unknown>): (key: string) => unknown {
  return (key: string): unknown => config[key];
}

function schemaFrom(config: Record<string, unknown>) {
  return parseSchema(makeRead(config)).schema;
}

function envAllowing(defaultFolder = ''): PlanEnv {
  return { defaultFolder, exists: () => false };
}

const KB_CATEGORY = 'base/categories/knowledge base.md';
const INFO_PROCESSING = 'base/_meta-notes/information processing.md';
const INFO_ACQUISITION = 'base/_problems/information acquisition.md';
const READING_STRATEGIES = 'base/_hierarchy/reading strategies.md';

describe('planAction — create: rejection reasons', () => {
  const schema = schemaFrom({
    types: { Cat: { tag: 'cat', children: { Leaf: 'up' } }, Leaf: { tag: 'leaf' } },
  });
  const snap = snapshot([note('cat.md', { tags: ['cat'] })]);

  it('rejects an unknown type', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'cat.md', type: 'Ghost', name: 'X' },
      envAllowing(),
    );

    expect(result).toStrictEqual({ ok: false, reason: 'Unknown type "Ghost"' });
  });

  it('rejects an empty (whitespace-only) name', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'cat.md', type: 'Leaf', name: '   ' },
      envAllowing(),
    );

    expect(result).toStrictEqual({ ok: false, reason: 'Name is empty' });
  });

  it('rejects a name with a forbidden character (single)', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'cat.md', type: 'Leaf', name: 'a/b' },
      envAllowing(),
    );

    expect(result).toStrictEqual({
      ok: false,
      reason: 'Name contains characters that are not allowed: /',
    });
  });

  it('rejects a name with a different forbidden character', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'cat.md', type: 'Leaf', name: 'x[' },
      envAllowing(),
    );

    expect(result).toStrictEqual({
      ok: false,
      reason: 'Name contains characters that are not allowed: [',
    });
  });

  it('lists multiple forbidden characters once each, in order of first appearance', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'cat.md', type: 'Leaf', name: 'a?b*c?d' },
      envAllowing(),
    );

    expect(result).toStrictEqual({
      ok: false,
      reason: 'Name contains characters that are not allowed: ?*',
    });
  });

  it('rejects a parent that is not in the structure', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'ghost.md', type: 'Leaf', name: 'X' },
      envAllowing(),
    );

    expect(result).toStrictEqual({ ok: false, reason: '"ghost" is not in the structure' });
  });

  it('falls back to the last path segment (without ".md") for an unknown parent with no note', () => {
    // Exercises the fallback basename logic itself: a nested path (so the "has a slash" branch
    // runs) that doesn't even end in ".md" (so the "strip .md" branch's false side runs too).
    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'sub/ghost', type: 'Leaf', name: 'X' },
      envAllowing(),
    );

    expect(result).toStrictEqual({ ok: false, reason: '"ghost" is not in the structure' });
  });

  it('rejects a type that cannot be placed under the parent (typed parent)', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'cat.md', type: 'Cat', name: 'X' },
      envAllowing(),
    );

    expect(result).toStrictEqual({ ok: false, reason: '"Cat" cannot be placed under "cat"' });
  });

  it('rejects a type that cannot be placed under an untyped-root parent', () => {
    const untypedSchema = schemaFrom({
      types: { Root: { children: { A: 'link' } }, A: { tag: 'a' }, B: { tag: 'b' } },
    });
    // "hub.md" matches no type (Root has an "A" child only, no conditions of its own to match
    // against, and nothing gives it specificity), but a.md links to it so it still qualifies as
    // an untyped root.
    const untypedSnap = snapshot(
      [note('a.md', { tags: ['a'], propertyLinks: { link: ['hub.md'] } }), note('hub.md')],
      { host: 'hub.md' },
    );

    const result = planAction(
      untypedSchema,
      untypedSnap,
      { kind: 'create', parent: 'hub.md', type: 'B', name: 'X' },
      envAllowing(),
    );

    expect(result).toStrictEqual({ ok: false, reason: '"B" cannot be placed under "hub"' });
  });

  it('rejects when a note already exists in the snapshot at the target path', () => {
    const snapWithExisting = snapshot([note('cat.md', { tags: ['cat'] }), note('X.md')]);

    const result = planAction(
      schema,
      snapWithExisting,
      { kind: 'create', parent: 'cat.md', type: 'Leaf', name: 'X' },
      envAllowing(),
    );

    expect(result).toStrictEqual({ ok: false, reason: 'A note already exists at "X.md"' });
  });

  it('rejects when the vault has a file at the target path outside the snapshot (env.exists)', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'cat.md', type: 'Leaf', name: 'X' },
      { defaultFolder: '', exists: () => true },
    );

    expect(result).toStrictEqual({ ok: false, reason: 'A note already exists at "X.md"' });
  });
});

describe('planAction — create: move/retype are not supported yet', () => {
  const schema = schemaFrom({ types: { A: { tag: 'a' } } });
  const snap = snapshot([note('a.md', { tags: ['a'] })]);

  it('rejects a move action', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'a.md', parent: 'b.md' },
      envAllowing(),
    );

    expect(result).toStrictEqual({ ok: false, reason: 'Not supported yet' });
  });

  it('rejects a retype action', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'a.md', type: 'B' },
      envAllowing(),
    );

    expect(result).toStrictEqual({ ok: false, reason: 'Not supported yet' });
  });
});

describe('planAction — create: vault schema', () => {
  const schema = schemaFrom(KNOWLEDGE_BASE_CONFIG);

  it('creates a Meta-note under the root Category with only tags and category written', () => {
    const snap = knowledgeBaseSnapshot();

    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: KB_CATEGORY, type: 'Meta-note', name: 'New Meta' },
      envAllowing(''),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe('New Meta.md');
    expect(result.plan.creations).toStrictEqual([
      {
        path: 'New Meta.md',
        writes: [
          { key: 'tags', value: { kind: 'literal', value: ['system/high/meta'] } },
          {
            key: 'category',
            value: { kind: 'links', targets: [KB_CATEGORY], list: true },
          },
        ],
        bodyLinks: [],
      },
    ]);
    expect(result.plan.appends).toStrictEqual([]);
    expect(result.plan.changes).toStrictEqual([]);
    expect(result.plan.moves).toStrictEqual([]);
  });

  it('creates a Hierarchy under a Problem: rule property + inherited category/meta, in schema.inherit order', () => {
    const snap = knowledgeBaseSnapshot();

    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: INFO_ACQUISITION, type: 'Hierarchy', name: 'New Reading' },
      envAllowing('base/_hierarchy'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe('base/_hierarchy/New Reading.md');
    expect(result.plan.creations).toStrictEqual([
      {
        path: 'base/_hierarchy/New Reading.md',
        writes: [
          { key: 'tags', value: { kind: 'literal', value: ['system/high/hierarchy'] } },
          { key: 'problem', value: { kind: 'links', targets: [INFO_ACQUISITION], list: true } },
          { key: 'category', value: { kind: 'links', targets: [KB_CATEGORY], list: true } },
          { key: 'meta', value: { kind: 'links', targets: [INFO_PROCESSING], list: true } },
        ],
        bodyLinks: [],
      },
    ]);
    expect(result.plan.appends).toStrictEqual([]);
  });

  it('creates a Hierarchy under a Hierarchy: backlinks append + inherited category/meta/problem', () => {
    const snap = knowledgeBaseSnapshot();

    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: READING_STRATEGIES, type: 'Hierarchy', name: 'Sub reading' },
      envAllowing('base/_hierarchy'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const path = 'base/_hierarchy/Sub reading.md';
    expect(result.focus).toBe(path);
    expect(result.plan.creations).toStrictEqual([
      {
        path,
        writes: [
          { key: 'tags', value: { kind: 'literal', value: ['system/high/hierarchy'] } },
          { key: 'category', value: { kind: 'links', targets: [KB_CATEGORY], list: true } },
          { key: 'meta', value: { kind: 'links', targets: [INFO_PROCESSING], list: true } },
          { key: 'problem', value: { kind: 'links', targets: [INFO_ACQUISITION], list: true } },
        ],
        bodyLinks: [],
      },
    ]);
    expect(result.plan.appends).toStrictEqual([{ path: READING_STRATEGIES, target: path }]);
  });
});

describe('planAction — create: links rule writes bodyLinks', () => {
  const schema = schemaFrom({
    types: { Hub: { tag: 'hub', children: { Leaf: 'file.links' } }, Leaf: { tag: 'leaf' } },
  });

  it('a links-kind rule writes the parent into bodyLinks, not into propertyLinks', () => {
    const snap = snapshot([note('hub.md', { tags: ['hub'] })]);

    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'hub.md', type: 'Leaf', name: 'New Leaf' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.creations[0]?.bodyLinks).toStrictEqual(['hub.md']);
    expect(result.plan.creations[0]?.writes).toStrictEqual([
      { key: 'tags', value: { kind: 'literal', value: ['leaf'] } },
    ]);
    expect(result.plan.appends).toStrictEqual([]);
  });
});

describe('planAction — create: literal property recipe', () => {
  const schema = schemaFrom({
    types: {
      Project: { tag: 'project', children: { Task: 'parent' } },
      Task: { property: { type: 'task' } },
    },
  });

  it('writes a literal scalar for a "property" match entry (e.g. type: task)', () => {
    const snap = snapshot([note('project.md', { tags: ['project'] })]);

    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'project.md', type: 'Task', name: 'Do thing' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.creations[0]?.writes).toStrictEqual([
      { key: 'type', value: { kind: 'literal', value: 'task' } },
      { key: 'parent', value: { kind: 'links', targets: ['project.md'], list: true } },
    ]);
  });
});

describe('planAction — create: folder resolution', () => {
  const schema = schemaFrom({
    types: {
      Cat: { tag: 'cat', children: { Leaf: 'up', Plain: 'up' } },
      Leaf: { tag: 'leaf', folder: 'leaves' },
      Plain: { tag: 'plain' },
    },
  });
  const snap = snapshot([note('cat.md', { tags: ['cat'] })]);

  it("uses the type's own folder over env.defaultFolder", () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'cat.md', type: 'Leaf', name: 'X' },
      envAllowing('other'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe('leaves/X.md');
  });

  it("falls back to env.defaultFolder when the type has none, '' meaning the vault root", () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'cat.md', type: 'Plain', name: 'X' },
      envAllowing(''),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe('X.md');
  });
});

describe('planAction — create: verification failure', () => {
  it('rejects when the new note resolves to a different, tied-but-earlier type (nested tags)', () => {
    const schema = schemaFrom({
      types: {
        Root: { tag: 'root', children: { A: 'link', B: 'link' } },
        A: { tag: 'x' },
        B: { tag: 'x/y' },
      },
    });
    const snap = snapshot([note('root.md', { tags: ['root'] })]);

    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'root.md', type: 'B', name: 'X' },
      envAllowing(),
    );

    expect(result).toStrictEqual({
      ok: false,
      reason: 'The new note would not appear under "root" (recognised as "A")',
    });
  });

  it('rejects with "(not recognised as ...)" when the recipe is internally inconsistent and the note matches no type at all', () => {
    // "Weird"'s own property condition (tags contains "mismatch") can never be satisfied by its
    // own tag recipe (literal tags: ["weird"]) — the "tags" key collision means the property
    // write is the one that gets dropped (first write wins), so the created note ends up
    // matching neither Weird nor Cat, and drops out of the graph entirely.
    const schema = schemaFrom({
      types: {
        Cat: { tag: 'cat', children: { Weird: 'up' } },
        Weird: { tag: 'weird', property: { tags: 'mismatch' } },
      },
    });
    const snap = snapshot([note('cat.md', { tags: ['cat'] })]);

    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'cat.md', type: 'Weird', name: 'X' },
      envAllowing(),
    );

    expect(result).toStrictEqual({
      ok: false,
      reason: 'The new note would not appear under "cat" (not recognised as "Weird")',
    });
  });
});

describe('planAction — create: untyped mode ("parent: up")', () => {
  it('creates a child under an untyped-mode parent via the implicit property rule', () => {
    const schema = schemaFrom({ parent: 'up' });
    const snap = snapshot([note('root.md')], { results: ['root.md'] });

    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'root.md', type: '', name: 'Child' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe('Child.md');
    expect(result.plan.creations).toStrictEqual([
      {
        path: 'Child.md',
        writes: [{ key: 'up', value: { kind: 'links', targets: ['root.md'], list: true } }],
        bodyLinks: [],
      },
    ]);

    // Sanity: rebuilding the structure after the plan actually nests Child.md under root.md.
    const after = buildStructure(schema, {
      notes: new Map([
        ...snap.notes,
        [
          'Child.md',
          note('Child.md', {
            frontmatter: { up: ['[[root]]'] },
            propertyLinks: { up: ['root.md'] },
          }),
        ],
      ]),
      results: [...snap.results, 'Child.md'],
      host: snap.host,
    });
    expect(after.nodes.get('Child.md')?.parent).toBe('root.md');
  });
});

describe('planAction — create: untyped root, competing parent-type rules (hand-built schema)', () => {
  it('picks the lowest-level rule among several types that all claim the child type, not array order', () => {
    // `parseSchema` always keeps `types` in ascending-level (declaration) order, so this schema is
    // built by hand to prove `lowestLevelRuleFor` compares `level`, not position in the array: "A"
    // is declared first but is the *deeper* type (level 5), "B" is declared second but is the
    // *shallower* one (level 1) and must win.
    const leaf: TypeDef = {
      name: 'Leaf',
      level: 9,
      match: { tags: ['leaf'], folder: null, properties: [] },
      specificity: 1,
      children: new Map(),
    };
    const typeA: TypeDef = {
      name: 'A',
      level: 5,
      match: { tags: ['a'], folder: null, properties: [] },
      specificity: 1,
      children: new Map<string, EdgeRule>([['Leaf', { kind: 'property', property: 'viaA' }]]),
    };
    const typeB: TypeDef = {
      name: 'B',
      level: 1,
      match: { tags: ['b'], folder: null, properties: [] },
      specificity: 1,
      children: new Map<string, EdgeRule>([['Leaf', { kind: 'property', property: 'viaB' }]]),
    };
    const schema: Schema = {
      types: [typeA, typeB, leaf],
      typeByName: new Map([
        ['A', typeA],
        ['B', typeB],
        ['Leaf', leaf],
      ]),
      inherit: [],
      layout: 'graph',
    };
    const snap = snapshot(
      [
        note('a.md', { tags: ['a'] }),
        note('b.md', { tags: ['b'] }),
        note('existing-leaf.md', { tags: ['leaf'], propertyLinks: { viaB: ['hub.md'] } }),
        note('hub.md'),
      ],
      { host: 'hub.md' },
    );
    const structure = buildStructure(schema, snap);
    expect(structure.nodes.get('hub.md')?.type).toBeNull();

    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'hub.md', type: 'Leaf', name: 'New' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.creations[0]?.writes).toStrictEqual([
      { key: 'tags', value: { kind: 'literal', value: ['leaf'] } },
      { key: 'viaB', value: { kind: 'links', targets: ['hub.md'], list: true } },
    ]);
  });
});

describe('planAction — create: a key written twice keeps the first write', () => {
  it('a property recipe entry never overwrites an already-written "tags" key', () => {
    // The property recipe's expected value matches the tag itself, so the note stays
    // self-consistent even though the property write is the one that gets dropped.
    const schema = schemaFrom({
      types: {
        Cat: { tag: 'cat', children: { Weird: 'up' } },
        Weird: { tag: 'weird', property: { tags: 'weird' } },
      },
    });
    const snap = snapshot([note('cat.md', { tags: ['cat'] })]);

    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'cat.md', type: 'Weird', name: 'X' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.creations[0]?.writes).toStrictEqual([
      { key: 'tags', value: { kind: 'literal', value: ['weird'] } },
      { key: 'up', value: { kind: 'links', targets: ['cat.md'], list: true } },
    ]);
  });

  it('a property recipe entry wins over an inherit write for the same key', () => {
    const schema = schemaFrom({
      inherit: ['category'],
      types: {
        Cat: { tag: 'cat', children: { Item: 'up' } },
        Item: { property: { category: 'Lit' } },
      },
    });
    const snap = snapshot([
      note('cat.md', { tags: ['cat'], propertyLinks: { category: ['somewhere.md'] } }),
    ]);

    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'cat.md', type: 'Item', name: 'X' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.creations[0]?.writes).toStrictEqual([
      { key: 'category', value: { kind: 'literal', value: 'Lit' } },
      { key: 'up', value: { kind: 'links', targets: ['cat.md'], list: true } },
    ]);
  });
});

describe('planAction — create: verification failure (right type, wrong parent)', () => {
  it('rejects with the bare message when the new note resolves under a different, higher-priority parent', () => {
    // "up1" is the parent we ask for (P1, level 0); but P1 itself inherits "up2" from a note
    // already pointing at a P2 (level 1, deeper — so it outranks P1 as primary parent). The new
    // note still resolves to the right type ("Leaf"), just under the wrong parent.
    const schema = schemaFrom({
      inherit: ['up2'],
      types: {
        P1: { tag: 'p1', children: { Leaf: 'up1' } },
        P2: { tag: 'p2', children: { Leaf: 'up2' } },
        Leaf: { tag: 'leaf' },
      },
    });
    const snap = snapshot([
      note('p1.md', { tags: ['p1'], propertyLinks: { up2: ['p2.md'] } }),
      note('p2.md', { tags: ['p2'] }),
    ]);

    const result = planAction(
      schema,
      snap,
      { kind: 'create', parent: 'p1.md', type: 'Leaf', name: 'X' },
      envAllowing(),
    );

    expect(result).toStrictEqual({
      ok: false,
      reason: 'The new note would not appear under "p1"',
    });
  });
});

describe('childOptions', () => {
  it('returns [] for a node missing from the structure', () => {
    const schema = schemaFrom({ types: { A: { tag: 'a' } } });
    const snap: Snapshot = snapshot([]);
    const structure = buildStructure(schema, snap);

    expect(childOptions(schema, structure, 'missing.md')).toStrictEqual([]);
  });

  it("for a typed parent, returns its children ordered by the child type's level", () => {
    // "Hierarchy" is listed before "Meta-note" in Category.children, but Meta-note has the
    // lower level (declared earlier among the top-level types) — the result must follow level,
    // not declaration order inside `children`.
    const schema = schemaFrom({
      types: {
        Category: { tag: 'cat', children: { Hierarchy: 'category', 'Meta-note': 'category' } },
        'Meta-note': { tag: 'meta' },
        Hierarchy: { tag: 'hier' },
      },
    });
    const snap = snapshot([note('cat.md', { tags: ['cat'] })]);
    const structure = buildStructure(schema, snap);

    expect(childOptions(schema, structure, 'cat.md')).toStrictEqual([
      { type: 'Meta-note', rule: { kind: 'property', property: 'category' } },
      { type: 'Hierarchy', rule: { kind: 'property', property: 'category' } },
    ]);
  });

  it('for an untyped root, returns each placeable type with its lowest-level parent rule', () => {
    const schema = schemaFrom({
      types: { Cat: { tag: 'cat', children: { Leaf: 'link' } }, Leaf: { tag: 'leaf' } },
    });
    const snap = snapshot(
      [note('leaf.md', { tags: ['leaf'], propertyLinks: { link: ['hub.md'] } }), note('hub.md')],
      { host: 'hub.md' },
    );
    const structure = buildStructure(schema, snap);
    expect(structure.nodes.get('hub.md')?.type).toBeNull();

    expect(childOptions(schema, structure, 'hub.md')).toStrictEqual([
      { type: 'Leaf', rule: { kind: 'property', property: 'link' } },
    ]);
  });
});
