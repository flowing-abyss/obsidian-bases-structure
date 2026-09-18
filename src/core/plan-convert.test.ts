import { describe, expect, it } from 'vitest';
import { note, snapshot } from './__tests__/notes.js';
import {
  convertOptions,
  operationTargets,
  planConvert,
  type ConvertContext,
} from './plan-convert.js';
import { moveTargets } from './plan-move.js';
import type { Action } from './plan-types.js';
import { planAction } from './planner.js';
import type { Schema } from './schema.js';
import { parseSchema } from './schema.js';
import { applyPlan } from './simulate.js';
import type { Snapshot } from './snapshot.js';
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

/** `convertOptions`/`operationTargets` bundle everything they need to plan honestly into one
 * context — built fresh per fixture (`buildStructure` is cheap and each describe block below has
 * its own schema/snapshot). */
function contextOf(schema: Schema, snap: Snapshot): ConvertContext {
  return { schema, structure: buildStructure(schema, snap), snapshot: snap, env: noEnv };
}

// Category -> Meta-note or Hierarchy (both "category"). Meta-note -> Hierarchy ("meta"). Problem
// (P's own current type) -> Hierarchy ("problem"). Hierarchy -> Hierarchy is text-only
// (file.backlinks — the same shape as the real vault schema). p.md's own child (h.md, Hierarchy)
// is attached by the property "problem" (Problem's own rule) — converting p.md to "Hierarchy"
// rewrites that edge onto Hierarchy's own rule instead (file.backlinks): h.md gets appended to
// p.md's body, and its stale "problem" value is cleared. This is the user's reported case.
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
const context = contextOf(schema, snap);

/** Every caller that only cares *which* types are offered, not the `Plan` paired with each —
 * `optionTypes` narrows a `convertOptions` result down to the same ordered type-name list the
 * function itself used to return directly. */
function optionTypes(options: ReturnType<typeof convertOptions>): readonly string[] {
  return options.map((option) => option.type);
}

