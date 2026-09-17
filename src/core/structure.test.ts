import { describe, expect, it } from 'vitest';
import { note, snapshot } from './__tests__/notes.js';
import type { Schema } from './schema.js';
import { parseSchema } from './schema.js';
import type { Snapshot } from './snapshot.js';
import { buildStructure } from './structure.js';

function makeRead(config: Record<string, unknown>): (key: string) => unknown {
  return (key: string): unknown => config[key];
}

describe('buildStructure — untyped mode', () => {
  it('builds a tree from an "up" chain with children in results order (forest, no host)', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [
        note('root.md'),
        note('child1.md', { propertyLinks: { up: ['root.md'] } }),
        note('child2.md', { propertyLinks: { up: ['root.md'] } }),
        note('grandchild.md', { propertyLinks: { up: ['child1.md'] } }),
      ],
      { results: ['grandchild.md', 'child2.md', 'child1.md', 'root.md'] },
    );

    const structure = buildStructure(schema, snap);

    expect(structure.root).toBeNull();
    expect(structure.tops).toStrictEqual(['root.md']);
    expect(structure.orphans).toStrictEqual([]);
    expect(structure.nodes.get('root.md')?.children).toStrictEqual(['child2.md', 'child1.md']);
    expect(structure.nodes.get('child1.md')?.children).toStrictEqual(['grandchild.md']);
    expect(structure.nodes.get('grandchild.md')?.parent).toBe('child1.md');
    expect(structure.nodes.get('grandchild.md')?.edge).toStrictEqual({
      kind: 'property',
      property: 'up',
    });
  });
});

