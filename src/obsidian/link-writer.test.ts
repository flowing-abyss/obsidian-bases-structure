import { App } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it } from 'vitest';
import { linkLine, toFrontmatterValue } from './link-writer.js';

function createApp(): App {
  return App.createConfigured__({
    files: {
      'notes/target.md': '',
      'other.md': '',
    },
  });
}

describe('toFrontmatterValue — links', () => {
  it.each<[string, readonly string[], boolean, unknown]>([
    [
      'a list of targets, one wikilink per target, in order',
      ['notes/target.md', 'other.md'],
      true,
      ['[[target]]', '[[other]]'],
    ],
    ['a single scalar target', ['notes/target.md'], false, '[[target]]'],
    ['an empty scalar as null', [], false, null],
    ['an empty list as an empty array', [], true, []],
    [
      'a scalar target that does not exist yet, falling back to its basename',
      ['new/created.md'],
      false,
      '[[created]]',
    ],
    [
      'a scalar target with no .md extension, falling back to it as-is',
      ['no-extension'],
      false,
      '[[no-extension]]',
    ],
  ])('renders %s', (_description, targets, list, expected) => {
    const app = createApp();

    const value = toFrontmatterValue(
      app.asOriginalType__(),
      { kind: 'links', targets, list },
      'source.md',
    );

    expect(value).toStrictEqual(expected);
  });
});

describe('toFrontmatterValue — literal', () => {
  it('passes literal values through unchanged', () => {
    const app = createApp();

    const value = toFrontmatterValue(
      app.asOriginalType__(),
      { kind: 'literal', value: 'plain text' },
      'source.md',
    );

    expect(value).toBe('plain text');
  });

  it('passes a literal null through unchanged (not the link "no targets" null)', () => {
    const app = createApp();

    const value = toFrontmatterValue(
      app.asOriginalType__(),
      { kind: 'literal', value: null },
      'source.md',
    );

    expect(value).toBeNull();
  });
});

describe('linkLine', () => {
  it('renders a Markdown list item linking to an existing target', () => {
    const app = createApp();

    expect(linkLine(app.asOriginalType__(), 'notes/target.md', 'source.md')).toBe('- [[target]]');
  });

  it('falls back to the bare basename when the target does not exist', () => {
    const app = createApp();

    expect(linkLine(app.asOriginalType__(), 'missing.md', 'source.md')).toBe('- [[missing]]');
  });
});
