import type * as ObsidianModule from 'obsidian';
import type { BasesQueryResult, PluginManifest, TFile } from 'obsidian';
import { App, FileView, MarkdownView, QueryController } from 'obsidian-test-mocks/obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { note, snapshot } from '../core/__tests__/notes.js';
import * as schemaModule from '../core/schema.js';
import StructureViewPlugin from '../main.js';
import * as superchargedLinksModule from '../obsidian/supercharged-links.js';
import { UndoManager } from '../obsidian/undo-manager.js';
import { StructureActions } from './actions-ui.js';
import * as dragModule from './drag.js';
import { GraphRenderer } from './graph-renderer.js';
import * as keyboardModule from './keyboard.js';
import { OutlineRenderer } from './outline-renderer.js';
import { formatStructureIssue, StructureView } from './structure-view.js';
import { clearUiState } from './view-state.js';

// `Notice` is replaced with a small hand-rolled mock (same shape/approach as `actions-ui.test.ts`)
// so the addSibling-with-no-parent wiring test can inspect the exact message shown.
const { NoticeMock } = vi.hoisted(() => {
  class NoticeMock {
    static readonly instances: NoticeMock[] = [];
    readonly message: string | DocumentFragment;

    constructor(message: string | DocumentFragment) {
      this.message = message;
      NoticeMock.instances.push(this);
    }
  }
  return { NoticeMock };
});

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<typeof ObsidianModule>();
  return { ...actual, Notice: NoticeMock };
});

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
  NoticeMock.instances.length = 0;
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

  it("passes the plugin's manifest id as the Supercharged Links owner id, for both layouts (D1)", () => {
    const hookSpy = vi.spyOn(superchargedLinksModule, 'hookSuperchargedLinks');
    const app = App.createConfigured__({ files: { 'a.md': '' } });
    const { view } = createView(app, [mustFile(app, 'a.md')]);
    view.config.set('parent', 'note.parent');

    view.onDataUpdated();

    expect(hookSpy).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ ownerId: manifest.id }),
      expect.anything(),
      'a.bases-structure-title',
      'bases-structure-node',
    );

    hookSpy.mockClear();
    view.config.set('layout', 'outline');
    view.onDataUpdated();

    expect(hookSpy).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ ownerId: manifest.id }),
      expect.anything(),
      'a.bases-structure-title',
      'bases-structure-node',
    );
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

  it('destroys the graph renderer and builds the outline when the layout switches mid-session', () => {
    const app = App.createConfigured__({ files: { 'a.md': '' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'a.md')]);
    view.config.set('parent', 'note.parent');
    view.onDataUpdated();
    expect(parentEl.querySelector('.bases-structure-graph')).not.toBeNull();
    expect(parentEl.querySelector('.bases-structure-outline')).toBeNull();
    const graphDestroySpy = vi.spyOn(GraphRenderer.prototype, 'destroy');
    const outlineUpdateSpy = vi.spyOn(OutlineRenderer.prototype, 'update');

    view.config.set('layout', 'outline');
    view.onDataUpdated();

    expect(graphDestroySpy).toHaveBeenCalledTimes(1);
    expect(outlineUpdateSpy).toHaveBeenCalledTimes(1);
    expect(parentEl.querySelector('.bases-structure-graph')).toBeNull();
    expect(parentEl.querySelector('.bases-structure-outline')).not.toBeNull();
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
    // I11: one render for the plan's own optimistic prediction (shown before the write lands),
    // one for the commit's own refresh afterward — not a third, wasted one.
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it('a render error on the refresh after a successful commit shows the render failure, not "could not apply the change" (M11)', async () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    view.config.set('types', typesConfig);
    view.onDataUpdated();
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
    // The synchronous prefix above already ran the plan's own optimistic render (I11) — this fails
    // only the *next* one (the commit's own post-apply `refresh()`), not the one that already drew
    // the draft, nor the optimistic one just above.
    vi.spyOn(GraphRenderer.prototype, 'update').mockImplementationOnce(() => {
      throw new Error('render boom');
    });

    await vi.waitFor(() => {
      expect(app.vault.getFileByPath('New Leaf.md')).not.toBeNull();
    });

    // M11: `refresh` goes through `safeRender()`, so a render failure lands in the body exactly
    // like `onDataUpdated`'s own failures do — not wrapped in `commitAndNotify`'s generic
    // "could not apply the change" Notice, which only ever meant to cover `commitPlan` itself
    // throwing, not whatever the following render does.
    await vi.waitFor(() => {
      expect(parentEl.querySelector('.bases-structure-body')?.textContent).toBe(
        'Structure view failed: render boom',
      );
    });
    expect(
      NoticeMock.instances.some(
        (notice) =>
          typeof notice.message === 'string' && notice.message.includes('could not apply'),
      ),
    ).toBe(false);
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

// I11: the planner already verifies a plan by simulating it before this ever writes to the vault
// (`applyPlan`, see `src/core/simulate.ts`) — `StructureActions` shows that exact result through
// `ActionsDeps.showOptimistic` right after planning succeeds, and `StructureView` renders it until
// the next real `onDataUpdated` (from Bases) replaces it.
describe('StructureView — optimistic rendering (I11)', () => {
  const typesConfig = { Cat: { tag: 'cat', children: { Leaf: 'up' } }, Leaf: { tag: 'leaf' } };

  it('shows the planned create result immediately, before the vault write lands or Bases reports it', () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    view.config.set('types', typesConfig);
    view.onDataUpdated();
    parentEl
      .querySelector('.bases-structure-add')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const input = parentEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    if (input === null) {
      throw new Error('Test setup error: draft input did not open');
    }
    input.value = 'New Leaf';
    const updateSpy = vi.spyOn(GraphRenderer.prototype, 'update');

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    // Nothing async has run yet (no `await`, no `onDataUpdated`) — this is the plan's own
    // simulated result, shown synchronously right after it verified.
    expect(parentEl.querySelector('[data-path="New Leaf.md"]')).not.toBeNull();
    expect(updateSpy).toHaveBeenCalledTimes(1);

    return vi.waitFor(() => {
      expect(app.vault.getFileByPath('New Leaf.md')).not.toBeNull();
    });
  });

  it('onDataUpdated discards the optimistic prediction once real data arrives, even mid-commit', async () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    view.config.set('types', typesConfig);
    view.onDataUpdated();
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
    expect(parentEl.querySelector('[data-path="New Leaf.md"]')).not.toBeNull();

    await vi.waitFor(() => {
      expect(app.vault.getFileByPath('New Leaf.md')).not.toBeNull();
    });
    // The commit's own refresh already ran, but Bases' own `view.data` hasn't caught up yet — the
    // prediction is still what's shown.
    expect(parentEl.querySelector('[data-path="New Leaf.md"]')).not.toBeNull();

    // The Enter chain (U5) reopens a sibling draft immediately after commit — close it first so
    // the next onDataUpdated below isn't deferred by an unrelated open draft.
    parentEl
      .querySelector<HTMLInputElement>('.bases-structure-draft-input')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );

    // Bases finally pushes — still without the new note in its own result set (`view.data` is
    // unchanged) — proving the render that follows is real data, not a lingering prediction.
    view.onDataUpdated();

    expect(parentEl.querySelector('[data-path="New Leaf.md"]')).toBeNull();
  });

  // Reviewer regression (critical): undo is a real vault mutation, not a planned+simulated
  // action — `undoLast`/`runUndoFromNotice` never went through `showOptimistic`, so a stale
  // pre-undo prediction was left on screen indefinitely (until the next real `onDataUpdated`,
  // an unbounded wait). The normal flow this covers: commit, then undo, before Bases ever
  // reports the new note.
  it('undo clears the optimistic prediction — the rendered structure no longer shows the change that was just undone', async () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    document.body.appendChild(parentEl);
    view.config.set('types', typesConfig);
    view.onDataUpdated();
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
    // Still showing the optimistic prediction — Bases hasn't reported the new note yet.
    expect(parentEl.querySelector('[data-path="New Leaf.md"]')).not.toBeNull();

    // The Enter chain (U5) reopens a sibling draft immediately after commit — close it so Mod+Z
    // below reaches the container's own keydown handler instead of the draft input's typing guard.
    parentEl
      .querySelector<HTMLInputElement>('.bases-structure-draft-input')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );

    // The normal flow: undo right after the commit (Mod+Z — same `undoLast` a notice's own
    // button reaches), still before any real `onDataUpdated`.
    const bodyEl = parentEl.querySelector<HTMLElement>('.bases-structure-body');
    bodyEl?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => {
      expect(app.vault.getFileByPath('New Leaf.md')).toBeNull();
    });
    // Not the stale, already-undone prediction — the rendered structure must reflect the revert.
    expect(parentEl.querySelector('[data-path="New Leaf.md"]')).toBeNull();
  });
});

