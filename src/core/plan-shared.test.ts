import { describe, expect, it } from 'vitest';
import { note, snapshot } from './__tests__/notes.js';
import { bareContext, type SubtreeContext } from './derive.js';
import {
  buildEdgeWrites,
  computeOldEdgeCleanup,
  firstChangedOtherNode,
  inheritWritesFor,
  type EdgeWriteInputs,
} from './plan-shared.js';
import type { Schema } from './schema.js';
import type { Structure, StructureNode } from './structure.js';

const emptySchema: Schema = { types: [], typeByName: new Map(), inherit: [], layout: 'graph' };

/** A minimal, self-contained `StructureNode`; callers override only what the scenario needs. */
function node(overrides: Partial<StructureNode> & { readonly path: string }): StructureNode {
  return {
    type: null,
    parent: null,
    edge: null,
    children: [],
    extras: [],
    alsoIn: [],
    twoWay: false,
    ...overrides,
  };
}

function structureOf(nodes: readonly StructureNode[]): Structure {
  return {
    root: null,
    tops: [],
    orphans: [],
    nodes: new Map(nodes.map((n) => [n.path, n])),
    issues: [],
  };
}

// The move/retype test suites already exercise `textLinkReason`, `sameSet`,
// `recordOverride`, `recordAllOverrides`, and `computeEdgeWrite`'s and `inheritWritesFor`'s
// write-producing branches end to end, so this file only targets what those integration tests
// can't reach directly: `firstChangedOtherNode`'s "collateral damage" detection (previously
// impossible to test in isolation, since it was a private duplicate embedded in each planner) and
// a few defensive fallbacks in `computeOldEdgeCleanup`/`buildEdgeWrites`/`inheritWritesFor`.

describe('firstChangedOtherNode', () => {
  it('returns null when no other node changed parent', () => {
    const before = structureOf([node({ path: 'n.md' }), node({ path: 'a.md', parent: 'n.md' })]);
    const after = structureOf([node({ path: 'n.md' }), node({ path: 'a.md', parent: 'n.md' })]);

    expect(firstChangedOtherNode(before, after, 'n.md', 'n.md')).toBeNull();
  });

  it('returns the path of the first other node whose parent changed', () => {
    const before = structureOf([
      node({ path: 'n.md' }),
      node({ path: 'a.md', parent: 'n.md' }),
      node({ path: 'b.md', parent: 'elsewhere.md' }),
    ]);
    const after = structureOf([
      node({ path: 'n.md' }),
      node({ path: 'a.md', parent: 'n.md' }),
      node({ path: 'b.md', parent: 'somewhere-else.md' }),
    ]);

    expect(firstChangedOtherNode(before, after, 'n.md', 'n.md')).toBe('b.md');
  });

  it('skips a node missing from "after" entirely rather than flagging it as changed', () => {
    const before = structureOf([node({ path: 'n.md' }), node({ path: 'gone.md', parent: 'x.md' })]);
    const after = structureOf([node({ path: 'n.md' })]);

    expect(firstChangedOtherNode(before, after, 'n.md', 'n.md')).toBeNull();
  });

  it('maps a child of the renamed node to "focus" instead of flagging it as changed', () => {
    const before = structureOf([
      node({ path: 'old.md' }),
      node({ path: 'child.md', parent: 'old.md' }),
    ]);
    const after = structureOf([
      node({ path: 'new.md' }),
      node({ path: 'child.md', parent: 'new.md' }),
    ]);

    expect(firstChangedOtherNode(before, after, 'old.md', 'new.md')).toBeNull();
  });

  it("still flags a child whose parent doesn't match the renamed node's new path", () => {
    const before = structureOf([
      node({ path: 'old.md' }),
      node({ path: 'child.md', parent: 'old.md' }),
    ]);
    const after = structureOf([
      node({ path: 'new.md' }),
      node({ path: 'child.md', parent: 'unexpected.md' }),
    ]);

    expect(firstChangedOtherNode(before, after, 'old.md', 'new.md')).toBe('child.md');
  });
});

describe('computeOldEdgeCleanup', () => {
  it('returns null when the old parent is not actually present under the old key (nothing to clean up)', () => {
    const snap = snapshot([note('n.md', { propertyLinks: { oldKey: ['someone-else.md'] } })]);
    const inputs: EdgeWriteInputs = {
      snapshot: snap,
      node: 'n.md',
      oldParent: 'old-parent.md',
      newParent: 'new-parent.md',
      oldEdge: { kind: 'property', property: 'oldKey' },
      key: 'newKey',
      staleForNewKey: new Set(),
    };

    const result = computeOldEdgeCleanup(
      emptySchema,
      inputs,
      snap.notes.get('n.md')?.propertyLinks ?? {},
    );

    expect(result).toBeNull();
  });

  it('treats a missing old-key list as empty rather than throwing (defensive)', () => {
    const snap = snapshot([note('n.md')]);
    const inputs: EdgeWriteInputs = {
      snapshot: snap,
      node: 'n.md',
      oldParent: 'old-parent.md',
      newParent: 'new-parent.md',
      oldEdge: { kind: 'property', property: 'oldKey' },
      key: 'newKey',
      staleForNewKey: new Set(),
    };

    const result = computeOldEdgeCleanup(emptySchema, inputs, {});

    expect(result).toBeNull();
  });
});

describe('buildEdgeWrites', () => {
  it('treats a node missing from the snapshot as having no current property links (defensive)', () => {
    const snap = snapshot([]);

    const result = buildEdgeWrites(emptySchema, {
      snapshot: snap,
      node: 'ghost.md',
      oldParent: null,
      newParent: 'p.md',
      oldEdge: null,
      key: 'up',
      staleForNewKey: new Set(),
    });

    expect(result).toStrictEqual([
      { key: 'up', value: { kind: 'links', remove: [], add: ['p.md'], list: true } },
    ]);
  });
});

describe('inheritWritesFor', () => {
  it('treats a node missing from the snapshot as having no current inherit values (defensive)', () => {
    const snap = snapshot([note('p.md')]);
    const ctx: SubtreeContext = {
      schema: { ...emptySchema, inherit: ['category'] },
      snapshot: snap,
      structure: structureOf([node({ path: 'p.md' })]),
      typeOverrides: new Map(),
      linkOverrides: new Map(),
    };

    const result = inheritWritesFor(ctx, bareContext(ctx), {
      node: 'ghost.md',
      excludeKey: 'unrelated-key',
      oldPropertyParents: ['p.md'],
      newPropertyParents: ['p.md'],
    });

    // "category" isn't provided by p.md's (untyped, here) edgeProperties nor by any links value,
    // so desired is [] and current (missing note, defensive `?? {}`) is also [] -> no write.
    expect(result).toStrictEqual([]);
  });
});
