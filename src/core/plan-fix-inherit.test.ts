import { describe, expect, it } from 'vitest';
import { note, snapshot } from './__tests__/notes.js';
import { collectDiagnostics } from './diagnostics.js';
import { planFixInherit } from './plan-fix-inherit.js';
import type { Schema } from './schema.js';
import { parseSchema } from './schema.js';
import { applyPlan } from './simulate.js';
import { buildStructure } from './structure.js';

function makeRead(config: Record<string, unknown>): (key: string) => unknown {
  return (key: string): unknown => config[key];
}

function schemaFrom(config: Record<string, unknown>): Schema {
  return parseSchema(makeRead(config)).schema;
}

// Category -> Meta (via "category") -> Hier (via "meta"), Hier -> Hier via file.backlinks — a
// small version of the real vault schema's cascade, matching `diagnostics.test.ts`'s own fixture
// shape so "category" flows down a Hierarchy chain as a plain inherited copy, decoupled from the
// chain's own (backlink) edge.
const SCHEMA_CONFIG = {
  inherit: ['category'],
  types: {
    Category: { tag: 'category', children: { Meta: 'category' } },
    Meta: { tag: 'meta', children: { Hier: 'meta' } },
    Hier: { tag: 'hier', children: { Hier: 'file.backlinks' } },
  },
};