describe('buildStructure — vault hierarchy (design spec)', () => {
  const vaultConfig = {
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

  it('picks the deepest matching ancestor (Problem) as parent, no extras for the shallower ancestors', () => {
    const { schema } = parseSchema(makeRead(vaultConfig));
    const snap = snapshot([
      note('category.md', { tags: ['system/category'] }),
      note('meta.md', {
        tags: ['system/high/meta'],
        propertyLinks: { category: ['category.md'] },
      }),
      note('problem.md', {
        tags: ['system/high/problem'],
        propertyLinks: { meta: ['meta.md'] },
      }),
      note('hierarchy.md', {
        tags: ['system/high/hierarchy'],
        propertyLinks: {
          category: ['category.md'],
          meta: ['meta.md'],
          problem: ['problem.md'],
        },
      }),
    ]);

    const structure = buildStructure(schema, snap);

    const hierarchyNode = structure.nodes.get('hierarchy.md');
    expect(hierarchyNode?.parent).toBe('problem.md');
    expect(hierarchyNode?.edge).toStrictEqual({ kind: 'property', property: 'problem' });
    expect(hierarchyNode?.extras).toStrictEqual([]);
  });

  it('nests a child hierarchy under a parent hierarchy via file.backlinks, beating the shallower Category candidate', () => {
    const { schema } = parseSchema(makeRead(vaultConfig));
    const snap = snapshot([
      note('category.md', { tags: ['system/category'] }),
      note('parentHier.md', {
        tags: ['system/high/hierarchy'],
        links: ['childHier.md'],
      }),
      note('childHier.md', {
        tags: ['system/high/hierarchy'],
        propertyLinks: { category: ['category.md'] },
      }),
    ]);

    const structure = buildStructure(schema, snap);

    const childNode = structure.nodes.get('childHier.md');
    expect(childNode?.parent).toBe('parentHier.md');
    expect(childNode?.edge).toStrictEqual({ kind: 'backlinks', property: 'file.backlinks' });
    expect(structure.nodes.get('parentHier.md')?.children).toStrictEqual(['childHier.md']);
    expect(childNode?.extras).toStrictEqual([{ parent: 'category.md', kind: 'property' }]);
  });
});

describe('buildStructure — a property list with more than one candidate', () => {
  it('picks the first list entry as parent and records the rest as extras', () => {
    const { schema } = parseSchema(
      makeRead({
        types: {
          Meta: { tag: 'meta', children: { Hierarchy: 'meta' } },
          Hierarchy: { tag: 'hier' },
        },
      }),
    );
    const snap = snapshot([
      note('a.md', { tags: ['meta'] }),
      note('b.md', { tags: ['meta'] }),
      note('c.md', { tags: ['meta'] }),
      note('hier.md', { tags: ['hier'], propertyLinks: { meta: ['a.md', 'b.md', 'c.md'] } }),
    ]);

    const structure = buildStructure(schema, snap);

    const hierNode = structure.nodes.get('hier.md');
    expect(hierNode?.parent).toBe('a.md');
    expect(hierNode?.extras).toStrictEqual([
      { parent: 'b.md', kind: 'property' },
      { parent: 'c.md', kind: 'property' },
    ]);
  });
});

describe('buildStructure — notes matching no type', () => {
  it('excludes a result note that matches no defined type from the graph', () => {
    const { schema } = parseSchema(makeRead({ types: { A: { tag: 'a' } } }));
    const snap = snapshot([note('matched.md', { tags: ['a'] }), note('stray.md')]);

    const structure = buildStructure(schema, snap);

    expect(structure.nodes.has('matched.md')).toBe(true);
    expect(structure.nodes.has('stray.md')).toBe(false);
    expect(structure.issues).toStrictEqual([]);
  });
});

describe('buildStructure — mutual and cyclic text links', () => {
  const linksSchema = parseSchema(
    makeRead({
      types: {
        Hierarchy: { tag: 'hier', children: { Hierarchy: 'file.links' } },
      },
    }),
  ).schema;

  it('resolves a mutual link (A<->B) with extra children of A: A becomes parent, B is twoWay, no extra', () => {
    const snap = snapshot([
      note('a.md', { tags: ['hier'], links: ['b.md'] }),
      note('b.md', { tags: ['hier'], links: ['a.md'] }),
      note('c.md', { tags: ['hier'], links: ['a.md'] }),
      note('d.md', { tags: ['hier'], links: ['a.md'] }),
    ]);

    const structure = buildStructure(linksSchema, snap);

    expect(structure.nodes.get('a.md')?.parent).toBeNull();
    expect(structure.nodes.get('a.md')?.extras).toStrictEqual([]);
    expect(structure.nodes.get('b.md')?.parent).toBe('a.md');
    expect(structure.nodes.get('b.md')?.twoWay).toBe(true);
    expect(structure.nodes.get('b.md')?.extras).toStrictEqual([]);
    expect(structure.nodes.get('c.md')?.parent).toBe('a.md');
    expect(structure.nodes.get('d.md')?.parent).toBe('a.md');
    expect(structure.tops).toStrictEqual(['a.md']);
  });

  it('breaks a symmetric 2-cycle by earliest results order when candidate-child counts tie', () => {
    const snap = snapshot(
      [
        note('a.md', { tags: ['hier'], links: ['b.md'] }),
        note('b.md', { tags: ['hier'], links: ['a.md'] }),
      ],
      { results: ['a.md', 'b.md'] },
    );

    const structure = buildStructure(linksSchema, snap);

    // Both a.md and b.md have exactly 1 candidate-child (each other) — tie broken by a.md
    // coming first in results order, so a.md is "top" and its only candidate gets excluded.
    expect(structure.nodes.get('a.md')?.parent).toBeNull();
    expect(structure.nodes.get('a.md')?.extras).toStrictEqual([]);
    expect(structure.nodes.get('b.md')?.parent).toBe('a.md');
    expect(structure.nodes.get('b.md')?.twoWay).toBe(true);
    expect(structure.tops).toStrictEqual(['a.md']);
  });

  it('breaks a 3-cycle at the node with the most candidate children, the cut link becomes an extra', () => {
    const snap = snapshot([
      note('a.md', { tags: ['hier'], links: ['b.md'] }),
      note('b.md', { tags: ['hier'], links: ['c.md'] }),
      note('c.md', { tags: ['hier'], links: ['a.md'] }),
      note('e.md', { tags: ['hier'], links: ['b.md'] }),
    ]);

    const structure = buildStructure(linksSchema, snap);

    // b.md has 2 candidate-children (a.md, e.md) vs 1 each for a.md/c.md, so b.md is "top".
    expect(structure.nodes.get('b.md')?.parent).toBeNull();
    expect(structure.nodes.get('a.md')?.parent).toBe('b.md');
    expect(structure.nodes.get('e.md')?.parent).toBe('b.md');
    expect(structure.nodes.get('c.md')?.parent).toBe('a.md');
    expect(structure.nodes.get('b.md')?.extras).toStrictEqual([{ parent: 'c.md', kind: 'links' }]);
    expect(structure.tops).toStrictEqual(['b.md']);
  });
});

describe('buildStructure — host and root qualification', () => {
  it('makes a host not in results the root when it matches a real type with specificity > 0', () => {
    const { schema } = parseSchema(
      makeRead({
        types: {
          Category: { tag: 'cat', children: { Meta: 'category' } },
          Meta: { tag: 'meta' },
        },
      }),
    );
    const snap = snapshot(
      [note('meta1.md', { tags: ['meta'], propertyLinks: { category: ['cat.md'] } })],
      { host: 'cat.md' },
    );
    // cat.md must have NoteData even though it's not in results.
    const notes = new Map(snap.notes);
    notes.set('cat.md', note('cat.md', { tags: ['cat'] }));
    const fullSnap = { ...snap, notes };

    const structure = buildStructure(schema, fullSnap);

    expect(structure.root).toBe('cat.md');
    expect(structure.tops).toStrictEqual(['cat.md']);
    expect(structure.nodes.get('cat.md')?.children).toStrictEqual(['meta1.md']);
  });

  it('keeps the graph a forest when an untyped host has nothing linking to it', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root2.md'), note('child.md', { propertyLinks: { up: ['root2.md'] } })],
      {
        host: 'hub.md',
      },
    );
    const notes = new Map(snap.notes);
    notes.set('hub.md', note('hub.md'));
    const fullSnap = { ...snap, notes };

    const structure = buildStructure(schema, fullSnap);

    expect(structure.root).toBeNull();
    expect(structure.nodes.has('hub.md')).toBe(false);
    expect(structure.tops).toStrictEqual(['root2.md']);
  });

  it('makes an untyped host the root once a node links to it via "parent"', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('child.md', { propertyLinks: { up: ['hub.md'] } })], {
      host: 'hub.md',
    });
    const notes = new Map(snap.notes);
    notes.set('hub.md', note('hub.md'));
    const fullSnap = { ...snap, notes };

    const structure = buildStructure(schema, fullSnap);

    expect(structure.root).toBe('hub.md');
    expect(structure.nodes.get('hub.md')?.children).toStrictEqual(['child.md']);
  });

  it('does not root an empty-type (specificity 0) host unless something links to it', () => {
    const { schema } = parseSchema(
      makeRead({
        types: {
          Catch: { children: { Leaf: 'p' } },
          Leaf: { tag: 'leaf' },
        },
      }),
    );

    // Sub-case A: nothing links to the host -> dropped, root null.
    const notLinked = snapshot([note('leaf.md', { tags: ['leaf'] })], { host: 'hub.md' });
    const notLinkedNotes = new Map(notLinked.notes).set('hub.md', note('hub.md'));
    const notLinkedSnap = { ...notLinked, notes: notLinkedNotes };

    const structureA = buildStructure(schema, notLinkedSnap);
    expect(structureA.root).toBeNull();
    expect(structureA.nodes.has('hub.md')).toBe(false);

    // Sub-case B: leaf.md's "p" property links to the host -> qualifies as root.
    const linked = snapshot(
      [note('leaf.md', { tags: ['leaf'], propertyLinks: { p: ['hub.md'] } })],
      {
        host: 'hub.md',
      },
    );
    const linkedNotes = new Map(linked.notes).set('hub.md', note('hub.md'));
    const linkedSnap = { ...linked, notes: linkedNotes };

    const structureB = buildStructure(schema, linkedSnap);
    expect(structureB.root).toBe('hub.md');
  });

  it('treats a host that is also in results the same node, without duplication', () => {
    const { schema } = parseSchema(
      makeRead({
        types: {
          Category: { tag: 'cat', children: { Leaf: 'category' } },
          Leaf: { tag: 'leaf' },
        },
      }),
    );
    const snap = snapshot(
      [
        note('h.md', { tags: ['cat'] }),
        note('x.md', { tags: ['leaf'], propertyLinks: { category: ['h.md'] } }),
      ],
      { host: 'h.md' },
    );

    const structure = buildStructure(schema, snap);

    expect(structure.root).toBe('h.md');
    expect(Array.from(structure.nodes.keys()).filter((p) => p === 'h.md')).toHaveLength(1);
    expect(structure.nodes.get('x.md')?.parent).toBe('h.md');
  });
});

