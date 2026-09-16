// Unit tests for `StructureActions` — the "+" create flow. `Notice` is replaced with a small
// hand-rolled mock (constructor args + a `hide` spy recorded per instance) so tests can inspect
// the message/fragment a call produced and simulate clicking a button inside it; everything else
// from `obsidian` (Menu, MenuItem, App, ...) stays the real `obsidian-test-mocks` implementation,
// same as `plan-applier.test.ts`.

import type * as ObsidianModule from 'obsidian';
import { App, Menu, type TFile } from 'obsidian-test-mocks/obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSchema, type Schema } from '../core/schema.js';
import { buildStructure } from '../core/structure.js';
import { readSnapshot } from '../obsidian/snapshot-reader.js';
import { UndoManager } from '../obsidian/undo-manager.js';
import { type ActionsDeps, StructureActions } from './actions-ui.js';
import type { RenderInput } from './structure-view.js';
import type { ViewUiState } from './view-state.js';

const { NoticeMock } = vi.hoisted(() => {
  class NoticeMock {
    static readonly instances: NoticeMock[] = [];
    readonly hide = vi.fn();
    readonly setMessage = vi.fn();
    readonly message: string | DocumentFragment;
    readonly duration: number | undefined;

    constructor(message: string | DocumentFragment, duration?: number) {
      this.message = message;
      this.duration = duration;
      NoticeMock.instances.push(this);
    }
  }
  return { NoticeMock };
});

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<typeof ObsidianModule>();
  return { ...actual, Notice: NoticeMock };
});

function schemaFrom(config: Record<string, unknown>): Schema {
  return parseSchema((key: string): unknown => config[key]).schema;
}

const SCHEMA_CONFIG = {
  types: {
    Cat: { tag: 'cat', children: { Leaf: 'up', Other: 'up' } },
    Leaf: { tag: 'leaf', children: { Sub: 'up' } },
    Other: { tag: 'other', children: { Sub2: 'up' } },
    Sub: { tag: 'sub' },
    Sub2: { tag: 'sub2' },
  },
};

const NODE_CLASS = 'bases-structure-node';
const ROOT_CLASS = 'bases-structure-body';

function mustFile(app: App, path: string): TFile {
  const file = app.vault.getFileByPath(path);
  if (file === null) {
    throw new Error(`Test setup error: missing file "${path}"`);
  }
  return file;
}

function makeState(): ViewUiState {
  return { collapsed: new Set(), zoom: 1, scrollLeft: 0, scrollTop: 0 };
}

/** A minimal stand-in for a renderer's DOM: one `.bases-structure-node[data-path]` per note the
 * schema/vault currently know about, inside a `.bases-structure-body` root — the same shape
 * `StructureActions` looks for when it re-anchors a chained draft after a refresh. Real renderers
 * rebuild every node from scratch on `update()`; this fake only *adds* nodes it hasn't seen yet,
 * which is all the chaining logic needs (it just needs a live element at the right `data-path`,
 * not renderer-faithful teardown/rebuild). */
function makeTree(paths: readonly string[]): {
  root: HTMLElement;
  nodes: Map<string, HTMLElement>;
} {
  const root = createDiv(ROOT_CLASS);
  const nodes = new Map<string, HTMLElement>();
  for (const path of paths) {
    const nodeEl = root.createDiv(NODE_CLASS, (el) => {
      el.setAttribute('data-path', path);
    });
    nodes.set(path, nodeEl);
  }
  return { root, nodes };
}

interface Harness {
  readonly app: App;
  readonly schema: Schema;
  readonly actions: StructureActions;
  readonly undo: UndoManager;
  readonly refresh: ReturnType<typeof vi.fn>;
  readonly root: HTMLElement;
  readonly nodes: Map<string, HTMLElement>;
  getInput(): RenderInput;
}

