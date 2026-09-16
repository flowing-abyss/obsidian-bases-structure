import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_BASE_CONFIG,
  knowledgeBaseSnapshot,
} from './__tests__/knowledge-base.fixture.js';
import { note, snapshot } from './__tests__/notes.js';
import { retypeOptions } from './plan-retype.js';
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

function envAllowing(defaultFolder = ''): { defaultFolder: string; exists: () => boolean } {
  return { defaultFolder, exists: () => false };
}

describe('planAction — retype: rejection reasons (hand-built schema)', () => {
  // Category (root, host) has: Sub (property "up"), LinkKid (file.links), BackKid
  // (file.backlinks). No rule for "Other" at all.
  const schema = schemaFrom({
    types: {
      Category: {
        tag: 'cat',
        children: { Sub: 'up', LinkKid: 'file.links', BackKid: 'file.backlinks' },
      },
      Sub: { tag: 'sub' },
      LinkKid: { tag: 'linkkid' },
      BackKid: { tag: 'backkid' },
      Other: { tag: 'other' },
    },
  });
  const snap = snapshot(
    [
      note('cat.md', { tags: ['cat'], links: ['backkid.md'] }),
      note('sub.md', { tags: ['sub'], propertyLinks: { up: ['cat.md'] } }),
      note('linkkid.md', { tags: ['linkkid'], links: ['cat.md'] }),
      note('backkid.md', { tags: ['backkid'] }),
      note('other.md', { tags: ['other'] }),
    ],
    { host: 'cat.md', results: ['sub.md', 'linkkid.md', 'backkid.md', 'other.md'] },
  );

  it('rejects an unknown type', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'sub.md', type: 'Ghost' },
      envAllowing(),
    );
    expect(result).toStrictEqual({ ok: false, reason: 'Unknown type "Ghost"' });
  });

  it('rejects a node that is not in the structure', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'ghost.md', type: 'Sub' },
      envAllowing(),
    );
    expect(result).toStrictEqual({ ok: false, reason: '"ghost" is not in the structure' });
  });

  it('rejects retyping to the same type', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'sub.md', type: 'Sub' },
      envAllowing(),
    );
    expect(result).toStrictEqual({ ok: false, reason: '"sub" is already "Sub"' });
  });

  it('rejects a type with no rule under the current parent', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'sub.md', type: 'Other' },
      envAllowing(),
    );
    expect(result).toStrictEqual({ ok: false, reason: '"Other" cannot be placed under "cat"' });
  });

  it('rejects when the new rule is file.links and differs from the current (property) edge', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'sub.md', type: 'LinkKid' },
      envAllowing(),
    );
    expect(result).toStrictEqual({
      ok: false,
      reason: 'The link from "sub" to "cat" lives in note text and cannot be written automatically',
    });
  });

  it('rejects when the new rule is file.backlinks and differs from the current (property) edge', () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'sub.md', type: 'BackKid' },
      envAllowing(),
    );
    expect(result).toStrictEqual({
      ok: false,
      reason: 'The link from "cat" to "sub" lives in note text and cannot be written automatically',
    });
  });
});

