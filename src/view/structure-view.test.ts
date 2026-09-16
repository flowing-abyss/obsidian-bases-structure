import type { BasesQueryResult, PluginManifest, TFile } from 'obsidian';
import { App, QueryController } from 'obsidian-test-mocks/obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { note, snapshot } from '../core/__tests__/notes.js';
import StructureViewPlugin from '../main.js';
import { StructureActions } from './actions-ui.js';
import * as dragModule from './drag.js';
import { GraphRenderer } from './graph-renderer.js';
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

  it('shows the schema issue in the banner for a bad config (no parent, no types), with no leading key prefix', () => {
    const app = App.createConfigured__({});
    const { view, parentEl } = createView(app, []);

    view.onDataUpdated();

    const issuesEl = parentEl.querySelector('.bases-structure-issues');
    expect(issuesEl?.classList.contains('is-hidden')).toBe(false);
    // The issue's `key` is '' (it isn't about any single config field), so the line must be just
    // the message — no leading ": " from an empty key.
    expect(issuesEl?.textContent).toBe('Set "parent" or "types"');
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
    view.config.set('layout', 'outline');
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
    view.config.set('layout', 'outline');
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
    view.config.set('layout', 'outline');
    view.onDataUpdated();
    const destroySpy = vi.spyOn(OutlineRenderer.prototype, 'destroy');

    view.load();
    view.unload();

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(parentEl.querySelector('.bases-structure')).toBeNull();
  });
});

describe('StructureView — create wiring', () => {
  const typesConfig = { Cat: { tag: 'cat', children: { Leaf: 'up' } }, Leaf: { tag: 'leaf' } };

  it('opens a draft on "+", commits it into a real note, and re-renders (onAdd/refresh wiring)', async () => {
    // Bases itself re-runs the underlying query and calls `onDataUpdated()` again once the vault
    // settles (outside this test's control — see `refresh`'s own doc comment); what's under test
    // here is only that clicking "+" reaches `StructureActions` and that a successful commit
    // triggers a `render()` through `refresh`, not the full round trip through a live Bases query.
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    view.config.set('types', typesConfig);
    view.onDataUpdated();
    const updateSpy = vi.spyOn(GraphRenderer.prototype, 'update');

    parentEl
      .querySelector('.bases-structure-add')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const input = parentEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    if (input === null) {
      throw new Error('Test setup error: draft input did not open');
    }
    input.value = 'New Leaf';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => {
      expect(app.vault.getFileByPath('New Leaf.md')).not.toBeNull();
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('destroys the create actions (and any open draft) on unload', () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view } = createView(app, [mustFile(app, 'cat.md')]);
    view.config.set('types', typesConfig);
    view.onDataUpdated();
    const destroySpy = vi.spyOn(StructureActions.prototype, 'destroy');

    view.load();
    view.unload();

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});

function findNode(parentEl: HTMLElement, path: string): HTMLElement {
  for (const el of Array.from(parentEl.querySelectorAll<HTMLElement>('.bases-structure-node'))) {
    if (el.getAttribute('data-path') === path) {
      return el;
    }
  }
  throw new Error(`Test setup error: no node element for "${path}"`);
}

describe('StructureView — drag wiring', () => {
  const twoParentsConfig = { Cat: { tag: 'cat', children: { Leaf: 'up' } }, Leaf: { tag: 'leaf' } };

  function twoParentsView(): TestView & { app: App } {
    const app = App.createConfigured__({
      files: {
        'cat1.md': '---\ntags: [cat]\n---\n',
        'cat2.md': '---\ntags: [cat]\n---\n',
        'leaf.md': '---\ntags: [leaf]\nup: "[[cat1]]"\n---\n',
      },
    });
    const view = createView(app, [
      mustFile(app, 'cat1.md'),
      mustFile(app, 'cat2.md'),
      mustFile(app, 'leaf.md'),
    ]);
    view.view.config.set('types', twoParentsConfig);
    return { ...view, app };
  }

  it('attaches drag to the renderer container', () => {
    const disposeSpy = vi.fn();
    const attachDragSpy = vi.spyOn(dragModule, 'attachDrag').mockReturnValue(disposeSpy);
    const { view, parentEl } = twoParentsView();

    view.onDataUpdated();

    expect(attachDragSpy).toHaveBeenCalledTimes(1);
    const deps = attachDragSpy.mock.calls[0]?.[0];
    expect(deps?.container).toBe(parentEl.querySelector('.bases-structure-body'));
  });

  it('wires targetsFor to moveTargets and onDrop to StructureActions.startMove', () => {
    const attachDragSpy = vi.spyOn(dragModule, 'attachDrag').mockReturnValue(vi.fn());
    const { view } = twoParentsView();
    view.onDataUpdated();
    const deps = attachDragSpy.mock.calls[0]?.[0];
    if (deps === undefined) throw new Error('attachDrag was not called');
    const startMoveSpy = vi
      .spyOn(StructureActions.prototype, 'startMove')
      .mockImplementation(() => undefined);

    expect(deps.targetsFor('leaf.md')).toStrictEqual(new Set(['cat2.md']));
    deps.onDrop('leaf.md', 'cat2.md');

    expect(startMoveSpy).toHaveBeenCalledExactlyOnceWith('leaf.md', 'cat2.md');
  });

  it('disposes the previous attachment and re-attaches when the renderer is recreated (layout switch)', () => {
    const disposeSpy1 = vi.fn();
    const disposeSpy2 = vi.fn();
    const attachDragSpy = vi
      .spyOn(dragModule, 'attachDrag')
      .mockReturnValueOnce(disposeSpy1)
      .mockReturnValueOnce(disposeSpy2);
    const { view } = twoParentsView();
    view.onDataUpdated();
    expect(attachDragSpy).toHaveBeenCalledTimes(1);
    expect(disposeSpy1).not.toHaveBeenCalled();

    view.config.set('layout', 'outline');
    view.onDataUpdated();

    expect(disposeSpy1).toHaveBeenCalledTimes(1);
    expect(attachDragSpy).toHaveBeenCalledTimes(2);
    expect(disposeSpy2).not.toHaveBeenCalled();
  });

  it('disposes the drag attachment on unload', () => {
    const disposeSpy = vi.fn();
    vi.spyOn(dragModule, 'attachDrag').mockReturnValue(disposeSpy);
    const { view } = twoParentsView();
    view.onDataUpdated();

    view.load();
    view.unload();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('drives a real move end to end through the rendered DOM and the actual attachDrag implementation', async () => {
    // No mocking of `attachDrag` here — a stub for the one jsdom gap (`elementFromPoint`) is
    // enough to prove the whole path (real DOM → real `moveTargets` → real `startMove` → a real
    // committed frontmatter write) actually connects, not just that the wiring *calls* the right
    // functions with plausible arguments.
    const { view, parentEl, app } = twoParentsView();
    view.onDataUpdated();
    const sourceEl = findNode(parentEl, 'leaf.md');
    const targetEl = findNode(parentEl, 'cat2.md');
    const proto = document as unknown as { elementFromPoint?: (x: number, y: number) => Element };
    proto.elementFromPoint = () => targetEl;

    try {
      sourceEl.dispatchEvent(
        new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, bubbles: true }),
      );
      document.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, clientX: 20, clientY: 20, bubbles: true }),
      );
      document.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 1, clientX: 20, clientY: 20, bubbles: true }),
      );

      await vi.waitFor(() => {
        const file = app.vault.getFileByPath('leaf.md');
        expect(file).not.toBeNull();
        if (file === null) return;
        expect(app.metadataCache.getFileCache(file)?.frontmatter?.['up']).toBe('[[cat2]]');
      });
    } finally {
      delete proto.elementFromPoint;
    }
  });
});