describe('buildStructure — the root stays parentless', () => {
  it('does not let another type parent the root, even when the root has a matching candidate of its own', () => {
    const { schema } = parseSchema(
      makeRead({
        types: {
          Super: { tag: 'super', children: { Category: 'super' } },
          Category: { tag: 'cat' },
        },
      }),
    );
    // cat.md is the host and qualifies as root outright (Category has specificity > 0). It also
    // has its own "super" property pointing at sup.md, which — absent the fix — would make
    // sup.md look like cat.md's primary parent (Super is a deeper/matching type for Category).
    const base = snapshot([note('sup.md', { tags: ['super'] })], { host: 'cat.md' });
    const notes = new Map(base.notes).set(
      'cat.md',
      note('cat.md', { tags: ['cat'], propertyLinks: { super: ['sup.md'] } }),
    );
    const snap = { ...base, notes };

    const structure = buildStructure(schema, snap);

    expect(structure.root).toBe('cat.md');
    expect(structure.tops).toStrictEqual(['cat.md']);
    const rootNode = structure.nodes.get('cat.md');
    expect(rootNode?.parent).toBeNull();
    expect(rootNode?.edge).toBeNull();
    // The root's candidate isn't discarded — with no ancestors to suppress it, it surfaces as
    // an extra on the root itself.
    expect(rootNode?.extras).toStrictEqual([{ parent: 'sup.md', kind: 'property' }]);
    // sup.md never becomes cat.md's parent: it isn't listed as anyone's child, its own parent
    // stays whatever its own candidates say (none here), and it shows up as an orphan.
    expect(structure.nodes.get('sup.md')?.children).toStrictEqual([]);
    expect(structure.nodes.get('sup.md')?.parent).toBeNull();
    expect(structure.orphans).toStrictEqual(['sup.md']);
  });
});

