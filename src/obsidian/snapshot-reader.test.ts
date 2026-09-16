import type { TFile } from 'obsidian';
import { App } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { readNote, readSnapshot } from './snapshot-reader.js';

function mustFile(app: App, path: string): TFile {
  const file = app.vault.getFileByPath(path);
  if (file === null) {
    throw new Error(`Test setup error: missing file "${path}"`);
  }
  return file.asOriginalType2__();
}

describe('readNote', () => {
  it('reads tags from frontmatter and body, stripping the leading #', () => {
    const app = App.createConfigured__({
      files: {
        'note.md': '---\ntags: [alpha, "#beta"]\n---\nBody with a #gamma tag.\n',
      },
    });

    const note = readNote(app.asOriginalType__(), mustFile(app, 'note.md'));

    // `getAllTags` orders body tags before frontmatter tags.
    expect(note.tags).toStrictEqual(['gamma', 'alpha', 'beta']);
  });

  it('dedupes tags that appear in both frontmatter and body, keeping first-seen order', () => {
    const app = App.createConfigured__({
      files: {
        'note.md': '---\ntags: [gamma]\n---\nBody with a #gamma tag.\n',
      },
    });

    const note = readNote(app.asOriginalType__(), mustFile(app, 'note.md'));

    expect(note.tags).toStrictEqual(['gamma']);
  });

  it('returns an empty tags array when there are none', () => {
    const app = App.createConfigured__({ files: { 'note.md': 'Just a body.\n' } });

    const note = readNote(app.asOriginalType__(), mustFile(app, 'note.md'));

    expect(note.tags).toStrictEqual([]);
  });

  it('copies frontmatter without the position key', () => {
    const app = App.createConfigured__({
      files: { 'note.md': '---\nstatus: active\ncount: 3\n---\nBody\n' },
    });

    const note = readNote(app.asOriginalType__(), mustFile(app, 'note.md'));

    expect(note.frontmatter).toStrictEqual({ status: 'active', count: 3 });
    expect(note.frontmatter).not.toHaveProperty('position');
  });

  it('returns an empty frontmatter object when there is none', () => {
    const app = App.createConfigured__({ files: { 'note.md': 'Just a body.\n' } });

    const note = readNote(app.asOriginalType__(), mustFile(app, 'note.md'));

    expect(note.frontmatter).toStrictEqual({});
  });

  it('strips a position key injected directly into the cache (the fixture parser never adds one, but real Obsidian does)', () => {
    const app = App.createConfigured__({ files: { 'note.md': 'Body\n' } });
    const file = mustFile(app, 'note.md');
    vi.spyOn(app.metadataCache, 'getFileCache').mockReturnValue({
      frontmatter: {
        status: 'active',
        position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 1, col: 0, offset: 10 } },
      },
    });

    const note = readNote(app.asOriginalType__(), file);

    expect(note.frontmatter).toStrictEqual({ status: 'active' });
  });

  it('falls back to empty defaults when the file has no metadata cache entry or resolved links yet', () => {
    const app = App.createConfigured__({ files: { 'note.md': 'Body\n' } });
    const file = mustFile(app, 'note.md');
    vi.spyOn(app.metadataCache, 'getFileCache').mockReturnValue(null);
    delete app.metadataCache.resolvedLinks['note.md'];

    const note = readNote(app.asOriginalType__(), file);

    expect(note.tags).toStrictEqual([]);
    expect(note.frontmatter).toStrictEqual({});
    expect(note.propertyLinks).toStrictEqual({});
    expect(note.links).toStrictEqual([]);
  });

  it('resolves propertyLinks for a list-shaped key, one property per index prefix', () => {
    const app = App.createConfigured__({
      files: {
        'note.md': '---\ncategory:\n  - "[[a]]"\n  - "[[b]]"\n---\n',
        'a.md': '',
        'b.md': '',
      },
    });

    const note = readNote(app.asOriginalType__(), mustFile(app, 'note.md'));

    expect(note.propertyLinks).toStrictEqual({ category: ['a.md', 'b.md'] });
  });

  it('resolves propertyLinks for a scalar key', () => {
    const app = App.createConfigured__({
      files: { 'note.md': '---\nup: "[[a]]"\n---\n', 'a.md': '' },
    });

    const note = readNote(app.asOriginalType__(), mustFile(app, 'note.md'));

    expect(note.propertyLinks).toStrictEqual({ up: ['a.md'] });
  });

  it('skips unresolved property links and dedupes resolved ones per property', () => {
    const app = App.createConfigured__({
      files: {
        'note.md': '---\nup: "[[a]]"\nsee:\n  - "[[a]]"\n  - "[[missing]]"\n---\n',
        'a.md': '',
      },
    });

    const note = readNote(app.asOriginalType__(), mustFile(app, 'note.md'));

    expect(note.propertyLinks).toStrictEqual({ up: ['a.md'], see: ['a.md'] });
  });

  it('resolves an alias link [[a|alias]] and a heading link [[a#h]] to the same target', () => {
    const app = App.createConfigured__({
      files: {
        'note.md': '---\nup: "[[a|Alias Text]]"\nsee: "[[a#h]]"\n---\n',
        'a.md': '',
      },
    });

    const note = readNote(app.asOriginalType__(), mustFile(app, 'note.md'));

    expect(note.propertyLinks).toStrictEqual({ up: ['a.md'], see: ['a.md'] });
  });

  it('reads outgoing links from resolvedLinks, including body links', () => {
    const app = App.createConfigured__({
      files: {
        // `a.md`/`b.md` must exist before `note.md` is created: `resolvedLinks` is computed once,
        // at note-creation time, from whatever targets already exist in the vault then.
        'a.md': '',
        'b.md': '',
        'note.md': '---\nup: "[[a]]"\n---\nSee also [[b]] in the body.\n',
      },
    });

    const note = readNote(app.asOriginalType__(), mustFile(app, 'note.md'));

    expect(note.links).toStrictEqual(expect.arrayContaining(['a.md', 'b.md']));
    expect(note.links).toHaveLength(2);
  });

  it('carries the path and basename through unchanged', () => {
    const app = App.createConfigured__({ files: { 'folder/note.md': 'Body\n' } });

    const note = readNote(app.asOriginalType__(), mustFile(app, 'folder/note.md'));

    expect(note.path).toBe('folder/note.md');
    expect(note.basename).toBe('note');
  });
});