describe('convertOptions', () => {
  it('lists the types a problem can become under a category, keeping its Hierarchy child', () => {
    expect(optionTypes(convertOptions(context, 'p.md', 'cat.md'))).toEqual([
      'Meta-note',
      'Hierarchy',
    ]);
  });

  it('excludes a candidate type with no rule to the parent at all', () => {
    // Category has no rule to itself.
    expect(optionTypes(convertOptions(context, 'p.md', 'cat.md'))).not.toContain('Category');
  });

  it('now includes a type whose only rule to the child is a different kind — the edge gets rewritten, not refused', () => {
    expect(optionTypes(convertOptions(context, 'p.md', 'cat.md'))).toContain('Hierarchy');
  });

  it('pairs each option with the exact Plan planConvert would produce for it — reused, not re-planned, by callers', () => {
    const options = convertOptions(context, 'p.md', 'cat.md');
    const metaNote = options.find((option) => option.type === 'Meta-note');
    const expected = planAction(schema, snap, convert('p.md', 'cat.md', 'Meta-note'), noEnv);
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    expect(metaNote?.plan).toStrictEqual(expected.plan);
  });

  it('returns [] for a node missing from the structure', () => {
    expect(convertOptions(context, 'ghost.md', 'cat.md')).toStrictEqual([]);
  });

  it('returns [] for a parent missing from the structure', () => {
    expect(convertOptions(context, 'p.md', 'ghost.md')).toStrictEqual([]);
  });

  it('returns [] when the requested parent is the node itself or its own descendant', () => {
    expect(convertOptions(context, 'p.md', 'p.md')).toStrictEqual([]);
    expect(convertOptions(context, 'p.md', 'h.md')).toStrictEqual([]);
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

  it("converts the node to Hierarchy: the child is appended to its new body and its stale property is cleared (the user's reported case)", () => {
    const result = planAction(schema, snap, convert('p.md', 'cat.md', 'Hierarchy'), noEnv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.appends).toStrictEqual([{ path: 'p.md', target: 'h.md' }]);
    expect(result.plan.bodyLinkRemovals).toStrictEqual([]);
    const afterSnap = applyPlan(snap, result.plan);
    const after = buildStructure(schema, afterSnap);
    expect(after.nodes.get('p.md')?.parent).toBe('cat.md');
    expect(after.nodes.get('p.md')?.type).toBe('Hierarchy');
    // The child stays the node's child — its "problem" edge is rewritten onto the body mention
    // Hierarchy's own rule requires, instead of stranding it under the old (now-meaningless) key.
    expect(after.nodes.get('h.md')?.parent).toBe('p.md');
    expect(afterSnap.notes.get('h.md')?.propertyLinks['problem']).toBeUndefined();
    expect(afterSnap.notes.get('p.md')?.links).toContain('h.md');
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

// The real vault schema (see CLAUDE.md / transitions.test.ts's own copy) — used here because it
// has both a property rule (Meta-note -> Problem, "meta") and the schema's one text rule
// (Hierarchy -> Hierarchy, file.backlinks), the two shapes a direct child's edge now rewrites
// between in either direction.
const realSchema = schemaFrom({
  inherit: ['category', 'meta', 'problem'],
  types: {
    Category: {
      tag: 'system/category',
      children: { 'Meta-note': 'category', Hierarchy: 'category' },
    },
    'Meta-note': { tag: 'system/high/meta', children: { Problem: 'meta', Hierarchy: 'meta' } },
    Problem: { tag: 'system/high/problem', children: { Hierarchy: 'problem' } },
    Hierarchy: { tag: 'system/high/hierarchy', children: { Hierarchy: 'file.backlinks' } },
  },
});

describe("planConvert — a direct child's edge rewrites between any rule kind, in either direction", () => {
  it("file.backlinks -> property (the mirror of the reported case): the child gains the property, its body mention is removed, and it stays the node's child", () => {
    const mirrorSnap = snapshot([
      note('meta-target.md', { basename: 'Meta target', tags: ['system/high/meta'] }),
      note('h.md', { basename: 'H', tags: ['system/high/hierarchy'], links: ['k.md'] }),
      note('k.md', { basename: 'K', tags: ['system/high/hierarchy'] }),
    ]);

    const result = planAction(
      realSchema,
      mirrorSnap,
      convert('h.md', 'meta-target.md', 'Problem'),
      noEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.bodyLinkRemovals).toStrictEqual([{ path: 'h.md', target: 'k.md' }]);
    const afterSnap = applyPlan(mirrorSnap, result.plan);
    const after = buildStructure(realSchema, afterSnap);
    expect(after.nodes.get('h.md')?.type).toBe('Problem');
    expect(after.nodes.get('h.md')?.parent).toBe('meta-target.md');
    expect(after.nodes.get('k.md')?.parent).toBe('h.md');
    expect(afterSnap.notes.get('k.md')?.propertyLinks['problem']).toStrictEqual(['h.md']);
  });

  it('refuses a conversion that would strand a direct child of a type the new type has no rule to at all, naming that child', () => {
    const refusalSnap = snapshot([
      note('cat.md', { basename: 'Category target', tags: ['system/category'] }),
      note('mn.md', { basename: 'MN', tags: ['system/high/meta'] }),
      note('pc.md', {
        basename: 'PC',
        tags: ['system/high/problem'],
        frontmatter: { meta: '[[MN]]' },
        propertyLinks: { meta: ['mn.md'] },
      }),
    ]);

    const result = planAction(
      realSchema,
      refusalSnap,
      convert('mn.md', 'cat.md', 'Hierarchy'),
      noEnv,
    );

    expect(result).toStrictEqual({
      ok: false,
      reason: '"PC" cannot stay under "MN" as a "Hierarchy"',
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

describe('planConvert / convertOptions — I4: the old type tag must be rewritable', () => {
  const tagSchema = schemaFrom({
    types: {
      Cat2: { tag: 'cat2', children: { Alpha: 'up', Beta: 'up' } },
      Alpha: { tag: 'alpha' },
      Beta: { tag: 'beta' },
    },
  });
  const tagSnap = snapshot([
    note('cat2.md', { tags: ['cat2'] }),
    note('n.md', { tags: ['alpha'], frontmatterTags: [], bodyTags: ['alpha'] }),
  ]);
  const tagContext = contextOf(tagSchema, tagSnap);

  it('rejects converting when the old type tag lives only in body text', () => {
    const result = planAction(tagSchema, tagSnap, convert('n.md', 'cat2.md', 'Beta'), noEnv);

    expect(result).toStrictEqual({
      ok: false,
      reason: '"n" keeps the tag "alpha" in its text; remove it there first',
    });
  });

  it('excludes "Beta" from convertOptions — never offers a type planConvert would reject', () => {
    // The reviewer's reproduction: a cheap rule/failingChildren pre-filter alone would have let
    // "Beta" through here (nothing about it strands a child); only actually planning catches I4.
    expect(optionTypes(convertOptions(tagContext, 'n.md', 'cat2.md'))).not.toContain('Beta');
    expect(convertOptions(tagContext, 'n.md', 'cat2.md')).toStrictEqual([]);
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

  it('omits the removal when a frontmatter property on the old parent still resolves the same link (finding 2, shared with planMove)', () => {
    // oldcat.md's link to thing.md comes from a frontmatter property ("related"), not body text —
    // `links` doesn't distinguish the two. The old rule (Thing via file.backlinks) doesn't even
    // apply to the converted type (OtherThing), so this has no bearing on where thing.md resolves
    // after the convert; it only matters for whether a doomed removal gets emitted at all.
    const heldSnap = snapshot(
      [
        note('oldcat.md', {
          tags: ['oldcat'],
          frontmatter: { related: '[[thing]]' },
          propertyLinks: { related: ['thing.md'] },
          links: ['thing.md'],
        }),
        note('newcat.md', { tags: ['newcat'] }),
        note('thing.md', { tags: ['thing'] }),
      ],
      { results: ['oldcat.md', 'newcat.md', 'thing.md'] },
    );

    const result = planAction(
      textSchema,
      heldSnap,
      convert('thing.md', 'newcat.md', 'OtherThing'),
      noEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.bodyLinkRemovals).toStrictEqual([]);
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

describe('planConvert / convertOptions — an untouched higher-priority candidate survives the conversion', () => {
  // M (level 2) outranks K (level 1) and N (level 0) for a NodeT2-typed child regardless of which
  // one the action asks for — even a successful-looking write to "n_key" still leaves M in charge
  // once node.md's type becomes NodeT2 (all three parent types recognise it, same as they
  // recognised its old type NodeT). verifyConvert catches this by simulation; convertOptions must
  // exclude "NodeT2" for the same reason rather than offering it and letting planConvert reject
  // it later — the reviewer's second reproduction of the same honesty gap.
  const rivalSchema = schemaFrom({
    types: {
      N: { tag: 'n', children: { NodeT2: 'n_key' } },
      K: { tag: 'k', children: { NodeT2: 'k_key' } },
      M: { tag: 'm', children: { NodeT2: 'm_key' } },
      NodeT: { tag: 'nodet' },
      NodeT2: { tag: 'nodet2' },
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
  const rivalContext = contextOf(rivalSchema, rivalSnap);

  it('rejects when a stronger untouched candidate still outranks the requested parent', () => {
    const result = planAction(rivalSchema, rivalSnap, convert('node.md', 'N.md', 'NodeT2'), noEnv);

    expect(result).toStrictEqual({
      ok: false,
      reason: '"node" would not become "NodeT2" under "N"',
    });
  });

  it('excludes "NodeT2" from convertOptions for the same reason', () => {
    expect(optionTypes(convertOptions(rivalContext, 'node.md', 'N.md'))).not.toContain('NodeT2');
    expect(convertOptions(rivalContext, 'node.md', 'N.md')).toStrictEqual([]);
  });
});

describe('planConvert — relocates into the new type’s folder, same as a plain retype would', () => {
  const folderSchema = schemaFrom({
    types: {
      Root: { tag: 'root', children: { Foo: 'up', Bar: 'up' } },
      Foo: { tag: 'foo' },
      Bar: { tag: 'bar', folder: 'bar-folder' },
    },
  });

  it('produces a moves entry and the new focus', () => {
    const folderSnap = snapshot([
      note('root1.md', { tags: ['root'] }),
      note('root2.md', { tags: ['root'] }),
      note('n.md', { tags: ['foo'], propertyLinks: { up: ['root1.md'] } }),
    ]);

    const result = planAction(folderSchema, folderSnap, convert('n.md', 'root2.md', 'Bar'), noEnv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe('bar-folder/n.md');
    expect(result.plan.moves).toStrictEqual([{ from: 'n.md', to: 'bar-folder/n.md' }]);
    const after = buildStructure(folderSchema, applyPlan(folderSnap, result.plan));
    expect(after.nodes.get('bar-folder/n.md')?.parent).toBe('root2.md');
    expect(after.nodes.get('bar-folder/n.md')?.type).toBe('Bar');
  });

  it('rejects when a note already exists at the target folder path', () => {
    const occupiedSnap = snapshot([
      note('root1.md', { tags: ['root'] }),
      note('root2.md', { tags: ['root'] }),
      note('n.md', { tags: ['foo'], propertyLinks: { up: ['root1.md'] } }),
      note('bar-folder/n.md', { tags: ['bar'] }),
    ]);

    const result = planAction(
      folderSchema,
      occupiedSnap,
      convert('n.md', 'root2.md', 'Bar'),
      noEnv,
    );

    expect(result).toStrictEqual({
      ok: false,
      reason: 'A note already exists at "bar-folder/n.md"',
    });
  });

  it('does not move when N already lives inside the target folder', () => {
    const insideSnap = snapshot([
      note('root1.md', { tags: ['root'] }),
      note('root2.md', { tags: ['root'] }),
      note('bar-folder/sub/n.md', { tags: ['foo'], propertyLinks: { up: ['root1.md'] } }),
    ]);

    const result = planAction(
      folderSchema,
      insideSnap,
      convert('bar-folder/sub/n.md', 'root2.md', 'Bar'),
      noEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe('bar-folder/sub/n.md');
    expect(result.plan.moves).toStrictEqual([]);
  });
});

describe('convertOptions / planConvert — a conversion may never adopt new children', () => {
  // The user's real schema (see CLAUDE.md): Meta-note's own children are property-based
  // ("meta"), but Hierarchy's own children rule is `file.backlinks` — a Meta-note converting to
  // Hierarchy would make every Hierarchy-typed note it body-links a new child, exactly the
  // structure-wrecking adoption this guards against.
  const adoptSchema = schemaFrom({
    inherit: ['category', 'meta', 'problem'],
    types: {
      Category: {
        tag: 'system/category',
        children: { 'Meta-note': 'category', Hierarchy: 'category' },
      },
      'Meta-note': { tag: 'system/high/meta', children: { Problem: 'meta', Hierarchy: 'meta' } },
      Problem: { tag: 'system/high/problem', children: { Hierarchy: 'problem' } },
      Hierarchy: { tag: 'system/high/hierarchy', children: { Hierarchy: 'file.backlinks' } },
    },
  });
  const adoptSnap = snapshot([
    note('meta1.md', { tags: ['system/high/meta'] }),
    note('structure.md', {
      basename: 'structure',
      tags: ['system/high/meta'],
      links: ['km.md', 'other.md'],
    }),
    note('km.md', { basename: 'knowledge models', tags: ['system/high/hierarchy'] }),
    note('other.md', { basename: 'other hierarchy', tags: ['system/high/hierarchy'] }),
  ]);
  const adoptContext = contextOf(adoptSchema, adoptSnap);

  it("does not offer a text-link type that would adopt the note's body links", () => {
    // `structure.md` is a Meta-note whose body links to two Hierarchy notes
    expect(optionTypes(convertOptions(adoptContext, 'structure.md', 'meta1.md'))).toEqual([
      'Problem',
    ]);
  });

  it('rejects such a conversion with the adopted note named', () => {
    expect(
      planConvert(adoptSchema, adoptSnap, convert('structure.md', 'meta1.md', 'Hierarchy'), noEnv),
    ).toEqual({
      ok: false,
      reason: '"knowledge models" would become a child of "structure"',
    });
  });
});

describe('operationTargets', () => {
  it("delegates to moveTargets for 'move'", () => {
    // h.md (Hierarchy) can move straight under cat.md (Category -> Hierarchy is a direct rule) —
    // a non-trivial set, so this actually exercises the delegation rather than two empty sets.
    expect(operationTargets(context, 'h.md', 'move')).toStrictEqual(
      moveTargets(schema, structure, 'h.md'),
    );
    expect(operationTargets(context, 'h.md', 'move')).toStrictEqual(new Set(['cat.md']));
  });

  it("offers convert targets only where some type fits, for 'convert'", () => {
    expect(operationTargets(context, 'p.md', 'convert')).toStrictEqual(new Set(['cat.md']));
  });

  it("excludes the node's own descendant as a convert target", () => {
    expect(operationTargets(context, 'p.md', 'convert')).not.toContain('h.md');
  });
});

describe('planConvert — user ruling — writes only the type tag and the moved link, keeping a rich real-note fixture untouched (2026-09-18)', () => {
  // The user's real schema (see CLAUDE.md): Problem and Hierarchy are both children of Meta-note
  // via "meta" — converting between meta-notes only ever patches "tags" and "meta".
  const realSchema = schemaFrom({
    inherit: ['category', 'meta', 'problem'],
    types: {
      Category: {
        tag: 'system/category',
        children: { 'Meta-note': 'category', Hierarchy: 'category' },
      },
      'Meta-note': { tag: 'system/high/meta', children: { Problem: 'meta', Hierarchy: 'meta' } },
      Problem: { tag: 'system/high/problem', children: { Hierarchy: 'problem' } },
      Hierarchy: { tag: 'system/high/hierarchy', children: { Hierarchy: 'file.backlinks' } },
    },
  });
  // Every key the schema is ever allowed to write for this action — anything else in the note
  // belongs to the user (and other plugins) and must survive untouched (2026-09-18 ruling).
  const OWNED_KEYS = ['tags', 'category', 'meta', 'problem'];

  it('converting a Problem to Hierarchy under a different meta-note writes only "tags" and "meta", leaving icon/color/aliases/description/created/updated and every user tag untouched', () => {
    const cat = note('cat.md', { tags: ['system/category'] });
    const meta1 = note('meta1.md', {
      tags: ['system/high/meta'],
      frontmatter: { category: '[[cat]]' },
      propertyLinks: { category: ['cat.md'] },
    });
    const meta2 = note('meta2.md', {
      tags: ['system/high/meta'],
      frontmatter: { category: '[[cat]]' },
      propertyLinks: { category: ['cat.md'] },
    });
    const n = note('n.md', {
      tags: ['mark/ignore', 'system/high/problem', 'category/knowledge_base'],
      frontmatterTags: ['mark/ignore', 'system/high/problem', 'category/knowledge_base'],
      frontmatter: {
        tags: ['mark/ignore', 'system/high/problem', 'category/knowledge_base'],
        icon: '🗄️',
        color: '#ff7733',
        aliases: ['Problem Alias'],
        description: 'A note describing a specific problem.',
        created: '2024-02-02',
        updated: '2024-07-01',
        meta: '[[meta1]]',
        category: '[[Unrelated Category]]',
        problem: '[[Unrelated Problem]]',
      },
      propertyLinks: { meta: ['meta1.md'] },
    });
    const snap = snapshot([cat, meta1, meta2, n], {
      results: ['cat.md', 'meta1.md', 'meta2.md', 'n.md'],
    });

    const result = planAction(
      realSchema,
      snap,
      { kind: 'convert', node: 'n.md', parent: 'meta2.md', type: 'Hierarchy' },
      noEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.moves).toStrictEqual([]);
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'n.md',
        writes: [
          {
            key: 'tags',
            value: {
              kind: 'listItem',
              remove: 'system/high/problem',
              add: 'system/high/hierarchy',
            },
          },
          {
            key: 'meta',
            value: { kind: 'links', remove: ['meta1.md'], add: ['meta2.md'], list: false },
          },
        ],
      },
    ]);
    // The assertion the user ruling requires: the whole frontmatter object minus the owned keys,
    // not a spot check of a couple of properties.
    const before = snap.notes.get('n.md')?.frontmatter ?? {};
    const after = applyPlan(snap, result.plan).notes.get('n.md')?.frontmatter ?? {};
    for (const key of Object.keys(before).filter((k) => !OWNED_KEYS.includes(k))) {
      expect(after[key]).toEqual(before[key]);
    }
  });
});