describe('buildStructure — external targets and alsoIn', () => {
  const config = {
    types: {
      Category: {
        tag: 'cat',
        children: { Meta: 'category', Hierarchy: 'category' },
      },
      Meta: { tag: 'meta', children: { Hierarchy: 'meta' } },
      Hierarchy: { tag: 'hier' },
    },
  };

  it('reports alsoIn for an external Category target not in results, but not on a descendant that inherits it', () => {
    const { schema } = parseSchema(makeRead(config));
    const base = snapshot([
      note('root.md', { tags: ['cat'] }),
      note('meta.md', {
        tags: ['meta'],
        propertyLinks: { category: ['root.md', 'other.md'] },
      }),
      note('hierarchy.md', {
        tags: ['hier'],
        propertyLinks: { meta: ['meta.md'], category: ['root.md', 'other.md'] },
      }),
    ]);
    const notes = new Map(base.notes).set('other.md', note('other.md', { tags: ['cat'] }));
    const snap = { ...base, notes };

    const structure = buildStructure(schema, snap);

    expect(structure.nodes.get('meta.md')?.alsoIn).toStrictEqual(['other.md']);
    expect(structure.nodes.get('hierarchy.md')?.alsoIn).toStrictEqual([]);
  });

  it('suppresses an extra for a candidate already linked from an ancestor (both are real nodes)', () => {
    const { schema } = parseSchema(makeRead(config));
    const snap = snapshot([
      note('a.md', { tags: ['cat'] }),
      note('b.md', { tags: ['cat'] }),
      note('meta.md', {
        tags: ['meta'],
        propertyLinks: { category: ['a.md', 'b.md'] },
      }),
      note('hierarchy.md', {
        tags: ['hier'],
        propertyLinks: { meta: ['meta.md'], category: ['a.md', 'b.md'] },
      }),
    ]);

    const structure = buildStructure(schema, snap);

    expect(structure.nodes.get('meta.md')?.extras).toStrictEqual([
      { parent: 'b.md', kind: 'property' },
    ]);
    // hierarchy.md's "a.md" candidate is an ancestor (ignored) and "b.md" is already linked
    // from ancestor meta.md, so it's inherited — no extra on hierarchy.md at all.
    expect(structure.nodes.get('hierarchy.md')?.extras).toStrictEqual([]);
  });
});

