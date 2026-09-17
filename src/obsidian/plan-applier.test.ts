import type * as ObsidianModule from 'obsidian';
import { App, type TFile } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { note, snapshot } from '../core/__tests__/notes.js';
import type { Plan } from '../core/plan-types.js';
import type { Snapshot } from '../core/snapshot.js';
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

/** No notes at all — the optimistic-concurrency check (I5) is a no-op for every path, since
 * `expected.notes.get(path)` is always `undefined`. What every test that isn't specifically about
 * that check uses. */
function emptySnapshot(): Snapshot {
  return snapshot([]);
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

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Create child', emptySnapshot());

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
      { kind: 'createFolder', path: 'projects' },
      { kind: 'createFolder', path: 'projects/sub' },
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

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Create root', emptySnapshot());

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

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Create nested', emptySnapshot());

    expect(outcome.error).toBeNull();
    expect(createFolderSpy).toHaveBeenCalledExactlyOnceWith('projects/sub');
    expect(app.vault.getFileByPath('projects/sub/child.md')).not.toBeNull();
  });

  it('only records a createFolder step for a segment it actually created (not one that already existed)', async () => {
    const app = App.createConfigured__({});
    await app.vault.createFolder('projects');
    const plan: Plan = {
      ...emptyPlan(),
      creations: [{ path: 'projects/sub/child.md', writes: [], bodyLinks: [] }],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Create nested', emptySnapshot());

    const content = await app.vault.read(mustFile(app, 'projects/sub/child.md'));
    expect(outcome.transaction.steps).toStrictEqual([
      { kind: 'createFolder', path: 'projects/sub' },
      { kind: 'create', path: 'projects/sub/child.md', content },
    ]);
  });

  it('records the create step with the initial (pre-frontmatter) content when processFrontMatter fails partway (M2)', async () => {
    const app = App.createConfigured__({});
    vi.spyOn(app.fileManager, 'processFrontMatter').mockRejectedValue(
      new Error('frontmatter boom'),
    );
    const plan: Plan = {
      ...emptyPlan(),
      creations: [
        {
          path: 'a.md',
          writes: [{ key: 'status', value: { kind: 'literal', value: 'x' } }],
          bodyLinks: [],
        },
      ],
    };

    const outcome = await applyPlan(
      app.asOriginalType__(),
      plan,
      'Create with failing frontmatter',
      emptySnapshot(),
    );

    expect(outcome.error).toBeInstanceOf(Error);
    // Even though writing frontmatter failed, the note itself was created — and its 'create' step
    // was already recorded (with its actual, pre-frontmatter content) before that failure, so undo
    // can still find and trash it (the bug this fixes: it used to be recorded only after
    // `processFrontMatter` succeeded, leaving a partially-created note un-undoable).
    expect(outcome.transaction.steps).toStrictEqual([
      { kind: 'create', path: 'a.md', content: '' },
    ]);
    expect(app.vault.getFileByPath('a.md')).not.toBeNull();
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

    const expected = snapshot([note('note.md', { frontmatter: { status: 'active' } })]);
    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Change note', expected);

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

    const expected = snapshot([
      note('H.md', {
        frontmatter: { meta: ['[[A]]', '[[Not yet written]]', 'some text', '[[Ext]]'] },
      }),
    ]);
    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Move', expected);

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

describe('applyPlan — phantom steps (round 2 minor 5)', () => {
  it('records no steps at all for a note when a later write throws, even though an earlier write in the same note already applied', async () => {
    const app = App.createConfigured__({
      files: { 'note.md': '---\nstatus: active\n---\n' },
    });
    const plan: Plan = {
      ...emptyPlan(),
      changes: [
        {
          path: 'note.md',
          writes: [
            { key: 'status', value: { kind: 'literal', value: 'new' } },
            // "gone.md" doesn't exist and isn't being created by this plan — linktextFor throws
            // (I5), which real Obsidian's processFrontMatter surfaces by discarding *every*
            // mutation the callback made this call, not just the one that failed.
            { key: 'meta', value: { kind: 'links', remove: [], add: ['gone.md'], list: false } },
          ],
        },
      ],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Phantom step', emptySnapshot());

    expect(errorMessage(outcome.error)).toBe('Cannot link to "gone.md": it no longer exists');
    // Before round 2 minor 5, the "status" write's step was pushed straight into the shared steps
    // array as each write ran, so it would still show up here even though the note's real
    // frontmatter never actually changed (a "phantom" step undo could never actually reverse).
    expect(outcome.transaction.steps).toStrictEqual([]);
    const cache = app.metadataCache.getFileCache(mustFile(app, 'note.md'));
    expect(cache?.frontmatter?.['status']).toBe('active');
  });
});

describe('applyPlan — optimistic concurrency check (I5)', () => {
  it('aborts the whole change and every later one when a note no longer matches what the plan expected, leaving both notes untouched', async () => {
    const app = App.createConfigured__({
      files: {
        'a.md': '---\nstatus: changed-by-someone-else\n---\n',
        'b.md': '---\nstatus: active\n---\n',
      },
    });
    // "a.md" was "active" when the plan was built (freshInput's snapshot), but the file has since
    // changed underneath it.
    const expected = snapshot([
      note('a.md', { frontmatter: { status: 'active' } }),
      note('b.md', { frontmatter: { status: 'active' } }),
    ]);
    const plan: Plan = {
      ...emptyPlan(),
      changes: [
        { path: 'a.md', writes: [{ key: 'status', value: { kind: 'literal', value: 'new' } }] },
        { path: 'b.md', writes: [{ key: 'status', value: { kind: 'literal', value: 'new' } }] },
      ],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Concurrent edit', expected);

    expect(errorMessage(outcome.error)).toBe(
      '"a" changed while applying; nothing else was written',
    );
    expect(outcome.transaction.steps).toStrictEqual([]);
    const cacheA = app.metadataCache.getFileCache(mustFile(app, 'a.md'));
    expect(cacheA?.frontmatter?.['status']).toBe('changed-by-someone-else');
    const cacheB = app.metadataCache.getFileCache(mustFile(app, 'b.md'));
    expect(cacheB?.frontmatter?.['status']).toBe('active');
  });

  it('keeps an earlier write on the same note that still matched, only aborting from the mismatched key onward', async () => {
    const app = App.createConfigured__({
      files: { 'note.md': '---\nstatus: active\nkind: changed-by-someone-else\n---\n' },
    });
    const expected = snapshot([
      note('note.md', { frontmatter: { status: 'active', kind: 'original' } }),
    ]);
    const plan: Plan = {
      ...emptyPlan(),
      changes: [
        {
          path: 'note.md',
          writes: [
            { key: 'status', value: { kind: 'literal', value: 'new-status' } },
            { key: 'kind', value: { kind: 'literal', value: 'new-kind' } },
          ],
        },
      ],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Partial conflict', expected);

    expect(errorMessage(outcome.error)).toBe(
      '"note" changed while applying; nothing else was written',
    );
    expect(outcome.transaction.steps).toStrictEqual([
      {
        kind: 'frontmatter',
        path: 'note.md',
        key: 'status',
        existed: true,
        before: 'active',
        after: 'new-status',
        deleted: false,
      },
    ]);
    const cache = app.metadataCache.getFileCache(mustFile(app, 'note.md'));
    expect(cache?.frontmatter?.['status']).toBe('new-status');
    expect(cache?.frontmatter?.['kind']).toBe('changed-by-someone-else');
  });

  it('does not re-check a key the plan itself writes to twice (e.g. a paired tag remove+add)', async () => {
    const app = App.createConfigured__({
      files: { 'note.md': '---\ntype:\n  - project\n  - archived\n---\n' },
    });
    const expected = snapshot([
      note('note.md', { frontmatter: { type: ['project', 'archived'] } }),
    ]);
    const plan: Plan = {
      ...emptyPlan(),
      changes: [
        {
          path: 'note.md',
          writes: [
            { key: 'type', value: { kind: 'listItem', remove: 'project', add: 'task' } },
            { key: 'type', value: { kind: 'listItem', add: 'urgent' } },
          ],
        },
      ],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Pairwise tags', expected);

    expect(outcome.error).toBeNull();
    const cache = app.metadataCache.getFileCache(mustFile(app, 'note.md'));
    expect(cache?.frontmatter?.['type']).toStrictEqual(['task', 'archived', 'urgent']);
  });

  it('does not check a key the plan never touches, even if it also changed concurrently', async () => {
    const app = App.createConfigured__({
      files: { 'note.md': '---\nstatus: active\nunrelated: changed-by-someone-else\n---\n' },
    });
    const expected = snapshot([
      note('note.md', { frontmatter: { status: 'active', unrelated: 'original' } }),
    ]);
    const plan: Plan = {
      ...emptyPlan(),
      changes: [
        {
          path: 'note.md',
          writes: [{ key: 'status', value: { kind: 'literal', value: 'new-status' } }],
        },
      ],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Unrelated key change', expected);

    expect(outcome.error).toBeNull();
    const cache = app.metadataCache.getFileCache(mustFile(app, 'note.md'));
    expect(cache?.frontmatter?.['status']).toBe('new-status');
  });
});

describe('applyPlan — appends', () => {
  it('appends without a leading blank line when the file is empty', async () => {
    const app = App.createConfigured__({ files: { 'empty.md': '', 'target.md': '' } });
    const plan: Plan = {
      ...emptyPlan(),
      appends: [{ path: 'empty.md', target: 'target.md' }],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Append', emptySnapshot());

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

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Append', emptySnapshot());

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

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Append', emptySnapshot());

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

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Move', emptySnapshot());

    expect(outcome.error).toBeNull();
    expect(app.vault.getFolderByPath('newfolder/sub')).not.toBeNull();
    expect(app.vault.getFileByPath('source.md')).toBeNull();
    expect(app.vault.getFileByPath('newfolder/sub/source.md')).not.toBeNull();
    expect(outcome.transaction.steps).toStrictEqual([
      { kind: 'createFolder', path: 'newfolder' },
      { kind: 'createFolder', path: 'newfolder/sub' },
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

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Partial', emptySnapshot());

    expect(outcome.error).toBeInstanceOf(Error);
    expect(errorMessage(outcome.error)).toBe('Note not found: missing.md');
    expect(outcome.transaction.steps).toHaveLength(1);
    expect(outcome.transaction.steps[0]?.kind).toBe('create');
  });

  it('errors for an append targeting a missing note', async () => {
    const app = App.createConfigured__({});
    const plan: Plan = { ...emptyPlan(), appends: [{ path: 'missing.md', target: 'x.md' }] };

    const outcome = await applyPlan(
      app.asOriginalType__(),
      plan,
      'Append missing',
      emptySnapshot(),
    );

    expect(errorMessage(outcome.error)).toBe('Note not found: missing.md');
  });

  it('errors for a move of a missing note', async () => {
    const app = App.createConfigured__({});
    const plan: Plan = { ...emptyPlan(), moves: [{ from: 'missing.md', to: 'x.md' }] };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Move missing', emptySnapshot());

    expect(errorMessage(outcome.error)).toBe('Note not found: missing.md');
  });
});

describe('commitPlan', () => {
  it('applies the plan, pushes the transaction, and returns true on success', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__());
    const pushSpy = vi.spyOn(undo, 'push');
    const plan: Plan = { ...emptyPlan(), creations: [{ path: 'a.md', writes: [], bodyLinks: [] }] };

    const result = await commitPlan(app.asOriginalType__(), undo, {
      plan,
      label: 'Commit',
      expected: emptySnapshot(),
    });

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

    const result = await commitPlan(app.asOriginalType__(), undo, {
      plan,
      label: 'Commit fail',
      expected: emptySnapshot(),
    });

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

    const result = await commitPlan(app.asOriginalType__(), undo, {
      plan: emptyPlan(),
      label: 'Nothing to do',
      expected: emptySnapshot(),
    });

    expect(result).toBe(true);
    expect(pushSpy).not.toHaveBeenCalled();
    expect(undo.canUndo).toBe(false);
  });

  it('falls back to String(error) in the Notice message when a non-Error value is thrown', async () => {
    const app = App.createConfigured__({});
    vi.spyOn(app.vault, 'create').mockRejectedValue('boom');
    const undo = new UndoManager(app.asOriginalType__());
    const plan: Plan = { ...emptyPlan(), creations: [{ path: 'a.md', writes: [], bodyLinks: [] }] };

    const result = await commitPlan(app.asOriginalType__(), undo, {
      plan,
      label: 'Non-error throw',
      expected: emptySnapshot(),
    });

    expect(result).toBe(false);
    expect(noticeMock).toHaveBeenCalledWith('Structure: could not apply all changes. boom');
  });
});
