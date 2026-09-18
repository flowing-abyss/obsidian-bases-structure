// Table-driven pin of every ordered (dragged type, target type) transition the user's real schema
// allows (see CLAUDE.md / plan-convert.test.ts's own "user ruling" fixture, same schema): whether
// a plain drag (move) is offered, and which types a Shift-drag (convert) offers. The expected
// tables below are written out by hand against the schema itself, then checked against the actual
// planner — not the other way around — so a future change that silently narrows what's possible
// fails loudly instead of just shrinking a computed table alongside it.
//
// Category is the graph's root/host (`root.md`), reproducing the originally reported bug directly:
// a plain drag of a Problem onto the root offers nothing at all (only a type change can carry a
// Problem that far up) — that part of the bug is unchanged. Shift-dragging it now offers both
// "Meta-note" *and* "Hierarchy": a direct child's edge rewrites between any rule kind (property,
// file.links, file.backlinks) in either direction, so a Hierarchy child attached by a property no
// longer blocks becoming a type whose own rule to Hierarchy is the schema's one text-only edge.
// The only thing that still blocks a conversion outright is a direct child whose *own* type has no
// rule at all under the candidate new type — one conversion only ever changes one note's type, so
// that child would have to change type too. See the "with a child of an illegal type" rows below.

import { describe, expect, it } from 'vitest';
import { note, snapshot } from './__tests__/notes.js';
import { convertOptions, type ConvertContext } from './plan-convert.js';
import { moveTargets } from './plan-move.js';
import type { Action } from './plan-types.js';
import { planAction } from './planner.js';
import { parseSchema, type Schema } from './schema.js';
import { buildStructure } from './structure.js';

function makeRead(config: Record<string, unknown>): (key: string) => unknown {
  return (key: string): unknown => config[key];
}

function schemaFrom(config: Record<string, unknown>): Schema {
  return parseSchema(makeRead(config)).schema;
}

const noEnv = { defaultFolder: '', exists: (): boolean => false };

const CATEGORY_TAG = 'system/category';
const META_TAG = 'system/high/meta';
const PROBLEM_TAG = 'system/high/problem';
const HIERARCHY_TAG = 'system/high/hierarchy';

const schema = schemaFrom({
  inherit: ['category', 'meta', 'problem'],
  types: {
    Category: {
      tag: CATEGORY_TAG,
      children: { 'Meta-note': 'category', Hierarchy: 'category' },
    },
    'Meta-note': { tag: META_TAG, children: { Problem: 'meta', Hierarchy: 'meta' } },
    Problem: { tag: PROBLEM_TAG, children: { Hierarchy: 'problem' } },
    Hierarchy: { tag: HIERARCHY_TAG, children: { Hierarchy: 'file.backlinks' } },
  },
});

/** A with-child row's own child, attached through *that row's own* rule (a property key matching
 * the parent's real child rule under its *current* type) — `childTag` picks the child's type, so
 * this builds both shapes a with-child row needs: a Hierarchy child (every type has a rule to
 * Hierarchy, so this shape always survives a conversion) and a child of whatever type the row's
 * *current* type owns a rule to but candidate new types mostly don't (so this shape mostly
 * refuses, naming the child — see `firstFailingChildReason`). */
function childViaProperty(
  path: string,
  childTag: string,
  property: string,
  parentBasename: string,
) {
  return note(path, {
    tags: [childTag],
    frontmatter: { [property]: `[[${parentBasename}]]` },
    propertyLinks: { [property]: [`${parentBasename}.md`] },
  });
}

