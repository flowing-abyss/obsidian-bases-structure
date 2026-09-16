import type { BasesQueryResult, PluginManifest, TFile } from 'obsidian';
import { App, QueryController } from 'obsidian-test-mocks/obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { note, snapshot } from '../core/__tests__/notes.js';
import StructureViewPlugin from '../main.js';
import { OutlineRenderer } from './outline-renderer.js';
import { formatStructureIssue, StructureView } from './structure-view.js';
import { clearUiState } from './view-state.js';

const manifest: PluginManifest = {
  id: 'bases-structure',
  name: 'Bases Structure',
  author: 'test',
  version: '0.0.0-test',
  minAppVersion: '1.10.3',
  description: 'Test manifest',
};

function mustFile(app: App, path: string): TFile {
  const file = app.vault.getFileByPath(path);
  if (file === null) {
    throw new Error(`Test setup error: missing file "${path}"`);
  }
  return file.asOriginalType2__();
}

interface TestView {
  readonly view: StructureView;
  readonly parentEl: HTMLElement;
}

function createView(app: App, files: readonly TFile[]): TestView {
  const plugin = new StructureViewPlugin(app.asOriginalType__(), manifest);
  const controller = QueryController.create2__(app, plugin, createDiv());
  const parentEl = createDiv();
  const view = new StructureView(controller.asOriginalType2__(), parentEl, plugin);
  view.app = app.asOriginalType__();
  view.data = { data: files.map((file) => ({ file })) } as unknown as BasesQueryResult;
  return { view, parentEl };
}

afterEach(() => {
  clearUiState();
  vi.restoreAllMocks();
});

describe('StructureView', () => {
  it('creates the issues and body child elements immediately, before any data arrives', () => {
    const app = App.createConfigured__({});

    const { parentEl } = createView(app, []);

    expect(parentEl.querySelector('.bases-structure-issues')).not.toBeNull();
    expect(parentEl.querySelector('.bases-structure-body')).not.toBeNull();
  });

  it('shows the schema issue in the banner for a bad config (no parent, no types)', () => {
    const app = App.createConfigured__({});
    const { view, parentEl } = createView(app, []);

    view.onDataUpdated();

    const issuesEl = parentEl.querySelector('.bases-structure-issues');
    expect(issuesEl?.classList.contains('is-hidden')).toBe(false);
    expect(issuesEl?.textContent).toContain('Set "parent" or "types"');
  });

  it('hides the issues banner and renders a node per result in order for a valid untyped config', () => {
    const app = App.createConfigured__({ files: { 'b.md': '', 'a.md': '' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'b.md'), mustFile(app, 'a.md')]);
    view.config.set('parent', 'note.parent');

    view.onDataUpdated();

    const issuesEl = parentEl.querySelector('.bases-structure-issues');
    expect(issuesEl?.classList.contains('is-hidden')).toBe(true);
    const nodes = parentEl.querySelectorAll('.bases-structure-body .bases-structure-node');
    expect(Array.from(nodes).map((el) => el.textContent)).toStrictEqual(['b', 'a']);
  });

  it('reuses the renderer instance and the same UI state across a second onDataUpdated with the same layout', () => {
    const app = App.createConfigured__({ files: { 'a.md': '' } });
    const { view } = createView(app, [mustFile(app, 'a.md')]);
    view.config.set('parent', 'note.parent');
    const updateSpy = vi.spyOn(OutlineRenderer.prototype, 'update');
    const destroySpy = vi.spyOn(OutlineRenderer.prototype, 'destroy');

    view.onDataUpdated();
    view.onDataUpdated();

    expect(destroySpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(2);
    const firstInput = updateSpy.mock.calls[0]?.[0];
    const secondInput = updateSpy.mock.calls[1]?.[0];
    expect(firstInput).toBeDefined();
    expect(secondInput).toBeDefined();
    expect(secondInput?.state).toBe(firstInput?.state);
  });

  it('shows a failure message in the body and logs when the renderer throws', () => {
    const app = App.createConfigured__({ files: { 'a.md': '' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'a.md')]);
    view.config.set('parent', 'note.parent');
    vi.spyOn(OutlineRenderer.prototype, 'update').mockImplementation(() => {
      throw new Error('boom');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    view.onDataUpdated();

    const bodyEl = parentEl.querySelector('.bases-structure-body');
    expect(bodyEl?.textContent).toBe('Structure view failed: boom');
    expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
  });

  it('shows a structure issue (type conflict) prefixed with the note basename', () => {
    const app = App.createConfigured__({
      files: { 'note.md': '---\ntags: [x, y]\n---\n' },
    });
    const { view, parentEl } = createView(app, [mustFile(app, 'note.md')]);
    view.config.set('types', { A: { tag: 'x' }, B: { tag: 'y' } });

    view.onDataUpdated();

    const issuesEl = parentEl.querySelector('.bases-structure-issues');
    expect(issuesEl?.classList.contains('is-hidden')).toBe(false);
    expect(issuesEl?.textContent).toContain('note: Matches several types: A, B');
  });

  it('caps the issues banner at 5 lines with a trailing "+n more" summary', () => {
    const app = App.createConfigured__({});
    const { view, parentEl } = createView(app, []);
    view.config.set('types', {
      A: { children: { X1: 'up', X2: 'up', X3: 'up', X4: 'up', X5: 'up', X6: 'up' } },
    });

    view.onDataUpdated();

    const issuesEl = parentEl.querySelector('.bases-structure-issues');
    expect(issuesEl?.textContent).toContain('+1 more');
  });

  it('destroys the renderer and empties/removes the container on unload', () => {
    const app = App.createConfigured__({ files: { 'a.md': '' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'a.md')]);
    view.config.set('parent', 'note.parent');
    view.onDataUpdated();
    const destroySpy = vi.spyOn(OutlineRenderer.prototype, 'destroy');

    view.load();
    view.unload();

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(parentEl.querySelector('.bases-structure')).toBeNull();
  });
});

describe('formatStructureIssue', () => {
  it('returns the message alone when the issue has no path', () => {
    expect(formatStructureIssue({ path: null, message: 'Msg' }, snapshot([]))).toBe('Msg');
  });

  it('prefixes the note basename when the issue has a path', () => {
    const snap = snapshot([note('a.md')]);

    expect(formatStructureIssue({ path: 'a.md', message: 'Msg' }, snap)).toBe('a: Msg');
  });
});
