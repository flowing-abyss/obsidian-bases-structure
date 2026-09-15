import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT_OPTIONS,
  layoutTree,
  type LayoutInput,
  type LayoutOptions,
  type Size,
} from './layout.js';

// Small, round numbers throughout so the geometry can be hand-checked from the algorithm in
// task-7-decisions.md: gapFor(0) = rowGap + 2 * groupPadding = 4 + 4 = 8; gapFor(depth >= 1) =
// rowGap = 4.
const opts: LayoutOptions = { columnGap: 10, rowGap: 4, groupPadding: 2, topGap: 8 };

interface NodeSpec {
  readonly children?: readonly string[];
  readonly size?: Size;
}

type TreeSpec = Readonly<Record<string, NodeSpec>>;

/** Builds a `LayoutInput` from a plain path -> {children, size} map; a path missing from `spec`
 * (or missing a field) has no children / a 10x10 default size. */
function treeInput(
  tops: readonly string[],
  spec: TreeSpec,
  collapsed: readonly string[] = [],
): LayoutInput {
  return {
    tops,
    childrenOf: (path) => spec[path]?.children ?? [],
    sizeOf: (path) => spec[path]?.size ?? { width: 10, height: 10 },
    collapsed: new Set(collapsed),
  };
}

describe('layoutTree — empty and single node', () => {
  it('returns empty boxes/groups and zero width/height for no tops', () => {
    const result = layoutTree(treeInput([], {}), opts);

    expect(result.boxes.size).toBe(0);
    expect(result.groups).toStrictEqual([]);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });

  it('places a single node at the origin', () => {
    const input = treeInput(['a'], { a: { size: { width: 50, height: 20 } } });

    const result = layoutTree(input, opts);

    expect(result.boxes.get('a')).toStrictEqual({ x: 0, y: 0, width: 50, height: 20 });
    expect(result.groups).toStrictEqual([]);
    expect(result.width).toBe(50);
    expect(result.height).toBe(20);
  });
});

describe('layoutTree — vertical centring', () => {
  it('centres a parent on two children of different heights', () => {
    const input = treeInput(['p'], {
      p: { children: ['c1', 'c2'], size: { width: 40, height: 20 } },
      c1: { size: { width: 30, height: 10 } },
      c2: { size: { width: 30, height: 30 } },
    });

    const result = layoutTree(input, opts);

    expect(result.boxes.get('p')).toStrictEqual({ x: 0, y: 14, width: 40, height: 20 });
    expect(result.boxes.get('c1')).toStrictEqual({ x: 50, y: 0, width: 30, height: 10 });
    expect(result.boxes.get('c2')).toStrictEqual({ x: 50, y: 18, width: 30, height: 30 });
    expect(result.groups).toStrictEqual([]);
    expect(result.width).toBe(80);
    expect(result.height).toBe(48);
  });

  it('centres the children block on a parent taller than it', () => {
    const input = treeInput(['p'], {
      p: { children: ['c1', 'c2'], size: { width: 40, height: 60 } },
      c1: { size: { width: 20, height: 10 } },
      c2: { size: { width: 20, height: 10 } },
    });

    const result = layoutTree(input, opts);

    expect(result.boxes.get('p')).toStrictEqual({ x: 0, y: 0, width: 40, height: 60 });
    expect(result.boxes.get('c1')).toStrictEqual({ x: 50, y: 16, width: 20, height: 10 });
    expect(result.boxes.get('c2')).toStrictEqual({ x: 50, y: 34, width: 20, height: 10 });
    expect(result.width).toBe(70);
    expect(result.height).toBe(60);
  });
});

describe('layoutTree — columns', () => {
  it('places a depth column at the widest node of the previous depth, plus columnGap', () => {
    // c2 is the widest depth-1 sibling (50), even though the grandchild g1 hangs off the
    // narrower c1 (20) — depth 2's column x must still be based on the depth-1 max (50).
    const input = treeInput(['p'], {
      p: { children: ['c1', 'c2', 'c3'], size: { width: 15, height: 10 } },
      c1: { children: ['g1'], size: { width: 20, height: 10 } },
      c2: { size: { width: 50, height: 10 } },
      c3: { size: { width: 10, height: 10 } },
      g1: { size: { width: 5, height: 10 } },
    });

    const result = layoutTree(input, opts);

    expect(result.boxes.get('p')?.x).toBe(0);
    expect(result.boxes.get('c1')?.x).toBe(25);
    expect(result.boxes.get('c2')?.x).toBe(25);
    expect(result.boxes.get('c3')?.x).toBe(25);
    expect(result.boxes.get('g1')?.x).toBe(85);
  });
});

