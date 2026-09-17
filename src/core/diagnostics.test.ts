import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_BASE_CONFIG,
  knowledgeBaseSnapshot,
} from './__tests__/knowledge-base.fixture.js';
import { note, snapshot } from './__tests__/notes.js';
import type { DiagnosticKind } from './diagnostics.js';
import { collectDiagnostics } from './diagnostics.js';
import type { Schema } from './schema.js';
import { parseSchema } from './schema.js';
import type { Snapshot } from './snapshot.js';
import { buildStructure } from './structure.js';

function makeRead(config: Record<string, unknown>): (key: string) => unknown {
  return (key: string): unknown => config[key];
}

/** The design spec's real schema, verbatim: `inherit: [category, meta, problem]` over
 * Category -> Meta-note -> Problem -> Hierarchy, matching `knowledge-base.fixture.ts`. */
const vaultConfig = {
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

function vaultSchema(): Schema {
  return parseSchema(makeRead(vaultConfig)).schema;
}

function diagnosticsFor(schema: Schema, snap: Snapshot) {
  const structure = buildStructure(schema, snap);
  return collectDiagnostics(schema, snap, structure);
}

describe('collectDiagnostics — illegal-parent', () => {
  it('flags a parent link the schema does not allow', () => {
    // "h.md" (Hierarchy) has `category: [[p.md]]`; Category -> Hierarchy is a legal "category"
    // edge, but "p.md" is a Problem, and Problem's own edge into Hierarchy is "problem", not
    // "category".
    const schema = vaultSchema();
    const snap = snapshot([
      note('p.md', { basename: 'Problem', tags: ['system/high/problem'] }),
      note('h.md', {
        basename: 'Hierarchy',
        tags: ['system/high/hierarchy'],
        propertyLinks: { category: ['p.md'] },
      }),
    ]);

    const diagnostics = diagnosticsFor(schema, snap);

    expect(diagnostics).toStrictEqual([
      {
        kind: 'illegal-parent',
        node: 'h.md',
        target: 'p.md',
        property: 'category',
        message: '"Problem" cannot be the category of "Hierarchy"',
      },
    ]);
  });

  it('does not flag a flattened inherited copy under a property that is not this note type’s own edge', () => {
    // A Problem note carries a "category" copy (per `inherit`), even though "category" is never
    // Problem's own edge property (that's "meta") — the copy must not be mistaken for an illegal
    // direct edge just because Category never lists Problem as a child.
    const schema = vaultSchema();
    const snap = snapshot([
      note('cat.md', { tags: ['system/category'] }),
      note('meta.md', { tags: ['system/high/meta'], propertyLinks: { category: ['cat.md'] } }),
      note('prob.md', {
        tags: ['system/high/problem'],
        propertyLinks: { category: ['cat.md'], meta: ['meta.md'] },
      }),
    ]);

    const diagnostics = diagnosticsFor(schema, snap);

    expect(diagnostics).toStrictEqual([]);
  });
});

describe('collectDiagnostics — broken-link', () => {
  it('flags a link that resolves to nothing', () => {
    const schema = vaultSchema();
    const snap = snapshot([
      note('h.md', {
        tags: ['system/high/hierarchy'],
        unresolvedLinks: { category: ['missing'] },
      }),
    ]);

    const diagnostics = diagnosticsFor(schema, snap);

    expect(diagnostics).toStrictEqual([
      {
        kind: 'broken-link',
        node: 'h.md',
        target: 'missing',
        property: 'category',
        message: '"h" links to "missing" as category, but no such note exists.',
      },
    ]);
  });
});

describe('collectDiagnostics — untyped', () => {
  it('flags a note that matches no type', () => {
    // "host.md" matches no type at all, but qualifies as the tree's root because "meta.md"'s own
    // "category" property points at it (an untyped root "fits" any candidate rule).
    const schema = vaultSchema();
    const snap = snapshot(
      [
        note('host.md'),
        note('meta.md', { tags: ['system/high/meta'], propertyLinks: { category: ['host.md'] } }),
      ],
      { host: 'host.md', results: ['meta.md'] },
    );

    const structure = buildStructure(schema, snap);
    expect(structure.root).toBe('host.md');

    const diagnostics = collectDiagnostics(schema, snap, structure);

    expect(diagnostics).toStrictEqual([
      {
        kind: 'untyped',
        node: 'host.md',
        message: '"host" does not match any of the schema\'s types.',
      },
    ]);
  });
});

describe('collectDiagnostics — inherit-mismatch', () => {
  it('flags inherited values that disagree with the parent', () => {
    // h2.md nests under h1.md via file.backlinks (not via "category"), so its "category" is a
    // plain inherited copy of h1.md's own value — and h2.md's own value disagrees with it.
    const schema = vaultSchema();
    const snap = snapshot([
      note('c1.md'),
      note('c2.md'),
      note('h1.md', {
        tags: ['system/high/hierarchy'],
        propertyLinks: { category: ['c1.md'] },
        links: ['h2.md'],
      }),
      note('h2.md', {
        tags: ['system/high/hierarchy'],
        propertyLinks: { category: ['c2.md'] },
      }),
    ]);

    const diagnostics = diagnosticsFor(schema, snap);

    expect(diagnostics).toStrictEqual([
      {
        kind: 'inherit-mismatch',
        node: 'h2.md',
        keys: ['category'],
        message: '"h2" does not match its parent for category.',
      },
    ]);
  });

  it('flags a shorter inherited set as a mismatch even when every value it does have is valid', () => {
    // h1.md contributes two category targets; h2.md's own copy only kept one of them.
    const schema = vaultSchema();
    const snap = snapshot([
      note('c1.md'),
      note('c2.md'),
      note('h1.md', {
        tags: ['system/high/hierarchy'],
        propertyLinks: { category: ['c1.md', 'c2.md'] },
        links: ['h2.md'],
      }),
      note('h2.md', {
        tags: ['system/high/hierarchy'],
        propertyLinks: { category: ['c1.md'] },
      }),
    ]);

    const diagnostics = diagnosticsFor(schema, snap);

    expect(diagnostics).toStrictEqual([
      {
        kind: 'inherit-mismatch',
        node: 'h2.md',
        keys: ['category'],
        message: '"h2" does not match its parent for category.',
      },
    ]);
  });

  it('reports nothing for a consistent tree', () => {
    const { schema } = parseSchema(makeRead(KNOWLEDGE_BASE_CONFIG));
    const snap = knowledgeBaseSnapshot();

    const diagnostics = diagnosticsFor(schema, snap);

    expect(diagnostics).toStrictEqual([]);
  });

  it('does not flag a key neither parent nor child has', () => {
    const schema = vaultSchema();
    const snap = snapshot([
      note('cat.md', { tags: ['system/category'] }),
      note('meta.md', { tags: ['system/high/meta'], propertyLinks: { category: ['cat.md'] } }),
    ]);

    const diagnostics = diagnosticsFor(schema, snap);

    expect(diagnostics).toStrictEqual([]);
  });

  it('does not flag the root for inheritance', () => {
    // "cat.md" is the tree's root (no parent to inherit from at all) and holds a "category" value
    // of its own — that must never be compared against an "expected: []" from having no parent.
    const schema = vaultSchema();
    const snap = snapshot(
      [
        note('cat.md', { tags: ['system/category'], propertyLinks: { category: ['other.md'] } }),
        note('other.md', { tags: ['system/category'] }),
      ],
      { host: 'cat.md', results: ['other.md'] },
    );

    const structure = buildStructure(schema, snap);
    expect(structure.root).toBe('cat.md');

    const diagnostics = collectDiagnostics(schema, snap, structure);

    expect(diagnostics).toStrictEqual([]);
  });
});

describe('collectDiagnostics — mixed kinds', () => {
  it('reports all four kinds together, one per offending note, without any interfering', () => {
    const schema = vaultSchema();
    const snap = snapshot(
      [
        note('host.md'),
        note('metaA.md', { tags: ['system/high/meta'], propertyLinks: { category: ['host.md'] } }),
        note('pB.md', { tags: ['system/high/problem'] }),
        note('hB.md', { tags: ['system/high/hierarchy'], propertyLinks: { category: ['pB.md'] } }),
        note('hC.md', {
          tags: ['system/high/hierarchy'],
          unresolvedLinks: { category: ['missing'] },
        }),
        note('c1D.md'),
        note('c2D.md'),
        note('h1D.md', {
          tags: ['system/high/hierarchy'],
          propertyLinks: { category: ['c1D.md'] },
          links: ['h2D.md'],
        }),
        note('h2D.md', {
          tags: ['system/high/hierarchy'],
          propertyLinks: { category: ['c2D.md'] },
        }),
      ],
      {
        host: 'host.md',
        results: ['metaA.md', 'pB.md', 'hB.md', 'hC.md', 'h1D.md', 'h2D.md'],
      },
    );

    const diagnostics = diagnosticsFor(schema, snap);
    const kinds: readonly DiagnosticKind[] = diagnostics.map((diagnostic) => diagnostic.kind);

    expect(new Set(kinds)).toStrictEqual(
      new Set<DiagnosticKind>(['untyped', 'illegal-parent', 'broken-link', 'inherit-mismatch']),
    );
    expect(diagnostics).toHaveLength(4);
  });
});
