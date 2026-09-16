// Pure edge geometry for the graph renderer: the anchor points a parent→child (or extra) edge
// connects, and the cubic-bezier SVG path string between them. No DOM, no Obsidian imports.

import type { Box } from '../core/layout.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface EdgeAnchors {
  readonly start: Point;
  readonly end: Point;
}

const MIN_CONTROL_OFFSET = 24;

/** `start` is the right-edge centre of `from`; `end` is the left-edge centre of `to` — the
 * points every edge (regular or extra, forward or back) is drawn between. */
export function edgeAnchors(from: Box, to: Box): EdgeAnchors {
  return {
    start: { x: from.x + from.width, y: from.y + from.height / 2 },
    end: { x: to.x, y: to.y + to.height / 2 },
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A horizontal cubic bezier between the two boxes' anchors: `dx` is half the horizontal gap
 * (never less than `MIN_CONTROL_OFFSET`), except a "back edge" — where `to` sits to the left of
 * `from` — always uses the minimum, since half the (negative) gap would pull the curve the wrong
 * way. Every coordinate is rounded to 2 decimals before being written into the path string. */
export function edgePath(from: Box, to: Box): string {
  const { start, end } = edgeAnchors(from, to);
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
