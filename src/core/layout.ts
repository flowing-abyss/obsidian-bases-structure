// Pure left-to-right tidy tree layout: positions every visible node into an (x, y, width,
// height) box, columns nodes by depth (the widest node of a depth sets that column's width), and
// computes group frames around depth-1 subtrees that have visible children. No DOM, no Obsidian
// imports — a later view feeds this `Structure.tops` and each node's children, with sizes
// measured from the real DOM.

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutInput {
  readonly tops: readonly string[];
  readonly childrenOf: (path: string) => readonly string[];
  readonly sizeOf: (path: string) => Size;
  readonly collapsed: ReadonlySet<string>; // children of these paths are not laid out
}

export interface LayoutOptions {
  readonly columnGap: number; // horizontal gap between depth columns
  readonly rowGap: number; // vertical gap between siblings
  readonly groupPadding: number; // padding of group frames
  readonly topGap: number; // vertical gap between forest tops
}

export interface LayoutGroup {
  readonly path: string;
  readonly box: Box;
}

export interface LayoutResult {
  readonly boxes: ReadonlyMap<string, Box>; // every visible node
  readonly groups: readonly LayoutGroup[]; // in visit order
  readonly width: number; // max (x + width) over boxes and groups, 0 when empty
  readonly height: number; // max (y + height) over boxes and groups, 0 when empty
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  columnGap: 72,
  rowGap: 12,
  groupPadding: 12,
  topGap: 32,
};

/** A visible node, as discovered by `collectVisible`: `depth` and `children` are fixed at
 * construction (`children` only ever grows during that same walk); `x` starts at a placeholder
 * and is filled in by `computeColumns` before anything reads it. */
interface VisibleNode {
  readonly path: string;
  readonly depth: number;
  readonly children: VisibleNode[];
  x: number;
}

interface VisibleForest {
  readonly topOrder: readonly VisibleNode[];
  readonly visitOrder: readonly VisibleNode[];
}

interface ForestBuilder {
  readonly input: LayoutInput;
  readonly visited: Set<string>;
  readonly visitOrder: VisibleNode[];
}

/** Depth-first from `path`: records it as visited before recursing (so a cycle back to an
 * in-progress node is also caught) and skips a child already in `builder.visited` — a later
 * occurrence of an already-visited path, whether a duplicate sibling or a second parent claiming
 * the same child, is silently dropped. A collapsed node stops here, keeping itself but not
 * queuing its children at all. */
function visit(builder: ForestBuilder, path: string, depth: number): VisibleNode {
  const node: VisibleNode = { path, depth, children: [], x: 0 };
  builder.visited.add(path);
  builder.visitOrder.push(node);
  if (builder.input.collapsed.has(path)) {
    return node;
  }
  for (const kid of builder.input.childrenOf(path)) {
    if (builder.visited.has(kid)) {
      continue;
    }
    node.children.push(visit(builder, kid, depth + 1));
  }
  return node;
}

/** The visible forest: every top not already visited (a duplicate top is dropped the same way a
 * duplicate descendant is), each walked depth-first via `visit`. */
function collectVisible(input: LayoutInput): VisibleForest {
  const builder: ForestBuilder = { input, visited: new Set<string>(), visitOrder: [] };
  const topOrder: VisibleNode[] = [];
  for (const top of input.tops) {
    if (builder.visited.has(top)) {
      continue;
    }
    topOrder.push(visit(builder, top, 0));
  }
  return { topOrder, visitOrder: builder.visitOrder };
}

/** Groups visible nodes into depth columns (each column's width is the widest node in it), then
 * assigns each node's `x` as the running sum of every previous column's width plus `columnGap` —
 * `x[0] = 0`, `x[d] = x[d-1] + columnWidth[d-1] + columnGap`. Depths are contiguous from 0 (a
 * node's depth is always its parent's depth + 1), so no column is ever empty. */
function computeColumns(
  visitOrder: readonly VisibleNode[],
  input: LayoutInput,
  columnGap: number,
): void {
  const columns: VisibleNode[][] = [];
  for (const node of visitOrder) {
    const existing = columns[node.depth];
    if (existing === undefined) {
      columns[node.depth] = [node];
    } else {
      existing.push(node);
    }
  }
  let x = 0;
  for (const column of columns) {
    let width = 0;
    for (const node of column) {
      width = Math.max(width, input.sizeOf(node.path).width);
    }
    for (const node of column) {
      node.x = x;
    }
    x += width + columnGap;
  }
}

/** The sibling gap below a node at `parentDepth`: children of a depth-0 node get the wider gap
 * so depth-1 group frames (padded on every side) never touch each other; every deeper level uses
 * the plain row gap. */
function gapFor(parentDepth: number, options: LayoutOptions): number {
  return parentDepth === 0 ? options.rowGap + 2 * options.groupPadding : options.rowGap;
}

interface LayoutState {
  readonly input: LayoutInput;
  readonly options: LayoutOptions;
  readonly span: Map<string, number>;
  readonly block: Map<string, number>;
  readonly boxes: Map<string, Box>;
  readonly groups: LayoutGroup[];
}

/** `block(n)` = sum of `span(child)` over n's visible children, plus `gapFor(depth(n))` between
 * consecutive children (0 with no visible children). */
function blockOf(state: LayoutState, node: VisibleNode): number {
  const cached = state.block.get(node.path);
  if (cached !== undefined) {
    return cached;
  }
  const gap = gapFor(node.depth, state.options);
  let total = 0;
  for (const [index, kid] of node.children.entries()) {
    total += spanOf(state, kid);
    if (index < node.children.length - 1) {
      total += gap;
    }
  }
  state.block.set(node.path, total);
  return total;
}

