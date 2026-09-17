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