interface HarnessOptions {
  /** `false` mimics a `refresh` that never adds a DOM element for a newly created note (e.g. a
   * renderer pass that hasn't caught up yet) — used to exercise the "chained anchor can't be
   * found after refresh" defensive branch. Defaults to `true` (rebuilds like the fixture below
   * describes). */
  readonly rebuildTree?: boolean;
  readonly hostPath?: string;
}

/** Wires a real `StructureActions` against a real mock vault: `getInput` re-reads the vault
 * (via the production `readSnapshot`/`buildStructure`) on every call, so a note created mid-test
 * is immediately visible to the next `childOptions`/`planAction` call — and `refresh` grows the
 * fake tree (see `makeTree`) to include any note that doesn't have an element yet, standing in
 * for what a real renderer's `update()` would do. */
function makeHarness(files: Record<string, string>, options: HarnessOptions = {}): Harness {
  const app = App.createConfigured__({ files });
  const schema = schemaFrom(SCHEMA_CONFIG);
  const { root, nodes } = makeTree(Object.keys(files));
  const state = makeState();
  const rebuildTree = options.rebuildTree ?? true;

  function getInput(): RenderInput {
    const originalApp = app.asOriginalType__();
    const vaultFiles = app.vault.getMarkdownFiles().map((file) => file.asOriginalType2__());
    const snapshot = readSnapshot(originalApp, vaultFiles, null);
    const structure = buildStructure(schema, snapshot);
    return { schema, snapshot, structure, state };
  }

  const refresh = vi.fn(() => {
    if (!rebuildTree) {
      return;
    }
    for (const path of getInput().structure.nodes.keys()) {
      if (!nodes.has(path)) {
        const nodeEl = root.createDiv(NODE_CLASS, (el) => {
          el.setAttribute('data-path', path);
        });
        nodes.set(path, nodeEl);
      }
    }
  });

  const undo = new UndoManager(app.asOriginalType__());
  const deps: ActionsDeps = {
    app: app.asOriginalType__(),
    undo,
    getInput,
    hostPath: options.hostPath ?? '',
    refresh,
  };
  const actions = new StructureActions(deps);
  return { app, schema, actions, undo, refresh, root, nodes, getInput };
}

function baseFiles(): Record<string, string> {
  return {
    'cat.md': '---\ntags: [cat]\n---\n',
    'leaf.md': '---\ntags: [leaf]\nup: "[[cat]]"\n---\n',
    'other.md': '---\ntags: [other]\nup: "[[cat]]"\n---\n',
    'sub.md': '---\ntags: [sub]\nup: "[[leaf]]"\n---\n',
  };
}

function lastNotice(): (typeof NoticeMock.instances)[number] | undefined {
  return NoticeMock.instances[NoticeMock.instances.length - 1];
}

function draftInput(root: HTMLElement): HTMLInputElement {
  const inputEl = root.querySelector<HTMLInputElement>('.bases-structure-draft-input');
  if (inputEl === null) {
    throw new Error('Test setup error: no draft input in the tree');
  }
  return inputEl;
}