// One note of every type, each in three shapes where the schema offers them (leaf, with a
// Hierarchy child, with a child of a type most candidates have no rule to at all) — plus one
// target anchor per type (never dragged, only ever a `parent` below) and the host/root itself, so
// the root can be its own target column without colliding with a source row. Every note is
// otherwise isolated: no note links or property-references any other except a with-child row's
// own single child, so converting/moving one row can never perturb another
// (`firstChangedOtherNode`'s whole-structure scan would otherwise mistake stray coupling for a
// real rejection).
const notesList = [
  // Root/host.
  note('root.md', { tags: [CATEGORY_TAG] }),
  // Target anchors.
  note('catTarget.md', { tags: [CATEGORY_TAG] }),
  note('metaTarget.md', { tags: [META_TAG] }),
  note('problemTarget.md', { tags: [PROBLEM_TAG] }),
  note('hierarchyTarget.md', { tags: [HIERARCHY_TAG] }),
  // Category: leaf, with a Hierarchy child (property "category"), and with a Meta-note child
  // (also property "category" — Category's own rule to each).
  note('catLeaf.md', { tags: [CATEGORY_TAG] }),
  note('catChild.md', { tags: [CATEGORY_TAG] }),
  childViaProperty('catChildKid.md', HIERARCHY_TAG, 'category', 'catChild'),
  note('catChildB.md', { tags: [CATEGORY_TAG] }),
  childViaProperty('catChildBKid.md', META_TAG, 'category', 'catChildB'),
  // Meta-note: leaf, with a Hierarchy child, and with a Problem child (both property "meta" —
  // Meta-note's own rule to each).
  note('metaLeaf.md', { tags: [META_TAG] }),
  note('metaChild.md', { tags: [META_TAG] }),
  childViaProperty('metaChildKid.md', HIERARCHY_TAG, 'meta', 'metaChild'),
  note('metaChildB.md', { tags: [META_TAG] }),
  childViaProperty('metaChildBKid.md', PROBLEM_TAG, 'meta', 'metaChildB'),
  // Problem: leaf, and with a Hierarchy child (property "problem" — Problem's own, and only, rule).
  note('problemLeaf.md', { tags: [PROBLEM_TAG] }),
  note('problemChild.md', { tags: [PROBLEM_TAG] }),
  childViaProperty('problemChildKid.md', HIERARCHY_TAG, 'problem', 'problemChild'),
  // Hierarchy: leaf, and with a Hierarchy child via a body link (file.backlinks — Hierarchy's own,
  // and only, rule).
  note('hierarchyLeaf.md', { tags: [HIERARCHY_TAG] }),
  note('hierarchyChild.md', { tags: [HIERARCHY_TAG], links: ['hierarchyChildKid.md'] }),
  note('hierarchyChildKid.md', { tags: [HIERARCHY_TAG] }),
];

const snap = snapshot(notesList, { host: 'root.md' });
const structure = buildStructure(schema, snap);
const context: ConvertContext = { schema, structure, snapshot: snap, env: noEnv };

// Target columns, in the order every table below lists them.
const COLUMNS = [
  { label: 'Category', path: 'catTarget.md' },
  { label: 'Meta-note', path: 'metaTarget.md' },
  { label: 'Problem', path: 'problemTarget.md' },
  { label: 'Hierarchy', path: 'hierarchyTarget.md' },
  { label: 'Root', path: 'root.md' },
] as const;

// -- Move: shape-invariant (a move never changes N's own type, so a child's rule to it is
// unaffected by where N goes) — one row per type, checked against both the leaf and with-child
// note to pin that invariant itself, not just assume it.
//
//              | Category | Meta-note | Problem | Hierarchy |  Root
// Category     |    -     |     -     |    -    |     -     |   -
// Meta-note    |    Y     |     -     |    -    |     -     |   Y
// Problem      |    -     |     Y     |    -    |     -     |   -
// Hierarchy    |    Y     |     Y     |    Y    |     Y     |   Y
const MOVE_ROWS = [
  {
    type: 'Category',
    leaf: 'catLeaf.md',
    child: 'catChild.md',
    offered: [false, false, false, false, false],
  },
  {
    type: 'Meta-note',
    leaf: 'metaLeaf.md',
    child: 'metaChild.md',
    offered: [true, false, false, false, true],
  },
  {
    type: 'Problem',
    leaf: 'problemLeaf.md',
    child: 'problemChild.md',
    offered: [false, true, false, false, false],
  },
  {
    type: 'Hierarchy',
    leaf: 'hierarchyLeaf.md',
    child: 'hierarchyChild.md',
    offered: [true, true, true, true, true],
  },
] as const;

