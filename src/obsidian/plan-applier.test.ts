import type * as ObsidianModule from 'obsidian';
import type { TFile as RealTFile } from 'obsidian';
import { App, type TFile } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { note, snapshot } from '../core/__tests__/notes.js';
import type { Plan } from '../core/plan-types.js';
import { planAction } from '../core/planner.js';
import { parseSchema } from '../core/schema.js';
import { applyPlan as simulateApplyPlan } from '../core/simulate.js';
import type { Snapshot } from '../core/snapshot.js';
import { applyPlan, commitPlan } from './plan-applier.js';
import { readSnapshot } from './snapshot-reader.js';
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
  return { creations: [], changes: [], appends: [], moves: [], bodyLinkRemovals: [] };
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

  it('round 3: the real planner’s own output (readSnapshot → planAction → applyPlan), applied to a mock vault, keeps an untagged note, a wrong-type note, a typed "also in" category, and a user-added value', async () => {
    const app = App.createConfigured__({
      files: {
        'C1.md': '---\ntags: [category]\n---\n',
        'C2.md': '---\ntags: [category]\n---\n',
        'ExtCat.md': '---\ntags: [category]\n---\n',
        'UserCat.md': '',
        'Random.md': '',
        'WrongType.md': '---\ntags: [other]\n---\n',
        'A.md': '---\ntags: [meta]\ncategory: "[[C1]]"\n---\n',
        'M2.md': '---\ntags: [meta]\ncategory: "[[C2]]"\n---\n',
        'H.md':
          '---\ntags: [hier]\nmeta:\n  - "[[A]]"\n  - "[[Random]]"\n  - "[[WrongType]]"\ncategory:\n  - "[[C1]]"\n  - "[[ExtCat]]"\n  - "[[UserCat]]"\n---\n',
      },
    });
    const schema = parseSchema(
      (key: string) =>
        ({
          inherit: ['category'],
          types: {
            Category: { tag: 'category', children: { Meta: 'category' } },
            Meta: { tag: 'meta', children: { Hier: 'meta' } },
            Hier: { tag: 'hier' },
            Other: { tag: 'other' },
          },
        })[key],
    ).schema;
    const env = { defaultFolder: '', exists: (): boolean => false };
    const realFile = (path: string): RealTFile => mustFile(app, path).asOriginalType2__();
    const originalApp = app.asOriginalType__();
    const initialSnapshot = readSnapshot(
      originalApp,
      [realFile('A.md'), realFile('M2.md'), realFile('H.md')],
      null,
    );

    const result = planAction(
      schema,
      initialSnapshot,
      { kind: 'move', node: 'H.md', parent: 'M2.md' },
      env,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = await applyPlan(originalApp, result.plan, 'Move', initialSnapshot);

    expect(outcome.error).toBeNull();
    const cache = app.metadataCache.getFileCache(mustFile(app, 'H.md'));
    expect(cache?.frontmatter?.['meta']).toStrictEqual(['[[M2]]', '[[Random]]', '[[WrongType]]']);
    expect(cache?.frontmatter?.['category']).toStrictEqual(['[[C2]]', '[[ExtCat]]', '[[UserCat]]']);
  });

  it('round 4: moving a note whose old edge to an untyped host was through an inherited key keeps the host’s own value for that key, and undo restores it', async () => {
    // MOC is an untyped host — its own "category" ([[Knowledge]]) was never inherited by m.md;
    // m.md's link to MOC *is* the edge itself (both go through "category", which also happens to
    // be a schema.inherit key). Moving m.md must remove only MOC, never Knowledge.
    const app = App.createConfigured__({
      files: {
        'Knowledge.md': '',
        'MOC.md': '---\ncategory: "[[Knowledge]]"\n---\n',
        'C2.md': '---\ntags: [category]\n---\n',
        'm.md': '---\ntags: [meta]\ncategory:\n  - "[[MOC]]"\n  - "[[Knowledge]]"\n---\n',
      },
    });
    const schema = parseSchema(
      (key: string) =>
        ({
          inherit: ['category'],
          types: {
            Category: { tag: 'category', children: { MetaT: 'category' } },
            MetaT: { tag: 'meta' },
          },
        })[key],
    ).schema;
    const env = { defaultFolder: '', exists: (): boolean => false };
    const realFile = (path: string): RealTFile => mustFile(app, path).asOriginalType2__();
    const originalApp = app.asOriginalType__();
    const undo = new UndoManager(originalApp);
    const initialSnapshot = readSnapshot(
      originalApp,
      [realFile('C2.md'), realFile('m.md')],
      realFile('MOC.md'),
    );

    const result = planAction(
      schema,
      initialSnapshot,
      { kind: 'move', node: 'm.md', parent: 'C2.md' },
      env,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = await applyPlan(originalApp, result.plan, 'Move', initialSnapshot);

    expect(outcome.error).toBeNull();
    if (outcome.transaction.steps.length > 0) {
      undo.push(outcome.transaction);
    }
    const cache = app.metadataCache.getFileCache(mustFile(app, 'm.md'));
    expect(cache?.frontmatter?.['category']).toStrictEqual(['[[C2]]', '[[Knowledge]]']);

    const undoResult = await undo.undo();

    expect(undoResult.skipped).toStrictEqual([]);
    const restoredCache = app.metadataCache.getFileCache(mustFile(app, 'm.md'));
    expect(restoredCache?.frontmatter?.['category']).toStrictEqual(['[[MOC]]', '[[Knowledge]]']);
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

describe('applyPlan — body link removals', () => {
  it('removes the mention from the note text and records a bodyEdit step', async () => {
    const app = App.createConfigured__({
      files: { 'parent.md': '- [[Child]]\n- [[Other]]\n', 'child.md': '' },
    });
    const plan: Plan = {
      ...emptyPlan(),
      bodyLinkRemovals: [{ path: 'parent.md', target: 'child.md' }],
    };

    const outcome = await applyPlan(
      app.asOriginalType__(),
      plan,
      'Remove mention',
      emptySnapshot(),
    );

    expect(outcome.error).toBeNull();
    expect(await app.vault.read(mustFile(app, 'parent.md'))).toBe('- [[Other]]\n');
    expect(outcome.transaction.steps).toStrictEqual([
      { kind: 'bodyEdit', path: 'parent.md', removed: '- [[Child]]\n', index: 0 },
    ]);
  });

  it('matches a bare mention, not just a bullet, and undo restores it exactly (round trip)', async () => {
    const app = App.createConfigured__({
      files: { 'parent.md': 'See [[Child]] for details.\n', 'child.md': '' },
    });
    const plan: Plan = {
      ...emptyPlan(),
      bodyLinkRemovals: [{ path: 'parent.md', target: 'child.md' }],
    };

    const outcome = await applyPlan(
      app.asOriginalType__(),
      plan,
      'Remove mention',
      emptySnapshot(),
    );
    expect(await app.vault.read(mustFile(app, 'parent.md'))).toBe('See for details.\n');

    const undo = new UndoManager(app.asOriginalType__());
    undo.push(outcome.transaction);
    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Remove mention', skipped: [] });
    expect(await app.vault.read(mustFile(app, 'parent.md'))).toBe('See [[Child]] for details.\n');
  });

  it('errors for a removal targeting a missing note', async () => {
    const app = App.createConfigured__({ files: { 'parent.md': '- [[Child]]\n' } });
    const plan: Plan = {
      ...emptyPlan(),
      bodyLinkRemovals: [{ path: 'parent.md', target: 'missing.md' }],
    };

    const outcome = await applyPlan(
      app.asOriginalType__(),
      plan,
      'Remove missing',
      emptySnapshot(),
    );

    expect(errorMessage(outcome.error)).toBe('Note not found: missing.md');
  });

  it('errors for a removal from a missing note', async () => {
    const app = App.createConfigured__({ files: { 'child.md': '' } });
    const plan: Plan = {
      ...emptyPlan(),
      bodyLinkRemovals: [{ path: 'missing.md', target: 'child.md' }],
    };

    const outcome = await applyPlan(
      app.asOriginalType__(),
      plan,
      'Remove missing',
      emptySnapshot(),
    );

    expect(errorMessage(outcome.error)).toBe('Note not found: missing.md');
  });

  it('rejects when the note no longer mentions the target', async () => {
    const app = App.createConfigured__({
      files: { 'parent.md': '- [[Other]]\n', 'child.md': '' },
    });
    const plan: Plan = {
      ...emptyPlan(),
      bodyLinkRemovals: [{ path: 'parent.md', target: 'child.md' }],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Remove absent', emptySnapshot());

    expect(errorMessage(outcome.error)).toBe('No mention of "child" found in "parent"');
    expect(await app.vault.read(mustFile(app, 'parent.md'))).toBe('- [[Other]]\n');
  });

  it('rejects a move whose old mention turns out to be an embed, leaving the note untouched', async () => {
    // The planner (Task 8) has no note text to check against — it can't tell an embed from a
    // plain link when building `bodyLinkRemovals`. Only the applier, with the real body in hand,
    // can catch it (`removeBodyLink` treats `![[...]]` as no match at all).
    const app = App.createConfigured__({
      files: { 'parent.md': '![[Child]]\n', 'child.md': '' },
    });
    const plan: Plan = {
      ...emptyPlan(),
      bodyLinkRemovals: [{ path: 'parent.md', target: 'child.md' }],
    };

    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Move', emptySnapshot());

    expect(errorMessage(outcome.error)).toBe('No mention of "child" found in "parent"');
    expect(await app.vault.read(mustFile(app, 'parent.md'))).toBe('![[Child]]\n');
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
      bodyLinkRemovals: [],
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
  it('applies the plan, pushes the transaction, and returns applied: true with that same transaction (I1)', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__());
    const pushSpy = vi.spyOn(undo, 'push');
    const plan: Plan = { ...emptyPlan(), creations: [{ path: 'a.md', writes: [], bodyLinks: [] }] };

    const result = await commitPlan(app.asOriginalType__(), undo, {
      plan,
      label: 'Commit',
      expected: emptySnapshot(),
    });

    expect(result.applied).toBe(true);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(undo.canUndo).toBe(true);
    // The exact reference `undo.push` received — so a caller can pass it straight to
    // `undo.undo(transaction)`'s identity check (I1).
    expect(result.transaction).toBe(pushSpy.mock.calls[0]?.[0]);
  });

  it('pushes the partial transaction, logs, shows a Notice, and returns applied: false with that transaction', async () => {
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
      bodyLinkRemovals: [],
    };

    const result = await commitPlan(app.asOriginalType__(), undo, {
      plan,
      label: 'Commit fail',
      expected: emptySnapshot(),
    });

    expect(result.applied).toBe(false);
    expect(result.transaction).not.toBeNull();
    expect(undo.canUndo).toBe(true);
    expect(consoleError).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
    expect(noticeMock).toHaveBeenCalledWith(
      'Structure: could not apply all changes. Note not found: missing.md',
    );
  });

  it('shows the exact I5 concurrency wording, without the generic "could not apply all changes" wrapper (round 2 minor 6)', async () => {
    const app = App.createConfigured__({
      files: { 'note.md': '---\nstatus: changed-by-someone-else\n---\n' },
    });
    const undo = new UndoManager(app.asOriginalType__());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const plan: Plan = {
      ...emptyPlan(),
      changes: [
        { path: 'note.md', writes: [{ key: 'status', value: { kind: 'literal', value: 'new' } }] },
      ],
    };
    const expected = snapshot([note('note.md', { frontmatter: { status: 'active' } })]);

    const result = await commitPlan(app.asOriginalType__(), undo, {
      plan,
      label: 'Concurrent',
      expected,
    });

    expect(result.applied).toBe(false);
    expect(noticeMock).toHaveBeenCalledWith(
      'Structure: "note" changed while applying; nothing else was written',
    );
  });

  it('does not push the transaction when the plan produces no steps, and reports transaction: null', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__());
    const pushSpy = vi.spyOn(undo, 'push');

    const result = await commitPlan(app.asOriginalType__(), undo, {
      plan: emptyPlan(),
      label: 'Nothing to do',
      expected: emptySnapshot(),
    });

    expect(result).toStrictEqual({ applied: true, transaction: null });
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

    expect(result.applied).toBe(false);
    expect(noticeMock).toHaveBeenCalledWith('Structure: could not apply all changes. boom');
  });
});

describe('applyPlan parity with the simulator (round 2 minor 7)', () => {
  it('produces the same resulting frontmatter as simulate.ts’s applyPlan for the same plan, across a links write, a listItem write, and a literal write', async () => {
    const snap = snapshot([
      note('old.md'),
      note('new.md'),
      note('n.md', {
        tags: ['a'],
        frontmatterTags: ['a'],
        frontmatter: { up: ['[[old]]', '[[Not yet written]]'], tags: ['a'], status: 'todo' },
        propertyLinks: { up: ['old.md'] },
      }),
    ]);
    const plan: Plan = {
      ...emptyPlan(),
      changes: [
        {
          path: 'n.md',
          writes: [
            {
              key: 'up',
              value: { kind: 'links', remove: ['old.md'], add: ['new.md'], list: true },
            },
            { key: 'tags', value: { kind: 'listItem', remove: 'a', add: 'b' } },
            { key: 'status', value: { kind: 'literal', value: 'doing' } },
          ],
        },
      ],
    };

    const simulated = simulateApplyPlan(snap, plan);
    const simulatedFrontmatter = simulated.notes.get('n.md')?.frontmatter;

    const app = App.createConfigured__({
      files: {
        'old.md': '',
        'new.md': '',
        'n.md':
          '---\nup:\n  - "[[old]]"\n  - "[[Not yet written]]"\ntags:\n  - a\nstatus: todo\n---\n',
      },
    });
    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Parity', emptySnapshot());
    const realFrontmatter = app.metadataCache.getFileCache(mustFile(app, 'n.md'))?.frontmatter;

    expect(outcome.error).toBeNull();
    expect(simulatedFrontmatter).toStrictEqual({
      up: ['[[new]]', '[[Not yet written]]'],
      tags: ['b'],
      status: 'doing',
    });
    expect(realFrontmatter?.['up']).toStrictEqual(simulatedFrontmatter?.['up']);
    expect(realFrontmatter?.['tags']).toStrictEqual(simulatedFrontmatter?.['tags']);
    expect(realFrontmatter?.['status']).toStrictEqual(simulatedFrontmatter?.['status']);
  });
});