function pressKey(inputEl: HTMLInputElement, key: string): void {
  inputEl.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

afterEach(() => {
  NoticeMock.instances.length = 0;
  vi.restoreAllMocks();
});

describe('startCreate', () => {
  it('opens the draft input directly when exactly one type is allowed', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');

    h.actions.startCreate('leaf.md', leafEl);

    const inputEl = draftInput(h.root);
    expect(inputEl.placeholder).toBe('Sub');
    expect(leafEl.querySelector('.bases-structure-draft')).not.toBeNull();
  });

  it('shows a menu with one item per allowed type when several are allowed, and choosing one opens the draft', () => {
    const h = makeHarness(baseFiles());
    const catEl = h.nodes.get('cat.md');
    if (catEl === undefined) throw new Error('missing cat element');
    const showAtPositionSpy = vi
      .spyOn(Menu.prototype, 'showAtPosition')
      .mockImplementation(function (this: Menu) {
        return this;
      });

    h.actions.startCreate('cat.md', catEl);

    expect(showAtPositionSpy).toHaveBeenCalledTimes(1);
    const menu = showAtPositionSpy.mock.contexts[0] as Menu;
    expect(menu.items__.map((item) => item.title__)).toStrictEqual(['Leaf', 'Other']);
    menu.items__[0]?.onClick__?.(new MouseEvent('click'));

    const inputEl = draftInput(h.root);
    expect(inputEl.placeholder).toBe('Leaf');
  });

  it('shows the menu at the mouse event when one is provided', () => {
    const h = makeHarness(baseFiles());
    const catEl = h.nodes.get('cat.md');
    if (catEl === undefined) throw new Error('missing cat element');
    const showAtMouseEventSpy = vi
      .spyOn(Menu.prototype, 'showAtMouseEvent')
      .mockImplementation(function (this: Menu) {
        return this;
      });
    const event = new MouseEvent('click');

    h.actions.startCreate('cat.md', catEl, event);

    expect(showAtMouseEventSpy).toHaveBeenCalledExactlyOnceWith(event);
  });

  it('shows a Notice and opens no draft when nothing is allowed under the node', () => {
    const h = makeHarness(baseFiles());
    const subEl = h.nodes.get('sub.md');
    if (subEl === undefined) throw new Error('missing sub element');

    h.actions.startCreate('sub.md', subEl);

    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();
    expect(NoticeMock.instances).toHaveLength(1);
    expect(NoticeMock.instances[0]?.message).toBe('Structure: nothing can be added under "sub"');
  });

  it('cancels a previously open draft before opening a new one, so only one draft exists at a time', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    const otherEl = h.nodes.get('other.md');
    if (leafEl === undefined || otherEl === undefined) throw new Error('missing elements');

    h.actions.startCreate('leaf.md', leafEl);
    h.actions.startCreate('other.md', otherEl);

    const drafts = h.root.querySelectorAll('.bases-structure-draft');
    expect(drafts).toHaveLength(1);
    expect(otherEl.querySelector('.bases-structure-draft')).not.toBeNull();
    expect(leafEl.querySelector('.bases-structure-draft')).toBeNull();
  });
});

describe('draft cancellation', () => {
  it('Escape removes the draft', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);

    pressKey(draftInput(h.root), 'Escape');

    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();
  });

  it('blur removes the draft when no commit is in flight', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);

    draftInput(h.root).dispatchEvent(new Event('blur'));

    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();
  });

  it('blur is ignored while a commit is in flight', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    const inputEl = draftInput(h.root);
    inputEl.value = 'New Sub';

    pressKey(inputEl, 'Enter');
    inputEl.dispatchEvent(new Event('blur'));

    expect(h.root.querySelector('.bases-structure-draft-input')).toBe(inputEl);
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
  });

  it('ignores every other key, keeping the draft open and uncommitted', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    const inputEl = draftInput(h.root);
    inputEl.value = 'Still Typing';

    pressKey(inputEl, 'a');

    expect(h.root.querySelector('.bases-structure-draft-input')).toBe(inputEl);
    expect(h.refresh).not.toHaveBeenCalled();
  });
});

describe('commit — Enter', () => {
  it('is ignored for an empty (whitespace-only) name, keeping the draft open', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    const inputEl = draftInput(h.root);
    inputEl.value = '   ';

    pressKey(inputEl, 'Enter');

    expect(h.root.querySelector('.bases-structure-draft-input')).toBe(inputEl);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('creates the note with the recipe tag and the parent link, and pushes an undoable transaction', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    const inputEl = draftInput(h.root);
    inputEl.value = 'New Sub';

    pressKey(inputEl, 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });

    const file = mustFile(h.app, 'New Sub.md');
    const cache = h.app.metadataCache.getFileCache(file);
    expect(cache?.frontmatter?.['tags']).toStrictEqual(['sub']);
    expect(cache?.frontmatter?.['up']).toBe('[[leaf]]');
    expect(h.undo.canUndo).toBe(true);
  });

  it('shows a Notice with the planner reason and keeps the draft open when the plan is rejected', async () => {
    const files = { ...baseFiles(), 'Taken.md': '' };
    const h = makeHarness(files);
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    const inputEl = draftInput(h.root);
    inputEl.value = 'Taken';

    pressKey(inputEl, 'Enter');
    await vi.waitFor(() => {
      expect(NoticeMock.instances.length).toBeGreaterThan(0);
    });

    expect(NoticeMock.instances[0]?.message).toBe('Structure: A note already exists at "Taken.md"');
    expect(h.root.querySelector('.bases-structure-draft-input')).toBe(inputEl);
    expect(h.undo.canUndo).toBe(false);
  });

  it('reopens a draft on the same parent with the same type after a successful create (sibling chaining)', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'Sibling One';
    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });

    const reopened = leafEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    expect(reopened).not.toBeNull();
    expect(reopened?.placeholder).toBe('Sub');
  });
});