describe('planAction — retype: folders', () => {
  const schema = schemaFrom({
    types: {
      Root: { tag: 'root', children: { Foo: 'up', Bar: 'up' } },
      Foo: { tag: 'foo' },
      Bar: { tag: 'bar', folder: 'bar-folder' },
    },
  });

  it('retyping into a type with a folder produces a moves entry and the new focus', () => {
    const snap = snapshot(
      [
        note('root.md', { tags: ['root'] }),
        note('n.md', { tags: ['foo'], propertyLinks: { up: ['root.md'] } }),
      ],
      { host: 'root.md', results: ['n.md'] },
    );

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'n.md', type: 'Bar' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe('bar-folder/n.md');
    expect(result.plan.moves).toStrictEqual([{ from: 'n.md', to: 'bar-folder/n.md' }]);
    expect(result.plan.changes).toStrictEqual([
      { path: 'n.md', writes: [{ key: 'tags', value: { kind: 'literal', value: ['bar'] } }] },
    ]);
  });

  it('rejects when a note already exists at the target folder path (snapshot)', () => {
    const snap = snapshot(
      [
        note('root.md', { tags: ['root'] }),
        note('n.md', { tags: ['foo'], propertyLinks: { up: ['root.md'] } }),
        note('bar-folder/n.md', { tags: ['bar'] }),
      ],
      { host: 'root.md', results: ['n.md', 'bar-folder/n.md'] },
    );

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'n.md', type: 'Bar' },
      envAllowing(),
    );

    expect(result).toStrictEqual({
      ok: false,
      reason: 'A note already exists at "bar-folder/n.md"',
    });
  });

  it('does not move when N already lives inside the target folder', () => {
    const snap = snapshot(
      [
        note('root.md', { tags: ['root'] }),
        note('bar-folder/sub/n.md', { tags: ['foo'], propertyLinks: { up: ['root.md'] } }),
      ],
      { host: 'root.md', results: ['bar-folder/sub/n.md'] },
    );

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'bar-folder/sub/n.md', type: 'Bar' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe('bar-folder/sub/n.md');
    expect(result.plan.moves).toStrictEqual([]);
  });

  it('rejects when a note already exists at the target folder path (env.exists)', () => {
    const snap = snapshot(
      [
        note('root.md', { tags: ['root'] }),
        note('n.md', { tags: ['foo'], propertyLinks: { up: ['root.md'] } }),
      ],
      { host: 'root.md', results: ['n.md'] },
    );

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'n.md', type: 'Bar' },
      { defaultFolder: '', exists: () => true },
    );

    expect(result).toStrictEqual({
      ok: false,
      reason: 'A note already exists at "bar-folder/n.md"',
    });
  });
});

describe('planAction — retype: property-typed schema literal swap', () => {
  it('property: { type: task } -> type: project swaps the literal value', () => {
    const schema = schemaFrom({
      types: {
        Cat: { tag: 'cat', children: { Task: 'up', Project: 'up' } },
        Task: { property: { type: 'task' } },
        Project: { property: { type: 'project' } },
      },
    });
    const snap = snapshot([
      note('cat.md', { tags: ['cat'] }),
      note('task.md', {
        frontmatter: { type: 'task' },
        propertyLinks: { up: ['cat.md'] },
      }),
    ]);

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'task.md', type: 'Project' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe('task.md');
    expect(result.plan.moves).toStrictEqual([]);
    expect(result.plan.changes).toStrictEqual([
      { path: 'task.md', writes: [{ key: 'type', value: { kind: 'literal', value: 'project' } }] },
    ]);
  });
});

describe('planAction — retype: own edge-key change cascades to children', () => {
  it('changing the property that links N to its parent rewrites a child that used the old key', () => {
    // Cat links Meta children via "category" but Prob2 children via "cat2" — retyping m.md from
    // Meta to Prob2 changes N's own edge key, and m.md's child h.md (a Hier linked via "meta")
    // must move to the new "prob2" key (Hier -> Prob2 is "prob2") because Hier -> Meta was "meta".
    const schema = schemaFrom({
      inherit: ['category'],
      types: {
        Cat: { tag: 'cat', children: { Meta: 'category', Prob2: 'cat2' } },
        Meta: { tag: 'meta', children: { Hier: 'meta' } },
        Prob2: { tag: 'prob2', children: { Hier: 'prob2' } },
        Hier: { tag: 'hier' },
      },
    });
    const snap = snapshot(
      [
        note('cat.md', { tags: ['cat'] }),
        note('m.md', { tags: ['meta'], propertyLinks: { category: ['cat.md'] } }),
        // "category" isn't set yet on h.md — it must be freshly cascaded down as part of the
        // subtree recompute (not just left alone the way "meta"/"prob2" are handled explicitly).
        note('h.md', { tags: ['hier'], propertyLinks: { meta: ['m.md'] } }),
      ],
      { host: 'cat.md', results: ['m.md', 'h.md'] },
    );

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'm.md', type: 'Prob2' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe('m.md');
    expect(result.plan.moves).toStrictEqual([]);
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'm.md',
        writes: [
          { key: 'tags', value: { kind: 'literal', value: ['prob2'] } },
          { key: 'cat2', value: { kind: 'links', remove: [], add: ['cat.md'], list: true } },
        ],
      },
      {
        path: 'h.md',
        writes: [
          { key: 'prob2', value: { kind: 'links', remove: [], add: ['m.md'], list: true } },
          { key: 'meta', value: { kind: 'links', remove: ['m.md'], add: [], list: true } },
          { key: 'category', value: { kind: 'links', remove: [], add: ['cat.md'], list: true } },
        ],
      },
    ]);
  });
});