describe('buildStructure — orphans', () => {
  it('groups nodes without a candidate parent as orphans when a root exists', () => {
    const { schema } = parseSchema(
      makeRead({
        types: {
          Category: { tag: 'cat', children: { Meta: 'category' } },
          Meta: { tag: 'meta' },
        },
      }),
    );
    const snap = snapshot(
      [note('root.md', { tags: ['cat'] }), note('orphan.md', { tags: ['meta'] })],
      { host: 'root.md' },
    );

    const structure = buildStructure(schema, snap);

    expect(structure.root).toBe('root.md');
    expect(structure.tops).toStrictEqual(['root.md']);
    expect(structure.orphans).toStrictEqual(['orphan.md']);
  });
});

describe('buildStructure — type conflicts', () => {
  it('reports an issue with the note path when two types tie on specificity', () => {
    const { schema } = parseSchema(
      makeRead({
        types: {
          A: { tag: 'x' },
          B: { tag: 'y' },
        },
      }),
    );
    const snap = snapshot([note('n.md', { tags: ['x', 'y'] })]);

    const structure = buildStructure(schema, snap);

    expect(structure.issues).toStrictEqual([
      { path: 'n.md', message: 'Matches several types: A, B' },
    ]);
    expect(structure.nodes.get('n.md')?.type).toBe('A');
  });
});

// I6 (final review, batch B): `collectCandidates`'s `collectBacklinks` used to scan every other
// potential node's own `links` for each node with a `file.backlinks` child rule (node × node ×
// `links.includes`), and `structure.ts`'s cycle breaking rebuilt the whole children index and
// re-walked every already-settled node from scratch after fixing *each* cycle — both quadratic in
// the node count. Reproduces the reviewer's own repro shape: a 4-level spec schema (Category →
// Meta-note → Problem → Hierarchy, `file.backlinks` self-children on Hierarchy) with 4,000
// Hierarchy notes, each cross-linking 10 pseudo-random others — dense enough to also force many
// cycles through `breakCycles`, not just stress `collectBacklinks` alone.
//
// U7: this used to assert a wall-clock bound (`elapsed < 200ms` at N=4,000). That caught a real
// 632ms -> ~35ms quadratic regression, but an absolute bound flakes on slower/shared CI runners —
// especially under v8 coverage instrumentation, which this project's `verify` always runs with.
// A scaling check is insensitive to machine speed instead: build the same shape at N and 4N —
// linear work should come out around 4x, quadratic around 16x — and assert the ratio stays well
// under quadratic. Only a very loose absolute bound remains, to catch a catastrophic hang rather
// than to measure performance.
interface Scenario {
  readonly schema: Schema;
  readonly snap: Snapshot;
}

function buildScenario(hierarchyCount: number): Scenario {
  const cfg: Record<string, unknown> = {
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
  };
  const { schema } = parseSchema(makeRead(cfg));
  const metas = 20;
  const notes = [note('C.md', { tags: ['system/category'] })];
  for (let m = 0; m < metas; m++) {
    notes.push(
      note(`M${m}.md`, {
        tags: ['system/high/meta'],
        frontmatter: { category: ['[[C]]'] },
        propertyLinks: { category: ['C.md'] },
      }),
    );
  }
  for (let i = 0; i < hierarchyCount; i++) {
    const links: string[] = [];
    for (let k = 1; k <= 10; k++) {
      links.push(`H${(i * 7 + k * 13) % hierarchyCount}.md`);
    }
    const m = i % metas;
    notes.push(
      note(`H${i}.md`, {
        tags: ['system/high/hierarchy'],
        frontmatter: { meta: [`[[M${m}]]`], category: ['[[C]]'] },
        propertyLinks: { meta: [`M${m}.md`], category: ['C.md'] },
        links,
      }),
    );
  }
  const snap = snapshot(notes, { host: 'C.md', results: notes.slice(1).map((n) => n.path) });
  return { schema, snap };
}

