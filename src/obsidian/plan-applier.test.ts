import type * as ObsidianModule from 'obsidian';
import { App, type TFile } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { Plan } from '../core/plan-types.js';
import { applyPlan, commitPlan } from './plan-applier.js';
import { UndoManager } from './undo-manager.js';

// The real `Notice` mock wires its constructor through the library's internal `strictProxy`,
// which doesn't tolerate being wrapped by `vi.spyOn` (its prototype methods aren't stubbed, so
// the proxy throws when the spy calls through). Swapping in a bare `vi.fn()` for just this test
// file sidesteps that: `commitPlan` only calls `new Notice(...)` for its side effect, never reads
// anything back off the instance, so a no-op mock is all this needs. `vi.hoisted` shares the mock
// between the `vi.mock` factory (which must run before this file's imports) and the assertions.
const { noticeMock } = vi.hoisted(() => ({ noticeMock: vi.fn() }));
vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<typeof ObsidianModule>();
  return { ...actual, Notice: noticeMock };
});

/** The mock `TFile` at `path` (for use with the mock `app.vault`/`app.metadataCache` directly,
 * not with production code — those want `app.asOriginalType__()`). */
function mustFile(app: App, path: string): TFile {
  const file = app.vault.getFileByPath(path);
  if (file === null) {
    throw new Error(`Test setup error: missing file "${path}"`);
  }
  return file;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyPlan(): Plan {
  return { creations: [], changes: [], appends: [], moves: [] };
}

describe('applyPlan — creations', () => {
  it('creates missing parent folders, renders body links and frontmatter, and records the final content', async () => {
    const app = App.createConfigured__({ files: { 'parent.md': '' } });
    const plan: Plan = {
      ...emptyPlan(),
      creations: [
        {
          path: 'projects/sub/child.md',
          writes: [
            { key: 'status', value: { kind: 'literal', value: 'active' } },
            { key: 'up', value: { kind: 'links', remove: [], add: ['parent.md'], list: false } },
          ],
          bodyLinks: ['parent.md'],
        },
      ],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Create child');

    expect(outcome.error).toBeNull();
    expect(app.vault.getFolderByPath('projects')).not.toBeNull();
    expect(app.vault.getFolderByPath('projects/sub')).not.toBeNull();
    const file = mustFile(app, 'projects/sub/child.md');
    const content = await app.vault.read(file);
    expect(content).toContain('- [[parent]]');
    const cache = app.metadataCache.getFileCache(file);
    expect(cache?.frontmatter?.['status']).toBe('active');
    expect(cache?.frontmatter?.['up']).toBe('[[parent]]');
    expect(outcome.transaction.label).toBe('Create child');
    expect(outcome.transaction.steps).toStrictEqual([
      { kind: 'create', path: 'projects/sub/child.md', content },
    ]);
    expect(file.path).toBe('projects/sub/child.md');
  });

  it('creates a file at the vault root without attempting folder creation', async () => {
    const app = App.createConfigured__({});
    const plan: Plan = {
      ...emptyPlan(),
      creations: [{ path: 'root.md', writes: [], bodyLinks: [] }],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Create root');

    expect(outcome.error).toBeNull();
    expect(app.vault.getFileByPath('root.md')).not.toBeNull();
  });

  it('does not try to recreate a folder segment that already exists', async () => {
    const app = App.createConfigured__({});
    await app.vault.createFolder('projects');
    const createFolderSpy = vi.spyOn(app.vault, 'createFolder');
    const plan: Plan = {
      ...emptyPlan(),
      creations: [{ path: 'projects/sub/child.md', writes: [], bodyLinks: [] }],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Create nested');

    expect(outcome.error).toBeNull();
    expect(createFolderSpy).toHaveBeenCalledExactlyOnceWith('projects/sub');
    expect(app.vault.getFileByPath('projects/sub/child.md')).not.toBeNull();
  });
});

describe('applyPlan — changes', () => {
  it('records a frontmatter step per write, for both a delete and a new-key set', async () => {
    const app = App.createConfigured__({
      files: { 'note.md': '---\nstatus: active\n---\nBody\n' },
    });
    const plan: Plan = {
      ...emptyPlan(),
      changes: [
        {
          path: 'note.md',
          writes: [
            { key: 'status', value: null },
            { key: 'tags', value: { kind: 'literal', value: ['x'] } },
          ],
        },
      ],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Change note');

    expect(outcome.error).toBeNull();
    expect(outcome.transaction.steps).toStrictEqual([
      {
        kind: 'frontmatter',
        path: 'note.md',
        key: 'status',
        existed: true,
        before: 'active',
        after: undefined,
        deleted: true,
      },
      {
        kind: 'frontmatter',
        path: 'note.md',
        key: 'tags',
        existed: false,
        before: undefined,
        after: ['x'],
        deleted: false,
      },
    ]);
    const cache = app.metadataCache.getFileCache(mustFile(app, 'note.md'));
    expect(cache?.frontmatter?.['status']).toBeUndefined();
    expect(cache?.frontmatter?.['tags']).toStrictEqual(['x']);
  });

  it('patches an existing links value in place, preserving an unresolved link, plain text, and a link outside the base exactly as written, and undo restores the original text (C1)', async () => {
    const app = App.createConfigured__({
      files: {
        'A.md': '',
        'Ext.md': '',
        'M2.md': '',
        'H.md':
          '---\nmeta:\n  - "[[A]]"\n  - "[[Not yet written]]"\n  - some text\n  - "[[Ext]]"\n---\nBody\n',
      },
    });
    const undo = new UndoManager(app.asOriginalType__());
    const plan: Plan = {
      ...emptyPlan(),
      changes: [
        {
          path: 'H.md',
          writes: [
            { key: 'meta', value: { kind: 'links', remove: ['A.md'], add: ['M2.md'], list: true } },
          ],
        },
      ],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Move');

    expect(outcome.error).toBeNull();
    if (outcome.transaction.steps.length > 0) {
      undo.push(outcome.transaction);
    }
    const cache = app.metadataCache.getFileCache(mustFile(app, 'H.md'));
    expect(cache?.frontmatter?.['meta']).toStrictEqual([
      '[[M2]]',
      '[[Not yet written]]',
      'some text',
      '[[Ext]]',
    ]);

    const undoResult = await undo.undo();

    expect(undoResult.skipped).toStrictEqual([]);
    const restoredCache = app.metadataCache.getFileCache(mustFile(app, 'H.md'));
    expect(restoredCache?.frontmatter?.['meta']).toStrictEqual([
      '[[A]]',
      '[[Not yet written]]',
      'some text',
      '[[Ext]]',
    ]);
  });
});

describe('applyPlan — appends', () => {
  it('appends without a leading blank line when the file is empty', async () => {
    const app = App.createConfigured__({ files: { 'empty.md': '', 'target.md': '' } });
    const plan: Plan = {
      ...emptyPlan(),
      appends: [{ path: 'empty.md', target: 'target.md' }],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Append');

    expect(outcome.error).toBeNull();
    expect(outcome.transaction.steps).toStrictEqual([
      { kind: 'append', path: 'empty.md', text: '- [[target]]\n' },
    ]);
    expect(await app.vault.read(mustFile(app, 'empty.md'))).toBe('- [[target]]\n');
  });

  it('inserts a newline before the list item when the file does not end with one', async () => {
    const app = App.createConfigured__({ files: { 'note.md': 'Hello', 'target.md': '' } });
    const plan: Plan = {
      ...emptyPlan(),
      appends: [{ path: 'note.md', target: 'target.md' }],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Append');

    expect(outcome.transaction.steps).toStrictEqual([
      { kind: 'append', path: 'note.md', text: '\n- [[target]]\n' },
    ]);
    expect(await app.vault.read(mustFile(app, 'note.md'))).toBe('Hello\n- [[target]]\n');
  });

  it('does not add an extra blank line when the file already ends with one', async () => {
    const app = App.createConfigured__({ files: { 'note.md': 'Hello\n', 'target.md': '' } });
    const plan: Plan = {
      ...emptyPlan(),
      appends: [{ path: 'note.md', target: 'target.md' }],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Append');

    expect(outcome.transaction.steps).toStrictEqual([
      { kind: 'append', path: 'note.md', text: '- [[target]]\n' },
    ]);
    expect(await app.vault.read(mustFile(app, 'note.md'))).toBe('Hello\n- [[target]]\n');
  });
});

describe('applyPlan — moves', () => {
  it('creates the missing target folder and renames the file, recording the step', async () => {
    const app = App.createConfigured__({ files: { 'source.md': 'Body\n' } });
    const plan: Plan = {
      ...emptyPlan(),
      moves: [{ from: 'source.md', to: 'newfolder/sub/source.md' }],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Move');

    expect(outcome.error).toBeNull();
    expect(app.vault.getFolderByPath('newfolder/sub')).not.toBeNull();
    expect(app.vault.getFileByPath('source.md')).toBeNull();
    expect(app.vault.getFileByPath('newfolder/sub/source.md')).not.toBeNull();
    expect(outcome.transaction.steps).toStrictEqual([
      { kind: 'rename', from: 'source.md', to: 'newfolder/sub/source.md' },
    ]);
  });
});

describe('applyPlan — missing notes', () => {
  it('stops at the first failing operation, keeping the steps already completed', async () => {
    const app = App.createConfigured__({});
    const plan: Plan = {
      creations: [{ path: 'ok.md', writes: [], bodyLinks: [] }],
      changes: [
        { path: 'missing.md', writes: [{ key: 'x', value: { kind: 'literal', value: 1 } }] },
      ],
      appends: [],
      moves: [],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Partial');

    expect(outcome.error).toBeInstanceOf(Error);
    expect(errorMessage(outcome.error)).toBe('Note not found: missing.md');
    expect(outcome.transaction.steps).toHaveLength(1);
    expect(outcome.transaction.steps[0]?.kind).toBe('create');
  });

  it('errors for an append targeting a missing note', async () => {
    const app = App.createConfigured__({});
    const plan: Plan = { ...emptyPlan(), appends: [{ path: 'missing.md', target: 'x.md' }] };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Append missing');

    expect(errorMessage(outcome.error)).toBe('Note not found: missing.md');
  });

  it('errors for a move of a missing note', async () => {
    const app = App.createConfigured__({});
    const plan: Plan = { ...emptyPlan(), moves: [{ from: 'missing.md', to: 'x.md' }] };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Move missing');

    expect(errorMessage(outcome.error)).toBe('Note not found: missing.md');
  });
});

describe('commitPlan', () => {
  it('applies the plan, pushes the transaction, and returns true on success', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__());
    const pushSpy = vi.spyOn(undo, 'push');
    const plan: Plan = { ...emptyPlan(), creations: [{ path: 'a.md', writes: [], bodyLinks: [] }] };

    const result = await commitPlan(app.asOriginalType__(), undo, plan, 'Commit');

    expect(result).toBe(true);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(undo.canUndo).toBe(true);
  });

  it('pushes the partial transaction, logs, shows a Notice, and returns false on failure', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__());
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const plan: Plan = {
      creations: [{ path: 'ok.md', writes: [], bodyLinks: [] }],
      changes: [
        { path: 'missing.md', writes: [{ key: 'x', value: { kind: 'literal', value: 1 } }] },
      ],
      appends: [],
      moves: [],
    };

    const result = await commitPlan(app.asOriginalType__(), undo, plan, 'Commit fail');

    expect(result).toBe(false);
    expect(undo.canUndo).toBe(true);
    expect(consoleError).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
    expect(noticeMock).toHaveBeenCalledWith(
      'Structure: could not apply all changes. Note not found: missing.md',
    );
  });

  it('does not push the transaction when the plan produces no steps', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__());
    const pushSpy = vi.spyOn(undo, 'push');

    const result = await commitPlan(app.asOriginalType__(), undo, emptyPlan(), 'Nothing to do');

    expect(result).toBe(true);
    expect(pushSpy).not.toHaveBeenCalled();
    expect(undo.canUndo).toBe(false);
  });

  it('falls back to String(error) in the Notice message when a non-Error value is thrown', async () => {
    const app = App.createConfigured__({});
    vi.spyOn(app.vault, 'create').mockRejectedValue('boom');
    const undo = new UndoManager(app.asOriginalType__());
    const plan: Plan = { ...emptyPlan(), creations: [{ path: 'a.md', writes: [], bodyLinks: [] }] };

    const result = await commitPlan(app.asOriginalType__(), undo, plan, 'Non-error throw');

    expect(result).toBe(false);
    expect(noticeMock).toHaveBeenCalledWith('Structure: could not apply all changes. boom');
  });
});