describe('planAction — retype: old-type property cleanup and new-type property writes', () => {
  it('deletes/filters old-type properties no longer used, and writes new-type properties that differ', () => {
    // Every one of "Multi"'s own conditions must genuinely hold for n.md to already be a Multi:
    // "status" (array, contains the match) and "kind" (plain scalar) clean up as expected;
    // "linktext"/"linkarr" match only via type-matching's wikilink normalisation (not the cleanup
    // step's plain trim/lowercase compare), and "count" matches via a numeric value — all three
    // leave the property untouched ("otherwise no write"), exactly as the decisions doc specifies.
    const schema = schemaFrom({
      types: {
        Cat: { tag: 'cat', children: { Multi: 'up', Note: 'up' } },
        Multi: {
          property: {
            status: 'todo',
            kind: 'urgent',
            linktext: 'Todo',
            count: '5',
            linkarr: 'Todo',
          },
        },
        Note: { property: { already: 'same', changed: 'new' } },
      },
    });
    const snap = snapshot([
      note('cat.md', { tags: ['cat'] }),
      note('n.md', {
        frontmatter: {
          status: ['todo', 'other'],
          kind: 'urgent',
          linktext: '[[Todo]]',
          count: 5,
          linkarr: ['[[Todo]]', 'other'],
          already: 'same',
        },
        propertyLinks: { up: ['cat.md'] },
      }),
    ]);

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'n.md', type: 'Note' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'n.md',
        writes: [
          { key: 'status', value: { kind: 'listItem', remove: 'todo' } },
          { key: 'kind', value: null },
          { key: 'changed', value: { kind: 'literal', value: 'new' } },
        ],
      },
    ]);
  });
});

describe('planAction — retype: verification failure (resolves to a different type)', () => {
  it('rejects when the written tags tie with an earlier-level type', () => {
    const schema = schemaFrom({
      types: {
        A: { tag: 'x' },
        B: { tag: 'x/y' },
        C: { tag: 'c' },
      },
    });
    const snap = snapshot([note('x.md', { tags: ['c'] })]);

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'x.md', type: 'B' },
      envAllowing(),
    );

    expect(result).toStrictEqual({
      ok: false,
      reason: '"x" would not be recognised as "B"',
    });
  });
});

describe('retypeOptions', () => {
  const schema = schemaFrom({
    types: {
      Cat: { tag: 'cat', children: { A: 'up', B: 'up' } },
      A: { tag: 'a', children: { B: 'up2' } },
      B: { tag: 'b' },
    },
  });

  it('returns [] for a node missing from the structure', () => {
    const snap = snapshot([note('cat.md', { tags: ['cat'] })]);
    const structure = buildStructure(schema, snap);
    expect(retypeOptions(schema, structure, 'ghost.md')).toStrictEqual([]);
  });

  it('includes a compatible type for a leaf', () => {
    const snap = snapshot([
      note('cat.md', { tags: ['cat'] }),
      note('leafA.md', { tags: ['a'], propertyLinks: { up: ['cat.md'] } }),
    ]);
    const structure = buildStructure(schema, snap);

    expect(retypeOptions(schema, structure, 'leafA.md')).toStrictEqual(['B']);
  });

  it('excludes a type that would strand a primary child', () => {
    const snap = snapshot([
      note('cat.md', { tags: ['cat'] }),
      note('parentA.md', { tags: ['a'], propertyLinks: { up: ['cat.md'] } }),
      note('childB.md', { tags: ['b'], propertyLinks: { up2: ['parentA.md'] } }),
    ]);
    const structure = buildStructure(schema, snap);
    expect(structure.nodes.get('parentA.md')?.children).toStrictEqual(['childB.md']);

    expect(retypeOptions(schema, structure, 'parentA.md')).toStrictEqual([]);
  });
});

