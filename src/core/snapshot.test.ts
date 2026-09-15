import { describe, expect, it } from 'vitest';
import { note, snapshot } from './__tests__/notes.js';
import { folderOf, hasTag } from './snapshot.js';

describe('folderOf', () => {
  it('returns the folder for a nested path', () => {
    expect(folderOf('a/b/c.md')).toBe('a/b');
  });

  it('returns "" for a root-level path', () => {
    expect(folderOf('c.md')).toBe('');
  });

  it('returns the immediate folder for a two-segment path', () => {
    expect(folderOf('base/dataview.md')).toBe('base');
  });
});

describe('hasTag', () => {
  it('matches an exact tag, case-insensitively', () => {
    expect(hasTag(note('a.md', { tags: ['System/High'] }), 'system/high')).toBe(true);
  });

  it('matches a nested note tag (type tag is a path prefix of it)', () => {
    expect(hasTag(note('a.md', { tags: ['system/high/meta'] }), 'system/high')).toBe(true);
  });

  it('does not match a tag that only shares a text prefix, not a path segment', () => {
    expect(hasTag(note('a.md', { tags: ['system/higher'] }), 'system/high')).toBe(false);
  });

  it('returns false when the note has no tags', () => {
    expect(hasTag(note('a.md'), 'system/high')).toBe(false);
  });

  it('returns false when no note tag matches', () => {
    expect(hasTag(note('a.md', { tags: ['other'] }), 'system/high')).toBe(false);
  });
});

describe('note() builder', () => {
  it('derives basename from the path and defaults everything else empty', () => {
    const result = note('base/_hierarchy/dataview.md');

    expect(result).toStrictEqual({
      path: 'base/_hierarchy/dataview.md',
      basename: 'dataview',
      tags: [],
      frontmatter: {},
      propertyLinks: {},
      links: [],
    });
  });

  it('lets partial override any derived or defaulted field', () => {
    const result = note('a.md', { basename: 'custom', tags: ['x'], frontmatter: { k: 'v' } });

    expect(result.basename).toBe('custom');
    expect(result.tags).toStrictEqual(['x']);
    expect(result.frontmatter).toStrictEqual({ k: 'v' });
  });
});

describe('snapshot() builder', () => {
  it('defaults results to all note paths in the given order, and host to null', () => {
    const notes = [note('b.md'), note('a.md')];

    const result = snapshot(notes);

    expect(result.results).toStrictEqual(['b.md', 'a.md']);
    expect(result.host).toBeNull();
    expect(result.notes.get('a.md')).toBe(notes[1]);
    expect(result.notes.size).toBe(2);
  });

  it('lets options override results and host', () => {
    const notes = [note('a.md'), note('b.md')];

    const result = snapshot(notes, { results: ['b.md'], host: 'host.md' });

    expect(result.results).toStrictEqual(['b.md']);
    expect(result.host).toBe('host.md');
  });
});