const MOVE_CASES = MOVE_ROWS.flatMap((row) =>
  COLUMNS.map((col, i) => ({
    rowType: row.type,
    leaf: row.leaf,
    withChild: row.child,
    colLabel: col.label,
    colPath: col.path,
    expected: row.offered[i],
  })),
);

describe('move — every (dragged type, target type) pair the schema allows', () => {
  it.each(MOVE_CASES)(
    '$rowType -> $colLabel: offered = $expected (both leaf and with-child)',
    ({ leaf, withChild, colPath, expected }) => {
      expect(moveTargets(schema, structure, leaf).has(colPath)).toBe(expected);
      expect(moveTargets(schema, structure, withChild).has(colPath)).toBe(expected);
    },
  );
});

// -- Convert (Shift-drag): shape only matters when the *child's own type* has no rule at all under
// a candidate new type — a direct child's edge now rewrites between any rule kind (property,
// file.links, file.backlinks) in either direction (`plan-retype.ts`'s `retypedChildWrites`), so a
// Hierarchy child attached by a property no longer blocks converting to a type whose own rule to
// Hierarchy is the schema's one text-only edge (`childEdgeChange` rewrites it instead of refusing).
// Every type in this schema has *some* rule to Hierarchy, so a "with a Hierarchy child" row always
// collapses onto its leaf row below — this is exactly the user's reported case: their real Problem
// note had its own Hierarchy child, and it now offers "Meta-note" *and* "Hierarchy" under the root,
// same as a bare Problem leaf.
//
// What still narrows a row is a child whose *own type* has no rule at all under the candidate new
// type — one conversion only ever changes one note's type, so that child would have to change type
// too, and `failingChildren` refuses it (`firstFailingChildReason` names the child). Category only
// ever offers Meta-note/Hierarchy as children, and Meta-note only ever offers Problem/Hierarchy —
// neither Meta-note nor Problem has a rule to the *other* one, so "Category (child: Meta-note)" and
// "Meta-note (child: Problem)" refuse every candidate type, everywhere.
//
//                                | Category  | Meta-note | Problem | Hierarchy |  Root
// Category (leaf)                | Meta,Hier | Prob,Hier |  Hier   |   Hier    | Meta,Hier
// Category (child: Hierarchy)    | Meta,Hier | Prob,Hier |  Hier   |   Hier    | Meta,Hier
// Category (child: Meta-note)    |    -      |    -      |    -    |     -     |    -
// Meta-note (leaf)                |   Hier    | Prob,Hier |  Hier   |   Hier    |   Hier
// Meta-note (child: Hierarchy)   |   Hier    | Prob,Hier |  Hier   |   Hier    |   Hier
// Meta-note (child: Problem)     |    -      |    -      |    -    |     -     |    -
// Problem (leaf)                  | Meta,Hier |   Hier    |  Hier   |   Hier    | Meta,Hier
// Problem (child: Hierarchy)     | Meta,Hier |   Hier    |  Hier   |   Hier    | Meta,Hier
// Hierarchy (leaf)                |   Meta    |   Prob    |    -    |     -     |   Meta
// Hierarchy (child: Hierarchy)   |   Meta    |   Prob    |    -    |     -     |   Meta
const CONVERT_ROWS = [
  {
    label: 'Category (leaf)',
    path: 'catLeaf.md',
    offered: [
      ['Meta-note', 'Hierarchy'],
      ['Problem', 'Hierarchy'],
      ['Hierarchy'],
      ['Hierarchy'],
      ['Meta-note', 'Hierarchy'],
    ],
  },
  {
    label: 'Category (child: Hierarchy)',
    path: 'catChild.md',
    offered: [
      ['Meta-note', 'Hierarchy'],
      ['Problem', 'Hierarchy'],
      ['Hierarchy'],
      ['Hierarchy'],
      ['Meta-note', 'Hierarchy'],
    ],
  },
  {
    label: 'Category (child: Meta-note)',
    path: 'catChildB.md',
    offered: [[], [], [], [], []],
  },
  {
    label: 'Meta-note (leaf)',
    path: 'metaLeaf.md',
    offered: [['Hierarchy'], ['Problem', 'Hierarchy'], ['Hierarchy'], ['Hierarchy'], ['Hierarchy']],
  },
  {
    label: 'Meta-note (child: Hierarchy)',
    path: 'metaChild.md',
    offered: [['Hierarchy'], ['Problem', 'Hierarchy'], ['Hierarchy'], ['Hierarchy'], ['Hierarchy']],
  },
  {
    label: 'Meta-note (child: Problem)',
    path: 'metaChildB.md',
    offered: [[], [], [], [], []],
  },
  {
    label: 'Problem (leaf)',
    path: 'problemLeaf.md',
    offered: [
      ['Meta-note', 'Hierarchy'],
      ['Hierarchy'],
      ['Hierarchy'],
      ['Hierarchy'],
      ['Meta-note', 'Hierarchy'],
    ],
  },
  {
    label: 'Problem (child: Hierarchy)',
    path: 'problemChild.md',
    offered: [
      ['Meta-note', 'Hierarchy'],
      ['Hierarchy'],
      ['Hierarchy'],
      ['Hierarchy'],
      ['Meta-note', 'Hierarchy'],
    ],
  },
  {
    label: 'Hierarchy (leaf)',
    path: 'hierarchyLeaf.md',
    offered: [['Meta-note'], ['Problem'], [], [], ['Meta-note']],
  },
  {
    label: 'Hierarchy (child: Hierarchy)',
    path: 'hierarchyChild.md',
    offered: [['Meta-note'], ['Problem'], [], [], ['Meta-note']],
  },
] as const;

