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

  it('moves across a required file.backlinks rule: appends to the new parent, removes from the old', () => {
    // backkid's only route to Category is file.backlinks (cat1's body mentions it) — Task 8's
    // move-over-text-links: the append writes the new parent's body, the removal cuts the old.
    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'backkid.md', parent: 'cat2.md' },
      noEnv,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.appends).toStrictEqual([{ path: 'cat2.md', target: 'backkid.md' }]);
    expect(result.plan.bodyLinkRemovals).toStrictEqual([{ path: 'cat1.md', target: 'backkid.md' }]);
  });

  it('moves across a required file.links rule: appends to the node itself, removes from the node itself', () => {
    // linkkid's only route to Category is file.links (linkkid's own body mentions its parent) —
    // both the new mention and the cut of the old one land on linkkid's own note, not cat1/cat2's.
    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'linkkid.md', parent: 'cat2.md' },
      noEnv,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.appends).toStrictEqual([{ path: 'linkkid.md', target: 'cat2.md' }]);
    expect(result.plan.bodyLinkRemovals).toStrictEqual([{ path: 'linkkid.md', target: 'cat1.md' }]);
  });
});

describe('planAction — move: over a text-linked hierarchy (Task 8)', () => {
  // h1 (root) links [[h2]] in its body; h2 in turn links [[h4]], which links [[h5]] — a
  // three-level text-edge branch. h3 and h6 are unlinked Hierarchy tops: h3 has its own
  // "category" (Cat3), h6 has none and no previous parent at all.
  const schema = schemaFrom({
    inherit: ['category'],
    types: { Hierarchy: { tag: 'hier', children: { Hierarchy: 'file.backlinks' } } },
  });
  const snap = snapshot(
    [
      note('Cat1.md'),
      note('Cat3.md'),
      note('h1.md', {
        tags: ['hier'],
        frontmatter: { category: ['[[Cat1]]'] },
        propertyLinks: { category: ['Cat1.md'] },
        links: ['h2.md'],
      }),
      note('h2.md', {
        tags: ['hier'],
        frontmatter: { category: ['[[Cat1]]'] },
        propertyLinks: { category: ['Cat1.md'] },
        links: ['h4.md'],
      }),
      note('h3.md', {
        tags: ['hier'],
        frontmatter: { category: ['[[Cat3]]'] },
        propertyLinks: { category: ['Cat3.md'] },
      }),
      note('h4.md', {
        tags: ['hier'],
        frontmatter: { category: ['[[Cat1]]'] },
        propertyLinks: { category: ['Cat1.md'] },
        links: ['h5.md'],
      }),
      note('h5.md', {
        tags: ['hier'],
        frontmatter: { category: ['[[Cat1]]'] },
        propertyLinks: { category: ['Cat1.md'] },
      }),
      note('h6.md', { tags: ['hier'] }),
    ],
    { host: 'h1.md', results: ['h1.md', 'h2.md', 'h3.md', 'h4.md', 'h5.md', 'h6.md'] },
  );
  const structure = buildStructure(schema, snap);
  const result = planAction(schema, snap, { kind: 'move', node: 'h2.md', parent: 'h3.md' }, noEnv);

  it('moves a hierarchy under another hierarchy', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.appends).toStrictEqual([{ path: 'h3.md', target: 'h2.md' }]);
    expect(result.plan.bodyLinkRemovals).toStrictEqual([{ path: 'h1.md', target: 'h2.md' }]);
  });

  it('carries the whole branch: every descendant keeps its own parent and its inherited keys rewrite at every level', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.plan.changes.map((change) => change.path);
    expect(paths).toEqual(expect.arrayContaining(['h2.md', 'h4.md', 'h5.md']));
    const afterSnap = applyPlan(snap, result.plan);
    const after = buildStructure(schema, afterSnap);
    expect(after.nodes.get('h2.md')?.parent).toBe('h3.md');
    expect(after.nodes.get('h4.md')?.parent).toBe('h2.md');
    expect(after.nodes.get('h5.md')?.parent).toBe('h4.md');
    expect(afterSnap.notes.get('h4.md')?.frontmatter['category']).toStrictEqual(['[[Cat3]]']);
    expect(afterSnap.notes.get('h5.md')?.frontmatter['category']).toStrictEqual(['[[Cat3]]']);
  });

  it('offers text-link parents as move targets', () => {
    expect(moveTargets(schema, structure, 'h2.md')).toContain('h3.md');
  });

  it('appends only, with nothing to remove, when the node had no previous parent', () => {
    const orphanResult = planAction(
      schema,
      snap,
      { kind: 'move', node: 'h6.md', parent: 'h1.md' },
      noEnv,
    );
    expect(orphanResult.ok).toBe(true);
    if (!orphanResult.ok) return;
    expect(orphanResult.plan.appends).toStrictEqual([{ path: 'h1.md', target: 'h6.md' }]);
    expect(orphanResult.plan.bodyLinkRemovals).toStrictEqual([]);
  });
});

