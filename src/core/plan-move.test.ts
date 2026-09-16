import { describe, expect, it } from 'vitest';
import {
  KB_CATEGORY,
  KNOWLEDGE_BASE_CONFIG,
  knowledgeBaseWithLinuxSnapshot,
  LINUX_CATEGORY,
  rLangSnapshot,
} from './__tests__/knowledge-base.fixture.js';
import { note, snapshot } from './__tests__/notes.js';
import { moveTargets } from './plan-move.js';
import { planAction } from './planner.js';
import { parseSchema } from './schema.js';
import { applyPlan } from './simulate.js';
import { buildStructure } from './structure.js';

function makeRead(config: Record<string, unknown>): (key: string) => unknown {
  return (key: string): unknown => config[key];
}

function schemaFrom(config: Record<string, unknown>) {
  return parseSchema(makeRead(config)).schema;
}

const noEnv = { defaultFolder: '', exists: (): boolean => false };

describe('planAction — move: rejection reasons (hand-built schema)', () => {
  // Category (root, host) has: Sub (property "up"), Leaf (property "leaf_of", unreachable from
  // Sub), LinkKid (file.links), BackKid (file.backlinks). Sub has Leaf2 via "up2".
  const schema = schemaFrom({
    types: {
      Category: {
        tag: 'cat',
        children: { Sub: 'up', Leaf: 'leaf_of', LinkKid: 'file.links', BackKid: 'file.backlinks' },
      },
      Sub: { tag: 'sub', children: { Leaf2: 'up2' } },
      Leaf: { tag: 'leaf' },
      Leaf2: { tag: 'leaf2' },
      LinkKid: { tag: 'linkkid' },
      BackKid: { tag: 'backkid' },
    },
  });
  const snap = snapshot(
    [
      note('cat1.md', { tags: ['cat'], links: ['backkid.md'] }),
      note('cat2.md', { tags: ['cat'] }),
      note('sub1.md', { tags: ['sub'], propertyLinks: { up: ['cat1.md'] } }),
      note('leaf2a.md', { tags: ['leaf2'], propertyLinks: { up2: ['sub1.md'] } }),
      note('leaf.md', { tags: ['leaf'] }),
      note('linkkid.md', { tags: ['linkkid'], links: ['cat1.md'] }),
      note('backkid.md', { tags: ['backkid'] }),
    ],
    {
      host: 'cat1.md',
      results: ['cat2.md', 'sub1.md', 'leaf2a.md', 'leaf.md', 'linkkid.md', 'backkid.md'],
    },
  );

  it('rejects a node that is not in the structure', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'ghost.md', parent: 'cat2.md' },
      noEnv,
    );
    expect(result).toStrictEqual({ ok: false, reason: '"ghost" is not in the structure' });
  });

  it('rejects moving the structure root', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'cat1.md', parent: 'cat2.md' },
      noEnv,
    );
    expect(result).toStrictEqual({ ok: false, reason: 'The root cannot be moved' });
  });

  it('rejects a parent that is not in the structure', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'sub1.md', parent: 'ghost.md' },
      noEnv,
    );
    expect(result).toStrictEqual({ ok: false, reason: '"ghost" is not in the structure' });
  });

  it('rejects moving a node onto itself', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'sub1.md', parent: 'sub1.md' },
      noEnv,
    );
    expect(result).toStrictEqual({
      ok: false,
      reason: 'Cannot move "sub1" into itself or its own branch',
    });
  });

  it('rejects moving a node into its own descendant', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'sub1.md', parent: 'leaf2a.md' },
      noEnv,
    );
    expect(result).toStrictEqual({
      ok: false,
      reason: 'Cannot move "sub1" into itself or its own branch',
    });
  });

  it('rejects moving onto the current parent', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'sub1.md', parent: 'cat1.md' },
      noEnv,
    );
    expect(result).toStrictEqual({ ok: false, reason: '"sub1" is already under "cat1"' });
  });

  it('rejects a type/parent combination with no rule', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'leaf.md', parent: 'sub1.md' },
      noEnv,
    );
    expect(result).toStrictEqual({
      ok: false,
      reason: '"Leaf" cannot be placed under "sub1"',
    });
  });

  it('rejects when the required rule is file.backlinks (text, parent -> node order)', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'backkid.md', parent: 'cat2.md' },
      noEnv,
    );
    expect(result).toStrictEqual({
      ok: false,
      reason:
        'The link from "cat2" to "backkid" lives in note text and cannot be written automatically',
    });
  });

  it('rejects when the required rule is file.links (text, node -> parent order)', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'linkkid.md', parent: 'cat2.md' },
      noEnv,
    );
    expect(result).toStrictEqual({
      ok: false,
      reason:
        'The link from "linkkid" to "cat2" lives in note text and cannot be written automatically',
    });
  });
});