const CONVERT_CASES = CONVERT_ROWS.flatMap((row) =>
  COLUMNS.map((col, i) => ({
    rowLabel: row.label,
    rowPath: row.path,
    colLabel: col.label,
    colPath: col.path,
    expected: row.offered[i],
  })),
);

/** This table only pins *which* types each pair offers, not the `Plan` `convertOptions` now pairs
 * each one with (see `plan-convert.test.ts`'s own coverage of that pairing) — narrows a result
 * back down to the plain, ordered type-name list every row above is written against. */
function optionTypes(options: ReturnType<typeof convertOptions>): readonly string[] {
  return options.map((option) => option.type);
}

describe('convert (Shift-drag) — every type each (dragged type, target type) pair offers', () => {
  it.each(CONVERT_CASES)(
    '$rowLabel -> $colLabel offers $expected',
    ({ rowPath, colPath, expected }) => {
      expect(optionTypes(convertOptions(context, rowPath, colPath))).toStrictEqual(expected);
    },
  );
});

// -- Empty cells, pinned to the planner's own reason (not just "offers nothing") — a future change
// that silently narrows what's possible must fail here even if it happens to keep the cell empty.

interface EmptyCase {
  readonly node: string;
  readonly parent: string;
  readonly reason: string;
}

const EMPTY_MOVE_CASES: readonly EmptyCase[] = [
  // Category can never be moved anywhere — nothing in the schema ever adopts a Category child.
  {
    node: 'catLeaf.md',
    parent: 'catTarget.md',
    reason: '"Category" cannot be placed under "catTarget"',
  },
  {
    node: 'catLeaf.md',
    parent: 'metaTarget.md',
    reason: '"Category" cannot be placed under "metaTarget"',
  },
  {
    node: 'catLeaf.md',
    parent: 'problemTarget.md',
    reason: '"Category" cannot be placed under "problemTarget"',
  },
  {
    node: 'catLeaf.md',
    parent: 'hierarchyTarget.md',
    reason: '"Category" cannot be placed under "hierarchyTarget"',
  },
  { node: 'catLeaf.md', parent: 'root.md', reason: '"Category" cannot be placed under "root"' },
  // Meta-note only ever moves under a Category — never under itself, Problem, or Hierarchy.
  {
    node: 'metaLeaf.md',
    parent: 'metaTarget.md',
    reason: '"Meta-note" cannot be placed under "metaTarget"',
  },
  {
    node: 'metaLeaf.md',
    parent: 'problemTarget.md',
    reason: '"Meta-note" cannot be placed under "problemTarget"',
  },
  {
    node: 'metaLeaf.md',
    parent: 'hierarchyTarget.md',
    reason: '"Meta-note" cannot be placed under "hierarchyTarget"',
  },
  // Problem only ever moves under a Meta-note — never under a Category (the reported bug: a plain
  // drag alone can't carry a Problem onto the root; only a Shift-drag/convert can), itself, or
  // Hierarchy.
  {
    node: 'problemLeaf.md',
    parent: 'catTarget.md',
    reason: '"Problem" cannot be placed under "catTarget"',
  },
  {
    node: 'problemLeaf.md',
    parent: 'problemTarget.md',
    reason: '"Problem" cannot be placed under "problemTarget"',
  },
  {
    node: 'problemLeaf.md',
    parent: 'hierarchyTarget.md',
    reason: '"Problem" cannot be placed under "hierarchyTarget"',
  },
  { node: 'problemLeaf.md', parent: 'root.md', reason: '"Problem" cannot be placed under "root"' },
];