describe('planAction — move: old and new edge kinds differ (review fix)', () => {
  it('old edge property, new edge backlinks: clears the stale property, no bogus body removal, no stale extra', () => {
    // CatA (level 0, property "up") declared before CatB (level 1, file.backlinks) — deeper level
    // wins regardless of kind (compareCandidates), so if the old "up" property were left
    // uncleaned, CatB would still win primary and CatA would surface as a dangling extra: the
    // exact corruption a stale old edge produces when only the new rule's kind is consulted.
    const schema = schemaFrom({
      types: {
        CatA: { tag: 'cata', children: { NodeT: 'up' } },
        CatB: { tag: 'catb', children: { NodeT: 'file.backlinks' } },
        NodeT: { tag: 'nodet' },
      },
    });
    const notes = [
      note('catA.md', { tags: ['cata'] }),
      note('catB.md', { tags: ['catb'] }),
      note('child.md', {
        tags: ['nodet'],
        frontmatter: { up: '[[CatA]]' },
        propertyLinks: { up: ['catA.md'] },
      }),
    ];
    const snap = snapshot(notes, { results: notes.map((entry) => entry.path) });

    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'child.md', parent: 'catB.md' },
      noEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'child.md',
        writes: [
          { key: 'up', value: { kind: 'links', remove: ['catA.md'], add: [], list: false } },
        ],
      },
    ]);
    expect(result.plan.appends).toStrictEqual([{ path: 'catB.md', target: 'child.md' }]);
    expect(result.plan.bodyLinkRemovals).toStrictEqual([]);
    const after = buildStructure(schema, applyPlan(snap, result.plan));
    expect(after.nodes.get('child.md')?.parent).toBe('catB.md');
    expect(after.nodes.get('child.md')?.extras).toStrictEqual([]);
  });

  it('old edge backlinks, new edge property: removes the stale body mention, no stale extra (mirror case)', () => {
    // CatA2 (level 0, file.backlinks) declared before CatB2 (level 1, property "up2") — the same
    // deeper-wins-regardless-of-kind setup, mirrored: if the old backlinks mention were left in
    // CatA2's body, CatB2 would still win primary and CatA2 would surface as a dangling extra.
    const schema = schemaFrom({
      types: {
        CatA2: { tag: 'cata2', children: { NodeT2: 'file.backlinks' } },
        CatB2: { tag: 'catb2', children: { NodeT2: 'up2' } },
        NodeT2: { tag: 'nodet2' },
      },
    });
    const notes = [
      note('catA2.md', { tags: ['cata2'], links: ['child2.md'] }),
      note('catB2.md', { tags: ['catb2'] }),
      note('child2.md', { tags: ['nodet2'] }),
    ];
    const snap = snapshot(notes, { results: notes.map((entry) => entry.path) });

    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'child2.md', parent: 'catB2.md' },
      noEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'child2.md',
        writes: [
          { key: 'up2', value: { kind: 'links', remove: [], add: ['catB2.md'], list: true } },
        ],
      },
    ]);
    expect(result.plan.appends).toStrictEqual([]);
    expect(result.plan.bodyLinkRemovals).toStrictEqual([{ path: 'catA2.md', target: 'child2.md' }]);
    const after = buildStructure(schema, applyPlan(snap, result.plan));
    expect(after.nodes.get('child2.md')?.parent).toBe('catB2.md');
    expect(after.nodes.get('child2.md')?.extras).toStrictEqual([]);
  });

  it('still rejects when an untouched higher-priority candidate survives the move', () => {
    // K (level 1, property "k_key") is an independent, untouched "extra" that predates and
    // outlives this move — M (level 2, the old edge) gets properly cleaned up, but K, unrelated
    // to both the old and new edge, still outranks N (level 0, the requested new parent) once M
    // is gone. verifyMove must still catch this, not silently accept a plan that lands the node
    // somewhere other than requested — this is plain property-to-property, unaffected by the
    // old/new-kind fix above; it just needs to keep working.
    const schema = schemaFrom({
      types: {
        N: { tag: 'n', children: { NodeT: 'n_key' } },
        K: { tag: 'k', children: { NodeT: 'k_key' } },
        M: { tag: 'm', children: { NodeT: 'm_key' } },
        NodeT: { tag: 'nodet' },
      },
    });
    const notes = [
      note('N.md', { tags: ['n'] }),
      note('K.md', { tags: ['k'] }),
      note('M.md', { tags: ['m'] }),
      note('node.md', {
        tags: ['nodet'],
        frontmatter: { m_key: '[[M]]', k_key: '[[K]]' },
        propertyLinks: { m_key: ['M.md'], k_key: ['K.md'] },
      }),
    ];
    const snap = snapshot(notes, { results: notes.map((entry) => entry.path) });

    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'node.md', parent: 'N.md' },
      noEnv,
    );

    expect(result).toStrictEqual({ ok: false, reason: '"node" would stay under "K"' });
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
        bodyLinkRemovals: [],
      },
    });
  });
});