describe('planAction — move: keeps extra values in the same edge property', () => {
  const schema = schemaFrom({
    types: { MetaT: { tag: 'meta', children: { Hier: 'meta' } }, Hier: { tag: 'hier' } },
  });

  it('meta: [A, B] moving from A to C -> meta: [C, B]', () => {
    const snap = snapshot([
      note('a.md', { tags: ['meta'] }),
      note('b.md', { tags: ['meta'] }),
      note('c.md', { tags: ['meta'] }),
      note('hier.md', {
        tags: ['hier'],
        frontmatter: { meta: ['[[a]]', '[[b]]'] },
        propertyLinks: { meta: ['a.md', 'b.md'] },
      }),
    ]);

    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'hier.md', parent: 'c.md' },
      noEnv,
    );

    expect(result).toStrictEqual({
      ok: true,
      focus: 'hier.md',
      plan: {
        creations: [],
        changes: [
          {
            path: 'hier.md',
            writes: [
              {
                key: 'meta',
                value: { kind: 'links', remove: ['a.md'], add: ['c.md'], list: true },
              },
            ],
          },
        ],
        appends: [],
        moves: [],
      },
    });
  });
});

describe('planAction — move: preserves an unresolved link, plain text, and a link outside the base', () => {
  it("moving H from A to M2 keeps H's other meta values — an unresolved link, plain text, and Ext (typed Meta-note, but outside the base's own results) — the reviewer's exact C1 example, exercised end to end through the real planner (manual-check regression: the planner's own \"keep\" set had only ever covered structural extras, not alsoIn/external links, so this dropped Ext even after the C1 patch rewrite)", () => {
    const schema = schemaFrom({
      types: {
        'Meta-note': { tag: 'meta', children: { Hierarchy: 'meta' } },
        Hierarchy: { tag: 'hier' },
      },
    });
    const A = note('A.md', { tags: ['meta'] });
    const M2 = note('M2.md', { tags: ['meta'] });
    // "Ext" is a real, typed Meta-note, but not part of the base's own results — reachable only as
    // an external property-link target (readSnapshot's one-level inclusion), matching the "also
    // in" chip the view shows for it.
    const Ext = note('Ext.md', { tags: ['meta'] });
    const H = note('H.md', {
      tags: ['hier'],
      frontmatter: { meta: ['[[A]]', '[[Not yet written]]', 'some text', '[[Ext]]'] },
      propertyLinks: { meta: ['A.md', 'Ext.md'] },
    });
    const snap = snapshot([A, M2, Ext, H], { results: ['A.md', 'M2.md', 'H.md'] });

    const result = planAction(schema, snap, { kind: 'move', node: 'H.md', parent: 'M2.md' }, noEnv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'H.md',
        writes: [
          { key: 'meta', value: { kind: 'links', remove: ['A.md'], add: ['M2.md'], list: true } },
        ],
      },
    ]);
    const after = applyPlan(snap, result.plan);
    expect(after.notes.get('H.md')?.frontmatter['meta']).toStrictEqual([
      '[[M2]]',
      '[[Not yet written]]',
      'some text',
      '[[Ext]]',
    ]);
  });
});