describe('planFixInherit', () => {
  const schema = schemaFrom(SCHEMA_CONFIG);

  it('rejects a node that is not in the structure', () => {
    const snap = snapshot([note('cat1.md', { tags: ['category'] })], { host: 'cat1.md' });

    const result = planFixInherit(schema, snap, { kind: 'fix-inherit', node: 'ghost.md' });

    expect(result).toStrictEqual({ ok: false, reason: '"ghost" is not in the structure' });
  });

  it('rejects the root: it has no property parent, so its own values are never "wrong"', () => {
    const snap = snapshot(
      [note('cat1.md', { tags: ['category'], propertyLinks: { category: ['other.md'] } })],
      { host: 'cat1.md' },
    );

    const result = planFixInherit(schema, snap, { kind: 'fix-inherit', node: 'cat1.md' });

    expect(result).toStrictEqual({ ok: false, reason: '"cat1" already matches its parent' });
  });

  it('rewrites the node and its descendants to match the parent', () => {
    // c.md's own "category" disagrees with its parent m.md; d.md nests under c.md via
    // file.backlinks and, before the fix, merely mirrors c.md's own (wrong) value — fixing c.md
    // must cascade the corrected value down to d.md too.
    const snap = snapshot(
      [
        note('cat1.md', { tags: ['category'] }),
        note('wrong.md'),
        note('m.md', {
          tags: ['meta'],
          propertyLinks: { category: ['cat1.md'] },
          frontmatter: { category: ['[[cat1]]'] },
        }),
        note('c.md', {
          tags: ['hier'],
          propertyLinks: { meta: ['m.md'], category: ['wrong.md'] },
          frontmatter: { meta: '[[m]]', category: ['[[wrong]]'] },
          links: ['d.md'],
        }),
        note('d.md', {
          tags: ['hier'],
          propertyLinks: { category: ['wrong.md'] },
          frontmatter: { category: ['[[wrong]]'] },
        }),
      ],
      { host: 'cat1.md' },
    );

    const result = planFixInherit(schema, snap, { kind: 'fix-inherit', node: 'c.md' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.focus).toBe('c.md');
    expect(result.plan.changes).toStrictEqual([
      {
        path: 'c.md',
        writes: [
          {
            key: 'category',
            value: { kind: 'links', remove: ['wrong.md'], add: ['cat1.md'], list: true },
          },
        ],
      },
      {
        path: 'd.md',
        writes: [
          {
            key: 'category',
            value: { kind: 'links', remove: ['wrong.md'], add: ['cat1.md'], list: true },
          },
        ],
      },
    ]);
    const after = applyPlan(snap, result.plan);
    expect(collectDiagnostics(schema, after, buildStructure(schema, after))).toHaveLength(0);
  });

  it('rejects a node with nothing to fix', () => {
    const snap = snapshot(
      [
        note('cat1.md', { tags: ['category'] }),
        note('m.md', {
          tags: ['meta'],
          propertyLinks: { category: ['cat1.md'] },
          frontmatter: { category: '[[cat1]]' },
        }),
        note('OK.md', {
          tags: ['hier'],
          propertyLinks: { meta: ['m.md'], category: ['cat1.md'] },
          frontmatter: { meta: '[[m]]', category: '[[cat1]]' },
        }),
      ],
      { host: 'cat1.md' },
    );

    const result = planFixInherit(schema, snap, { kind: 'fix-inherit', node: 'OK.md' });

    expect(result).toEqual({ ok: false, reason: '"OK" already matches its parent' });
  });

  it("ignores a mismatch on a sibling outside the node's own branch", () => {
    // "stray.md" sits under the same parent as "c.md" but is never touched by fixing c.md — the
    // action repairs one node's branch, not the whole graph — and its own pre-existing mismatch
    // survives, proving the plan never reached it.
    const snap = snapshot(
      [
        note('cat1.md', { tags: ['category'] }),
        note('cat2.md', { tags: ['category'] }),
        note('wrong.md'),
        note('m.md', {
          tags: ['meta'],
          propertyLinks: { category: ['cat1.md'] },
          frontmatter: { category: '[[cat1]]' },
        }),
        note('c.md', {
          tags: ['hier'],
          propertyLinks: { meta: ['m.md'], category: ['wrong.md'] },
          frontmatter: { meta: '[[m]]', category: '[[wrong]]' },
        }),
        note('stray.md', {
          tags: ['hier'],
          propertyLinks: { meta: ['m.md'], category: ['cat2.md'] },
          frontmatter: { meta: '[[m]]', category: '[[cat2]]' },
        }),
      ],
      { host: 'cat1.md' },
    );

    const result = planFixInherit(schema, snap, { kind: 'fix-inherit', node: 'c.md' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.changes.map((change) => change.path)).toStrictEqual(['c.md']);
    const after = applyPlan(snap, result.plan);
    const diagnostics = collectDiagnostics(schema, after, buildStructure(schema, after));
    expect(diagnostics).toStrictEqual([
      {
        kind: 'inherit-mismatch',
        node: 'stray.md',
        keys: ['category'],
        message: '"stray" does not match its parent for category.',
      },
    ]);
  });

  it("rejects when a descendant's own independent drift would still be mismatched after the cascade", () => {
    // e.md nests under c.md's own child d.md and already holds an extra, unrelated value
    // ("stray-value.md") that neither c.md's old nor new "category" ever contributed — the
    // cascade correctly leaves it alone (it isn't stale), which means fixing c.md can't actually
    // bring e.md back in line with its parent; the whole action is rejected rather than applying
    // a fix that leaves part of the subtree still broken.
    const snap = snapshot(
      [
        note('cat1.md', { tags: ['category'] }),
        note('wrong.md'),
        note('stray-value.md'),
        note('m.md', {
          tags: ['meta'],
          propertyLinks: { category: ['cat1.md'] },
          frontmatter: { category: '[[cat1]]' },
        }),
        note('c.md', {
          tags: ['hier'],
          propertyLinks: { meta: ['m.md'], category: ['wrong.md'] },
          frontmatter: { meta: '[[m]]', category: '[[wrong]]' },
          links: ['d.md'],
        }),
        note('d.md', {
          tags: ['hier'],
          propertyLinks: { category: ['wrong.md'] },
          frontmatter: { category: '[[wrong]]' },
          links: ['e.md'],
        }),
        note('e.md', {
          tags: ['hier'],
          propertyLinks: { category: ['stray-value.md'] },
          frontmatter: { category: '[[stray-value]]' },
        }),
      ],
      { host: 'cat1.md' },
    );

    const result = planFixInherit(schema, snap, { kind: 'fix-inherit', node: 'c.md' });

    expect(result).toStrictEqual({
      ok: false,
      reason: 'Fixing "c" would still leave "e" out of sync',
    });
  });
});