describe('commit — Tab', () => {
  it('commits the name and opens a draft on the newly created note (child chaining)', async () => {
    const h = makeHarness(baseFiles());
    const catEl = h.nodes.get('cat.md');
    if (catEl === undefined) throw new Error('missing cat element');
    const showAtPositionSpy = vi
      .spyOn(Menu.prototype, 'showAtPosition')
      .mockImplementation(function (this: Menu) {
        return this;
      });
    h.actions.startCreate('cat.md', catEl);
    const menu = showAtPositionSpy.mock.contexts[0] as Menu;
    menu.items__[0]?.onClick__?.(new MouseEvent('click'));
    const draftEl = draftInput(h.root);
    draftEl.value = 'Chain Leaf';

    pressKey(draftEl, 'Tab');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });

    const newNodeEl = h.nodes.get('Chain Leaf.md');
    expect(newNodeEl).toBeDefined();
    const reopened = newNodeEl?.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    expect(reopened?.placeholder).toBe('Sub');
  });

  it('does not open a new draft when the created note allows no children', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    const draftEl = draftInput(h.root);
    draftEl.value = 'Leaf Sub';

    // `Sub` (the type just created) has no schema children of its own, so the Tab chain has
    // nowhere to go: no draft should appear anywhere in the tree.
    pressKey(draftEl, 'Tab');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });

    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();
  });
});