describe('planAction — retype: vault schema', () => {
  const schema = schemaFrom(KNOWLEDGE_BASE_CONFIG);
  const DATAVIEW = 'base/_hierarchy/dataview.md';
  const OBSIDIAN = 'base/_meta-notes/obsidian.md';
  const INFO_ACQUISITION = 'base/_problems/information acquisition.md';

  it('retypes a Hierarchy leaf (under a meta-note) to Problem: tags swap, same edge key, no move', () => {
    const snap = knowledgeBaseSnapshot();

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: DATAVIEW, type: 'Problem' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe(DATAVIEW);
    expect(result.plan.moves).toStrictEqual([]);
    expect(result.plan.changes).toStrictEqual([
      {
        path: DATAVIEW,
        writes: [{ key: 'tags', value: { kind: 'literal', value: ['system/high/problem'] } }],
      },
    ]);

    // Sanity: the parent relationship (via "meta") survives untouched.
    const after = buildStructure(schema, applyPlan(snap, result.plan));
    expect(after.nodes.get(DATAVIEW)?.parent).toBe(OBSIDIAN);
    expect(after.nodes.get(DATAVIEW)?.type).toBe('Problem');
  });

  it('rejects retyping a Problem with a Hierarchy child to Hierarchy (backlinks-only children)', () => {
    const snap = knowledgeBaseSnapshot();
    // The failing child is `READING_STRATEGIES`, named by its display name in the reason string.

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: INFO_ACQUISITION, type: 'Hierarchy' },
      envAllowing(),
    );

    expect(result).toStrictEqual({
      ok: false,
      reason: '"Hierarchy" cannot contain: reading strategies',
    });
  });
});

describe('planAction — retype: the untyped root, and a child of one', () => {
  // "Root" has no conditions of its own — matched only via the host qualifying through an
  // incoming candidate (a.md links to it) — so hub.md genuinely resolves to `type: null`.
  const schema = schemaFrom({
    types: {
      Root: { tag: 'root', children: { A: 'link', C: 'link2' } },
      A: { tag: 'a' },
      C: { tag: 'c' },
    },
  });
  const snap = snapshot(
    [note('a.md', { tags: ['a'], propertyLinks: { link: ['hub.md'] } }), note('hub.md')],
    { host: 'hub.md' },
  );

  it('retypes the untyped root itself (no parent, so no edge/inherit recompute)', () => {
    const structureBefore = buildStructure(schema, snap);
    expect(structureBefore.nodes.get('hub.md')?.type).toBeNull();

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'hub.md', type: 'Root' },
      envAllowing(),
    );

    expect(result).toStrictEqual({
      ok: true,
      focus: 'hub.md',
      plan: {
        creations: [],
        changes: [
          {
            path: 'hub.md',
            writes: [{ key: 'tags', value: { kind: 'literal', value: ['root'] } }],
          },
        ],
        appends: [],
        moves: [],
      },
    });
  });

  it("retypes a child of the untyped root (parent's type resolves through the null fallback)", () => {
    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'a.md', type: 'C' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'a.md',
        writes: [
          { key: 'tags', value: { kind: 'literal', value: ['c'] } },
          { key: 'link2', value: { kind: 'links', remove: [], add: ['hub.md'], list: true } },
          { key: 'link', value: { kind: 'links', remove: ['hub.md'], add: [], list: true } },
        ],
      },
    ]);
  });
});

describe('planAction — retype: own edge-key change, old key not owned by inherit', () => {
  it('writes an explicit cleanup for the old edge property when it is not a schema.inherit key', () => {
    const schema = schemaFrom({
      types: {
        Cat: { tag: 'cat', children: { X: 'viaX', Y: 'viaY' } },
        X: { tag: 'x' },
        Y: { tag: 'y' },
      },
    });
    const snap = snapshot([
      note('cat.md', { tags: ['cat'] }),
      note('n.md', { tags: ['x'], propertyLinks: { viaX: ['cat.md'] } }),
    ]);

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'n.md', type: 'Y' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'n.md',
        writes: [
          { key: 'tags', value: { kind: 'literal', value: ['y'] } },
          { key: 'viaY', value: { kind: 'links', remove: [], add: ['cat.md'], list: true } },
          { key: 'viaX', value: { kind: 'links', remove: ['cat.md'], add: [], list: true } },
        ],
      },
    ]);
  });
});

