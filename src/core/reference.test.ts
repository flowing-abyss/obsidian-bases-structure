// Reference test: checks that `buildStructure` reproduces the parent -> child edges of the
// user's original DataviewJS structure script (`view.js`, ported read-only as an oracle in
// `__tests__/view-js-oracle.ts`) on real-vault-shaped data, with the category note as root
// instead of the script's synthetic mermaid roots.

import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_BASE_CONFIG,
  knowledgeBaseSnapshot,
  rLangSnapshot,
} from './__tests__/knowledge-base.fixture.js';
import { viewJsEdges } from './__tests__/view-js-oracle.js';
import { parseSchema } from './schema.js';
import type { Structure } from './structure.js';
import { buildStructure } from './structure.js';

function makeRead(config: Record<string, unknown>): (key: string) => unknown {
  return (key: string): unknown => config[key];
}

/** `'a/b/c.md'` → `'c'`; mirrors `__tests__/notes.ts`'s private `basenameOf`. */
function basenameOf(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const fileName = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  return fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
}

/** For every node with a resolved parent, `"<parent basename> -> <child basename>"`. */
function edgesOf(structure: Structure): ReadonlySet<string> {
  const edges = new Set<string>();
  for (const child of structure.nodes.values()) {
    if (child.parent === null) {
      continue;
    }
    edges.add(`${basenameOf(child.parent)} -> ${basenameOf(child.path)}`);
  }
  return edges;
}

const { schema } = parseSchema(makeRead(KNOWLEDGE_BASE_CONFIG));

describe('buildStructure vs. the view.js oracle — knowledge base category', () => {
  it('matches the oracle edge set on the full meta/problem/hierarchy tree', () => {
    const snap = knowledgeBaseSnapshot();
    const categoryPath = 'base/categories/knowledge base.md';

    const structure = buildStructure(schema, snap);
    const oracle = viewJsEdges(snap, categoryPath);

    expect(edgesOf(structure)).toStrictEqual(oracle);
    expect(oracle.size).toBe(16);
    expect(structure.root).toBe(categoryPath);
    expect(structure.orphans).toStrictEqual([]);
    expect(structure.issues).toStrictEqual([]);
  });
});

describe('buildStructure vs. the view.js oracle — r-lang category', () => {
  it('matches the oracle edge set on a hierarchy-only tree with nested backlinks', () => {
    const snap = rLangSnapshot();
    const categoryPath = 'base/categories/r-lang.md';

    const structure = buildStructure(schema, snap);
    const oracle = viewJsEdges(snap, categoryPath);

    expect(edgesOf(structure)).toStrictEqual(oracle);
    expect(oracle.size).toBe(4);
    expect(structure.root).toBe(categoryPath);
    expect(structure.orphans).toStrictEqual([]);
    expect(structure.issues).toStrictEqual([]);
  });
});