describe('layoutTree — collapsed', () => {
  it('keeps a collapsed node but hides its descendants', () => {
    const input = treeInput(
      ['p'],
      {
        p: { children: ['c'], size: { width: 10, height: 10 } },
        c: { children: ['g'], size: { width: 5, height: 5 } },
        g: { size: { width: 3, height: 3 } },
      },
      ['p'],
    );

    const result = layoutTree(input, opts);

    expect(result.boxes.size).toBe(1);
    expect(result.boxes.get('p')).toStrictEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(result.boxes.has('c')).toBe(false);
    expect(result.boxes.has('g')).toBe(false);
    expect(result.groups).toStrictEqual([]);
    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
  });
});

describe('layoutTree — forest', () => {
  it('stacks two tops with topGap between them', () => {
    const input = treeInput(['t1', 't2'], {
      t1: { size: { width: 10, height: 20 } },
      t2: { size: { width: 10, height: 30 } },
    });

    const result = layoutTree(input, opts);

    expect(result.boxes.get('t1')).toStrictEqual({ x: 0, y: 0, width: 10, height: 20 });
    expect(result.boxes.get('t2')).toStrictEqual({ x: 0, y: 28, width: 10, height: 30 });
    expect(result.height).toBe(58);
  });

  it('advances the cursor by the full extent of a top (group frames included), not just its span', () => {
    // t1's own span is 6 (= block(c1), since t1's height 4 is smaller), but c1's group frame
    // extends the *local* vertical extent (boxes and groups, top placed provisionally at 0)
    // to [-2, 8] — a spread of 10, wider than the plain span. Shifting the whole subtree down
    // by 2 (so its minY lands at cursor 0) puts that extent at [0, 10]; the next top starts at
    // 10 + topGap(8) = 18.
    const input = treeInput(['t1', 't2'], {
      t1: { children: ['c1'], size: { width: 10, height: 4 } },
      c1: { children: ['g1'], size: { width: 8, height: 6 } },
      g1: { size: { width: 5, height: 4 } },
      t2: { size: { width: 10, height: 20 } },
    });

    const result = layoutTree(input, opts);

    expect(result.boxes.get('t2')?.y).toBe(18);
    // Every coordinate stays non-negative, even though c1's unshifted group would dip to -2.
    expect(result.boxes.get('t1')?.y).toBeGreaterThanOrEqual(0);
    const group = result.groups.find((g) => g.path === 'c1');
    expect(group?.box.y).toBe(0);
  });

  it('keeps two tops exactly topGap apart, with no negative group y, when groupPadding > topGap', () => {
    const bigPaddingOpts: LayoutOptions = { columnGap: 10, rowGap: 4, groupPadding: 20, topGap: 4 };
    const input = treeInput(['t1', 't2'], {
      t1: { children: ['c1'], size: { width: 10, height: 4 } },
      c1: { children: ['g1'], size: { width: 8, height: 6 } },
      g1: { size: { width: 5, height: 4 } },
      t2: { children: ['c2'], size: { width: 10, height: 4 } },
      c2: { children: ['g2'], size: { width: 8, height: 6 } },
      g2: { size: { width: 5, height: 4 } },
    });

    const result = layoutTree(input, bigPaddingOpts);

    const groupC1 = result.groups.find((g) => g.path === 'c1');
    const groupC2 = result.groups.find((g) => g.path === 'c2');
    expect(groupC1).toStrictEqual({ path: 'c1', box: { x: 0, y: 0, width: 63, height: 46 } });
    expect(groupC2).toStrictEqual({ path: 'c2', box: { x: 0, y: 50, width: 63, height: 46 } });
    // Neither frame dips below y 0...
    expect(groupC1?.box.y).toBeGreaterThanOrEqual(0);
    expect(groupC2?.box.y).toBeGreaterThanOrEqual(0);
    // ...and they're exactly topGap apart, not overlapping despite groupPadding(20) > topGap(4).
    const gap = (groupC2?.box.y ?? 0) - ((groupC1?.box.y ?? 0) + (groupC1?.box.height ?? 0));
    expect(gap).toBe(bigPaddingOpts.topGap);
  });
});