describe('planAction — move: preserves an unresolved link, plain text, and a link outside the base', () => {
  it("moving H from A to M2 keeps H's other meta values (an unresolved link, plain text, an untagged existing note, and Ext — a typed Meta-note outside the base's own results) and H's other category values (ExtCat — a typed Category outside the base's own results — and a plain user-added value), the reviewer's full C1 reproduction, exercised end to end through the real planner", () => {
    const schema = schemaFrom({
      inherit: ['category'],
      types: {
        Category: { tag: 'category', children: { 'Meta-note': 'category' } },
        'Meta-note': { tag: 'meta', children: { Hierarchy: 'meta' } },
        Hierarchy: { tag: 'hier' },
      },
    });
    const C1 = note('C1.md', { tags: ['category'] });
    const C2 = note('C2.md', { tags: ['category'] });
    // "ExtCat" is a real, typed Category, but not part of the base's own results — same "also in"
    // shape as "Ext" below, one level up (an inherited key rather than the edge key).
    const ExtCat = note('ExtCat.md', { tags: ['category'] });
    const UserCat = note('UserCat.md');
    const A = note('A.md', { tags: ['meta'], propertyLinks: { category: ['C1.md'] } });
    const M2 = note('M2.md', { tags: ['meta'], propertyLinks: { category: ['C2.md'] } });
    // "Ext" is a real, typed Meta-note, but not part of the base's own results — reachable only as
    // an external property-link target (readSnapshot's one-level inclusion), matching the "also
    // in" chip the view shows for it. "Random" is an existing note with no type/tag at all.
    const Ext = note('Ext.md', { tags: ['meta'] });
    const Random = note('Random.md');
    const H = note('H.md', {
      tags: ['hier'],
      frontmatter: {
        meta: ['[[A]]', '[[Not yet written]]', 'some text', '[[Ext]]', '[[Random]]'],
        category: ['[[C1]]', '[[ExtCat]]', '[[UserCat]]'],
      },
      propertyLinks: {
        meta: ['A.md', 'Ext.md', 'Random.md'],
        category: ['C1.md', 'ExtCat.md', 'UserCat.md'],
      },
    });
    const snap = snapshot([C1, C2, ExtCat, UserCat, A, M2, Ext, Random, H], {
      results: ['A.md', 'M2.md', 'H.md'],
    });

    const result = planAction(schema, snap, { kind: 'move', node: 'H.md', parent: 'M2.md' }, noEnv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'H.md',
        writes: [
          { key: 'meta', value: { kind: 'links', remove: ['A.md'], add: ['M2.md'], list: true } },
          {
            key: 'category',
            value: { kind: 'links', remove: ['C1.md'], add: ['C2.md'], list: true },
          },
        ],
      },
    ]);
    const after = applyPlan(snap, result.plan);
    expect(after.notes.get('H.md')?.frontmatter['meta']).toStrictEqual([
      '[[M2]]',
      '[[Not yet written]]',
      'some text',
      '[[Ext]]',
      '[[Random]]',
    ]);
    expect(after.notes.get('H.md')?.frontmatter['category']).toStrictEqual([
      '[[C2]]',
      '[[ExtCat]]',
      '[[UserCat]]',
    ]);
  });
});