/** `span(n)` = `max(height(n), block(n))` — the vertical room `n` and its visible descendants
 * actually occupy. */
function spanOf(state: LayoutState, node: VisibleNode): number {
  const cached = state.span.get(node.path);
  if (cached !== undefined) {
    return cached;
  }
  const height = state.input.sizeOf(node.path).height;
  const value = Math.max(height, blockOf(state, node));
  state.span.set(node.path, value);
  return value;
}

function pushGroup(state: LayoutState, node: VisibleNode, bounds: Box): void {
  const padding = state.options.groupPadding;
  state.groups.push({
    path: node.path,
    box: {
      x: bounds.x - padding,
      y: bounds.y - padding,
      width: bounds.width + 2 * padding,
      height: bounds.height + 2 * padding,
    },
  });
}

/** Places `node` (and, recursively, its visible children) with its span-block starting at `top`,
 * records its box, and returns the bounding box of `node` plus all of its visible descendants —
 * used to centre a node on its children (or vice versa) at the parent's own placement. When
 * `node` is depth 1 and has visible children, that bounding box also becomes a group frame
 * (pushed here, in the same depth-first order as `visitOrder`, since a depth-1 node can never be
 * nested inside another one). */
function place(state: LayoutState, node: VisibleNode, top: number): Box {
  const size = state.input.sizeOf(node.path);
  const span = spanOf(state, node);
  const y = top + (span - size.height) / 2;
  const ownBox: Box = { x: node.x, y, width: size.width, height: size.height };
  state.boxes.set(node.path, ownBox);
  if (node.children.length === 0) {
    return ownBox;
  }
  const block = blockOf(state, node);
  const gap = gapFor(node.depth, state.options);
  let cursor = top + (span - block) / 2;
  let minX = ownBox.x;
  let minY = ownBox.y;
  let maxX = ownBox.x + ownBox.width;
  let maxY = ownBox.y + ownBox.height;
  for (const kid of node.children) {
    const kidBounds = place(state, kid, cursor);
    minX = Math.min(minX, kidBounds.x);
    minY = Math.min(minY, kidBounds.y);
    maxX = Math.max(maxX, kidBounds.x + kidBounds.width);
    maxY = Math.max(maxY, kidBounds.y + kidBounds.height);
    cursor += spanOf(state, kid) + gap;
  }
  const bounds: Box = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  if (node.depth === 1) {
    pushGroup(state, node, bounds);
  }
  return bounds;
}

interface VerticalExtent {
  readonly minY: number;
  readonly maxY: number;
}

/** The vertical reach of a set of boxes and groups — a group frame can extend above or below
 * every plain node box in the same subtree (that's the whole reason it needs measuring
 * separately rather than trusting `span`/`block`, which only ever account for node boxes). */
function verticalExtentOf(
  boxes: ReadonlyMap<string, Box>,
  groups: readonly LayoutGroup[],
): VerticalExtent {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const box of boxes.values()) {
    minY = Math.min(minY, box.y);
    maxY = Math.max(maxY, box.y + box.height);
  }
  for (const group of groups) {
    minY = Math.min(minY, group.box.y);
    maxY = Math.max(maxY, group.box.y + group.box.height);
  }
  return { minY, maxY };
}

/** Copies a provisionally-placed top's boxes and groups into the real result, shifting every y
 * coordinate by `shift` (x is untouched — the shift is purely vertical). */
function mergeShifted(state: LayoutState, local: LayoutState, shift: number): void {
  for (const [path, box] of local.boxes) {
    state.boxes.set(path, { ...box, y: box.y + shift });
  }
  for (const group of local.groups) {
    state.groups.push({ path: group.path, box: { ...group.box, y: group.box.y + shift } });
  }
}

/** Places every top's whole subtree provisionally at its own `top = 0` (into a scratch state so
 * one top's boxes/groups can be measured and shifted without disturbing another top's), measures
 * its real vertical extent — boxes *and* group frames — then shifts the entire subtree so that
 * extent's top edge lands at `cursor`. The next top's `cursor` is the shifted extent's bottom
 * edge plus `topGap`: every coordinate ends up >= 0, and the vertical clearance between adjacent
 * trees (frames included) is always exactly `topGap`, regardless of `groupPadding`. */
function placeAllTops(state: LayoutState, forest: VisibleForest): void {
  let cursor = 0;
  for (const top of forest.topOrder) {
    const local: LayoutState = {
      input: state.input,
      options: state.options,
      span: state.span,
      block: state.block,
      boxes: new Map<string, Box>(),
      groups: [],
    };
    place(local, top, 0);
    const extent = verticalExtentOf(local.boxes, local.groups);
    const shift = cursor - extent.minY;
    mergeShifted(state, local, shift);
    cursor = extent.maxY + shift + state.options.topGap;
  }
}

function computeExtent(state: LayoutState): Size {
  let width = 0;
  let height = 0;
  for (const box of state.boxes.values()) {
    width = Math.max(width, box.x + box.width);
    height = Math.max(height, box.y + box.height);
  }
  for (const group of state.groups) {
    width = Math.max(width, group.box.x + group.box.width);
    height = Math.max(height, group.box.y + group.box.height);
  }
  return { width, height };
}

export function layoutTree(input: LayoutInput, options: LayoutOptions): LayoutResult {
  const forest = collectVisible(input);
  computeColumns(forest.visitOrder, input, options.columnGap);
  const state: LayoutState = {
    input,
    options,
    span: new Map<string, number>(),
    block: new Map<string, number>(),
    boxes: new Map<string, Box>(),
    groups: [],
  };
  placeAllTops(state, forest);
  const extent = computeExtent(state);
  return { boxes: state.boxes, groups: state.groups, width: extent.width, height: extent.height };
}