describe('layoutTree — groups', () => {
  it('separates depth-1 siblings by rowGap + 2*groupPadding and keeps their group boxes apart', () => {
    const input = treeInput(['r'], {
      r: { children: ['a', 'b'], size: { width: 10, height: 10 } },
      a: { children: ['a1'], size: { width: 30, height: 10 } },
      a1: { size: { width: 20, height: 10 } },
      b: { children: ['b1'], size: { width: 30, height: 10 } },
      b1: { size: { width: 20, height: 10 } },
    });

    const result = layoutTree(input, opts);

    // r's own subtree has a negative local minY (a's group dips to -2 before shifting), so the
    // whole top shifts down by 2 to keep every coordinate >= 0 — a and b (and their groups)
    // land 2 lower than their pre-shift positions.
    expect(result.boxes.get('a')).toStrictEqual({ x: 20, y: 2, width: 30, height: 10 });
    expect(result.boxes.get('b')).toStrictEqual({ x: 20, y: 20, width: 30, height: 10 });
    expect(result.groups).toStrictEqual([
      { path: 'a', box: { x: 18, y: 0, width: 64, height: 14 } },
      { path: 'b', box: { x: 18, y: 18, width: 64, height: 14 } },
    ]);
    // The group frames themselves don't overlap: b's group starts below a's group ends.
    const [groupA, groupB] = result.groups;
    expect(groupB?.box.y).toBeGreaterThanOrEqual((groupA?.box.y ?? 0) + (groupA?.box.height ?? 0));
  });

  it('only produces a group for a depth-1 node that has at least one visible child', () => {
    const input = treeInput(['r'], {
      r: { children: ['a', 'b'], size: { width: 10, height: 10 } },
      a: { size: { width: 10, height: 10 } },
      b: { children: ['b1'], size: { width: 10, height: 10 } },
      b1: { size: { width: 10, height: 10 } },
    });

    const result = layoutTree(input, opts);

    expect(result.groups).toStrictEqual([
      { path: 'b', box: { x: 18, y: 16, width: 34, height: 14 } },
    ]);
  });

  it('includes group frames when computing width/height', () => {
    const input = treeInput(['r'], {
      r: { children: ['a'], size: { width: 10, height: 10 } },
      a: { children: ['a1'], size: { width: 20, height: 10 } },
      a1: { size: { width: 15, height: 10 } },
    });

    const result = layoutTree(input, opts);

    // Plain node boxes alone would give width 65 (a1 at x 50 + width 15); the group frame
    // around a/a1 extends it to 67. Vertically, the group's local extent ([-2, 12], a spread
    // of 14) is wider than the plain boxes' ([0, 10]); after r's subtree shifts down by 2 (so
    // its minY lands at 0), the tallest edge — the group's bottom — sits at 14.
    expect(result.width).toBe(67);
    expect(result.height).toBe(14);
  });
});

describe('layoutTree — repeated paths', () => {
  it('assigns a shared child to only the first parent that reaches it', () => {
    const input = treeInput(['r'], {
      r: { children: ['a', 'b'], size: { width: 10, height: 10 } },
      a: { children: ['c'], size: { width: 10, height: 10 } },
      b: { children: ['c'], size: { width: 10, height: 10 } },
      c: { size: { width: 10, height: 6 } },
    });

    const result = layoutTree(input, opts);

    expect(result.boxes.size).toBe(4);
    // r's subtree has a negative local minY (a's group dips to -2 before shifting), so the
    // whole top shifts down by 2 to keep every coordinate >= 0.
    expect(result.boxes.get('a')).toStrictEqual({ x: 20, y: 2, width: 10, height: 10 });
    expect(result.boxes.get('c')).toStrictEqual({ x: 40, y: 4, width: 10, height: 6 });
    expect(result.boxes.get('b')).toStrictEqual({ x: 20, y: 20, width: 10, height: 10 });
    // b's claim on c was ignored (c already visited via a), so b ends up with no visible
    // children and therefore no group.
    expect(result.groups).toStrictEqual([
      { path: 'a', box: { x: 18, y: 0, width: 34, height: 14 } },
    ]);
  });

  it('ignores a duplicate top instead of laying it out twice', () => {
    const input = treeInput(['x', 'x'], { x: { size: { width: 10, height: 10 } } });

    const result = layoutTree(input, opts);

    expect(result.boxes.size).toBe(1);
    expect(result.boxes.get('x')).toStrictEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
  });
});

describe('DEFAULT_LAYOUT_OPTIONS', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_LAYOUT_OPTIONS).toStrictEqual({
      columnGap: 72,
      rowGap: 12,
      groupPadding: 12,
      topGap: 32,
    });
  });
});