describe('planAction — move: round 3 — a move only writes what it changes', () => {
  it('cascades to grandchildren without also copying down a sibling-chain value nothing in this move actually changed (H/A/M2, extended to K and L)', () => {
    // K is H's child (Hierarchy -> Hierarchy via file.backlinks) and already, independently, holds
    // "UserVal" in its own inherited "category" — nothing to do with this move. L is K's child.
    // Neither K's nor L's own "meta"/"category" had ever been fully cascaded from H (a realistic
    // gap, not something this move caused) — round 2's "add = U_new - current" would have both
    // retroactively closing that gap (K/L picking up Ext/Random/ExtCat they never had) *and*
    // leaking K's own UserVal down to L. Round 3: only the genuinely new M2/C2 contribution lands.
    const schema = schemaFrom({
      inherit: ['category', 'meta'],
      types: {
        Category: { tag: 'category', children: { 'Meta-note': 'category' } },
        'Meta-note': { tag: 'meta', children: { Hierarchy: 'meta' } },
        Hierarchy: { tag: 'hier', children: { Hierarchy: 'file.backlinks' } },
      },
    });
    const notes = [
      note('C1.md', { tags: ['category'] }),
      note('C2.md', { tags: ['category'] }),
      note('ExtCat.md', { tags: ['category'] }),
      note('Ext.md', { tags: ['meta'] }),
      note('Random.md'),
      note('UserVal.md'),
      note('A.md', { tags: ['meta'], propertyLinks: { category: ['C1.md'] } }),
      note('M2.md', { tags: ['meta'], propertyLinks: { category: ['C2.md'] } }),
      note('H.md', {
        tags: ['hier'],
        frontmatter: {
          meta: ['[[A]]', '[[Not yet written]]', 'some text', '[[Ext]]', '[[Random]]'],
          category: ['[[C1]]', '[[ExtCat]]'],
        },
        propertyLinks: { meta: ['A.md', 'Ext.md', 'Random.md'], category: ['C1.md', 'ExtCat.md'] },
        links: ['A.md', 'Ext.md', 'Random.md', 'K.md'],
      }),
      note('K.md', {
        tags: ['hier'],
        frontmatter: { meta: ['[[A]]'], category: ['[[C1]]', '[[UserVal]]'] },
        propertyLinks: { meta: ['A.md'], category: ['C1.md', 'UserVal.md'] },
        links: ['L.md'],
      }),
      note('L.md', {
        tags: ['hier'],
        frontmatter: { meta: ['[[A]]'], category: ['[[C1]]'] },
        propertyLinks: { meta: ['A.md'], category: ['C1.md'] },
      }),
    ];
    const snap = snapshot(notes, { host: 'A.md', results: notes.map((n) => n.path) });

    const result = planAction(schema, snap, { kind: 'move', node: 'H.md', parent: 'M2.md' }, noEnv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byPath = (path: string): unknown =>
      result.plan.changes.find((change) => change.path === path)?.writes;
    expect(byPath('K.md')).toStrictEqual([
      { key: 'category', value: { kind: 'links', remove: ['C1.md'], add: ['C2.md'], list: true } },
      { key: 'meta', value: { kind: 'links', remove: ['A.md'], add: ['M2.md'], list: true } },
    ]);
    expect(byPath('L.md')).toStrictEqual([
      { key: 'category', value: { kind: 'links', remove: ['C1.md'], add: ['C2.md'], list: true } },
      { key: 'meta', value: { kind: 'links', remove: ['A.md'], add: ['M2.md'], list: true } },
    ]);
    const after = applyPlan(snap, result.plan);
    expect(after.notes.get('K.md')?.frontmatter['meta']).toStrictEqual(['[[M2]]']);
    expect(after.notes.get('K.md')?.frontmatter['category']).toStrictEqual([
      '[[C2]]',
      '[[UserVal]]',
    ]);
    expect(after.notes.get('L.md')?.frontmatter['meta']).toStrictEqual(['[[M2]]']);
    expect(after.notes.get('L.md')?.frontmatter['category']).toStrictEqual(['[[C2]]']);
  });
});

describe('planAction — move: round 2 C1 — remove only what the action invalidates', () => {
  it('keeps an untagged existing note and a wrong-type note sitting in the edge key — neither is contributed by the old parent, so neither is stale', () => {
    const schema = schemaFrom({
      types: {
        MetaT: { tag: 'meta', children: { Hier: 'meta' } },
        Hier: { tag: 'hier' },
        Other: { tag: 'other' },
      },
    });
    const snap = snapshot([
      note('a.md', { tags: ['meta'] }),
      note('c.md', { tags: ['meta'] }),
      // An existing note the user linked into `meta` that has no type/tag at all (e.g. created by
      // clicking an unresolved link) — not contributed by "a.md", so never stale.
      note('random.md'),
      // A note of a completely different, unrelated type — also never contributed by "a.md".
      note('wrong-type.md', { tags: ['other'] }),
      note('hier.md', {
        tags: ['hier'],
        frontmatter: { meta: ['[[a]]', '[[random]]', '[[wrong-type]]'] },
        propertyLinks: { meta: ['a.md', 'random.md', 'wrong-type.md'] },
      }),
    ]);

    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'hier.md', parent: 'c.md' },
      noEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'hier.md',
        writes: [
          { key: 'meta', value: { kind: 'links', remove: ['a.md'], add: ['c.md'], list: true } },
        ],
      },
    ]);
    const after = applyPlan(snap, result.plan);
    expect(after.notes.get('hier.md')?.frontmatter['meta']).toStrictEqual([
      '[[c]]',
      '[[random]]',
      '[[wrong-type]]',
    ]);
  });

  it('cascades a category change to a grandchild\'s inherited key while keeping a typed "also in" link and a user-added value already sitting there', () => {
    const schema = schemaFrom({
      types: {
        Category: { tag: 'cat', children: { MetaT: 'category' } },
        MetaT: { tag: 'meta', children: { Hier: 'meta' } },
        Hier: { tag: 'hier' },
      },
      inherit: ['category'],
    });
    const c1 = note('c1.md', { tags: ['cat'] });
    const c2 = note('c2.md', { tags: ['cat'] });
    // A typed Category note outside the base's own results ("also in" in the view) and a plain
    // user-added value, both already sitting in the grandchild's inherited `category` alongside
    // what it currently inherits from "m.md" (c1).
    const extCat = note('ext-cat.md', { tags: ['cat'] });
    const m = note('m.md', {
      tags: ['meta'],
      frontmatter: { category: ['[[c1]]'] },
      propertyLinks: { category: ['c1.md'] },
    });
    const h = note('h.md', {
      tags: ['hier'],
      frontmatter: { meta: ['[[m]]'], category: ['[[c1]]', '[[ext-cat]]', '[[user added]]'] },
      propertyLinks: { meta: ['m.md'], category: ['c1.md', 'ext-cat.md', 'user added.md'] },
    });
    const snap = snapshot([c1, c2, extCat, m, h], {
      results: ['c1.md', 'c2.md', 'm.md', 'h.md'],
    });

    const result = planAction(schema, snap, { kind: 'move', node: 'm.md', parent: 'c2.md' }, noEnv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hChange = result.plan.changes.find((change) => change.path === 'h.md');
    expect(hChange).toStrictEqual({
      path: 'h.md',
      writes: [
        {
          key: 'category',
          value: { kind: 'links', remove: ['c1.md'], add: ['c2.md'], list: true },
        },
      ],
    });
    const after = applyPlan(snap, result.plan);
    expect(after.notes.get('h.md')?.frontmatter['category']).toStrictEqual([
      '[[c2]]',
      '[[ext-cat]]',
      '[[user added]]',
    ]);
  });

  it('moving a node directly under a grandparent it already inherited this key from is a no-op for that value, not a silent drop', () => {
    // "child.md" currently sits under "meta.md" (via the "meta" edge) and separately inherits
    // "category" from it — "cat1.md" (via meta.md's own category). Moving child.md so its *new*
    // edge parent is that same cat1.md (reparenting it directly under its own grandparent) means
    // the new parent is simultaneously "already present" and "stale" (meta.md's own contribution
    // to this key *was* cat1.md) — edgeKeyPatch must never remove it without re-adding it.
    const schema = schemaFrom({
      types: {
        Category: { tag: 'category', children: { MetaT: 'category', Hier: 'category' } },
        MetaT: { tag: 'meta', children: { Hier: 'meta' } },
        Hier: { tag: 'hier' },
      },
      inherit: ['category'],
    });
    const snap = snapshot([
      note('cat1.md', { tags: ['category'] }),
      note('meta.md', { tags: ['meta'], propertyLinks: { category: ['cat1.md'] } }),
      note('child.md', {
        tags: ['hier'],
        frontmatter: { meta: ['[[meta]]'], category: ['[[cat1]]'] },
        propertyLinks: { meta: ['meta.md'], category: ['cat1.md'] },
      }),
    ]);

    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'child.md', parent: 'cat1.md' },
      noEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = applyPlan(snap, result.plan);
    expect(after.notes.get('child.md')?.frontmatter['category']).toStrictEqual(['[[cat1]]']);
    expect(after.notes.get('child.md')?.propertyLinks['category']).toStrictEqual(['cat1.md']);
  });

  it("round 3: a non-inherited edge key only removes the old parent itself, never the old parent's own (unrelated) value for that same property name", () => {
    // "area" is N's edge key here but isn't in `schema.inherit` — O's own "area" value is
    // coincidental, unrelated data (O is the untyped host, so it's a structure node at all only by
    // virtue of being host; its own "area" property has no structural meaning). N's edge to O is
    // via "[[O]]"; "Ref" is a second, independent value N happens to also hold in the same
    // property, which is *also* one of O's own (unrelated) area values — round 2's oldContribOf
    // wrongly folded O's own contribution into the removal set regardless of whether "area" was an
    // inherit key, deleting Ref even though O never actually contributed it to N.
    const schema = schemaFrom({
      types: {
        AreaT: { tag: 'area-tag', children: { NT: 'area' } },
        NT: { tag: 'nt' },
      },
    });
    const snap = snapshot(
      [
        note('AreaX.md'),
        note('Ref.md'),
        note('O.md', {
          propertyLinks: { area: ['AreaX.md', 'Ref.md'] },
          frontmatter: { area: ['[[AreaX]]', '[[Ref]]'] },
        }),
        note('AreaY.md', { tags: ['area-tag'] }),
        note('N.md', {
          tags: ['nt'],
          propertyLinks: { area: ['O.md', 'Ref.md'] },
          frontmatter: { area: ['[[O]]', '[[Ref]]'] },
        }),
      ],
      { host: 'O.md' },
    );

    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'N.md', parent: 'AreaY.md' },
      noEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'N.md',
        writes: [
          {
            key: 'area',
            value: { kind: 'links', remove: ['O.md'], add: ['AreaY.md'], list: true },
          },
        ],
      },
    ]);
    const after = applyPlan(snap, result.plan);
    expect(after.notes.get('N.md')?.frontmatter['area']).toStrictEqual(['[[AreaY]]', '[[Ref]]']);
  });

  it('round 3: an untyped host’s own value for a non-inherited edge key never leaks into the moved node’s removal set', () => {
    // The reviewer's exact second probe: an untyped host MOC with its own (unrelated) "up: [[Home]]",
    // and a task whose own "up" holds both MOC (its real parent) and Home (its own, independent
    // value, coincidentally identical to MOC's). Moving the task must drop only MOC.
    const schema = schemaFrom({
      types: {
        ProjT: { tag: 'proj', children: { TaskT: 'up' } },
        TaskT: { tag: 'task' },
      },
    });
    const snap = snapshot(
      [
        note('Home.md'),
        note('MOC.md', { propertyLinks: { up: ['Home.md'] }, frontmatter: { up: '[[Home]]' } }),
        note('Proj.md', { tags: ['proj'] }),
        note('task.md', {
          tags: ['task'],
          propertyLinks: { up: ['MOC.md', 'Home.md'] },
          frontmatter: { up: ['[[MOC]]', '[[Home]]'] },
        }),
      ],
      { host: 'MOC.md' },
    );

    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: 'task.md', parent: 'Proj.md' },
      noEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'task.md',
        writes: [
          { key: 'up', value: { kind: 'links', remove: ['MOC.md'], add: ['Proj.md'], list: true } },
        ],
      },
    ]);
    const after = applyPlan(snap, result.plan);
    expect(after.notes.get('task.md')?.frontmatter['up']).toStrictEqual(['[[Proj]]', '[[Home]]']);
  });

  it('round 4: an inherited edge key removes only the old parent, never the old parent’s own value for that same key, when the node’s old edge to it was through that key', () => {
    // "category" is both N's edge key to its untyped host MOC (schema.inherit includes it) *and*
    // the key through which MOC — an untyped host — is itself N's old parent. MOC's own "category"
    // value ([[Knowledge]]) was never contributed to N by inheritance: N's link to MOC *is* the
    // edge relationship itself (oldEdge.property === rule.property), so nothing should fold MOC's
    // own raw value into the removal set — that fallback (`oldContribOf`'s "copy the parent's own
    // value" branch) exists only for chain-forwarding through a *different* property than the edge,
    // exactly like plan-create's `addInheritWrites` (`key === rule.property` skip) and derive.ts's
    // `inheritKeysFor` (excludes the node's own edge property) never touch this key via inheritance
    // either. Before the fix, staleForNewKey wrongly included Knowledge (MOC's own category value),
    // deleting a value that belongs to N, not to MOC.
    const schema = schemaFrom({
      types: {
        Category: { tag: 'cat', children: { MetaT: 'category' } },
        MetaT: { tag: 'meta' },
      },
      inherit: ['category'],
    });
    const snap = snapshot(
      [
        note('Knowledge.md'),
        note('MOC.md', {
          propertyLinks: { category: ['Knowledge.md'] },
          frontmatter: { category: '[[Knowledge]]' },
        }),
        note('C2.md', { tags: ['cat'] }),
        note('m.md', {
          tags: ['meta'],
          propertyLinks: { category: ['MOC.md', 'Knowledge.md'] },
          frontmatter: { category: ['[[MOC]]', '[[Knowledge]]'] },
        }),
      ],
      { host: 'MOC.md' },
    );

    const result = planAction(schema, snap, { kind: 'move', node: 'm.md', parent: 'C2.md' }, noEnv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'm.md',
        writes: [
          {
            key: 'category',
            value: { kind: 'links', remove: ['MOC.md'], add: ['C2.md'], list: true },
          },
        ],
      },
    ]);
    const after = applyPlan(snap, result.plan);
    expect(after.notes.get('m.md')?.frontmatter['category']).toStrictEqual([
      '[[C2]]',
      '[[Knowledge]]',
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

  it('excludes the node itself, its descendants, and its current parent', () => {
    // sub1's candidates would otherwise be: cat1 (self-excluded: it's already the parent),
    // cat2 (a valid Category target), leaf2a (its own descendant, excluded), and nothing via
    // BackKid (a different type entirely, not even a candidate rule for Sub).
    const targets = moveTargets(schema, structure, 'sub1.md');

    expect(targets).toStrictEqual(new Set(['cat2.md']));
  });

  it('includes a target reachable only through a text-based (backlinks) rule', () => {
    // backkid's only possible parent type is Category, and only via file.backlinks — still
    // offered as a move target (Task 8): the planner writes/removes the body mention itself.
    const targets = moveTargets(schema, structure, 'backkid.md');

    expect(targets).toStrictEqual(new Set(['cat2.md']));
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

  it('moves a text-edge (backlinks) node onto a category: clears the old body mention, no frontmatter change needed', () => {
    // basicVariables' old primary parent is r-lang hierarchy (file.backlinks, a deeper type than
    // Category so it outranks basicVariables' own "category" property even though that property
    // already holds r-lang — reattaching it directly under r-lang's category needs only the old
    // text mention removed; the already-consistent "category" property needs no write at all.
    const snap = rLangSnapshot();
    const basicVariables = 'base/_hierarchy/basic variables types in r.md';
    const rlangHierarchy = 'base/_hierarchy/r-lang hierarchy.md';
    const rlangCategory = 'base/categories/r-lang.md';

    const result = planAction(
      schema,
      snap,
      { kind: 'move', node: basicVariables, parent: rlangCategory },
      noEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe(basicVariables);
    expect(result.plan.changes).toStrictEqual([]);
    expect(result.plan.appends).toStrictEqual([]);
    expect(result.plan.bodyLinkRemovals).toStrictEqual([
      { path: rlangHierarchy, target: basicVariables },
    ]);
    const after = buildStructure(schema, applyPlan(snap, result.plan));
    expect(after.nodes.get(basicVariables)?.parent).toBe(rlangCategory);
    expect(after.nodes.get(basicVariables)?.extras).toStrictEqual([]);
  });
});