describe('move — why the empty cells are empty', () => {
  it.each(EMPTY_MOVE_CASES)('$node -> $parent', ({ node, parent, reason }) => {
    expect(moveTargets(schema, structure, node).has(parent)).toBe(false);
    const action: Action = { kind: 'move', node, parent };
    expect(planAction(schema, snap, action, noEnv)).toStrictEqual({ ok: false, reason });
  });
});

interface EmptyConvertCase extends EmptyCase {
  /** The type `planAction` is actually asked to plan — the one candidate that best demonstrates
   * *why* the cell is empty (a rule that doesn't exist at all, or a rule that exists but the row's
   * own child's type has no rule under it; see the two comment blocks in `EMPTY_CONVERT_CASES`
   * below). */
  readonly attempt: string;
}

// Two distinct reasons produce every empty convert cell:
//
// (a) No target column here offers a rule to any type this row could still become (every
//     candidate fails `checkConvertParent`'s own rule lookup) — Hierarchy's leaf/with-child rows
//     under a Problem or Hierarchy target, neither of which has a rule to Meta-note, Category, or
//     (for a non-self type) anything else.
//
// (b) A rule *does* exist, but the row's own child's type has no rule at all under it —
//     `failingChildren`'s one remaining refusal, the one-type-change-per-operation limit: that
//     child would have to change type too, which a single conversion never does. "Hierarchy" is
//     placement-valid under every column type in this schema, so it's used here for every
//     "child: Meta-note"/"child: Problem" row regardless of column — the point isn't the column,
//     it's that neither Meta-note nor Problem has a rule to the other.
const EMPTY_CONVERT_CASES: readonly EmptyConvertCase[] = [
  // Category (child: Meta-note): "Hierarchy" is placement-valid under every column, and Hierarchy
  // has no rule to Meta-note at all — refused everywhere, naming catChildBKid.
  {
    node: 'catChildB.md',
    parent: 'catTarget.md',
    attempt: 'Hierarchy',
    reason: '"catChildBKid" cannot stay under "catChildB" as a "Hierarchy"',
  },
  {
    node: 'catChildB.md',
    parent: 'metaTarget.md',
    attempt: 'Hierarchy',
    reason: '"catChildBKid" cannot stay under "catChildB" as a "Hierarchy"',
  },
  {
    node: 'catChildB.md',
    parent: 'problemTarget.md',
    attempt: 'Hierarchy',
    reason: '"catChildBKid" cannot stay under "catChildB" as a "Hierarchy"',
  },
  {
    node: 'catChildB.md',
    parent: 'hierarchyTarget.md',
    attempt: 'Hierarchy',
    reason: '"catChildBKid" cannot stay under "catChildB" as a "Hierarchy"',
  },
  {
    node: 'catChildB.md',
    parent: 'root.md',
    attempt: 'Hierarchy',
    reason: '"catChildBKid" cannot stay under "catChildB" as a "Hierarchy"',
  },
  // Meta-note (child: Problem): same shape — Hierarchy has no rule to Problem either.
  {
    node: 'metaChildB.md',
    parent: 'catTarget.md',
    attempt: 'Hierarchy',
    reason: '"metaChildBKid" cannot stay under "metaChildB" as a "Hierarchy"',
  },
  {
    node: 'metaChildB.md',
    parent: 'metaTarget.md',
    attempt: 'Hierarchy',
    reason: '"metaChildBKid" cannot stay under "metaChildB" as a "Hierarchy"',
  },
  {
    node: 'metaChildB.md',
    parent: 'problemTarget.md',
    attempt: 'Hierarchy',
    reason: '"metaChildBKid" cannot stay under "metaChildB" as a "Hierarchy"',
  },
  {
    node: 'metaChildB.md',
    parent: 'hierarchyTarget.md',
    attempt: 'Hierarchy',
    reason: '"metaChildBKid" cannot stay under "metaChildB" as a "Hierarchy"',
  },
  {
    node: 'metaChildB.md',
    parent: 'root.md',
    attempt: 'Hierarchy',
    reason: '"metaChildBKid" cannot stay under "metaChildB" as a "Hierarchy"',
  },
  // Hierarchy (leaf and with-child, identically): Problem/Hierarchy targets have no rule to any
  // *other* type at all — (a) — represented here by attempting "Meta-note".
  {
    node: 'hierarchyLeaf.md',
    parent: 'problemTarget.md',
    attempt: 'Meta-note',
    reason: '"Meta-note" cannot be placed under "problemTarget"',
  },
  {
    node: 'hierarchyLeaf.md',
    parent: 'hierarchyTarget.md',
    attempt: 'Meta-note',
    reason: '"Meta-note" cannot be placed under "hierarchyTarget"',
  },
  {
    node: 'hierarchyChild.md',
    parent: 'problemTarget.md',
    attempt: 'Meta-note',
    reason: '"Meta-note" cannot be placed under "problemTarget"',
  },
  {
    node: 'hierarchyChild.md',
    parent: 'hierarchyTarget.md',
    attempt: 'Meta-note',
    reason: '"Meta-note" cannot be placed under "hierarchyTarget"',
  },
];

