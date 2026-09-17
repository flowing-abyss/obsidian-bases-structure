// Pure edge geometry for the graph renderer: the anchor points a parent→child (or extra) edge
// connects, and the cubic-bezier SVG path string between them. No DOM, no Obsidian imports.

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