describe('edge cases', () => {
  it('ignores a second Enter while the first commit is still in flight', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    const inputEl = draftInput(h.root);
    inputEl.value = 'Only Once';

    pressKey(inputEl, 'Enter');
    pressKey(inputEl, 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });

    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(
      h.app.vault.getMarkdownFiles().filter((file) => file.basename === 'Only Once'),
    ).toHaveLength(1);
  });

  it('writes the new note inside a non-root default folder derived from the host path', async () => {
    const files = { ...baseFiles(), 'folder/host.md': '' };
    const h = makeHarness(files, { hostPath: 'folder/host.md' });
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'Foldered';

    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });

    expect(h.app.vault.getFileByPath('folder/Foldered.md')).not.toBeNull();
  });

  it('still refreshes but skips the undo notice and chaining when commitPlan could not apply the plan', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    vi.spyOn(h.app.vault, 'create').mockRejectedValueOnce(new Error('disk full'));
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'Will Fail';

    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });

    // `commitPlan` itself already shows its own failure Notice (see plan-applier.ts) — no
    // "Created ..." undo notice on top of it, and no chained draft.
    expect(NoticeMock.instances.some((notice) => notice.message === 'Created "Will Fail"')).toBe(
      false,
    );
    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();
    // Nothing actually got written before `vault.create` rejected, so there's no transaction to
    // undo either — `commitPlan` only pushes when at least one step succeeded.
    expect(h.undo.canUndo).toBe(false);
  });

  it('logs and shows a Notice when committing throws synchronously', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    vi.spyOn(h.app.fileManager, 'getNewFileParent').mockImplementation(() => {
      throw new Error('boom');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'Boom';

    pressKey(draftInput(h.root), 'Enter');

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
    });
    expect(
      NoticeMock.instances.some(
        (notice) => notice.message === 'Structure: could not create the note. boom',
      ),
    ).toBe(true);
  });

  it('falls back to String(error) in the Notice when a non-Error value is thrown', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    vi.spyOn(h.app.fileManager, 'getNewFileParent').mockImplementation(() => {
      // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error -- exercising the non-`Error` fallback branch of this module's own `errorMessage` helper
      throw 'plain string boom';
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'Boom Two';

    pressKey(draftInput(h.root), 'Enter');

    await vi.waitFor(() => {
      expect(
        NoticeMock.instances.some(
          (notice) => notice.message === 'Structure: could not create the note. plain string boom',
        ),
      ).toBe(true);
    });
  });

  it('resets the committing lock after a thrown commit error, so a blur can cancel the draft', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    vi.spyOn(h.app.fileManager, 'getNewFileParent').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.actions.startCreate('leaf.md', leafEl);
    const inputEl = draftInput(h.root);
    inputEl.value = 'Boom Blur';

    pressKey(inputEl, 'Enter');
    await vi.waitFor(() => {
      expect(
        NoticeMock.instances.some(
          (notice) =>
            typeof notice.message === 'string' &&
            notice.message.includes('could not create the note'),
        ),
      ).toBe(true);
    });

    // Before the fix, `committing` stayed `true` forever once the commit threw, so blur (guarded
    // by `!committing`) silently did nothing and the draft was stuck open until Escape.
    inputEl.dispatchEvent(new Event('blur'));

    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();
  });

  it('resets the committing lock after a thrown commit error, so a second Enter can retry the commit', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    const getNewFileParentSpy = vi
      .spyOn(h.app.fileManager, 'getNewFileParent')
      .mockImplementationOnce(() => {
        throw new Error('boom');
      });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.actions.startCreate('leaf.md', leafEl);
    const inputEl = draftInput(h.root);
    inputEl.value = 'Retry Me';

    pressKey(inputEl, 'Enter');
    await vi.waitFor(() => {
      expect(getNewFileParentSpy).toHaveBeenCalledTimes(1);
    });
    // `mockImplementationOnce` only throws the first time — before the fix, `commitDraft` would
    // have silently ignored this second Enter because `committing` was never reset to `false`.
    pressKey(inputEl, 'Enter');

    await vi.waitFor(() => {
      expect(h.app.vault.getFileByPath('Retry Me.md')).not.toBeNull();
    });
  });

  it('does not resurrect a draft that was cancelled before its own commit attempt throws', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    vi.spyOn(h.app.fileManager, 'getNewFileParent').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.actions.startCreate('leaf.md', leafEl);
    const inputEl = draftInput(h.root);
    const selectSpy = vi.spyOn(inputEl, 'select');
    inputEl.value = 'Cancelled While Throwing';

    pressKey(inputEl, 'Enter');
    // Cancelled synchronously — before the rejected commit's `.catch()` runs as a microtask —
    // simulating Escape/blur racing a commit that's about to fail.
    h.actions.cancelDraft();

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
    });
    // The draft is already gone; the catch handler must not reset/reselect the discarded input.
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('does not reopen the chained sibling draft when the parent element cannot be relocated after refresh', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'Untraceable';
    // Simulates the parent note losing its DOM identity across the refresh (e.g. scrolled out of
    // a virtualised list) — `root` is still reachable from `anchorEl`, but nothing in it answers
    // to the old path any more, so the chain has nothing to re-anchor to.
    leafEl.removeAttribute('data-path');

    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });

    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();
  });

  it('does not reopen a chained sibling draft when the user cancelled it (Escape) while the commit was still in flight', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    const inputEl = draftInput(h.root);
    inputEl.value = 'Escaped Mid Commit';

    pressKey(inputEl, 'Enter');
    // Dispatched synchronously, before `commitPlan`'s promise settles — Escape isn't guarded by
    // `committing` (only blur is), so the draft closes right away while the commit keeps running
    // in the background.
    pressKey(inputEl, 'Escape');
    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();

    await vi.waitFor(() => {
      expect(h.app.vault.getFileByPath('Escaped Mid Commit.md')).not.toBeNull();
    });
    // The in-flight commit wasn't aborted (the note above proves it landed), but nothing should
    // have silently reopened a chained draft once it finished.
    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();
  });

  it('does not reopen the chained child draft when the created note has no element after refresh', async () => {
    const h = makeHarness(baseFiles(), { rebuildTree: false });
    const catEl = h.nodes.get('cat.md');
    if (catEl === undefined) throw new Error('missing cat element');
    const showAtPositionSpy = vi
      .spyOn(Menu.prototype, 'showAtPosition')
      .mockImplementation(function (this: Menu) {
        return this;
      });
    h.actions.startCreate('cat.md', catEl);
    const menu = showAtPositionSpy.mock.contexts[0] as Menu;
    menu.items__[0]?.onClick__?.(new MouseEvent('click'));
    draftInput(h.root).value = 'No Element';

    pressKey(draftInput(h.root), 'Tab');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });

    expect(h.app.vault.getFileByPath('No Element.md')).not.toBeNull();
    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();
  });

  it('does not reopen a draft when the committed anchor sits outside any rendered root', async () => {
    const h = makeHarness(baseFiles());
    const detachedEl = createDiv(NODE_CLASS, (el) => {
      el.setAttribute('data-path', 'leaf.md');
    });

    h.actions.startCreate('leaf.md', detachedEl);
    const inputEl = detachedEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    if (inputEl === null) throw new Error('missing draft input');
    inputEl.value = 'Orphaned';

    pressKey(inputEl, 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });

    expect(h.app.vault.getFileByPath('Orphaned.md')).not.toBeNull();
    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();
  });

  it('logs and shows a Notice when the undo triggered from the notice button rejects', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'Undo Fails';
    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    vi.spyOn(h.undo, 'undo').mockRejectedValueOnce(new Error('undo boom'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fragment = lastNotice()?.message as DocumentFragment;
    const button = fragment.querySelector<HTMLButtonElement>('.bases-structure-undo');

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
    });
    expect(NoticeMock.instances.some((notice) => notice.message === 'Structure: undo failed')).toBe(
      true,
    );
  });
});

