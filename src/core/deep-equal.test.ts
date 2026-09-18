import { describe, expect, it } from 'vitest';
import { deepEqual } from './deep-equal.js';

describe('deepEqual', () => {
  it('treats identical primitives as equal', () => {
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
  });

  it('treats different primitives as unequal', () => {
    expect(deepEqual('a', 'b')).toBe(false);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it('compares arrays order-sensitively', () => {
    expect(deepEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(deepEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(deepEqual(['a'], ['a', 'b'])).toBe(false);
  });

  it('treats a value that is only an array on one side as unequal', () => {
    expect(deepEqual(['a'], 'a')).toBe(false);
    expect(deepEqual('a', ['a'])).toBe(false);
  });

  it('compares plain objects regardless of key order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('recurses into nested arrays/objects', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
  });

  it('treats a plain object compared against a non-object as unequal', () => {
    expect(deepEqual({ a: 1 }, 'a')).toBe(false);
    expect(deepEqual({ a: 1 }, null)).toBe(false);
  });
});