describe('readSnapshot', () => {
  it('dedupes result paths and preserves the given order', () => {
    const app = App.createConfigured__({
      files: { 'b.md': '', 'a.md': '' },
    });
    const results = [mustFile(app, 'b.md'), mustFile(app, 'a.md'), mustFile(app, 'b.md')];

    const snapshot = readSnapshot(app.asOriginalType__(), results, null);

    expect(snapshot.results).toStrictEqual(['b.md', 'a.md']);
  });

  it('includes every result note in the snapshot', () => {
    const app = App.createConfigured__({ files: { 'a.md': '', 'b.md': '' } });
    const results = [mustFile(app, 'a.md'), mustFile(app, 'b.md')];

    const snapshot = readSnapshot(app.asOriginalType__(), results, null);

    expect([...snapshot.notes.keys()]).toStrictEqual(expect.arrayContaining(['a.md', 'b.md']));
  });

  // Regression: a Bases folder filter (`file.inFolder(...)`) matches every file under that
  // folder, not just markdown notes — a `.base`/`.canvas` file living in the same folder the view
  // filters on comes back as a query result too. A catch-all type (`{}`, no conditions) would
  // otherwise happily adopt it as a "note".
  it('excludes non-markdown results (e.g. a .base or .canvas file) from both results and notes', () => {
    const app = App.createConfigured__({
      files: { 'a.md': '', 'scheme.base': 'views: []\n', 'board.canvas': '{}' },
    });
    const results = [
      mustFile(app, 'a.md'),
      mustFile(app, 'scheme.base'),
      mustFile(app, 'board.canvas'),
    ];

    const snapshot = readSnapshot(app.asOriginalType__(), results, null);

    expect(snapshot.results).toStrictEqual(['a.md']);
    expect(snapshot.notes.has('scheme.base')).toBe(false);
    expect(snapshot.notes.has('board.canvas')).toBe(false);
  });

  it('includes the host note and reports its path, when given', () => {
    const app = App.createConfigured__({ files: { 'a.md': '', 'host.md': '' } });
    const results = [mustFile(app, 'a.md')];

    const snapshot = readSnapshot(app.asOriginalType__(), results, mustFile(app, 'host.md'));

    expect(snapshot.host).toBe('host.md');
    expect(snapshot.notes.has('host.md')).toBe(true);
  });

  it('reports a null host when none is given', () => {
    const app = App.createConfigured__({ files: { 'a.md': '' } });

    const snapshot = readSnapshot(app.asOriginalType__(), [mustFile(app, 'a.md')], null);

    expect(snapshot.host).toBeNull();
  });

  it('includes an external property-link target of a result note, one level deep', () => {
    const app = App.createConfigured__({
      files: {
        'a.md': '---\nup: "[[parent]]"\n---\n',
        'parent.md': '',
      },
    });

    const snapshot = readSnapshot(app.asOriginalType__(), [mustFile(app, 'a.md')], null);

    expect(snapshot.notes.has('parent.md')).toBe(true);
    expect(snapshot.results).toStrictEqual(['a.md']);
  });

  it('includes an external property-link target of the host note', () => {
    const app = App.createConfigured__({
      files: {
        'a.md': '',
        'host.md': '---\nup: "[[parent]]"\n---\n',
        'parent.md': '',
      },
    });

    const snapshot = readSnapshot(
      app.asOriginalType__(),
      [mustFile(app, 'a.md')],
      mustFile(app, 'host.md'),
    );

    expect(snapshot.notes.has('parent.md')).toBe(true);
  });

  it("does not recurse into an external target's own property links", () => {
    const app = App.createConfigured__({
      files: {
        'a.md': '---\nup: "[[parent]]"\n---\n',
        'parent.md': '---\nup: "[[grandparent]]"\n---\n',
        'grandparent.md': '',
      },
    });

    const snapshot = readSnapshot(app.asOriginalType__(), [mustFile(app, 'a.md')], null);

    expect(snapshot.notes.has('parent.md')).toBe(true);
    expect(snapshot.notes.has('grandparent.md')).toBe(false);
  });

  it('does not include a property-link target that resolves to a non-markdown file', () => {
    const app = App.createConfigured__({
      files: {
        'a.md': '---\nsee: "[[image.png]]"\n---\n',
        'image.png': 'binary-ish',
      },
    });

    const snapshot = readSnapshot(app.asOriginalType__(), [mustFile(app, 'a.md')], null);

    expect(snapshot.notes.has('image.png')).toBe(false);
  });

  it('reads a shared external target only once when two notes link to it', () => {
    const app = App.createConfigured__({
      files: {
        'parent.md': '',
        'a.md': '---\nup: "[[parent]]"\n---\n',
        'b.md': '---\nup: "[[parent]]"\n---\n',
      },
    });

    const snapshot = readSnapshot(
      app.asOriginalType__(),
      [mustFile(app, 'a.md'), mustFile(app, 'b.md')],
      null,
    );

    expect(snapshot.notes.has('parent.md')).toBe(true);
    expect(snapshot.notes.size).toBe(3);
  });
});
