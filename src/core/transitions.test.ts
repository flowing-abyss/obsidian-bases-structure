// Table-driven pin of every ordered (dragged type, target type) transition the user's real schema
// allows (see CLAUDE.md / plan-convert.test.ts's own "user ruling" fixture, same schema): whether
// a plain drag (move) is offered, and which types a Shift-drag (convert) offers. The expected
// tables below are written out by hand against the schema itself, then checked against the actual
// planner — not the other way around — so a future change that silently narrows what's possible
// fails loudly instead of just shrinking a computed table alongside it.
//
// Category is the graph's root/host (`root.md`), reproducing the reported bug directly: Shift-
// dragging a Problem onto the root offers exactly "Meta-note"; a plain drag onto it offers
// nothing at all (only a type change can carry a Problem that far up).

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

/** A with-child row's own child: always Hierarchy-typed, attached through *that row's own* rule
 * (a property key matching the parent's real child rule) — the shape whose child a plain retype
 * usually keeps by rewriting it onto the new parent's own rule (`plan-shared.ts`'s
 * `childEdgeChange`). */
function hierarchyChildViaProperty(path: string, property: string, parentBasename: string) {
  return note(path, {
    tags: [HIERARCHY_TAG],
    frontmatter: { [property]: `[[${parentBasename}]]` },
    propertyLinks: { [property]: [`${parentBasename}.md`] },
  });
}