describe('undo notice', () => {
  it('shows an undo notice on success whose button triggers undo and refresh', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'New Sub';
    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    const undoSpy = vi.spyOn(h.undo, 'undo');
    const notice = lastNotice();
    expect(notice).toBeDefined();
    expect(notice?.message).toBeInstanceOf(DocumentFragment);
    const fragment = notice?.message as DocumentFragment;
    const button = fragment.querySelector<HTMLButtonElement>('.bases-structure-undo');
    expect(button?.textContent).toBe('Undo');

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => {
      expect(undoSpy).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalledTimes(2);
    });
    expect(notice?.hide).toHaveBeenCalledTimes(1);
  });

  it('does not show an undo notice when the plan is rejected', async () => {
    const files = { ...baseFiles(), 'Taken.md': '' };
    const h = makeHarness(files);
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'Taken';

    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(NoticeMock.instances.length).toBeGreaterThan(0);
    });

    expect(NoticeMock.instances).toHaveLength(1);
  });
});

describe('destroy', () => {
  it('cancels the open draft', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);

    h.actions.destroy();

    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();
  });

  it('is a no-op when no draft is open', () => {
    const h = makeHarness(baseFiles());

    expect(() => {
      h.actions.destroy();
    }).not.toThrow();
  });
});

describe('consumeFocus', () => {
  it('returns null when nothing has been created yet', () => {
    const h = makeHarness(baseFiles());

    expect(h.actions.consumeFocus()).toBeNull();
  });

  it('returns the created path once after a successful create, then null', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'New Sub';

    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });

    expect(h.actions.consumeFocus()).toBe('New Sub.md');
    expect(h.actions.consumeFocus()).toBeNull();
  });
});
