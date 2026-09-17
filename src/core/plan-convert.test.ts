import { describe, expect, it } from 'vitest';
import { note, snapshot } from './__tests__/notes.js';
import { convertOptions, operationTargets } from './plan-convert.js';
import { moveTargets } from './plan-move.js';
import type { Action } from './plan-types.js';
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

function convert(node: string, parent: string, type: string): Extract<Action, { kind: 'convert' }> {
  return { kind: 'convert', node, parent, type };
}

// Category -> Meta-note or Hierarchy (both "category"). Meta-note -> Hierarchy ("meta"). Problem
// (P's own current type) -> Hierarchy ("problem"). Hierarchy -> Hierarchy is text-only
// (file.backlinks — the same shape as the real vault schema), so it can never be rewritten
// automatically: converting to it strands a property-linked Hierarchy child.
const schema = schemaFrom({
  types: {
    Category: { tag: 'category', children: { 'Meta-note': 'category', Hierarchy: 'category' } },
    'Meta-note': { tag: 'meta', children: { Hierarchy: 'meta' } },
    Problem: { tag: 'problem', children: { Hierarchy: 'problem' } },
    Hierarchy: { tag: 'hierarchy', children: { Hierarchy: 'file.backlinks' } },
  },
});

const snap = snapshot([
  note('cat.md', { tags: ['category'] }),
  note('p.md', {
    basename: 'Problem note',
    tags: ['problem'],
  }),
  note('h.md', {
    basename: 'Child',
    tags: ['hierarchy'],
    frontmatter: { problem: '[[Problem note]]' },
    propertyLinks: { problem: ['p.md'] },
  }),
]);
const structure = buildStructure(schema, snap);

describe('convertOptions', () => {
  it('lists the types a problem can become under a category, keeping its Hierarchy child', () => {
    expect(convertOptions(schema, structure, 'p.md', 'cat.md')).toEqual(['Meta-note']);
  });

  it('excludes a candidate type with no rule to the parent at all', () => {
    // Category has no rule to itself.
    expect(convertOptions(schema, structure, 'p.md', 'cat.md')).not.toContain('Category');
  });

  it('leaves out a type that would orphan the branch (text-only child rule, unwritable)', () => {
    expect(convertOptions(schema, structure, 'p.md', 'cat.md')).not.toContain('Hierarchy');
  });

  it('returns [] for a node missing from the structure', () => {
    expect(convertOptions(schema, structure, 'ghost.md', 'cat.md')).toStrictEqual([]);
  });

  it('returns [] for a parent missing from the structure', () => {
    expect(convertOptions(schema, structure, 'p.md', 'ghost.md')).toStrictEqual([]);
  });

  it('returns [] when the requested parent is the node itself or its own descendant', () => {
    expect(convertOptions(schema, structure, 'p.md', 'p.md')).toStrictEqual([]);
    expect(convertOptions(schema, structure, 'p.md', 'h.md')).toStrictEqual([]);
  });
});