describe('moveTargets', () => {
  const schema = schemaFrom({
    types: {
      Category: { tag: 'cat', children: { Sub: 'up', BackKid: 'file.backlinks' } },
      Sub: { tag: 'sub', children: { Leaf2: 'up2' } },
      Leaf2: { tag: 'leaf2' },
      BackKid: { tag: 'backkid' },
    },
  });
  const snap = snapshot(
    [
      note('cat1.md', { tags: ['cat'], links: ['backkid.md'] }),
      note('cat2.md', { tags: ['cat'] }),
      note('sub1.md', { tags: ['sub'], propertyLinks: { up: ['cat1.md'] } }),
      note('leaf2a.md', { tags: ['leaf2'], propertyLinks: { up2: ['sub1.md'] } }),
      note('backkid.md', { tags: ['backkid'] }),
    ],
    { host: 'cat1.md', results: ['cat2.md', 'sub1.md', 'leaf2a.md', 'backkid.md'] },
  );
  const structure = buildStructure(schema, snap);

  it('returns an empty set for a node missing from the structure', () => {
    expect(moveTargets(schema, structure, 'ghost.md')).toStrictEqual(new Set());
  });

  it('returns an empty set for the root', () => {
    expect(moveTargets(schema, structure, 'cat1.md')).toStrictEqual(new Set());
  });

  it('excludes the node itself, its descendants, its current parent, and text-only rules', () => {
    // sub1's candidates would otherwise be: cat1 (self-excluded: it's already the parent),
    // cat2 (a valid Category target), leaf2a (its own descendant, excluded), and nothing via
    // BackKid (a different type entirely, not even a candidate rule for Sub).
    const targets = moveTargets(schema, structure, 'sub1.md');

    expect(targets).toStrictEqual(new Set(['cat2.md']));
  });

  it('excludes a target reachable only through a text-based (backlinks) rule', () => {
    // backkid's only possible parent type is Category, but only via file.backlinks - never a
    // move target since that edge can't be written automatically.
    const targets = moveTargets(schema, structure, 'backkid.md');

    expect(targets).toStrictEqual(new Set());
  });
});

describe('planAction — move: vault schema', () => {
  const schema = schemaFrom(KNOWLEDGE_BASE_CONFIG);
  const OBSIDIAN = 'base/_meta-notes/obsidian.md';
  const DATAVIEW = 'base/_hierarchy/dataview.md';
  const TEMPLATER = 'base/_hierarchy/templater.md';
  const READING_STRATEGIES = 'base/_hierarchy/reading strategies.md';
  const NOTE_TAKING = 'base/_meta-notes/note taking.md';

  it('moving a meta-note to another category cascades category to its hierarchy children only', () => {
    const snap = knowledgeBaseWithLinuxSnapshot();

    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: OBSIDIAN, parent: LINUX_CATEGORY },
      noEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe(OBSIDIAN);
    const categoryWrite = (path: string) => ({
      path,
      writes: [
        {
          key: 'category',
          value: { kind: 'links', remove: [KB_CATEGORY], add: [LINUX_CATEGORY], list: true },
        },
      ],
    });
    expect(result.plan.changes).toStrictEqual([
      categoryWrite(OBSIDIAN),
      categoryWrite(DATAVIEW),
      categoryWrite(TEMPLATER),
    ]);
    expect(result.plan.creations).toStrictEqual([]);
    expect(result.plan.appends).toStrictEqual([]);
    expect(result.plan.moves).toStrictEqual([]);
  });

  it('moving a hierarchy from a problem to a meta-note clears problem and sets meta (no category write)', () => {
    // The note's "meta" property already held "information processing" — a value merely inherited
    // from its old problem parent's own meta chain, not a genuine extra — so `edgeTargets` drops it
    // rather than carrying it forward: the result is exactly `meta: [note taking]`.
    const snap = knowledgeBaseWithLinuxSnapshot();

    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: READING_STRATEGIES, parent: NOTE_TAKING },
      noEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe(READING_STRATEGIES);
    expect(result.plan.changes).toStrictEqual([
      {
        path: READING_STRATEGIES,
        writes: [
          {
            key: 'meta',
            value: {
              kind: 'links',
              remove: ['base/_meta-notes/information processing.md'],
              add: [NOTE_TAKING],
              list: true,
            },
          },
          {
            key: 'problem',
            value: {
              kind: 'links',
              remove: ['base/_problems/information acquisition.md'],
              add: [],
              list: true,
            },
          },
        ],
      },
    ]);
  });

  it('rejects moving a text-edge (backlinks) node into a category, with the note-text suffix', () => {
    const snap = rLangSnapshot();
    const basicVariables = 'base/_hierarchy/basic variables types in r.md';
    const rlangCategory = 'base/categories/r-lang.md';

    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: basicVariables, parent: rlangCategory },
      noEnv,
    );

    expect(result).toStrictEqual({
      ok: false,
      reason:
        '"basic variables types in r" would stay under "r-lang hierarchy" because its link from "r-lang hierarchy" is in note text',
    });
  });
});
