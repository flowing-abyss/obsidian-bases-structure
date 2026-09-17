import type { TFile } from 'obsidian-test-mocks/obsidian';
import { App } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { note, snapshot } from '../core/__tests__/notes.js';
import type { Plan } from '../core/plan-types.js';
import { applyPlan, type Transaction } from './plan-applier.js';
import { UndoManager } from './undo-manager.js';

function mustFile(app: App, path: string): TFile {
  const file = app.vault.getFileByPath(path);
  if (file === null) {
    throw new Error(`Test setup error: missing file "${path}"`);
  }
  return file;
}

describe('UndoManager', () => {
  it('reports an empty result and cannot undo when the stack is empty', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__());

    expect(undo.canUndo).toBe(false);
    const result = await undo.undo();

    expect(result).toStrictEqual({ label: null, skipped: [] });
  });

  it('rolls back a create+change+append+move plan to its exact original state', async () => {
    const app = App.createConfigured__({
      files: {
        'parent.md': '',
        'existing.md': '---\nstatus: active\n---\nBody\n',
        'append-target.md': '',
        'movable.md': 'Move me\n',
      },
    });
    const plan: Plan = {
      creations: [
        {
          path: 'new/child.md',
          writes: [{ key: 'status', value: { kind: 'literal', value: 'active' } }],
          bodyLinks: ['parent.md'],
        },
      ],
      changes: [{ path: 'existing.md', writes: [{ key: 'status', value: null }] }],
      appends: [{ path: 'append-target.md', target: 'parent.md' }],
      moves: [{ from: 'movable.md', to: 'moved/movable.md' }],
      bodyLinkRemovals: [],
    };
    const expected = snapshot([note('existing.md', { frontmatter: { status: 'active' } })]);
    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Round trip', expected);
    expect(outcome.error).toBeNull();
    const undo = new UndoManager(app.asOriginalType__());
    undo.push(outcome.transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Round trip', skipped: [] });
    expect(app.vault.getFileByPath('new/child.md')).toBeNull();
    expect(app.vault.getFileByPath('movable.md')).not.toBeNull();
    expect(app.vault.getFileByPath('moved/movable.md')).toBeNull();
    expect(await app.vault.read(mustFile(app, 'movable.md'))).toBe('Move me\n');
    expect(await app.vault.read(mustFile(app, 'append-target.md'))).toBe('');
    const cache = app.metadataCache.getFileCache(mustFile(app, 'existing.md'));
    expect(cache?.frontmatter?.['status']).toBe('active');
    expect(undo.canUndo).toBe(false);
  });

  it('reverts steps in reverse order', async () => {
    // Both steps are deliberately unrevertable (their recorded text isn't in the file), so the
    // only observable trace of revert order is the order paths land in `skipped`.
    const app = App.createConfigured__({ files: { 'a.md': 'one', 'b.md': 'one' } });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Order',
      steps: [
        { kind: 'append', path: 'a.md', text: 'not present' },
        { kind: 'append', path: 'b.md', text: 'not present either' },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Order', skipped: ['b.md', 'a.md'] });
  });

  it('skips a frontmatter step when the current value no longer matches what was written', async () => {
    const app = App.createConfigured__({
      files: { 'note.md': '---\nstatus: changed-by-someone-else\n---\n' },
    });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Conflict',
      steps: [
        {
          kind: 'frontmatter',
          path: 'note.md',
          key: 'status',
          existed: true,
          before: 'old',
          after: 'active',
          deleted: false,
        },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Conflict', skipped: ['note.md'] });
    const cache = app.metadataCache.getFileCache(mustFile(app, 'note.md'));
    expect(cache?.frontmatter?.['status']).toBe('changed-by-someone-else');
  });

  it('restores a list-shaped value when it still deep-equals the recorded one (object key order does not matter)', async () => {
    const app = App.createConfigured__({
      files: { 'note.md': '---\nlinks:\n  b: 2\n  a: 1\n---\n' },
    });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Restore',
      steps: [
        {
          kind: 'frontmatter',
          path: 'note.md',
          key: 'links',
          existed: false,
          before: undefined,
          after: { a: 1, b: 2 },
          deleted: false,
        },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Restore', skipped: [] });
    const cache = app.metadataCache.getFileCache(mustFile(app, 'note.md'));
    expect(cache?.frontmatter?.['links']).toBeUndefined();
  });

  it('skips a frontmatter restore when a recorded array value has been reordered (order-sensitive)', async () => {
    const app = App.createConfigured__({ files: { 'note.md': '---\ntags:\n  - b\n  - a\n---\n' } });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Reordered',
      steps: [
        {
          kind: 'frontmatter',
          path: 'note.md',
          key: 'tags',
          existed: false,
          before: undefined,
          after: ['a', 'b'],
          deleted: false,
        },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Reordered', skipped: ['note.md'] });
  });

  it('skips an append step when the appended text was edited', async () => {
    const app = App.createConfigured__({ files: { 'note.md': 'Body\n- [[edited]]\n' } });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Append conflict',
      steps: [{ kind: 'append', path: 'note.md', text: '- [[original]]\n' }],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Append conflict', skipped: ['note.md'] });
    expect(await app.vault.read(mustFile(app, 'note.md'))).toBe('Body\n- [[edited]]\n');
  });

  it('skips an append step when the note it targeted no longer exists', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Append missing',
      steps: [{ kind: 'append', path: 'gone.md', text: '- [[x]]\n' }],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Append missing', skipped: ['gone.md'] });
  });

  it('removes the appended text from the middle of the file when later content follows it', async () => {
    const app = App.createConfigured__({ files: { 'note.md': 'Before\n- [[x]]\nAfter\n' } });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Append middle',
      steps: [{ kind: 'append', path: 'note.md', text: '- [[x]]\n' }],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Append middle', skipped: [] });
    expect(await app.vault.read(mustFile(app, 'note.md'))).toBe('Before\nAfter\n');
  });

  it('removes a tail append that includes its leading separator newline, when the file still ends with it (I2, branch 1)', async () => {
    // The parent had no trailing newline when this was appended, so `applyAppend` prefixed the
    // link with one; reverting while it's still the last thing in the file removes that leading
    // newline along with it — correct here, since it's genuinely the separator this step added.
    const app = App.createConfigured__({ files: { 'note.md': 'last line\n- [[Child]]\n' } });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Append tail',
      steps: [{ kind: 'append', path: 'note.md', text: '\n- [[Child]]\n' }],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Append tail', skipped: [] });
    expect(await app.vault.read(mustFile(app, 'note.md'))).toBe('last line');
  });

  it('removes only the appended line, keeping the separating newline, once later content follows it (I2, branch 2 — the reviewer’s example)', async () => {
    // Same leading-newline shape as above, but something was appended after the link (so it's no
    // longer the file's tail) — naively stripping `step.text` (which starts with "\n") would eat
    // the newline that separates "last line" from "user line", merging them into one line.
    const app = App.createConfigured__({
      files: { 'note.md': '# Parent\nlast line\n- [[Child]]\nuser line\n' },
    });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Append then more text',
      steps: [{ kind: 'append', path: 'note.md', text: '\n- [[Child]]\n' }],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Append then more text', skipped: [] });
    expect(await app.vault.read(mustFile(app, 'note.md'))).toBe('# Parent\nlast line\nuser line\n');
  });

  it('skips (and leaves the file untouched) when the appended line no longer exists at all (I2, branch 3)', async () => {
    const app = App.createConfigured__({ files: { 'note.md': '# Parent\nsomething else\n' } });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Append gone',
      steps: [{ kind: 'append', path: 'note.md', text: '\n- [[Child]]\n' }],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Append gone', skipped: ['note.md'] });
    expect(await app.vault.read(mustFile(app, 'note.md'))).toBe('# Parent\nsomething else\n');
  });

  it('reinserts a whole removed line at its recorded index, exactly', async () => {
    // Recorded as if cut from '# H\n\n- [[Child]]\n- [[Other]]\n' (body-link.test.ts's own first
    // example): seamBefore is everything before the cut, seamAfter the line that followed it.
    const app = App.createConfigured__({ files: { 'note.md': '# H\n\n- [[Other]]\n' } });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Body edit',
      steps: [
        {
          kind: 'bodyEdit',
          path: 'note.md',
          removed: '- [[Child]]\n',
          index: 5,
          seamBefore: '# H\n\n',
          seamAfter: '- [[Other]]\n',
        },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Body edit', skipped: [] });
    expect(await app.vault.read(mustFile(app, 'note.md'))).toBe(
      '# H\n\n- [[Child]]\n- [[Other]]\n',
    );
  });

  it('reinserts a removed line at index 0, exactly', async () => {
    const app = App.createConfigured__({ files: { 'note.md': '- [[Other]]\n' } });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Body edit',
      steps: [
        {
          kind: 'bodyEdit',
          path: 'note.md',
          removed: '- [[Child]]\n',
          index: 0,
          seamBefore: '',
          seamAfter: '- [[Other]]\n',
        },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Body edit', skipped: [] });
    expect(await app.vault.read(mustFile(app, 'note.md'))).toBe('- [[Child]]\n- [[Other]]\n');
  });

  it('reinserts a removed bare mid-sentence mention at its recorded index, exactly', async () => {
    // Recorded as if cut from 'See [[Child]] for details.\n'.
    const app = App.createConfigured__({ files: { 'note.md': 'See for details.\n' } });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Body edit',
      steps: [
        {
          kind: 'bodyEdit',
          path: 'note.md',
          removed: '[[Child]] ',
          index: 4,
          seamBefore: 'See ',
          seamAfter: 'for details.\n',
        },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Body edit', skipped: [] });
    expect(await app.vault.read(mustFile(app, 'note.md'))).toBe('See [[Child]] for details.\n');
  });

  it('appends the removed line at the end and reports the note skipped once the seam has drifted', async () => {
    // Recorded against the same original as the first test above, but the file at undo time has
    // lost the blank line the index used to sit right after — splicing "removed" back in there
    // would land mid-line instead, so the seam check (seamBefore no longer matches) must catch it.
    const app = App.createConfigured__({ files: { 'note.md': '# H\n- [[Other]]\n' } });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Body edit drift',
      steps: [
        {
          kind: 'bodyEdit',
          path: 'note.md',
          removed: '- [[Child]]\n',
          index: 5,
          seamBefore: '# H\n\n',
          seamAfter: '- [[Other]]\n',
        },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Body edit drift', skipped: ['note.md'] });
    expect(await app.vault.read(mustFile(app, 'note.md'))).toBe('# H\n- [[Other]]\n- [[Child]]\n');
  });

  it('appends the removed text at the end when the recorded index is now out of bounds', async () => {
    const app = App.createConfigured__({ files: { 'note.md': 'X\n' } });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Body edit oob',
      steps: [
        {
          kind: 'bodyEdit',
          path: 'note.md',
          removed: '- [[Child]]\n',
          index: 50,
          seamBefore: '',
          seamAfter: '',
        },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Body edit oob', skipped: ['note.md'] });
    expect(await app.vault.read(mustFile(app, 'note.md'))).toBe('X\n- [[Child]]\n');
  });

  it('reports a conflict instead of splicing mid-word when an inline removal’s note was edited before undo, even with the index still in bounds', async () => {
    // Recorded as if cut from 'See [[Child]] for details.\n' (same capture as the mid-sentence
    // test above), but the note was rewritten entirely before undo ran. The old index (4) is
    // still comfortably inside the new, unrelated text — a bounds-only check would silently
    // splice "removed" into the middle of "Completely", corrupting the word. The seam context
    // (recorded "See "/"for details.\n") no longer matches, so this must be reported as a
    // conflict instead, leaving the edited note's own text untouched apart from the fallback
    // append.
    const app = App.createConfigured__({
      files: { 'note.md': 'Completely different note content now.\n' },
    });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Body edit conflict',
      steps: [
        {
          kind: 'bodyEdit',
          path: 'note.md',
          removed: '[[Child]] ',
          index: 4,
          seamBefore: 'See ',
          seamAfter: 'for details.\n',
        },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Body edit conflict', skipped: ['note.md'] });
    expect(await app.vault.read(mustFile(app, 'note.md'))).toBe(
      'Completely different note content now.\n[[Child]] \n',
    );
  });

  it('skips a bodyEdit step when the note it targeted no longer exists', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Body edit gone',
      steps: [
        {
          kind: 'bodyEdit',
          path: 'gone.md',
          removed: '- [[Child]]\n',
          index: 0,
          seamBefore: '',
          seamAfter: '',
        },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Body edit gone', skipped: ['gone.md'] });
  });

  it('skips a frontmatter step when the note it targeted no longer exists', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Frontmatter missing',
      steps: [
        {
          kind: 'frontmatter',
          path: 'gone.md',
          key: 'status',
          existed: true,
          before: 'active',
          after: undefined,
          deleted: true,
        },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Frontmatter missing', skipped: ['gone.md'] });
  });

  it('dedupes skipped paths when more than one step on the same note is skipped', async () => {
    const app = App.createConfigured__({ files: { 'note.md': 'Body\n' } });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Dup skip',
      steps: [
        { kind: 'append', path: 'note.md', text: 'not present' },
        {
          kind: 'frontmatter',
          path: 'note.md',
          key: 'status',
          existed: true,
          before: 'old',
          after: 'mismatch',
          deleted: false,
        },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Dup skip', skipped: ['note.md'] });
  });

  it('does nothing (and does not skip) when the created file no longer exists', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Already gone',
      steps: [{ kind: 'create', path: 'gone.md', content: 'anything' }],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Already gone', skipped: [] });
  });

  it('skips a create step when the created file was edited since', async () => {
    const app = App.createConfigured__({ files: { 'note.md': 'edited content' } });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Create conflict',
      steps: [{ kind: 'create', path: 'note.md', content: 'original content' }],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Create conflict', skipped: ['note.md'] });
    expect(app.vault.getFileByPath('note.md')).not.toBeNull();
  });

  it('trashes a created note on undo even when another plugin added frontmatter, as long as the body is unchanged (I11)', async () => {
    const app = App.createConfigured__({
      files: { 'note.md': '---\nstatus: active\nplugin_added: true\n---\nOriginal body\n' },
    });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Create with plugin edit',
      steps: [
        { kind: 'create', path: 'note.md', content: '---\nstatus: active\n---\nOriginal body\n' },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Create with plugin edit', skipped: [] });
    expect(app.vault.getFileByPath('note.md')).toBeNull();
  });

  it('skips (and names) a created note whose body was edited since, even if the frontmatter still matches (I11)', async () => {
    const app = App.createConfigured__({
      files: { 'note.md': '---\nstatus: active\n---\nEdited body\n' },
    });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Create then edit',
      steps: [
        { kind: 'create', path: 'note.md', content: '---\nstatus: active\n---\nOriginal body\n' },
      ],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Create then edit', skipped: ['note.md'] });
    expect(app.vault.getFileByPath('note.md')).not.toBeNull();
  });

  it('skips a rename step when something now occupies the original path', async () => {
    const app = App.createConfigured__({
      files: { 'moved.md': 'content', 'original.md': 'a different note now lives here' },
    });
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Rename conflict',
      steps: [{ kind: 'rename', from: 'original.md', to: 'moved.md' }],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Rename conflict', skipped: ['moved.md'] });
    expect(app.vault.getFileByPath('moved.md')).not.toBeNull();
  });

  it('removes a folder it created when it is still empty, in reverse (deepest first) order, alongside the note that used to live in it (M2)', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__());
    const plan: Plan = {
      creations: [{ path: 'projects/sub/child.md', writes: [], bodyLinks: [] }],
      changes: [],
      appends: [],
      moves: [],
      bodyLinkRemovals: [],
    };
    const outcome = await applyPlan(app.asOriginalType__(), plan, 'Create nested', snapshot([]));
    expect(outcome.error).toBeNull();
    undo.push(outcome.transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Create nested', skipped: [] });
    expect(app.vault.getFileByPath('projects/sub/child.md')).toBeNull();
    expect(app.vault.getFolderByPath('projects/sub')).toBeNull();
    expect(app.vault.getFolderByPath('projects')).toBeNull();
  });

  it('leaves a created folder alone (no skip reported) when something else now lives in it (M2)', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__());
    await app.vault.createFolder('projects');
    await app.vault.create('projects/unrelated.md', '');
    const transaction: Transaction = {
      label: 'Folder now occupied',
      steps: [{ kind: 'createFolder', path: 'projects' }],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Folder now occupied', skipped: [] });
    expect(app.vault.getFolderByPath('projects')).not.toBeNull();
    expect(app.vault.getFileByPath('projects/unrelated.md')).not.toBeNull();
  });

  it('does nothing (and does not skip) when a created folder is already gone', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Folder already gone',
      steps: [{ kind: 'createFolder', path: 'never-existed' }],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Folder already gone', skipped: [] });
  });

  it('logs and skips a step that throws while reverting', async () => {
    const app = App.createConfigured__({ files: { 'note.md': 'original' } });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(app.fileManager, 'trashFile').mockRejectedValue(new Error('boom'));
    const undo = new UndoManager(app.asOriginalType__());
    const transaction: Transaction = {
      label: 'Throws',
      steps: [{ kind: 'create', path: 'note.md', content: 'original' }],
    };
    undo.push(transaction);

    const result = await undo.undo();

    expect(result).toStrictEqual({ label: 'Throws', skipped: ['note.md'] });
    expect(consoleError).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
  });

  it('drops the oldest transaction once the limit is exceeded', async () => {
    const app = App.createConfigured__({});
    const undo = new UndoManager(app.asOriginalType__(), 2);
    undo.push({ label: 'first', steps: [] });
    undo.push({ label: 'second', steps: [] });
    undo.push({ label: 'third', steps: [] });

    expect(await undo.undo()).toStrictEqual({ label: 'third', skipped: [] });
    expect(await undo.undo()).toStrictEqual({ label: 'second', skipped: [] });
    expect(await undo.undo()).toStrictEqual({ label: null, skipped: [] });
  });

  describe('undo(transaction) — I1', () => {
    it('reverts and pops exactly like undo() when the given transaction is still on top', async () => {
      const app = App.createConfigured__({});
      const undo = new UndoManager(app.asOriginalType__());
      const transaction: Transaction = { label: 'Only', steps: [] };
      undo.push(transaction);

      const result = await undo.undo(transaction);

      expect(result).toStrictEqual({ label: 'Only', skipped: [] });
      expect(undo.canUndo).toBe(false);
    });

    it('returns { blocked: true } and leaves the stack untouched when a newer transaction is on top', async () => {
      const app = App.createConfigured__({});
      const undo = new UndoManager(app.asOriginalType__());
      const older: Transaction = { label: 'Older', steps: [] };
      const newer: Transaction = { label: 'Newer', steps: [] };
      undo.push(older);
      undo.push(newer);

      const result = await undo.undo(older);

      expect(result).toStrictEqual({ blocked: true });
      expect(undo.canUndo).toBe(true);
      // The stack is untouched — the newer transaction is still the one a plain undo() reverts.
      expect(await undo.undo()).toStrictEqual({ label: 'Newer', skipped: [] });
      expect(await undo.undo()).toStrictEqual({ label: 'Older', skipped: [] });
    });

    it('returns { blocked: true } when the stack is empty (the transaction was already undone)', async () => {
      const app = App.createConfigured__({});
      const undo = new UndoManager(app.asOriginalType__());
      const gone: Transaction = { label: 'Gone', steps: [] };

      const result = await undo.undo(gone);

      expect(result).toStrictEqual({ blocked: true });
    });
  });
});
