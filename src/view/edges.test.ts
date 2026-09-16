import { describe, expect, it } from 'vitest';
import type { Box } from '../core/layout.js';
import type { Point } from './edges.js';
import { edgeAnchors, edgePath } from './edges.js';

const from: Box = { x: 0, y: 0, width: 100, height: 20 };
const to: Box = { x: 200, y: 100, width: 80, height: 40 };

describe('edgeAnchors', () => {
  it('anchors at the right-edge centre of `from` and the left-edge centre of `to`', () => {
    const expectedStart: Point = { x: 100, y: 10 };
    const expectedEnd: Point = { x: 200, y: 120 };

    expect(edgeAnchors(from, to)).toStrictEqual({ start: expectedStart, end: expectedEnd });
  });
});

describe('edgePath', () => {
  it('builds a forward cubic bezier with dx = half the horizontal gap', () => {
    expect(edgePath(from, to)).toBe('M 100 10 C 150 10, 150 120, 200 120');
  });

  it('clamps dx to 24 when the column gap is smaller than 48', () => {
    const close: Box = { x: 110, y: 0, width: 80, height: 20 };
    expect(edgePath(from, close)).toBe('M 100 10 C 124 10, 86 10, 110 10');
  });

  it('uses dx = 24 for a back edge (end.x < start.x)', () => {
    const back: Box = { x: 200, y: 0, width: 100, height: 20 };
    const target: Box = { x: 0, y: 100, width: 80, height: 40 };
    expect(edgePath(back, target)).toBe('M 300 10 C 324 10, -24 120, 0 120');
  });

  it('rounds every coordinate to 2 decimals', () => {
    const frac1: Box = { x: 10.126, y: 5.004, width: 50, height: 10 };
    const frac2: Box = { x: 150.994, y: 20.127, width: 50, height: 10 };
    expect(edgePath(frac1, frac2)).toBe('M 60.13 10 C 105.56 10, 105.56 25.13, 150.99 25.13');
  });
});