describe('convert — why the empty cells are empty', () => {
  it.each(EMPTY_CONVERT_CASES)(
    '$node -> $parent (attempting "$attempt")',
    ({ node, parent, attempt, reason }) => {
      expect(convertOptions(context, node, parent)).toStrictEqual([]);
      const action: Action = { kind: 'convert', node, parent, type: attempt };
      expect(planAction(schema, snap, action, noEnv)).toStrictEqual({ ok: false, reason });
    },
  );
});

describe('the reported bug, reproduced directly against this fixture', () => {
  it('Shift-dragging a Problem (with its own Hierarchy child) onto the root Category now offers both "Meta-note" and "Hierarchy" — the child\'s edge rewrites instead of blocking the conversion', () => {
    expect(optionTypes(convertOptions(context, 'problemChild.md', 'root.md'))).toStrictEqual([
      'Meta-note',
      'Hierarchy',
    ]);
  });

  it('a plain drag (no Shift) of the same Problem onto the root Category is still not offered at all — only a type change can carry it that far up', () => {
    expect(moveTargets(schema, structure, 'problemChild.md').has('root.md')).toBe(false);
  });

  it('a bare Problem leaf (no child) offers the same two types onto the same root — shape no longer narrows a Hierarchy-child row at all', () => {
    expect(optionTypes(convertOptions(context, 'problemLeaf.md', 'root.md'))).toStrictEqual([
      'Meta-note',
      'Hierarchy',
    ]);
  });
});