function timeBuild(scenario: Scenario): number {
  const start = performance.now();
  buildStructure(scenario.schema, scenario.snap);
  return performance.now() - start;
}

interface ScalingMeasurement {
  /** The lowest small/large timing ratio seen across the measured rounds. */
  readonly ratio: number;
  /** The lowest `large` timing seen — only for the loose absolute sanity bound. */
  readonly timeLarge: number;
}

/** Times `small` then `large`, back-to-back, `runs` times, and returns the *best (lowest)
 * per-round ratio* — not the fastest `small` timing divided by the fastest `large` timing taken
 * independently. Those two fastest timings can come from *different* rounds measured under
 * *different* momentary contention (GC, a scheduler blip, a noisy neighbour on a shared CI
 * runner, another test file's worker thread) — comparing across rounds like that is exactly what
 * made an earlier version of this comparison occasionally flaky at a ~9-11x ratio even though the
 * algorithm itself scales close to linearly. Computing the ratio *within* each matched pair
 * cancels out contention that hits both timings in that round, and taking the best ratio across
 * rounds discards whichever round(s) got hit asymmetrically. */
function measureScaling(small: Scenario, large: Scenario, runs: number): ScalingMeasurement {
  let bestRatio = Infinity;
  let bestTimeLarge = Infinity;
  for (let i = 0; i < runs; i++) {
    const timeSmall = timeBuild(small);
    const timeLarge = timeBuild(large);
    // A floor under the denominator guards against a near-zero `timeSmall` (a sub-millisecond
    // `performance.now()` reading on an unrealistically fast machine) turning a perfectly fine
    // absolute time into a flaky, meaninglessly huge ratio.
    bestRatio = Math.min(bestRatio, timeLarge / Math.max(timeSmall, 1));
    bestTimeLarge = Math.min(bestTimeLarge, timeLarge);
  }
  return { ratio: bestRatio, timeLarge: bestTimeLarge };
}

describe('buildStructure — I6 perf regression (scaling, not wall-clock)', () => {
  // 15s, not the file's default 5s (see `vitest.config.ts`): this test does real work on purpose
  // (10 rounds x 2 scenarios, one at N=8,000) — under a busy CI runner that makes a
  // ratio-assertion failure *more* likely, not less, so the extra budget only ever matters when
  // the machine is genuinely under load, not when the algorithm has actually regressed.
  it('builds a 4N-note structure in well under 16x the time of an N-note one (linear ~4x, quadratic ~16x)', () => {
    const small = buildScenario(2000);
    const large = buildScenario(8000);
    // Warm up the JIT for both scenarios before the timed rounds, discarding the result — the
    // first call into a cold path is reliably the slowest one, for either size.
    measureScaling(small, large, 2);

    // Measured on the machine this test was written on (Node, vitest, `--coverage` on, matching
    // `verify`'s `test:coverage`; best-of-8 paired rounds; repeated across dozens of trials,
    // including deliberately under CPU contention from the rest of the suite running in
    // parallel worker threads): the ratio stayed in the 6-9x range — comfortably under the 12x
    // asserted below (itself still clearly under the ~16x a quadratic algorithm would produce)
    // but never near the ~4x a purely linear one predicts, since `buildStructure` does real
    // superlinear-but-not-quadratic work (e.g. sorting).
    const { ratio, timeLarge } = measureScaling(small, large, 8);

    expect(small.snap.notes.size).toBe(2000 + 20 + 1);
    expect(large.snap.notes.size).toBe(8000 + 20 + 1);
    expect(ratio).toBeLessThan(12);
    // Loose sanity bound only — not a performance assertion, just a catastrophic-hang guard.
    expect(timeLarge).toBeLessThan(2000);
  }, 15_000);
});
