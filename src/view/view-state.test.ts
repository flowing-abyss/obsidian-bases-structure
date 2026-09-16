import { describe, expect, it } from 'vitest';
import { clearUiState, getUiState } from './view-state.js';

describe('getUiState', () => {
  it('returns the default state shape for a new key', () => {
    clearUiState();

    const state = getUiState('a::View');

    expect(state).toStrictEqual({
      collapsed: new Set(),
      zoom: 1,
      zoomTouched: false,
      scrollLeft: 0,
      scrollTop: 0,
      active: null,
    });
  });

  it('returns the same object for the same key across calls', () => {
    clearUiState();

    const first = getUiState('a::View');
    first.zoom = 2;
    first.collapsed.add('a/b.md');
    const second = getUiState('a::View');

    expect(second).toBe(first);
    expect(second.zoom).toBe(2);
    expect(second.collapsed.has('a/b.md')).toBe(true);
  });

  it('returns a different object for a different key', () => {
    clearUiState();

    const first = getUiState('a::View');
    const second = getUiState('b::View');

    expect(second).not.toBe(first);
  });

  it('clearUiState resets every stored key', () => {
    clearUiState();
    const before = getUiState('a::View');
    before.zoom = 3;

    clearUiState();
    const after = getUiState('a::View');

    expect(after).not.toBe(before);
    expect(after.zoom).toBe(1);
  });
});
