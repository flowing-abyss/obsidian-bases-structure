import { App } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it } from 'vitest';
import { applyLinksWrite, applyListItemWrite, linkLine } from './link-writer.js';

function createApp(): App {
  return App.createConfigured__({
    files: {
      'notes/target.md': '',
      'other.md': '',
      'A.md': '',
      'Ext.md': '',
      'M2.md': '',
    },
  });
}

interface FreshCase {
  readonly description: string;
  readonly add: readonly string[];
  readonly list: boolean;
  readonly expected: unknown;
}

describe('applyLinksWrite — building a fresh value (no current content)', () => {
  it.each<FreshCase>([
    {
      description: 'a list of targets, one wikilink per target, in order',
      add: ['notes/target.md', 'other.md'],
      list: true,
      expected: ['[[target]]', '[[other]]'],
    },
    {
      description: 'a single scalar target',
      add: ['notes/target.md'],
      list: false,
      expected: '[[target]]',
    },
    {
      description: 'a scalar target that does not exist yet, falling back to its basename',
      add: ['new/created.md'],
      list: false,
      expected: '[[created]]',
    },
    {
      description: 'a scalar target with no .md extension, falling back to it as-is',
      add: ['no-extension'],
      list: false,
      expected: '[[no-extension]]',
    },
  ])('renders $description', ({ add, list, expected }) => {
    const app = createApp();
    const frontmatter: Record<string, unknown> = {};

    applyLinksWrite(app.asOriginalType__(), {
      frontmatter,
      key: 'key',
      value: { kind: 'links', remove: [], add, list },
      sourcePath: 'source.md',
    });

    expect(frontmatter['key']).toStrictEqual(expected);
  });

  it('deletes the key when there is nothing to add (an empty write)', () => {
    const app = createApp();
    const frontmatter: Record<string, unknown> = {};

    applyLinksWrite(app.asOriginalType__(), {
      frontmatter,
      key: 'key',
      value: { kind: 'links', remove: [], add: [], list: true },
      sourcePath: 'source.md',
    });

    expect('key' in frontmatter).toBe(false);
  });
});

describe('applyLinksWrite — patching existing content (C1)', () => {
  it('replaces the old parent in place, preserving an unresolved link, plain text, and a link outside the base exactly as written', () => {
    const app = createApp();
    const frontmatter: Record<string, unknown> = {
      meta: ['[[A]]', '[[Not yet written]]', 'some text', '[[Ext]]'],
    };

    applyLinksWrite(app.asOriginalType__(), {
      frontmatter,
      key: 'meta',
      value: { kind: 'links', remove: ['A.md'], add: ['M2.md'], list: true },
      sourcePath: 'source.md',
    });

    expect(frontmatter['meta']).toStrictEqual([
      '[[M2]]',
      '[[Not yet written]]',
      'some text',
      '[[Ext]]',
    ]);
  });

  it('drops an aliased/headed link when its resolved path is removed, leaving other elements untouched', () => {
    const app = createApp();
    const frontmatter: Record<string, unknown> = { meta: ['[[A|Alias]]', '[[A#Heading]]', 'kept'] };

    applyLinksWrite(app.asOriginalType__(), {
      frontmatter,
      key: 'meta',
      value: { kind: 'links', remove: ['A.md'], add: [], list: true },
      sourcePath: 'source.md',
    });

    expect(frontmatter['meta']).toStrictEqual(['kept']);
  });

  it('turns an existing scalar into a list only once the result holds more than one target (M1)', () => {
    const app = createApp();
    const frontmatter: Record<string, unknown> = { meta: '[[A]]' };

    applyLinksWrite(app.asOriginalType__(), {
      frontmatter,
      key: 'meta',
      value: { kind: 'links', remove: [], add: ['other.md'], list: false },
      sourcePath: 'source.md',
    });

    expect(frontmatter['meta']).toStrictEqual(['[[A]]', '[[other]]']);
  });

  it('deletes the key once the patch leaves nothing behind', () => {
    const app = createApp();
    const frontmatter: Record<string, unknown> = { meta: '[[A]]' };

    applyLinksWrite(app.asOriginalType__(), {
      frontmatter,
      key: 'meta',
      value: { kind: 'links', remove: ['A.md'], add: [], list: false },
      sourcePath: 'source.md',
    });

    expect('meta' in frontmatter).toBe(false);
  });
});

describe('applyListItemWrite', () => {
  it('replaces the old element with the new one at its position, keeping an unrelated element (type: [project, archived] -> task)', () => {
    const frontmatter: Record<string, unknown> = { type: ['project', 'archived'] };

    applyListItemWrite(frontmatter, 'type', { kind: 'listItem', remove: 'project', add: 'task' });

    expect(frontmatter['type']).toStrictEqual(['task', 'archived']);
  });

  it('deletes the key once the patch leaves nothing behind', () => {
    const frontmatter: Record<string, unknown> = { type: ['project'] };

    applyListItemWrite(frontmatter, 'type', { kind: 'listItem', remove: 'project' });

    expect('type' in frontmatter).toBe(false);
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