// One note of every type, each in two shapes (leaf, with a child) — plus one target anchor per
// type (never dragged, only ever a `parent` below) and the host/root itself, so the root can be
// its own target column without colliding with a source row. Every note is otherwise isolated: no
// note links or property-references any other except a with-child row's own single child, so
// converting/moving one row can never perturb another (`firstChangedOtherNode`'s whole-structure
// scan would otherwise mistake stray coupling for a real rejection).
const notesList = [
  // Root/host.
  note('root.md', { tags: [CATEGORY_TAG] }),
  // Target anchors.
  note('catTarget.md', { tags: [CATEGORY_TAG] }),
  note('metaTarget.md', { tags: [META_TAG] }),
  note('problemTarget.md', { tags: [PROBLEM_TAG] }),
  note('hierarchyTarget.md', { tags: [HIERARCHY_TAG] }),
  // Category: leaf, and with a Hierarchy child (property "category" — Category's own rule).
  note('catLeaf.md', { tags: [CATEGORY_TAG] }),
  note('catChild.md', { tags: [CATEGORY_TAG] }),
  hierarchyChildViaProperty('catChildKid.md', 'category', 'catChild'),
  // Meta-note: leaf, and with a Hierarchy child (property "meta" — Meta-note's own rule).
  note('metaLeaf.md', { tags: [META_TAG] }),
  note('metaChild.md', { tags: [META_TAG] }),
  hierarchyChildViaProperty('metaChildKid.md', 'meta', 'metaChild'),
  // Problem: leaf, and with a Hierarchy child (property "problem" — Problem's own rule).
  note('problemLeaf.md', { tags: [PROBLEM_TAG] }),
  note('problemChild.md', { tags: [PROBLEM_TAG] }),
  hierarchyChildViaProperty('problemChildKid.md', 'problem', 'problemChild'),
  // Hierarchy: leaf, and with a Hierarchy child via a body link (file.backlinks — Hierarchy's own
  // rule is the schema's one text-only edge).
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

// -- Convert (Shift-drag): shape matters for Category/Meta-note/Problem — a with-child row loses
// "Hierarchy" as an option a same-type leaf keeps, because its existing Hierarchy child is
// attached through a *property* key (its own type's rule) that a retype to "Hierarchy" would have
// to rewrite onto a *body-link* rule (Hierarchy's own child rule is the schema's only non-property
// one) — `plan-shared.ts`'s `childEdgeChange` refuses that rewrite, and nothing else picks it up.
// This is exactly the user's reported case: their real Problem note had its own Hierarchy child,
// so only "Meta-note" ever offered under the root; a bare Problem leaf offers "Meta-note" *and*
// "Hierarchy".
//
// Shape does *not* matter for Hierarchy itself: a with-child Hierarchy row's child is attached
// through a body link, and the schema's `inherit` list happens to name exactly the three property
// keys ("category"/"meta"/"problem") that back every other type's own child rule — so the generic
// `inherit` cascade (`derive.ts`'s `deriveSubtreeWrites`) re-establishes the child under its
// (retyped) parent through whichever of those keys the new type owns, the same way it would for
// any inherited property, regardless of the child's original edge kind.
//
//                        | Category  | Meta-note | Problem | Hierarchy |  Root
// Category (leaf)        | Meta,Hier | Prob,Hier |  Hier   |   Hier    | Meta,Hier
// Category (with child)  |   Meta    |   Prob    |    -    |     -     |   Meta
// Meta-note (leaf)       |   Hier    | Prob,Hier |  Hier   |   Hier    |   Hier
// Meta-note (with child) |    -      |   Prob    |    -    |     -     |    -
// Problem (leaf)         | Meta,Hier |   Hier    |  Hier   |   Hier    | Meta,Hier
// Problem (with child)   |   Meta    |    -      |    -    |     -     |   Meta
// Hierarchy (leaf)       |   Meta    |   Prob    |    -    |     -     |   Meta
// Hierarchy (with child) |   Meta    |   Prob    |    -    |     -     |   Meta
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
    label: 'Category (with child)',
    path: 'catChild.md',
    offered: [['Meta-note'], ['Problem'], [], [], ['Meta-note']],
  },
  {
    label: 'Meta-note (leaf)',
    path: 'metaLeaf.md',
    offered: [['Hierarchy'], ['Problem', 'Hierarchy'], ['Hierarchy'], ['Hierarchy'], ['Hierarchy']],
  },
  {
    label: 'Meta-note (with child)',
    path: 'metaChild.md',
    offered: [[], ['Problem'], [], [], []],
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
    label: 'Problem (with child)',
    path: 'problemChild.md',
    offered: [['Meta-note'], [], [], [], ['Meta-note']],
  },
  {
    label: 'Hierarchy (leaf)',
    path: 'hierarchyLeaf.md',
    offered: [['Meta-note'], ['Problem'], [], [], ['Meta-note']],
  },
  {
    label: 'Hierarchy (with child)',
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

describe('convert (Shift-drag) — every type each (dragged type, target type) pair offers', () => {
  it.each(CONVERT_CASES)(
    '$rowLabel -> $colLabel offers $expected',
    ({ rowPath, colPath, expected }) => {
      expect(convertOptions(context, rowPath, colPath)).toStrictEqual(expected);
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
   * *why* the cell is empty (a rule that doesn't exist at all, or a rule that exists but strands
   * the row's own Hierarchy child; see the two comment blocks in `EMPTY_CONVERT_CASES` below). */
  readonly attempt: string;
}

// Two distinct reasons produce every empty convert cell:
//
// (a) No target column here offers a rule to any type this row could still become (every
//     candidate fails `checkConvertParent`'s own rule lookup) — Hierarchy's leaf/with-child rows
//     under a Problem or Hierarchy target, neither of which has a rule to Meta-note, Category, or
//     (for a non-self type) anything else.
//
// (b) A rule *does* exist, but the row's own Hierarchy child can't survive it — either genuinely
//     orphaned ("would have no parent", when converting under a target whose own rule to the new
//     type is itself a body link, so nothing ever gives the child a new property to resolve
//     through), or, more surprisingly, reassigned somewhere else entirely ("would move to <X>"):
//     converting under a *property*-typed target writes that same property name onto the
//     converted row itself, and — since the child's own stranded key was excluded from the
//     generic `inherit` cascade for being "its own edge property" — an *unrelated* inherit key the
//     cascade does still recompute for it can collide with that same property name and pick up
//     the row's own new value instead, landing the child on the target rather than its real
//     parent.
const EMPTY_CONVERT_CASES: readonly EmptyConvertCase[] = [
  // Category (with child): converting to "Hierarchy" under Problem writes "problem" onto catChild
  // itself, which collides with catChildKid's own (excluded-from-rewrite) recompute of "problem"
  // — (b), "would move to problemTarget". Under Hierarchy, catChild's own new edge is a body link
  // (no property write at all), so nothing rescues or misdirects catChildKid — (b), orphaned.
  {
    node: 'catChild.md',
    parent: 'problemTarget.md',
    attempt: 'Hierarchy',
    reason: '"catChild" cannot become "Hierarchy": "catChildKid" would move to "problemTarget"',
  },
  {
    node: 'catChild.md',
    parent: 'hierarchyTarget.md',
    attempt: 'Hierarchy',
    reason: '"catChild" cannot become "Hierarchy": "catChildKid" would have no parent',
  },
  // Meta-note (with child): same shape, over every target whose own rule to "Hierarchy" exists.
  {
    node: 'metaChild.md',
    parent: 'catTarget.md',
    attempt: 'Hierarchy',
    reason: '"metaChild" cannot become "Hierarchy": "metaChildKid" would move to "catTarget"',
  },
  {
    node: 'metaChild.md',
    parent: 'problemTarget.md',
    attempt: 'Hierarchy',
    reason: '"metaChild" cannot become "Hierarchy": "metaChildKid" would move to "problemTarget"',
  },
  {
    node: 'metaChild.md',
    parent: 'hierarchyTarget.md',
    attempt: 'Hierarchy',
    reason: '"metaChild" cannot become "Hierarchy": "metaChildKid" would have no parent',
  },
  {
    node: 'metaChild.md',
    parent: 'root.md',
    attempt: 'Hierarchy',
    reason: '"metaChild" cannot become "Hierarchy": "metaChildKid" would move to "root"',
  },
  // Problem (with child): same shape again.
  {
    node: 'problemChild.md',
    parent: 'metaTarget.md',
    attempt: 'Hierarchy',
    reason:
      '"problemChild" cannot become "Hierarchy": "problemChildKid" would move to "metaTarget"',
  },
  {
    node: 'problemChild.md',
    parent: 'problemTarget.md',
    attempt: 'Hierarchy',
    reason: '"problemChild" cannot become "Hierarchy": "problemChildKid" would have no parent',
  },
  {
    node: 'problemChild.md',
    parent: 'hierarchyTarget.md',
    attempt: 'Hierarchy',
    reason: '"problemChild" cannot become "Hierarchy": "problemChildKid" would have no parent',
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
  it('Shift-dragging a Problem (with its own Hierarchy child) onto the root Category offers exactly "Meta-note"', () => {
    expect(convertOptions(context, 'problemChild.md', 'root.md')).toStrictEqual(['Meta-note']);
  });

  it('a plain drag (no Shift) of the same Problem onto the root Category is not offered at all', () => {
    expect(moveTargets(schema, structure, 'problemChild.md').has('root.md')).toBe(false);
  });

  it('a bare Problem leaf (no child) offers both "Meta-note" and "Hierarchy" onto the same root — the with-child shape is what narrows it to one', () => {
    expect(convertOptions(context, 'problemLeaf.md', 'root.md')).toStrictEqual([
      'Meta-note',
      'Hierarchy',
    ]);
  });
});