describe('StructureView — context menu wiring', () => {
  it('delegated contextmenu resolves the node path, calls openNodeMenu, and prevents default', () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    view.config.set('parent', 'note.parent');
    view.onDataUpdated();
    const openNodeMenuSpy = vi
      .spyOn(StructureActions.prototype, 'openNodeMenu')
      .mockImplementation(() => undefined);
    const nodeEl = findNode(parentEl, 'cat.md');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    nodeEl.dispatchEvent(event);

    expect(openNodeMenuSpy).toHaveBeenCalledExactlyOnceWith('cat.md', event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does nothing when the contextmenu does not land on a node', () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    view.onDataUpdated();
    const openNodeMenuSpy = vi
      .spyOn(StructureActions.prototype, 'openNodeMenu')
      .mockImplementation(() => undefined);
    const bases = parentEl.querySelector('.bases-structure');
    if (bases === null) throw new Error('missing view root');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    bases.dispatchEvent(event);

    expect(openNodeMenuSpy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores a contextmenu whose target is not an HTMLElement (e.g. an SVG edge in the graph)', () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    view.onDataUpdated();
    const openNodeMenuSpy = vi
      .spyOn(StructureActions.prototype, 'openNodeMenu')
      .mockImplementation(() => undefined);
    const bases = parentEl.querySelector('.bases-structure');
    if (bases === null) throw new Error('missing view root');
    const svgEl = createSvg('path');
    bases.appendChild(svgEl);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    svgEl.dispatchEvent(event);

    expect(openNodeMenuSpy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('StructureView — undo shortcut wiring', () => {
  it('Mod+Z triggers undoLast and prevents default', () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    view.onDataUpdated();
    const undoLastSpy = vi
      .spyOn(StructureActions.prototype, 'undoLast')
      .mockImplementation(() => undefined);
    const bases = parentEl.querySelector('.bases-structure');
    if (bases === null) throw new Error('missing view root');
    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    bases.dispatchEvent(event);

    expect(undoLastSpy).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('a key press inside an input does not trigger undo', () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    view.onDataUpdated();
    const undoLastSpy = vi
      .spyOn(StructureActions.prototype, 'undoLast')
      .mockImplementation(() => undefined);
    const bases = parentEl.querySelector('.bases-structure');
    if (bases === null) throw new Error('missing view root');
    const inputEl = createEl('input');
    bases.appendChild(inputEl);
    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    inputEl.dispatchEvent(event);

    expect(undoLastSpy).not.toHaveBeenCalled();
  });

  it('a key press without Mod does not trigger undo', () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    view.onDataUpdated();
    const undoLastSpy = vi
      .spyOn(StructureActions.prototype, 'undoLast')
      .mockImplementation(() => undefined);
    const bases = parentEl.querySelector('.bases-structure');
    if (bases === null) throw new Error('missing view root');
    const event = new KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true });

    bases.dispatchEvent(event);

    expect(undoLastSpy).not.toHaveBeenCalled();
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