describe('planAction — retype: N and a rewritten child each keep a genuine property extra', () => {
  it("retyping N to another type reachable via the same property key keeps N's extra in place (edgeTargets)", () => {
    // hier.md's "meta" already lists both a.md (primary) and b.md (a genuine extra, tied on the
    // same rule, lower valueIndex loses) — retyping to another MetaT child that's also reached via
    // "meta" must not disturb either value.
    const schema = schemaFrom({
      types: {
        MetaT: { tag: 'meta', children: { Hier: 'meta', OtherHier: 'meta' } },
        Hier: { tag: 'hier' },
        OtherHier: { tag: 'otherhier' },
      },
    });
    const snap = snapshot([
      note('a.md', { tags: ['meta'] }),
      note('b.md', { tags: ['meta'] }),
      note('hier.md', { tags: ['hier'], propertyLinks: { meta: ['a.md', 'b.md'] } }),
    ]);

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'hier.md', type: 'OtherHier' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No "meta" write: the edge key, parent, and set of kept values are all unchanged.
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'hier.md',
        writes: [{ key: 'tags', value: { kind: 'literal', value: ['otherhier'] } }],
      },
    ]);
  });

  it("rewriting a child's edge key during a retype keeps the child's own genuine property extra", () => {
    // h.md is primarily under m.md (via "viaM", the deeper/winning rule) but also has a genuine
    // extra candidate via "viaM2" (m2note.md). Retyping m.md to Q moves h.md's edge from "viaM" to
    // "viaQ"; the rewrite must run against h.md's own extras without erroring or dropping them.
    const schema = schemaFrom({
      types: {
        M2: { tag: 'm2', children: { H: 'viaM2' } },
        M: { tag: 'm', children: { H: 'viaM' } },
        Q: { tag: 'q', children: { H: 'viaQ' } },
        H: { tag: 'h' },
      },
    });
    const snap = snapshot([
      note('m2note.md', { tags: ['m2'] }),
      note('m.md', { tags: ['m'] }),
      note('h.md', { tags: ['h'], propertyLinks: { viaM: ['m.md'], viaM2: ['m2note.md'] } }),
    ]);
    const structure = buildStructure(schema, snap);
    expect(structure.nodes.get('h.md')?.parent).toBe('m.md');
    expect(structure.nodes.get('h.md')?.extras).toStrictEqual([
      { parent: 'm2note.md', kind: 'property' },
    ]);

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'm.md', type: 'Q' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toStrictEqual([
      { path: 'm.md', writes: [{ key: 'tags', value: { kind: 'literal', value: ['q'] } }] },
      {
        path: 'h.md',
        writes: [
          { key: 'viaQ', value: { kind: 'links', remove: [], add: ['m.md'], list: true } },
          { key: 'viaM', value: { kind: 'links', remove: ['m.md'], add: [], list: true } },
        ],
      },
    ]);
  });
});

describe('planAction — retype: own edge-key change where the new key is itself an inherit key', () => {
  it('skips the new key in the generic inherit recompute (it is written by the edge step) and leaves an unrelated, unchanged inherit key alone', () => {
    const schema = schemaFrom({
      inherit: ['meta', 'other', 'zzz'],
      types: {
        Cat: { tag: 'cat', children: { P: 'meta', Q: 'other' } },
        P: { tag: 'p' },
        Q: { tag: 'q' },
      },
    });
    const snap = snapshot([
      note('cat.md', { tags: ['cat'] }),
      note('n.md', { tags: ['p'], propertyLinks: { meta: ['cat.md'] } }),
    ]);

    const result = planAction(
      schema,
      snap,
      { kind: 'retype', node: 'n.md', type: 'Q' },
      envAllowing(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'n.md',
        writes: [
          { key: 'tags', value: { kind: 'literal', value: ['q'] } },
          { key: 'other', value: { kind: 'links', remove: [], add: ['cat.md'], list: true } },
        ],
      },
    ]);
  });
});