describe('planConvert', () => {
  it('retypes the node, moves it, and rewrites the branch — the child keeps its place', () => {
    const result = planAction(schema, snap, convert('p.md', 'cat.md', 'Meta-note'), noEnv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const afterSnap = applyPlan(snap, result.plan);
    const after = buildStructure(schema, afterSnap);
    expect(after.nodes.get('p.md')?.parent).toBe('cat.md');
    expect(after.nodes.get('p.md')?.type).toBe('Meta-note');
    expect(after.nodes.get('h.md')?.parent).toBe('p.md');
    // The child's own edge property moved from "problem" (Problem's rule) to "meta" (Meta-note's).
    expect(afterSnap.notes.get('h.md')?.propertyLinks['meta']).toStrictEqual(['p.md']);
    expect(afterSnap.notes.get('h.md')?.propertyLinks['problem']).toBeUndefined();
  });

  it('rejects a conversion the whole branch cannot survive', () => {
    const result = planAction(schema, snap, convert('p.md', 'cat.md', 'Hierarchy'), noEnv);

    expect(result).toStrictEqual({
      ok: false,
      reason: '"Problem note" cannot become "Hierarchy": "Child" would have no parent',
    });
  });

  it('rejects an unknown type', () => {
    const result = planAction(schema, snap, convert('p.md', 'cat.md', 'Ghost'), noEnv);
    expect(result).toStrictEqual({ ok: false, reason: 'Unknown type "Ghost"' });
  });

  it('rejects a node that is not in the structure', () => {
    const result = planAction(schema, snap, convert('ghost.md', 'cat.md', 'Meta-note'), noEnv);
    expect(result).toStrictEqual({ ok: false, reason: '"ghost" is not in the structure' });
  });

  it('rejects a parent that is not in the structure', () => {
    const result = planAction(schema, snap, convert('p.md', 'ghost.md', 'Meta-note'), noEnv);
    expect(result).toStrictEqual({ ok: false, reason: '"ghost" is not in the structure' });
  });

  it('rejects moving a node into itself or its own branch', () => {
    const result = planAction(schema, snap, convert('p.md', 'h.md', 'Meta-note'), noEnv);
    expect(result).toStrictEqual({
      ok: false,
      reason: 'Cannot move "Problem note" into itself or its own branch',
    });
  });

  it('rejects a type with no rule under the requested parent', () => {
    const result = planAction(schema, snap, convert('p.md', 'cat.md', 'Problem'), noEnv);
    expect(result).toStrictEqual({
      ok: false,
      reason: '"Problem" cannot be placed under "cat"',
    });
  });
});

describe('planConvert — the structure root', () => {
  it('rejects converting the root itself', () => {
    const rootSnap = snapshot(
      [
        note('cat.md', { tags: ['category'] }),
        note('p.md', { basename: 'Problem note', tags: ['problem'] }),
      ],
      { host: 'cat.md' },
    );
    const result = planAction(schema, rootSnap, convert('cat.md', 'p.md', 'Meta-note'), noEnv);
    expect(result).toStrictEqual({ ok: false, reason: 'The root cannot be moved' });
  });
});

describe('planConvert — I4: the old type tag must be rewritable', () => {
  const tagSchema = schemaFrom({
    types: {
      Cat2: { tag: 'cat2', children: { Alpha: 'up', Beta: 'up' } },
      Alpha: { tag: 'alpha' },
      Beta: { tag: 'beta' },
    },
  });

  it('rejects converting when the old type tag lives only in body text', () => {
    const tagSnap = snapshot([
      note('cat2.md', { tags: ['cat2'] }),
      note('n.md', { tags: ['alpha'], frontmatterTags: [], bodyTags: ['alpha'] }),
    ]);

    const result = planAction(tagSchema, tagSnap, convert('n.md', 'cat2.md', 'Beta'), noEnv);

    expect(result).toStrictEqual({
      ok: false,
      reason: '"n" keeps the tag "alpha" in its text; remove it there first',
    });
  });
});

describe('planConvert — text-based (non-property) edges on both sides', () => {
  const textSchema = schemaFrom({
    types: {
      OldCat: { tag: 'oldcat', children: { Thing: 'file.backlinks' } },
      NewCat: { tag: 'newcat', children: { OtherThing: 'file.backlinks' } },
      Thing: { tag: 'thing' },
      OtherThing: { tag: 'otherthing' },
    },
  });
  const textSnap = snapshot(
    [
      note('oldcat.md', { tags: ['oldcat'], links: ['thing.md'] }),
      note('newcat.md', { tags: ['newcat'] }),
      note('thing.md', { tags: ['thing'] }),
    ],
    { results: ['oldcat.md', 'newcat.md', 'thing.md'] },
  );

  it('appends the new body mention and removes the old one when both edges are text-based', () => {
    const result = planAction(
      textSchema,
      textSnap,
      convert('thing.md', 'newcat.md', 'OtherThing'),
      noEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.appends).toStrictEqual([{ path: 'newcat.md', target: 'thing.md' }]);
    expect(result.plan.bodyLinkRemovals).toStrictEqual([{ path: 'oldcat.md', target: 'thing.md' }]);
    const after = buildStructure(textSchema, applyPlan(textSnap, result.plan));
    expect(after.nodes.get('thing.md')?.parent).toBe('newcat.md');
    expect(after.nodes.get('thing.md')?.type).toBe('OtherThing');
  });
});

describe('planConvert — keeps a genuine property extra untouched', () => {
  const extraSchema = schemaFrom({
    types: {
      P1: { tag: 'p1', children: { N: 'link1' } },
      P2: { tag: 'p2', children: { N: 'link2' } },
      NewCat: { tag: 'newcat', children: { M: 'up' } },
      N: { tag: 'n' },
      M: { tag: 'm' },
    },
  });
  const extraSnap = snapshot([
    note('p1.md', { tags: ['p1'] }),
    note('p2.md', { tags: ['p2'] }),
    note('newcat.md', { tags: ['newcat'] }),
    note('n.md', {
      tags: ['n'],
      frontmatter: { link1: '[[p1]]', link2: '[[p2]]' },
      propertyLinks: { link1: ['p1.md'], link2: ['p2.md'] },
    }),
  ]);

  it('keeps the losing candidate as an untouched extra after converting to a different parent+type', () => {
    const before = buildStructure(extraSchema, extraSnap).nodes.get('n.md');
    expect(before?.parent).toBe('p2.md');
    expect(before?.extras).toStrictEqual([{ parent: 'p1.md', kind: 'property' }]);

    const result = planAction(extraSchema, extraSnap, convert('n.md', 'newcat.md', 'M'), noEnv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const afterSnap = applyPlan(extraSnap, result.plan);
    const after = buildStructure(extraSchema, afterSnap);
    expect(after.nodes.get('n.md')?.parent).toBe('newcat.md');
    expect(after.nodes.get('n.md')?.type).toBe('M');
    // "link1" (the losing candidate, p1.md) was never the primary edge — untouched by the convert.
    expect(afterSnap.notes.get('n.md')?.propertyLinks['link1']).toStrictEqual(['p1.md']);
  });
});

describe('planConvert — an untouched higher-priority candidate survives the conversion', () => {
  // Mirrors plan-move.test.ts's own "still rejects when an untouched higher-priority candidate
  // survives the move" case: M (level 2) outranks K (level 1) and N (level 0) regardless of which
  // one the action asks for, so even a successful-looking write to "n_key" still leaves M in
  // charge — verifyConvert must catch this by simulation, not just by planning the requested edge.
  const rivalSchema = schemaFrom({
    types: {
      N: { tag: 'n', children: { NodeT: 'n_key' } },
      K: { tag: 'k', children: { NodeT: 'k_key' } },
      M: { tag: 'm', children: { NodeT: 'm_key' } },
      NodeT: { tag: 'nodet' },
    },
  });
  const rivalSnap = snapshot([
    note('N.md', { tags: ['n'] }),
    note('K.md', { tags: ['k'] }),
    note('M.md', { tags: ['m'] }),
    note('node.md', {
      tags: ['nodet'],
      frontmatter: { m_key: '[[M]]', k_key: '[[K]]' },
      propertyLinks: { m_key: ['M.md'], k_key: ['K.md'] },
    }),
  ]);

  it('rejects when a stronger untouched candidate still outranks the requested parent', () => {
    const result = planAction(rivalSchema, rivalSnap, convert('node.md', 'N.md', 'NodeT'), noEnv);

    expect(result).toStrictEqual({
      ok: false,
      reason: '"node" would not become "NodeT" under "N"',
    });
  });
});

describe('operationTargets', () => {
  it("delegates to moveTargets for 'move'", () => {
    // h.md (Hierarchy) can move straight under cat.md (Category -> Hierarchy is a direct rule) —
    // a non-trivial set, so this actually exercises the delegation rather than two empty sets.
    expect(operationTargets(schema, structure, 'h.md', 'move')).toStrictEqual(
      moveTargets(schema, structure, 'h.md'),
    );
    expect(operationTargets(schema, structure, 'h.md', 'move')).toStrictEqual(new Set(['cat.md']));
  });

  it("offers convert targets only where some type fits, for 'convert'", () => {
    expect(operationTargets(schema, structure, 'p.md', 'convert')).toStrictEqual(
      new Set(['cat.md']),
    );
  });

  it("excludes the node's own descendant as a convert target", () => {
    expect(operationTargets(schema, structure, 'p.md', 'convert')).not.toContain('h.md');
  });
});