// Carried-over fix (task 14): `onDataUpdated` can fire while a create draft is open — e.g. the
// user's own metadata plugin filling fields into the note that was just created, which fires
// right when the chained sibling draft opens (see `structure-view.ts`'s file doc comment). Both
// renderers rebuild every node on `update()`, which would otherwise destroy the open draft's DOM,
// typed value and focus before `cancelDraft()` ever runs.
describe('StructureView — deferred render while a create draft is open', () => {
  const typesConfig = { Cat: { tag: 'cat', children: { Leaf: 'up' } }, Leaf: { tag: 'leaf' } };

  function openDraftView(app: App): TestView {
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    view.config.set('types', typesConfig);
    view.onDataUpdated();
    parentEl
      .querySelector('.bases-structure-add')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    if (parentEl.querySelector('.bases-structure-draft-input') === null) {
      throw new Error('Test setup error: draft input did not open');
    }
    return { view, parentEl };
  }

  it('defers a data update while the draft is open, keeping the draft element, its typed value and focus', () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = openDraftView(app);
    document.body.appendChild(parentEl);
    const input = parentEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    if (input === null) {
      throw new Error('Test setup error: draft input did not open');
    }
    input.value = 'Typed Name';
    input.focus();
    const updateSpy = vi.spyOn(GraphRenderer.prototype, 'update');

    view.onDataUpdated();

    expect(updateSpy).not.toHaveBeenCalled();
    expect(parentEl.querySelector('.bases-structure-draft-input')).toBe(input);
    expect(input.value).toBe('Typed Name');
    expect(document.activeElement).toBe(input);
  });

  it('performs exactly one render once the draft closes (Escape) after a deferred data update', () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = openDraftView(app);
    const input = parentEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    if (input === null) {
      throw new Error('Test setup error: draft input did not open');
    }
    // A data update arrives while the draft is open: deferred, not applied yet.
    view.onDataUpdated();
    const updateSpy = vi.spyOn(GraphRenderer.prototype, 'update');

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(parentEl.querySelector('.bases-structure-draft-input')).toBeNull();
  });

  it('the commit → chain flow reopens the sibling draft immediately after the commit’s own render, without waiting for the new note (U5)', async () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = openDraftView(app);
    const input = parentEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    if (input === null) {
      throw new Error('Test setup error: draft input did not open');
    }
    input.value = 'New Leaf';
    const updateSpy = vi.spyOn(GraphRenderer.prototype, 'update');

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => {
      expect(app.vault.getFileByPath('New Leaf.md')).not.toBeNull();
    });
    // Enter-mode's sibling chain only needs its own *parent* (`cat.md`), which already exists —
    // unlike a Tab chain (which reopens ON the new node itself, and so still has to wait for a
    // render that actually contains it), this reopens on the very first render after commit. One
    // render for the optimistic prediction (I11), one for the commit's own refresh.
    expect(updateSpy).toHaveBeenCalledTimes(2);
    const reopenedInput = parentEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    expect(reopenedInput).not.toBeNull();
    expect(reopenedInput).not.toBe(input);

    // Since the reopened draft above is itself now open, a later update is deferred until it
    // closes, same as any other open draft (see the "defers a data update" test above).
    view.data = {
      data: [mustFile(app, 'cat.md'), mustFile(app, 'New Leaf.md')].map((file) => ({ file })),
    } as unknown as BasesQueryResult;
    view.onDataUpdated();

    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it('the commit → Tab-chain flow reopens on the new node right away, from the optimistic prediction (I11 supersedes I7’s own wait)', async () => {
    // Unlike Enter's own chain (U5, above), Tab reopens *on* the newly created node itself — which
    // used to genuinely not exist in the render right after commit, so this had to wait for a
    // later render with real data (I7). Optimistic rendering (I11) removes that wait: the render
    // right after commit already shows the plan's own simulated result, which already contains the
    // new node.
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    view.config.set('types', {
      Cat: { tag: 'cat', children: { Leaf: 'up' } },
      Leaf: { tag: 'leaf', children: { Sub: 'up' } },
      Sub: { tag: 'sub' },
    });
    view.onDataUpdated();
    parentEl
      .querySelector('.bases-structure-add')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const input = parentEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    if (input === null) {
      throw new Error('Test setup error: draft input did not open');
    }
    input.value = 'New Leaf';
    const updateSpy = vi.spyOn(GraphRenderer.prototype, 'update');

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => {
      expect(app.vault.getFileByPath('New Leaf.md')).not.toBeNull();
    });
    // One render for the optimistic prediction, one for the commit's own refresh — both already
    // contain the new node, so the chain reopens on this first pass instead of waiting for Bases.
    expect(updateSpy).toHaveBeenCalledTimes(2);
    const reopenedInput = parentEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    expect(reopenedInput).not.toBeNull();
    expect(reopenedInput?.placeholder).toBe('Sub');

    // A later real onDataUpdated (Bases finally catching up) is deferred by the reopened draft,
    // same as any other open draft — it doesn't need to do anything here (already reopened above).
    view.data = {
      data: [mustFile(app, 'cat.md'), mustFile(app, 'New Leaf.md')].map((file) => ({ file })),
    } as unknown as BasesQueryResult;
    view.onDataUpdated();

    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it('merges a flushed deferred render with the commit’s own refresh into one, not two (I6)', async () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = openDraftView(app);
    const input = parentEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    if (input === null) {
      throw new Error('Test setup error: draft input did not open');
    }
    input.value = 'New Leaf';
    // An unrelated data update arrives while the draft is still open: deferred (the carried-over
    // fix this describe block is named for), not applied yet.
    view.onDataUpdated();
    const updateSpy = vi.spyOn(GraphRenderer.prototype, 'update');

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => {
      expect(app.vault.getFileByPath('New Leaf.md')).not.toBeNull();
    });

    // Before I6: closing the draft flushed the deferred render, and `runCommit`'s own explicit
    // `refresh()` ran again immediately after — same schema/snapshot/structure both times (nothing
    // else runs in between), pure waste. I6 skips the second one. The Enter chain reopening a
    // sibling draft (U5) straight after doesn't call `update()` again either — it's pure DOM, not a
    // render. So this stays at exactly two: one for the optimistic prediction (I11), one for the
    // merged flush/refresh — not three.
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(parentEl.querySelector('.bases-structure-draft-input')).not.toBeNull();
  });

  it('does not lose a pending render when the view unloads with the draft still open', () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    view.config.set('types', typesConfig);
    view.load();
    view.onDataUpdated();
    parentEl
      .querySelector('.bases-structure-add')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    if (parentEl.querySelector('.bases-structure-draft-input') === null) {
      throw new Error('Test setup error: draft input did not open');
    }
    // A data update arrives while the draft is open, right before the view unloads.
    view.onDataUpdated();
    const updateSpy = vi.spyOn(GraphRenderer.prototype, 'update');

    view.unload();

    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  // Regression: superseding a draft (a new "+" while one is already open) must not flush a
  // pending render — see `actions-ui.ts`'s `openDraft`/`teardownDraft`. Before that fix,
  // `openDraft`'s internal `cancelDraft()` call fired `onDraftClosed`, which flushed the deferred
  // render right there, rebuilding every node and detaching the second draft's own anchor before
  // `openDraft` got to attach the input to it — so the new draft's input never reached the live
  // DOM at all.
  it('supersedes an open draft with a new one while a render is deferred, keeping the second draft live and focused, and flushes exactly one render only once that draft finally closes', () => {
    const app = App.createConfigured__({
      files: { 'cat1.md': '---\ntags: [cat]\n---\n', 'cat2.md': '---\ntags: [cat]\n---\n' },
    });
    const { view, parentEl } = createView(app, [
      mustFile(app, 'cat1.md'),
      mustFile(app, 'cat2.md'),
    ]);
    document.body.appendChild(parentEl);
    view.config.set('types', typesConfig);
    view.onDataUpdated();

    // Draft A opens on cat1.
    findNode(parentEl, 'cat1.md')
      .querySelector('.bases-structure-add')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(parentEl.querySelector('.bases-structure-draft-input')).not.toBeNull();

    // A data update arrives while draft A is open: deferred, not applied yet.
    view.onDataUpdated();
    const updateSpy = vi.spyOn(GraphRenderer.prototype, 'update');

    // The user opens a second draft on cat2 instead of finishing the first one.
    findNode(parentEl, 'cat2.md')
      .querySelector('.bases-structure-add')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    // Superseding a draft is not a close: the pending render must still be deferred, and the new
    // draft's input must be live in the DOM, under cat2, and focused.
    expect(updateSpy).not.toHaveBeenCalled();
    const secondInput = parentEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    if (secondInput === null) throw new Error('Test setup error: second draft did not open');
    expect(findNode(parentEl, 'cat2.md').contains(secondInput)).toBe(true);
    expect(document.activeElement).toBe(secondInput);

    // Closing the second draft (Escape) finally ends the whole session: exactly one render flushes.
    secondInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(parentEl.querySelector('.bases-structure-draft-input')).toBeNull();
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

// Regression coverage for the removeChild/blur bug the C1 re-review found: `undoLast`,
// `runUndoFromNotice` (I1) and `commitAndNotify` (move/retype) all call `ActionsDeps.refresh`
// unconditionally once their own async work settles — before this fix, that rebuilt the whole DOM
// via `safeRender` even while an *unrelated* draft was open elsewhere, destroying its wrapper/input
// without going through `teardownDraft` (the only path that detaches the input's own blur
// listener first). The typed name was silently lost, and in a real browser the synchronous `blur`
// a detached-but-still-listening input fires re-entered `cancelDraft` → `teardownDraft` →
// `wrapperEl.remove()` mid-removal (`removeChild`: "the node to be removed is no longer a child of
// this node ... moved in a 'blur' event handler"). jsdom doesn't fire `blur` on removal (unlike a
// real browser), so these tests assert the observable contract instead: a settling action doesn't
// rebuild the DOM while a draft is open, and closing that draft afterward flushes exactly the one
// render that was owed.
describe('StructureView — actions defer their own refresh while an unrelated draft is open (removeChild/blur fix)', () => {
  const typesConfig = { Cat: { tag: 'cat', children: { Leaf: 'up' } }, Leaf: { tag: 'leaf' } };

  it('a settling move does not rebuild the DOM while an unrelated draft is open, and flushes exactly one render once that draft closes', async () => {
    const app = App.createConfigured__({
      files: {
        'cat1.md': '---\ntags: [cat]\n---\n',
        'cat2.md': '---\ntags: [cat]\n---\n',
        'leaf.md': '---\ntags: [leaf]\nup: "[[cat1]]"\n---\n',
      },
    });
    const attachDragSpy = vi.spyOn(dragModule, 'attachDrag').mockReturnValue(vi.fn());
    const { view, parentEl } = createView(app, [
      mustFile(app, 'cat1.md'),
      mustFile(app, 'cat2.md'),
      mustFile(app, 'leaf.md'),
    ]);
    document.body.appendChild(parentEl);
    view.config.set('types', typesConfig);
    view.onDataUpdated();
    const dragDeps = attachDragSpy.mock.calls[0]?.[0];
    if (dragDeps === undefined) throw new Error('Test setup error: attachDrag was not called');

    // Gate the move's own write so its commit stays "in flight" until the test releases it.
    let resolveWrite: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const originalProcessFrontMatter = app.fileManager.processFrontMatter.bind(app.fileManager);
    vi.spyOn(app.fileManager, 'processFrontMatter').mockImplementation(async (file, fn) => {
      await writeGate;
      return originalProcessFrontMatter(file, fn);
    });

    // Starts the move (leaf.md -> cat2.md) via the same path a real drag-drop uses — its own
    // `commitAndNotify` is now awaiting the gated write above.
    dragDeps.onDrop('leaf.md', 'cat2.md');

    // While that move is still in flight, the user opens an unrelated create draft and types.
    findNode(parentEl, 'cat1.md')
      .querySelector('.bases-structure-add')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const input = parentEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    if (input === null) throw new Error('Test setup error: draft input did not open');
    input.value = 'Should Survive The Settling Move';
    input.focus();
    expect(document.activeElement).toBe(input);
    const updateSpy = vi.spyOn(GraphRenderer.prototype, 'update');

    resolveWrite?.();
    await vi.waitFor(() => {
      const file = app.vault.getFileByPath('leaf.md');
      expect(file).not.toBeNull();
      if (file === null) return;
      expect(app.metadataCache.getFileCache(file)?.frontmatter?.['up']).toBe('[[cat2]]');
    });

    // The settling move's own `refresh()` must not have rebuilt the DOM out from under the open,
    // unrelated draft.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(parentEl.querySelector('.bases-structure-draft-input')).toBe(input);
    expect(input.value).toBe('Should Survive The Settling Move');
    expect(document.activeElement).toBe(input);

    // Closing the draft flushes exactly the one deferred render.
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(parentEl.querySelector('.bases-structure-draft-input')).toBeNull();
  });

  it('a settling undo (I1 — undoLast/runUndoFromNotice) does not rebuild the DOM while a draft is open, and flushes exactly one render once that draft closes', async () => {
    const app = App.createConfigured__({ files: { 'cat.md': '---\ntags: [cat]\n---\n' } });
    const { view, parentEl } = createView(app, [mustFile(app, 'cat.md')]);
    document.body.appendChild(parentEl);
    view.config.set('types', typesConfig);
    view.onDataUpdated();

    // Gate `UndoManager.undo()` so the undo triggered below stays "in flight" until released.
    let resolveUndo: ((result: { label: string | null; skipped: string[] }) => void) | undefined;
    const undoGate = new Promise<{ label: string | null; skipped: string[] }>((resolve) => {
      resolveUndo = resolve;
    });
    vi.spyOn(UndoManager.prototype, 'undo').mockReturnValue(undoGate);
    vi.spyOn(UndoManager.prototype, 'canUndo', 'get').mockReturnValue(true);

    // Mod+Z works without an active node (M7) — triggers `StructureActions.undoLast`, whose own
    // `undo.undo()` is now awaiting the gate above.
    const bodyEl = parentEl.querySelector<HTMLElement>('.bases-structure-body');
    bodyEl?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
    );

    // While that undo is still in flight, the user opens a create draft and types.
    findNode(parentEl, 'cat.md')
      .querySelector('.bases-structure-add')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const input = parentEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    if (input === null) throw new Error('Test setup error: draft input did not open');
    input.value = 'Should Survive The Settling Undo';
    input.focus();
    expect(document.activeElement).toBe(input);
    const updateSpy = vi.spyOn(GraphRenderer.prototype, 'update');

    resolveUndo?.({ label: 'Some earlier change', skipped: [] });
    await vi.waitFor(() => {
      expect(
        NoticeMock.instances.some(
          (notice) =>
            typeof notice.message === 'string' && notice.message.includes('Some earlier change'),
        ),
      ).toBe(true);
    });

    expect(updateSpy).not.toHaveBeenCalled();
    expect(parentEl.querySelector('.bases-structure-draft-input')).toBe(input);
    expect(input.value).toBe('Should Survive The Settling Undo');
    expect(document.activeElement).toBe(input);

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(parentEl.querySelector('.bases-structure-draft-input')).toBeNull();
  });
});

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

  it('plans a drag-triggered move against the vault as it is now, not the last render (I5)', async () => {
    // Changes "leaf.md"'s parent directly (bypassing the view) right after the one render this
    // test triggers — simulating an edit that lands between renders, which `onDataUpdated` never
    // gets called again for. A plan built from the stale last-render snapshot would still see
    // "leaf.md" under "cat1.md" and treat the drop below as a genuine (if redundant) cat1->cat2
    // move; `freshInput()` re-reads first and sees it's already under "cat2.md", rejecting it.
    const { view, parentEl, app } = twoParentsView();
    view.onDataUpdated();
    const sourceEl = findNode(parentEl, 'leaf.md');
    const targetEl = findNode(parentEl, 'cat2.md');
    const proto = document as unknown as { elementFromPoint?: (x: number, y: number) => Element };
    proto.elementFromPoint = () => targetEl;
    const leafFile = app.vault.getFileByPath('leaf.md');
    if (leafFile === null) {
      throw new Error('Test setup error: missing file "leaf.md"');
    }
    await app.fileManager.processFrontMatter(leafFile, (frontmatter: Record<string, unknown>) => {
      frontmatter['up'] = '[[cat2]]';
    });

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
        expect(
          NoticeMock.instances.some(
            (n) => typeof n.message === 'string' && n.message.includes('is already under'),
          ),
        ).toBe(true);
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

describe('StructureView — keyboard wiring', () => {
  const catLeafConfig = { Cat: { tag: 'cat', children: { Leaf: 'up' } }, Leaf: { tag: 'leaf' } };

  function catLeafView(): TestView & { app: App } {
    const app = App.createConfigured__({
      files: {
        'cat.md': '---\ntags: [cat]\n---\n',
        'leaf.md': '---\ntags: [leaf]\nup: "[[cat]]"\n---\n',
      },
    });
    const view = createView(app, [mustFile(app, 'cat.md'), mustFile(app, 'leaf.md')]);
    view.view.config.set('types', catLeafConfig);
    return { ...view, app };
  }

  // Two top-level "Cat" siblings (only one with a child) — needed for the collapse/refocus tests
  // below, which check that a following ArrowDown still moves the active node after a collapse:
  // `catLeafView`'s single top has nowhere to move to.
  function twoCatsView(): TestView & { app: App } {
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
    view.view.config.set('types', catLeafConfig);
    return { ...view, app };
  }

  it('attaches keyboard to the renderer container', () => {
    const disposeSpy = vi.fn();
    const attachKeyboardSpy = vi
      .spyOn(keyboardModule, 'attachKeyboard')
      .mockReturnValue(disposeSpy);
    const { view, parentEl } = catLeafView();

    view.onDataUpdated();

    expect(attachKeyboardSpy).toHaveBeenCalledTimes(1);
    const deps = attachKeyboardSpy.mock.calls[0]?.[0];
    expect(deps?.container).toBe(parentEl.querySelector('.bases-structure-body'));
  });

  it('wires open/addChild/movePicker/retype/undo to the matching StructureActions methods', () => {
    const attachKeyboardSpy = vi.spyOn(keyboardModule, 'attachKeyboard').mockReturnValue(vi.fn());
    const { view, parentEl } = catLeafView();
    view.onDataUpdated();
    const deps = attachKeyboardSpy.mock.calls[0]?.[0];
    if (deps === undefined) throw new Error('attachKeyboard was not called');
    const openNodeSpy = vi
      .spyOn(StructureActions.prototype, 'openNode')
      .mockImplementation(() => undefined);
    const startCreateSpy = vi
      .spyOn(StructureActions.prototype, 'startCreate')
      .mockImplementation(() => undefined);
    const startMovePickerSpy = vi
      .spyOn(StructureActions.prototype, 'startMovePicker')
      .mockImplementation(() => undefined);
    const startRetypeSpy = vi
      .spyOn(StructureActions.prototype, 'startRetype')
      .mockImplementation(() => undefined);
    const undoLastSpy = vi
      .spyOn(StructureActions.prototype, 'undoLast')
      .mockImplementation(() => undefined);
    const anchorEl = findNode(parentEl, 'leaf.md');

    deps.open('leaf.md', true);
    deps.addChild('leaf.md', anchorEl);
    deps.movePicker('leaf.md');
    deps.retype('leaf.md', anchorEl);
    deps.undo();

    expect(openNodeSpy).toHaveBeenCalledExactlyOnceWith('leaf.md', true);
    expect(startCreateSpy).toHaveBeenCalledExactlyOnceWith('leaf.md', anchorEl);
    expect(startMovePickerSpy).toHaveBeenCalledExactlyOnceWith('leaf.md');
    expect(startRetypeSpy).toHaveBeenCalledExactlyOnceWith('leaf.md', anchorEl);
    expect(undoLastSpy).toHaveBeenCalledTimes(1);
  });

  it('addSibling resolves the parent from the structure and calls startCreate anchored at it', () => {
    const attachKeyboardSpy = vi.spyOn(keyboardModule, 'attachKeyboard').mockReturnValue(vi.fn());
    const { view, parentEl } = catLeafView();
    view.onDataUpdated();
    const deps = attachKeyboardSpy.mock.calls[0]?.[0];
    if (deps === undefined) throw new Error('attachKeyboard was not called');
    const startCreateSpy = vi
      .spyOn(StructureActions.prototype, 'startCreate')
      .mockImplementation(() => undefined);
    const leafEl = findNode(parentEl, 'leaf.md');
    const catEl = findNode(parentEl, 'cat.md');

    deps.addSibling('leaf.md', leafEl);

    expect(startCreateSpy).toHaveBeenCalledExactlyOnceWith('cat.md', catEl);
  });

  it('addSibling shows a Notice instead when the node has no parent', () => {
    const attachKeyboardSpy = vi.spyOn(keyboardModule, 'attachKeyboard').mockReturnValue(vi.fn());
    const { view, parentEl } = catLeafView();
    view.onDataUpdated();
    const deps = attachKeyboardSpy.mock.calls[0]?.[0];
    if (deps === undefined) throw new Error('attachKeyboard was not called');
    const startCreateSpy = vi
      .spyOn(StructureActions.prototype, 'startCreate')
      .mockImplementation(() => undefined);
    const catEl = findNode(parentEl, 'cat.md');

    deps.addSibling('cat.md', catEl);

    expect(startCreateSpy).not.toHaveBeenCalled();
    expect(NoticeMock.instances).toHaveLength(1);
    expect(NoticeMock.instances[0]?.message).toBe(
      'Structure: "cat" has no parent to add a sibling to',
    );
  });

  it('disposes the previous attachment and re-attaches when the renderer is recreated (layout switch)', () => {
    const disposeSpy1 = vi.fn();
    const disposeSpy2 = vi.fn();
    const attachKeyboardSpy = vi
      .spyOn(keyboardModule, 'attachKeyboard')
      .mockReturnValueOnce(disposeSpy1)
      .mockReturnValueOnce(disposeSpy2);
    const { view } = catLeafView();
    view.onDataUpdated();
    expect(attachKeyboardSpy).toHaveBeenCalledTimes(1);
    expect(disposeSpy1).not.toHaveBeenCalled();

    view.config.set('layout', 'outline');
    view.onDataUpdated();

    expect(disposeSpy1).toHaveBeenCalledTimes(1);
    expect(attachKeyboardSpy).toHaveBeenCalledTimes(2);
    expect(disposeSpy2).not.toHaveBeenCalled();
  });

  it('does not recreate the renderer/keyboard attachment for a direction-only config change (U3)', () => {
    const disposeSpy = vi.fn();
    const attachKeyboardSpy = vi
      .spyOn(keyboardModule, 'attachKeyboard')
      .mockReturnValue(disposeSpy);
    const { view } = catLeafView();
    view.onDataUpdated();
    expect(attachKeyboardSpy).toHaveBeenCalledTimes(1);

    view.config.set('direction', 'down');
    view.onDataUpdated();

    expect(disposeSpy).not.toHaveBeenCalled();
    expect(attachKeyboardSpy).toHaveBeenCalledTimes(1);
  });

  it("getDirection reflects the graph's current Schema.direction (U3)", () => {
    const attachKeyboardSpy = vi.spyOn(keyboardModule, 'attachKeyboard').mockReturnValue(vi.fn());
    const { view } = catLeafView();
    view.onDataUpdated();
    const deps = attachKeyboardSpy.mock.calls[0]?.[0];
    if (deps === undefined) throw new Error('attachKeyboard was not called');
    expect(deps.getDirection()).toBe('right');

    view.config.set('direction', 'down');
    view.onDataUpdated();

    expect(deps.getDirection()).toBe('down');
  });

  it('getDirection always reports "right" for the outline, even with direction: down set directly (U3)', () => {
    const attachKeyboardSpy = vi.spyOn(keyboardModule, 'attachKeyboard').mockReturnValue(vi.fn());
    const { view } = catLeafView();
    view.config.set('layout', 'outline');
    view.config.set('direction', 'down');

    view.onDataUpdated();

    const deps = attachKeyboardSpy.mock.calls[0]?.[0];
    if (deps === undefined) throw new Error('attachKeyboard was not called');
    expect(deps.getDirection()).toBe('right');
  });

  it('disposes the keyboard attachment on unload', () => {
    const disposeSpy = vi.fn();
    vi.spyOn(keyboardModule, 'attachKeyboard').mockReturnValue(disposeSpy);
    const { view } = catLeafView();
    view.onDataUpdated();

    view.load();
    view.unload();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('drives a real click + Mod+Z end to end through the rendered DOM (no mocked attachKeyboard)', () => {
    const { view, parentEl } = catLeafView();
    view.onDataUpdated();
    const undoLastSpy = vi
      .spyOn(StructureActions.prototype, 'undoLast')
      .mockImplementation(() => undefined);
    const bodyEl = parentEl.querySelector('.bases-structure-body');
    if (bodyEl === null) throw new Error('missing body');
    const catEl = findNode(parentEl, 'cat.md');
    // Mod+Z only acts once a node is active — a real click (not a mock) is what sets it.
    catEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    bodyEl.dispatchEvent(event);

    expect(undoLastSpy).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('a real ArrowRight on the rendered body moves the active node end to end', () => {
    const { view, parentEl } = catLeafView();
    view.onDataUpdated();
    const bodyEl = parentEl.querySelector('.bases-structure-body');
    if (bodyEl === null) throw new Error('missing body');
    const catEl = findNode(parentEl, 'cat.md');
    catEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    bodyEl.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );

    expect(
      parentEl.querySelector('.bases-structure-node.is-active')?.getAttribute('data-path'),
    ).toBe('leaf.md');
  });

  it('a real Space on the rendered body collapses the active branch through the renderer’s own cheap update, not a full render (I6)', () => {
    // Unlike pure navigation, collapse/expand does re-draw (there's no "already-rendered node" to
    // just patch in place — a collapse changes *which* nodes are rendered at all), so this
    // exercises `attachStructureKeyboard`'s real `renderCollapse` closure end to end, not a mock —
    // but (I6) that closure calls `renderer.update(this.lastInput)` directly, not `this.render()`:
    // `parseSchema` (called exactly once per full render, by `computeCurrentData`, and nowhere
    // else in production code — see the grep this assertion stands in for) must not run again for
    // a pure collapse/expand.
    const { view, parentEl } = catLeafView();
    view.onDataUpdated();
    const parseSchemaSpy = vi.spyOn(schemaModule, 'parseSchema');
    const bodyEl = parentEl.querySelector('.bases-structure-body');
    if (bodyEl === null) throw new Error('missing body');
    const catEl = findNode(parentEl, 'cat.md');
    catEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(parentEl.querySelector('[data-path="leaf.md"]')).not.toBeNull();
    parseSchemaSpy.mockClear();

    bodyEl.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );

    expect(parseSchemaSpy).not.toHaveBeenCalled();
    expect(parentEl.querySelector('[data-path="leaf.md"]')).toBeNull();
    expect(
      parentEl.querySelector('.bases-structure-node.is-active')?.getAttribute('data-path'),
    ).toBe('cat.md');
  });

  // Regression: a collapse/expand always re-draws through `renderCollapse` (the renderer's own
  // `update()`, since I6 — see the test above), which rebuilds every node element — including the
  // active node's own, even though `state.active` itself doesn't change. Before this fix, real DOM
  // focus silently fell back to `document.body` afterward (the
  // renderer only re-focused when the *active path* changed), so the very next keydown — dispatched
  // on `document.activeElement`, as a real keypress would be, not on `bodyEl` directly — no longer
  // reached the container's delegated listener at all. Drives every step through
  // `document.activeElement` rather than `bodyEl` specifically, to exercise the same path a real
  // keyboard interaction does (the CLI manual check that missed this dispatched on the body, which
  // is why it didn't surface).
  //
  // Two consecutive toggles, not one: a click-driven `setActive` no longer touches the renderer at
  // all (see the toggle-click fix above), so the renderer's own `lastActivePath` bookkeeping is
  // still `null` going into the *first* refresh — that one refocuses "by accident" (`'cat1.md' !==
  // null`) even without this round's fix. Only the *second* toggle, once `lastActivePath` already
  // equals the (unchanged) active path, actually exercises the bug.
  it.each([
    { key: ' ', layout: undefined, label: 'graph, Space' },
    { key: ' ', layout: 'outline', label: 'outline, Space' },
    { key: 'ArrowLeft', layout: undefined, label: 'graph, ArrowLeft' },
    { key: 'ArrowLeft', layout: 'outline', label: 'outline, ArrowLeft' },
  ])(
    'two consecutive real collapses ($label) keep real focus on the rebuilt active node, and a following ArrowDown still moves it',
    ({ key, layout }) => {
      const { view, parentEl } = twoCatsView();
      // `.focus()` is a no-op on an element that isn't connected to `document` — needed here
      // (unlike most of this file's other tests) because this one actually checks
      // `document.activeElement`, not just classes/attributes.
      document.body.appendChild(parentEl);
      if (layout !== undefined) {
        view.config.set('layout', layout);
      }
      view.onDataUpdated();
      findNode(parentEl, 'cat1.md').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      expect(document.activeElement).toBe(findNode(parentEl, 'cat1.md'));
      expect(parentEl.querySelector('[data-path="leaf.md"]')).not.toBeNull();

      // First toggle: collapses cat1 (still refocuses even pre-fix, see the comment above).
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
      expect(parentEl.querySelector('[data-path="leaf.md"]')).toBeNull();

      // Second toggle: expands cat1 again — `lastActivePath` already matches, so this is the one
      // that actually needs the fix to keep real focus following the rebuilt node.
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
      expect(parentEl.querySelector('[data-path="leaf.md"]')).not.toBeNull();
      const rebuiltCat1El = findNode(parentEl, 'cat1.md');
      expect(document.activeElement).toBe(rebuiltCat1El);

      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );

      expect(
        parentEl.querySelector('.bases-structure-node.is-active')?.getAttribute('data-path'),
      ).toBe('cat2.md');
    },
  );

  // Regression: a toggle click bubbles from the renderer's own delegated click handler (which
  // already re-renders locally to reflect the collapse change) all the way up to `attachKeyboard`'s
  // click listener on `bodyEl` (which also matches the same node, via `closest`). Before this fix,
  // that second listener unconditionally called `deps.refresh()` — the full `StructureView.render()`
  // pipeline — on top of the renderer's own cheap `update()`, so a single toggle click always
  // produced two `update()` calls.
  it.each([
    { layout: undefined, RendererClass: GraphRenderer, label: 'graph' },
    { layout: 'outline', RendererClass: OutlineRenderer, label: 'outline' },
  ])(
    'a real toggle click on the $label renderer causes exactly one update and makes that node active',
    ({ layout, RendererClass }) => {
      const { view, parentEl } = catLeafView();
      if (layout !== undefined) {
        view.config.set('layout', layout);
      }
      view.onDataUpdated();
      const updateSpy = vi.spyOn(RendererClass.prototype, 'update');
      const toggle = findNode(parentEl, 'cat.md').querySelector<HTMLElement>(
        '.bases-structure-toggle',
      );
      if (toggle === null) throw new Error('Test setup error: missing toggle on cat.md');

      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(findNode(parentEl, 'cat.md').classList.contains('is-active')).toBe(true);
    },
  );

  // Reviewer regression (important): pressing Tab on the active node opens a create-child draft
  // anchored *on that same node* — `commitWithOptimism`'s own open-draft-gate bypass render (I11)
  // then runs while `state.active` still names it, and the renderer's usual "focus follows the
  // active node" logic (`applyActiveState`) steals real DOM focus from the draft's own input to
  // the node div. Masked on a successful commit (the chain reopen's own `.focus()` overwrites it
  // right after) — a failed commit leaves the draft open with nothing to refocus it.
  it('a failed commit from a Tab-opened child draft does not steal focus from the draft input (I11)', async () => {
    const { view, parentEl } = catLeafView();
    document.body.appendChild(parentEl);
    view.onDataUpdated();
    findNode(parentEl, 'cat.md').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(findNode(parentEl, 'cat.md'));

    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    const input = parentEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    if (input === null) {
      throw new Error('Test setup error: draft input did not open');
    }
    input.value = 'New Leaf';
    input.focus();
    expect(document.activeElement).toBe(input);

    // Forces a genuine throw (not `commitPlan`'s own graceful `applied: false`) so the draft is
    // left open, uncleared, with nothing to refocus it afterward.
    vi.spyOn(UndoManager.prototype, 'push').mockImplementation(() => {
      throw new Error('push boom');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
    });
    expect(parentEl.querySelector('.bases-structure-draft-input')).toBe(input);
    expect(document.activeElement).toBe(input);
  });
});

// A minimal concrete `FileView` standing in for the built-in, non-`MarkdownView` `FileView`
// subclass a directly-opened `.base` file's own leaf really uses (see `root-finder.test.ts`'s
// identical helper/doc comment — duplicated here rather than shared, matching this project's
// existing pattern of each view-level test file owning its own small View mocks).
class TestFileView extends FileView {
  getViewType(): string {
    return 'test-file-view';
  }
}

/** Attaches `parentEl` (a `StructureView`'s own root container) inside a `FileView` leaf backed
 * by `basePath` — simulates the view being opened directly (no host markdown note at all), the
 * one case `findHostFile` alone can't key UI state by (I9). */
function attachAsDirectBaseLeaf(app: App, parentEl: HTMLElement, basePath: string): void {
  const leaf = app.workspace.getLeaf(true);
  const view = new TestFileView(leaf);
  const file = app.vault.getFileByPath(basePath);
  if (file === null) {
    throw new Error(`Test setup error: missing file "${basePath}"`);
  }
  view.file = file;
  leaf.view = view.asOriginalType4__();
  view.containerEl.appendChild(parentEl);
}

/** Attaches `parentEl` inside a real `MarkdownView` leaf backed by `hostPath` — simulates the
 * ordinary embedded case (`findHostFile` resolves non-null), the state-key path I9 left
 * unchanged. */
function attachAsHostedMarkdownLeaf(app: App, parentEl: HTMLElement, hostPath: string): void {
  const leaf = app.workspace.getLeaf(true);
  const view = MarkdownView.create2__(leaf);
  const file = app.vault.getFileByPath(hostPath);
  if (file === null) {
    throw new Error(`Test setup error: missing file "${hostPath}"`);
  }
  view.file = file;
  leaf.view = view.asOriginalType7__();
  view.containerEl.appendChild(parentEl);
}

function zoomLabelOf(parentEl: HTMLElement): string | null {
  return parentEl.querySelector('.bases-structure-zoom-label')?.textContent ?? null;
}

describe('StructureView — UI state key includes the host note path when embedded (I9 baseline, unchanged)', () => {
  const catConfig = { Cat: { tag: 'cat' } };

  it('does not share zoom state between two different embedding host notes with the same (default, empty) view name', () => {
    const app = App.createConfigured__({
      files: {
        'cat.md': '---\ntags: [cat]\n---\n',
        'first-host.md': '',
        'second-host.md': '',
      },
    });

    const { view: viewA, parentEl: parentElA } = createView(app, [mustFile(app, 'cat.md')]);
    attachAsHostedMarkdownLeaf(app, parentElA, 'first-host.md');
    viewA.config.set('types', catConfig);
    viewA.onDataUpdated();
    const zoomInA = parentElA.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');
    if (zoomInA === null) throw new Error('Test setup error: missing zoom-in button');
    zoomInA.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(zoomLabelOf(parentElA)).not.toBe('100%');

    const { view: viewB, parentEl: parentElB } = createView(app, [mustFile(app, 'cat.md')]);
    attachAsHostedMarkdownLeaf(app, parentElB, 'second-host.md');
    viewB.config.set('types', catConfig);
    viewB.onDataUpdated();

    expect(zoomLabelOf(parentElB)).toBe('100%');
  });
});

describe('StructureView — UI state key includes the .base file path when opened directly (I9)', () => {
  const catConfig = { Cat: { tag: 'cat' } };

  it('does not share zoom state between two different directly-opened .base files with the same (default, empty) view name', () => {
    const app = App.createConfigured__({
      files: { 'cat.md': '---\ntags: [cat]\n---\n', 'first.base': '', 'second.base': '' },
    });

    const { view: viewA, parentEl: parentElA } = createView(app, [mustFile(app, 'cat.md')]);
    attachAsDirectBaseLeaf(app, parentElA, 'first.base');
    viewA.config.set('types', catConfig);
    viewA.onDataUpdated();
    const zoomInA = parentElA.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');
    if (zoomInA === null) throw new Error('Test setup error: missing zoom-in button');
    zoomInA.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(zoomLabelOf(parentElA)).not.toBe('100%');

    const { view: viewB, parentEl: parentElB } = createView(app, [mustFile(app, 'cat.md')]);
    attachAsDirectBaseLeaf(app, parentElB, 'second.base');
    viewB.config.set('types', catConfig);
    viewB.onDataUpdated();

    // Same empty view name, same schema, same host-less ("opened directly") shape — only the
    // `.base` file itself tells them apart; without that, view B would inherit view A's zoom.
    expect(zoomLabelOf(parentElB)).toBe('100%');
  });

  it('gives the same directly-opened .base file the same state key across two view instances (re-render, not a collision)', () => {
    const app = App.createConfigured__({
      files: { 'cat.md': '---\ntags: [cat]\n---\n', 'shared.base': '' },
    });

    const { view: viewA, parentEl: parentElA } = createView(app, [mustFile(app, 'cat.md')]);
    attachAsDirectBaseLeaf(app, parentElA, 'shared.base');
    viewA.config.set('types', catConfig);
    viewA.onDataUpdated();
    const zoomInA = parentElA.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');
    if (zoomInA === null) throw new Error('Test setup error: missing zoom-in button');
    zoomInA.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const zoomedLabel = zoomLabelOf(parentElA);
    expect(zoomedLabel).not.toBe('100%');

    const { view: viewB, parentEl: parentElB } = createView(app, [mustFile(app, 'cat.md')]);
    attachAsDirectBaseLeaf(app, parentElB, 'shared.base');
    viewB.config.set('types', catConfig);
    viewB.onDataUpdated();

    expect(zoomLabelOf(parentElB)).toBe(zoomedLabel);
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
