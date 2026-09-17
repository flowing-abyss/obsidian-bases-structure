// Pure edge geometry for the graph renderer: the anchor points a parent→child (or extra) edge
// connects, and the cubic-bezier SVG path string between them. No DOM, no Obsidian imports.

import type { DiagnosticKind } from '../core/diagnostics.js';
import type { Box } from '../core/layout.js';
import type { Direction } from '../core/schema.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface EdgeAnchors {
  readonly start: Point;
  readonly end: Point;
}

const MIN_CONTROL_OFFSET = 24;

/** `direction: 'right'` anchors at the right-edge centre of `from` and the left-edge centre of
 * `to`; `direction: 'down'` anchors at the bottom-edge centre of `from` and the top-edge centre
 * of `to` — the points every edge (regular or extra, forward or back) is drawn between, matching
 * whichever axis `Schema.direction` grows the tree along. */
export function edgeAnchors(from: Box, to: Box, direction: Direction): EdgeAnchors {
  if (direction === 'down') {
    return {
      start: { x: from.x + from.width / 2, y: from.y + from.height },
      end: { x: to.x + to.width / 2, y: to.y },
    };
  }
  return {
    start: { x: from.x + from.width, y: from.y + from.height / 2 },
    end: { x: to.x, y: to.y + to.height / 2 },
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function horizontalPath(start: Point, end: Point): string {
  const dx =
    end.x < start.x ? MIN_CONTROL_OFFSET : Math.max(MIN_CONTROL_OFFSET, (end.x - start.x) / 2);
  const x1 = round2(start.x);
  const y1 = round2(start.y);
  const x2 = round2(end.x);
  const y2 = round2(end.y);
  const c1x = round2(start.x + dx);
  const c2x = round2(end.x - dx);
  return `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`;
}

/** Mirrors `horizontalPath` along the vertical axis: `dy` is half the vertical gap (never less
 * than `MIN_CONTROL_OFFSET`) — `Math.max` alone (no separate back-edge branch) already clamps a
 * negative gap (a "back edge", where `to` sits above `from`) to the minimum. */
function verticalPath(start: Point, end: Point): string {
  const dy = Math.max(MIN_CONTROL_OFFSET, (end.y - start.y) / 2);
  const x1 = round2(start.x);
  const y1 = round2(start.y);
  const x2 = round2(end.x);
  const y2 = round2(end.y);
  const c1y = round2(start.y + dy);
  const c2y = round2(end.y - dy);
  return `M ${x1} ${y1} C ${x1} ${c1y}, ${x2} ${c2y}, ${x2} ${y2}`;
}

/** A cubic bezier between the two boxes' anchors, along whichever axis `direction` grows the tree
 * — horizontal for `'right'` (dx is half the horizontal gap, clamped for a back edge), vertical
 * for `'down'` (dy is half the vertical gap, same clamp). Every coordinate is rounded to 2
 * decimals before being written into the path string. */
export function edgePath(from: Box, to: Box, direction: Direction): string {
  const { start, end } = edgeAnchors(from, to, direction);
  return direction === 'down' ? verticalPath(start, end) : horizontalPath(start, end);
}

export type DiagnosticSeverity = 'is-error' | 'is-warning';

/** The edge/marker class a diagnostic's own kind draws — `null` for a kind that never anchors an
 * edge at all (`untyped` is a note-only problem, with no link of its own to mark).
 * `illegal-parent`/`broken-link` are definite rule violations (error); `inherit-mismatch` is a
 * softer drift (warning) on an edge that's otherwise perfectly legal. */
export function diagnosticEdgeSeverity(kind: DiagnosticKind): DiagnosticSeverity | null {
  switch (kind) {
    case 'illegal-parent':
    case 'broken-link':
      return 'is-error';
    case 'inherit-mismatch':
      return 'is-warning';
    case 'untyped':
      return null;
  }
}

const STUB_LENGTH = 28;

/** A short "leads nowhere" edge from `from`'s own tree-edge anchor, extending `STUB_LENGTH`
 * further along whichever axis `direction` grows — for a diagnostic (`illegal-parent`/
 * `broken-link`) whose `target` isn't a currently rendered node, so there is no second box for a
 * real connecting edge. */
export function stubEdge(from: Box, direction: Direction): EdgeAnchors {
  const start =
    direction === 'down'
      ? { x: from.x + from.width / 2, y: from.y + from.height }
      : { x: from.x + from.width, y: from.y + from.height / 2 };
  const end =
    direction === 'down'
      ? { x: start.x, y: start.y + STUB_LENGTH }
      : { x: start.x + STUB_LENGTH, y: start.y };
  return { start, end };
}

/** A plain straight line between two points, rounded to 2 decimals like every other path here —
 * a stub edge has nothing to curve toward, so it skips `horizontalPath`/`verticalPath`'s bezier
 * control points entirely. */
export function straightPath(start: Point, end: Point): string {
  return `M ${round2(start.x)} ${round2(start.y)} L ${round2(end.x)} ${round2(end.y)}`;
}

/** The point midway between a pair of anchors — where a diagnostic's own mid-edge marker sits,
 * whether the anchors came from a real connecting edge, a stub, or an existing tree edge. */
export function edgeMidpoint(anchors: EdgeAnchors): Point {
  return { x: (anchors.start.x + anchors.end.x) / 2, y: (anchors.start.y + anchors.end.y) / 2 };
}

/** D2: one child, as seen by `planEdgeLabels` — a run only cares about a child's own type, never
 * whether it's a tree edge or an extra (callers only ever pass a parent's own tree children, in
 * children order; extras have no run of their own). */
export interface EdgeLabelChild {
  readonly path: string;
  readonly type: string | null;
}

/** D2: one label to draw, anchored to the tree edge leading to `childPath` — the run's own
 * middle child, not necessarily the run's first or last one. */
export interface EdgeLabel {
  readonly childPath: string;
  readonly text: string;
}

/** The end (exclusive) of the run of same-type children starting at `start`. */
function runEnd(children: readonly EdgeLabelChild[], start: number): number {
  const type = children[start]?.type;
  let end = start + 1;
  while (end < children.length && children[end]?.type === type) {
    end += 1;
  }
  return end;
}

/** Appends a label for the run `[start, end)`, unless its type is untyped (`null`/`''`, the
 * implicit type) — those never get a label. */
function pushRunLabel(
  labels: EdgeLabel[],
  children: readonly EdgeLabelChild[],
  start: number,
  end: number,
): void {
  const type = children[start]?.type;
  if (type === null || type === undefined || type === '') {
    return;
  }
  const middle = children[start + Math.floor((end - start - 1) / 2)];
  if (middle !== undefined) {
    labels.push({ childPath: middle.path, text: type });
  }
}

/** D2: one label per run of consecutive same-type children (in the given, already-children-order
 * list), placed on the middle edge of that run (index `floor((n - 1) / 2)` within the run). A run
 * of the implicit, untyped (`null`/`''`) type never gets a label. Callers pass only a parent's own
 * visible *tree* children — extras (secondary parent candidates, drawn as dashed edges) and
 * two-way children never belong in this list, so they can never end up hosting a label either. */
export function planEdgeLabels(children: readonly EdgeLabelChild[]): EdgeLabel[] {
  const labels: EdgeLabel[] = [];
  let start = 0;
  while (start < children.length) {
    const end = runEnd(children, start);
    pushRunLabel(labels, children, start, end);
    start = end;
  }
  return labels;
}
