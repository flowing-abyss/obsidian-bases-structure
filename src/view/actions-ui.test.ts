// Unit tests for `StructureActions` — the "+" create flow. `Notice` is replaced with a small
// hand-rolled mock (constructor args + a `hide` spy recorded per instance) so tests can inspect
// the message/fragment a call produced and simulate clicking a button inside it; everything else
// from `obsidian` (Menu, MenuItem, App, ...) stays the real `obsidian-test-mocks` implementation,
// same as `plan-applier.test.ts`.

import type * as ObsidianModule from 'obsidian';
import { App, Menu, Modal, type TFile } from 'obsidian-test-mocks/obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectDiagnostics } from '../core/diagnostics.js';
import { parseSchema, type Schema } from '../core/schema.js';
import type { Snapshot } from '../core/snapshot.js';
import { buildStructure } from '../core/structure.js';
import { readSnapshot } from '../obsidian/snapshot-reader.js';
import { UndoManager } from '../obsidian/undo-manager.js';
import { formatUndoResult, StructureActions, type ActionsDeps } from './actions-ui.js';
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
  return {
    collapsed: new Set(),
    zoom: 1,
    zoomTouched: false,
    scrollLeft: 0,
    scrollTop: 0,
    active: null,
  };
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
  readonly onDraftClosed: ReturnType<typeof vi.fn>;
  readonly showOptimistic: ReturnType<typeof vi.fn>;
  readonly clearOptimistic: ReturnType<typeof vi.fn>;
  readonly root: HTMLElement;
  readonly nodes: Map<string, HTMLElement>;
  getInput(): RenderInput;
  /** Advances what `refresh` renders from to the vault's current file list, then reruns it — the
   * harness's stand-in for a real `onDataUpdated` (I7): everything a create/move/retype writes is
   * visible to `getInput`/`freshInput` (and hence to planning) immediately, matching production's
   * `freshInput`, but `refresh` itself only ever "sees" what this has most recently been told
   * about, matching production's `this.data.data` — which Bases updates asynchronously, not in the
   * same tick as the vault write `commitPlan` just made. Without this distinction, a test can't
   * tell "chained/highlighted immediately" (the bug) apart from "chained/highlighted once the
   * following render actually contains the new note" (the fix). */
  simulateBasesUpdate(): void;
}

interface HarnessOptions {
  /** `false` mimics a render pass that never adds a DOM element for a path even once its
   * `Structure` contains it (e.g. a renderer that hasn't caught up yet) — used to exercise the
   * "chained anchor can't be found after refresh" defensive branch. Defaults to `true` (rebuilds
   * like the fixture below describes). */
  readonly rebuildTree?: boolean;
  readonly hostPath?: string;
  /** Defaults to `SCHEMA_CONFIG` — move/retype tests need shapes (a cascading `inherit` key, a
   * sibling type an item can retype into) that fixture doesn't have. */
  readonly schemaConfig?: Record<string, unknown>;
}

/** Wires a real `StructureActions` against a real mock vault. Two separate views of the vault are
 * modeled, matching production exactly (I7):
 * - `freshInput`/`deps.freshInput` always re-reads the vault right now (via the production
 *   `readSnapshot`/`buildStructure`), same as `StructureView.readFreshInput` — a note created
 *   mid-test is immediately visible to the next `planAction` call.
 * - `deps.getInput`/`refresh` build from `visiblePaths`, a set that only advances when the test
 *   calls `simulateBasesUpdate()` — the harness's model of `this.data.data`, which a real
 *   `StructureView.render()` reads from and which Bases itself only refreshes asynchronously.
 *   `refresh` grows the fake tree (see `makeTree`) to include any *visible* path that doesn't have
 *   an element yet (standing in for what a real renderer's `update()` would do), applies `is-new`
 *   via `actions.resolveFocus`, and always calls `actions.completePending` — exactly the sequence
 *   `structure-view.ts`'s `render()` runs, so a pending create/chain only actually completes once
 *   `simulateBasesUpdate()` has made its path visible. */
function makeHarness(files: Record<string, string>, options: HarnessOptions = {}): Harness {
  const app = App.createConfigured__({ files });
  const schema = schemaFrom(options.schemaConfig ?? SCHEMA_CONFIG);
  const { root, nodes } = makeTree(Object.keys(files));
  // Connected to the live document (unlike the rest of this fixture, which is otherwise a plain
  // in-memory tree) so `HTMLElement.isConnected` — which `handleDraftBlur`'s defence-in-depth guard
  // reads — matches production, where `.bases-structure-body` always is. Cleaned up in `afterEach`.
  document.body.appendChild(root);
  const state = makeState();
  const rebuildTree = options.rebuildTree ?? true;
  let visiblePaths = new Set(Object.keys(files));

  function buildInputFrom(paths: ReadonlySet<string>): RenderInput {
    const originalApp = app.asOriginalType__();
    const vaultFiles = app.vault
      .getMarkdownFiles()
      .filter((file) => paths.has(file.path))
      .map((file) => file.asOriginalType2__());
    const snapshot = readSnapshot(originalApp, vaultFiles, null);
    const structure = buildStructure(schema, snapshot);
    const diagnostics = collectDiagnostics(schema, snapshot, structure);
    return { schema, snapshot, structure, state, diagnostics };
  }

  function getInput(): RenderInput {
    return buildInputFrom(visiblePaths);
  }

  function freshInput(): RenderInput {
    return buildInputFrom(new Set(app.vault.getMarkdownFiles().map((file) => file.path)));
  }

  // `deps.refresh` needs to call the real `actions`'s `resolveFocus`/`completePending`, but
  // `actions` itself needs `deps` (hence `refresh`) to already exist to be constructed — this
  // mutable holder breaks that cycle: `refresh`'s closure reads `actionsHolder.current` at call
  // time (well after `actions` is constructed below, at actual test-code call time), while the
  // holder binding itself is still a plain `const`.
  const actionsHolder: { current: StructureActions | null } = { current: null };

  const refresh = vi.fn(() => {
    const actions = actionsHolder.current;
    if (actions === null) {
      return;
    }
    const input = getInput();
    const focusPath = actions.resolveFocus(input.structure);
    if (rebuildTree) {
      for (const path of input.structure.nodes.keys()) {
        let nodeEl = nodes.get(path);
        if (nodeEl === undefined) {
          nodeEl = root.createDiv(NODE_CLASS, (el) => {
            el.setAttribute('data-path', path);
          });
          nodes.set(path, nodeEl);
        }
        nodeEl.classList.toggle('is-new', path === focusPath);
      }
    }
    actions.completePending(input.structure, root);
  });

  const undo = new UndoManager(app.asOriginalType__());
  const onDraftClosed = vi.fn();
  const showOptimistic = vi.fn();
  const clearOptimistic = vi.fn();
  const deps: ActionsDeps = {
    app: app.asOriginalType__(),
    undo,
    getInput,
    freshInput,
    hostPath: options.hostPath ?? '',
    refresh,
    showOptimistic,
    clearOptimistic,
    onDraftClosed,
  };
  const actions = new StructureActions(deps);
  actionsHolder.current = actions;
  return {
    app,
    schema,
    actions,
    undo,
    refresh,
    onDraftClosed,
    showOptimistic,
    clearOptimistic,
    root,
    nodes,
    getInput,
    simulateBasesUpdate: () => {
      visiblePaths = new Set(app.vault.getMarkdownFiles().map((file) => file.path));
      refresh();
    },
  };
}

function baseFiles(): Record<string, string> {
  return {
    'cat.md': '---\ntags: [cat]\n---\n',
    'leaf.md': '---\ntags: [leaf]\nup: "[[cat]]"\n---\n',
    'other.md': '---\ntags: [other]\nup: "[[cat]]"\n---\n',
    'sub.md': '---\ntags: [sub]\nup: "[[leaf]]"\n---\n',
  };
}

/** Category/Meta/Hierarchy, `category` inherited through `meta` — a small version of the real
 * vault schema's cascade (see the design spec's "Действия: одно ядро" and the manual check),
 * small enough to assert exact frontmatter on both the moved note and one cascaded descendant. */
const MOVE_SCHEMA_CONFIG = {
  inherit: ['category'],
  types: {
    Category: { tag: 'category', children: { Meta: 'category', Hierarchy: 'category' } },
    Meta: { tag: 'meta', children: { Hierarchy: 'meta' } },
    Hierarchy: { tag: 'hierarchy' },
  },
};

function moveFiles(): Record<string, string> {
  return {
    'cat1.md': '---\ntags: [category]\n---\n',
    'cat2.md': '---\ntags: [category]\n---\n',
    'meta.md': '---\ntags: [meta]\ncategory: "[[cat1]]"\n---\n',
    'child.md': '---\ntags: [hierarchy]\nmeta: "[[meta]]"\ncategory: "[[cat1]]"\n---\n',
  };
}

/** Category/Meta/Hier, `category` inherited through `meta`, plus a Hier -> Hier "up" property so
 * a cascade can be exercised without a text-based edge. `bad.md` disagrees with `m.md`'s own
 * category; `child.md` nests under `bad.md` and, before any fix, merely mirrors `bad.md`'s own
 * (wrong) value; `ok.md` already matches `m.md`. */
const FIX_INHERIT_SCHEMA_CONFIG = {
  inherit: ['category'],
  types: {
    Category: { tag: 'category', children: { Meta: 'category' } },
    Meta: { tag: 'meta', children: { Hier: 'meta' } },
    Hier: { tag: 'hier', children: { Hier: 'up' } },
  },
};

function fixInheritFiles(): Record<string, string> {
  return {
    'cat1.md': '---\ntags: [category]\n---\n',
    'm.md': '---\ntags: [meta]\ncategory: "[[cat1]]"\n---\n',
    'wrong.md': '---\n---\n',
    'bad.md': '---\ntags: [hier]\nmeta: "[[m]]"\ncategory: "[[wrong]]"\n---\n',
    'child.md': '---\ntags: [hier]\nup: "[[bad]]"\ncategory: "[[wrong]]"\n---\n',
    'ok.md': '---\ntags: [hier]\nmeta: "[[m]]"\ncategory: "[[cat1]]"\n---\n',
  };
}

/** Cat with two sibling child types (A, B) that don't accept each other's children — enough to
 * exercise both a real retype (`item.md`: A → B) and an empty-`retypeOptions` node (`cat.md`
 * itself, whose only child would fail under either sibling type). */
const RETYPE_SCHEMA_CONFIG = {
  types: {
    Cat: { tag: 'cat', children: { A: 'up', B: 'up' } },
    A: { tag: 'a' },
    B: { tag: 'b' },
  },
};

function retypeFiles(): Record<string, string> {
  return {
    'cat.md': '---\ntags: [cat]\n---\n',
    'item.md': '---\ntags: [a]\nup: "[[cat]]"\n---\n',
  };
}

/** Two parents shaped so a drop-drag-convert can land on either a "several fit" or a "single fit"
 * case with no extra schema config per test: `cat.md` (Cat) accepts Leaf/A/B, so dropping the
 * Leaf-typed `leaf.md` there excludes only its own current type, leaving two candidates (A, B);
 * `solo.md` (Solo) accepts only A/B, so dropping the B-typed `b.md` there excludes B, leaving
 * exactly one (A). */
const CONVERT_SCHEMA_CONFIG = {
  types: {
    Cat: { tag: 'cat', children: { Leaf: 'up', A: 'up', B: 'up' } },
    Solo: { tag: 'solo', children: { A: 'up', B: 'up' } },
    Leaf: { tag: 'leaf' },
    A: { tag: 'a' },
    B: { tag: 'b' },
  },
};

function convertFiles(): Record<string, string> {
  return {
    'cat.md': '---\ntags: [cat]\n---\n',
    'solo.md': '---\ntags: [solo]\n---\n',
    'leaf.md': '---\ntags: [leaf]\nup: "[[cat]]"\n---\n',
    'b.md': '---\ntags: [b]\nup: "[[cat]]"\n---\n',
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

/** `makeTree`'s nodes are bare `[data-path]` divs (all the chaining logic needs); the
 * `is-drafting` layout tests need a node that actually looks like a renderer's own output — a
 * collapse toggle, a title, the "+" button and an alsoIn chip — since the whole point of
 * `is-drafting` is hiding those specific siblings while a draft is open. */
function attachRendererChildren(nodeEl: HTMLElement): void {
  const toggle = createEl('button', { cls: 'bases-structure-toggle' });
  nodeEl.prepend(toggle);
  nodeEl.createEl('a', { cls: 'bases-structure-title', text: 'Leaf' });
  nodeEl.createEl('button', { cls: 'bases-structure-add' });
  nodeEl.createSpan({ cls: 'bases-structure-alsoin', text: 'also in' });
}

afterEach(() => {
  NoticeMock.instances.length = 0;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
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

    h.actions.startCreate('cat.md', catEl, undefined, event);

    expect(showAtMouseEventSpy).toHaveBeenCalledExactlyOnceWith(event);
  });

  it('positions the type menu at the "+" button’s own rect, not the (much wider) node’s (U1)', () => {
    const h = makeHarness(baseFiles());
    const catEl = h.nodes.get('cat.md');
    if (catEl === undefined) throw new Error('missing cat element');
    attachRendererChildren(catEl);
    const buttonEl = catEl.querySelector<HTMLElement>('.bases-structure-add');
    if (buttonEl === null) throw new Error('missing add button');
    // Deliberately different rects: before U1, the menu used `anchorEl` (the whole node) even
    // when a button was available — this fails unless the button's own numbers are the ones used.
    vi.spyOn(catEl, 'getBoundingClientRect').mockReturnValue({
      left: 5,
      bottom: 10,
    } as DOMRect);
    vi.spyOn(buttonEl, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      bottom: 200,
    } as DOMRect);
    const showAtPositionSpy = vi
      .spyOn(Menu.prototype, 'showAtPosition')
      .mockImplementation(function (this: Menu) {
        return this;
      });

    h.actions.startCreate('cat.md', catEl, buttonEl);

    expect(showAtPositionSpy).toHaveBeenCalledExactlyOnceWith(
      { x: 100, y: 204 },
      buttonEl.ownerDocument,
    );
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

describe('is-drafting node state', () => {
  it('marks the node is-drafting and keeps its toggle/title/add/alsoIn siblings in the DOM (CSS hides them) when opening a draft on a node that has them', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    attachRendererChildren(leafEl);

    h.actions.startCreate('leaf.md', leafEl);

    expect(leafEl.classList.contains('is-drafting')).toBe(true);
    expect(leafEl.querySelector('.bases-structure-toggle')).not.toBeNull();
    expect(leafEl.querySelector('.bases-structure-title')).not.toBeNull();
    expect(leafEl.querySelector('.bases-structure-add')).not.toBeNull();
    expect(leafEl.querySelector('.bases-structure-alsoin')).not.toBeNull();
    expect(leafEl.querySelector('.bases-structure-draft-input')).not.toBeNull();
  });

  it('cancelling (Escape) removes is-drafting from the node', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    attachRendererChildren(leafEl);
    h.actions.startCreate('leaf.md', leafEl);
    expect(leafEl.classList.contains('is-drafting')).toBe(true);

    pressKey(draftInput(h.root), 'Escape');

    expect(leafEl.classList.contains('is-drafting')).toBe(false);
  });

  it('committing removes is-drafting from the node once nothing chains back onto it', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    attachRendererChildren(leafEl);
    h.actions.startCreate('leaf.md', leafEl);
    expect(leafEl.classList.contains('is-drafting')).toBe(true);
    const draftEl = draftInput(h.root);
    draftEl.value = 'Leaf Sub';

    // Tab-chains onto the newly created `Sub` note, which has no schema children of its own (see
    // "does not open a new draft..." below) — so, unlike Enter's same-parent chaining, nothing
    // reopens a draft on `leafEl` itself and `is-drafting` should end up removed for good.
    pressKey(draftEl, 'Tab');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });

    expect(leafEl.classList.contains('is-drafting')).toBe(false);
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

  it('a blur dispatched on a detached draft input does not throw and does not call teardown twice (defence in depth)', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    const inputEl = draftInput(h.root);
    const wrapperEl = inputEl.closest('.bases-structure-draft');
    if (wrapperEl === null) throw new Error('missing draft wrapper');
    // Simulates the exact scenario `deferrableRender` (structure-view.ts) now prevents: a render
    // elsewhere removed the wrapper directly, bypassing `teardownDraft` — so the input's own blur
    // listener is still attached when the removal's blur fires. Kept as a regression guard even
    // though jsdom (unlike a real browser) doesn't fire blur on removal by itself.
    wrapperEl.remove();

    expect(() => {
      inputEl.dispatchEvent(new Event('blur'));
    }).not.toThrow();

    expect(h.onDraftClosed).not.toHaveBeenCalled();
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

  it('reopens a sibling draft on the same parent immediately after the commit’s own render, without waiting for Bases to catch up with the new note (U5)', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'Sibling One';
    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });

    // Enter-mode only needs its own *parent* (`leaf.md`), which already exists right now — unlike
    // Tab-mode (which reopens ON the new node itself, and so still has to wait — see the Tab
    // describe block's own I7 test), this must not need `simulateBasesUpdate()` at all.
    expect(h.app.vault.getFileByPath('Sibling One.md')).not.toBeNull();
    const reopened = leafEl.querySelector<HTMLInputElement>('.bases-structure-draft-input');
    expect(reopened).not.toBeNull();
    expect(reopened?.placeholder).toBe('Sub');
  });

  it('still applies is-new to the created note once Bases catches up, even though the sibling draft already reopened (U5)', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'Sibling One';
    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });
    expect(h.root.querySelector('.is-new')).toBeNull();

    h.simulateBasesUpdate();

    const newEl = h.nodes.get('Sibling One.md');
    expect(newEl?.classList.contains('is-new')).toBe(true);
  });
});

describe('commit — Tab', () => {
  it('does nothing on the refresh that runs before Bases has caught up with the new note — the chain is still pending (I7)', async () => {
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

    // This is the reviewer's original repro (I7): before this fix, `refresh()` reading from a
    // structure that doesn't have the new note yet meant Tab-chaining silently did nothing, ever.
    expect(h.nodes.get('Chain Leaf.md')).toBeUndefined();
    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();
  });

  it('commits the name and opens a draft on the newly created note once it becomes visible (child chaining)', async () => {
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
    h.simulateBasesUpdate();

    const newNodeEl = h.nodes.get('Chain Leaf.md');
    expect(newNodeEl).toBeDefined();
    expect(newNodeEl?.classList.contains('is-new')).toBe(true);
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
    // nowhere to go: no draft should appear anywhere in the tree, before or after Bases catches up.
    pressKey(draftEl, 'Tab');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });
    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();

    h.simulateBasesUpdate();

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

  it('does not reopen the chained child draft when the created note still has no element once it becomes visible', async () => {
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

    // The new note is now visible in `Structure` (so the pending chain does attempt to complete),
    // but `rebuildTree: false` means no DOM element was ever built for it — `continueChain`'s own
    // "anchor not found" guard is what has to stop it here, not "nothing was pending yet".
    h.simulateBasesUpdate();

    expect(h.root.querySelector('.bases-structure-draft')).toBeNull();
  });

  it('drops a pending chain when a new "+" starts before the created note becomes visible (the next user action cancels it)', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    const otherEl = h.nodes.get('other.md');
    if (leafEl === undefined || otherEl === undefined) throw new Error('missing elements');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'Pending Chain';
    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });

    // A new "+" opened elsewhere before Bases ever reports the earlier create becoming visible —
    // per the decision ("the next user action ... cancels it"), the still-pending chain is
    // dropped, so it can never reopen (and, worse, tear down this unrelated draft) later once the
    // created note does show up.
    h.actions.startCreate('other.md', otherEl);

    h.simulateBasesUpdate();

    expect(leafEl.querySelector('.bases-structure-draft-input')).toBeNull();
    expect(otherEl.querySelector('.bases-structure-draft-input')).not.toBeNull();
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

  // I11 regression: same fix as `undoLast`'s own — the notice's own undo button is the other real
  // entry point that mutates the vault directly, not through `showOptimistic`.
  it('clears the optimistic prediction once the notice’s own undo actually reverts something', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'New Sub';
    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.app.vault.getFileByPath('New Sub.md')).not.toBeNull();
    });
    h.clearOptimistic.mockClear();
    const fragment = lastNotice()?.message as DocumentFragment;
    const button = fragment.querySelector<HTMLButtonElement>('.bases-structure-undo');

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => {
      expect(h.clearOptimistic).toHaveBeenCalledTimes(1);
    });
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

describe('hasOpenDraft / onDraftClosed — carried-over fix: keep an open create draft alive across background renders', () => {
  it('hasOpenDraft is false with no draft, true once one opens, false again once it closes', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    expect(h.actions.hasOpenDraft).toBe(false);

    h.actions.startCreate('leaf.md', leafEl);
    expect(h.actions.hasOpenDraft).toBe(true);

    h.actions.cancelDraft();
    expect(h.actions.hasOpenDraft).toBe(false);
  });

  it('does not call onDraftClosed when cancelDraft runs with nothing open', () => {
    const h = makeHarness(baseFiles());

    h.actions.cancelDraft();

    expect(h.onDraftClosed).not.toHaveBeenCalled();
  });

  it('calls onDraftClosed exactly once when Escape closes the draft', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);

    pressKey(draftInput(h.root), 'Escape');

    expect(h.onDraftClosed).toHaveBeenCalledTimes(1);
  });

  it('calls onDraftClosed exactly once when blur closes the draft', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);

    draftInput(h.root).dispatchEvent(new Event('blur'));

    expect(h.onDraftClosed).toHaveBeenCalledTimes(1);
  });

  it('does not call onDraftClosed when a second startCreate supersedes an open draft — the session continues', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    const otherEl = h.nodes.get('other.md');
    if (leafEl === undefined || otherEl === undefined) throw new Error('missing elements');
    h.actions.startCreate('leaf.md', leafEl);

    h.actions.startCreate('other.md', otherEl);

    expect(h.onDraftClosed).not.toHaveBeenCalled();
    expect(h.actions.hasOpenDraft).toBe(true);
  });

  it('calls onDraftClosed once a successful commit settles (before the chained sibling draft reopens)', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'New Sub';

    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });

    // onDraftClosed fires once for the draft that actually closed (the committed one) — the chain
    // itself only reopens a sibling draft once a later render actually contains the created path
    // (I7), not synchronously here, so there's nothing else that could have fired it again yet.
    expect(h.onDraftClosed).toHaveBeenCalledTimes(1);
  });

  it('skips its own refresh() when closing the committed draft already rendered (I6 — merges the two into one)', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'New Sub';
    // Simulates a data update deferred while the draft was open, now flushed by this commit's own
    // close of it — `onDraftClosed` returning `true` (something else already rendered) should make
    // `runCommit` skip its own following `refresh()` as redundant.
    h.onDraftClosed.mockReturnValueOnce(true);

    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.onDraftClosed).toHaveBeenCalledTimes(1);
    });

    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('still calls its own refresh() when closing the committed draft did not render anything (the ordinary case)', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'New Sub';

    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.onDraftClosed).toHaveBeenCalledTimes(1);
    });

    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('calls onDraftClosed when destroy() closes an open draft, and not when nothing is open', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);

    h.actions.destroy();
    expect(h.onDraftClosed).toHaveBeenCalledTimes(1);

    h.actions.destroy();
    expect(h.onDraftClosed).toHaveBeenCalledTimes(1);
  });
});

describe('resolveFocus / completePending — is-new highlight and pending completion (I7)', () => {
  it('resolveFocus returns null when nothing has been created yet', () => {
    const h = makeHarness(baseFiles());

    expect(h.actions.resolveFocus(h.getInput().structure)).toBeNull();
  });

  it('resolveFocus returns null against a structure that does not yet contain the created path, and the path once it does', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'New Sub';

    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });

    // Still pending: the refresh above ran against the harness's not-yet-advanced visible paths,
    // same as `getInput()` would right now.
    expect(h.actions.resolveFocus(h.getInput().structure)).toBeNull();

    const freshStructure = buildStructure(
      h.schema,
      readSnapshot(
        h.app.asOriginalType__(),
        h.app.vault.getMarkdownFiles().map((file) => file.asOriginalType2__()),
        null,
      ),
    );
    expect(h.actions.resolveFocus(freshStructure)).toBe('New Sub.md');
  });

  it('applies is-new to the created node once a render actually contains it, and completePending consumes it (not reapplied on a later unrelated render)', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'New Sub';

    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });
    // No is-new anywhere yet — Bases hasn't told the harness about the new note.
    expect(h.root.querySelector('.is-new')).toBeNull();

    h.simulateBasesUpdate();
    const newEl = h.nodes.get('New Sub.md');
    expect(newEl?.classList.contains('is-new')).toBe(true);

    // A later, unrelated refresh must not reapply the highlight to a node that no longer matches
    // a (by-then-cleared) pending focus.
    h.simulateBasesUpdate();
    expect(newEl?.classList.contains('is-new')).toBe(false);
  });
});

describe('carried-over fix from the task 11 review — commit tail scoping', () => {
  it('does not wipe a newly opened draft when an earlier, cancelled commit settles afterwards', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    const otherEl = h.nodes.get('other.md');
    if (leafEl === undefined || otherEl === undefined) throw new Error('missing elements');
    h.actions.startCreate('leaf.md', leafEl);
    const firstInput = draftInput(h.root);
    firstInput.value = 'Settling Sub';

    // Commit starts (async), then the user cancels it (Escape) and opens a different draft
    // before the first commit's promise settles — the finishing commit must not touch the new
    // draft, which belongs to a different node (`other.md`, whose only allowed child is `Sub2`,
    // so it opens directly without a type menu).
    pressKey(firstInput, 'Enter');
    pressKey(firstInput, 'Escape');
    h.actions.startCreate('other.md', otherEl);
    const secondInput = draftInput(h.root);
    expect(secondInput).not.toBe(firstInput);

    await vi.waitFor(() => {
      expect(h.app.vault.getFileByPath('Settling Sub.md')).not.toBeNull();
    });

    expect(otherEl.querySelector('.bases-structure-draft-input')).toBe(secondInput);
    expect(h.root.querySelectorAll('.bases-structure-draft-input')).toHaveLength(1);
  });
});

describe('startMove', () => {
  it('commits the move, cascades category to the hierarchy child, refreshes and shows an undo notice', async () => {
    const h = makeHarness(moveFiles(), { schemaConfig: MOVE_SCHEMA_CONFIG });

    h.actions.startMove('meta.md', 'cat2.md');

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    const metaFile = mustFile(h.app, 'meta.md');
    const childFile = mustFile(h.app, 'child.md');
    expect(h.app.metadataCache.getFileCache(metaFile)?.frontmatter?.['category']).toBe('[[cat2]]');
    expect(h.app.metadataCache.getFileCache(childFile)?.frontmatter?.['category']).toBe('[[cat2]]');
    expect(h.undo.canUndo).toBe(true);
    const notice = lastNotice();
    const fragment = notice?.message as DocumentFragment;
    expect(fragment.querySelector('span')?.textContent).toBe('Moved "meta" to "cat2"');
  });

  it('shows the planner rejection reason and writes nothing for an invalid move', () => {
    const h = makeHarness(moveFiles(), { schemaConfig: MOVE_SCHEMA_CONFIG });

    h.actions.startMove('meta.md', 'meta.md');

    expect(NoticeMock.instances).toHaveLength(1);
    expect(NoticeMock.instances[0]?.message).toBe(
      'Structure: Cannot move "meta" into itself or its own branch',
    );
    expect(h.undo.canUndo).toBe(false);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('refreshes but skips the undo notice when commitPlan could not apply the move', async () => {
    const h = makeHarness(moveFiles(), { schemaConfig: MOVE_SCHEMA_CONFIG });
    vi.spyOn(h.app.fileManager, 'processFrontMatter').mockRejectedValueOnce(new Error('disk full'));

    h.actions.startMove('meta.md', 'cat2.md');

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    // `commitPlan` itself already shows its own failure Notice (see plan-applier.ts) — no
    // "Moved ..." undo notice on top of it.
    expect(NoticeMock.instances.some((notice) => notice.message === 'Moved "meta" to "cat2"')).toBe(
      false,
    );
    expect(h.undo.canUndo).toBe(false);
  });

  it('clears the committing lock after a failed commit, so a subsequent move is not ignored (round 2 minor 7)', async () => {
    const h = makeHarness(moveFiles(), { schemaConfig: MOVE_SCHEMA_CONFIG });
    vi.spyOn(h.app.fileManager, 'processFrontMatter').mockRejectedValueOnce(new Error('disk full'));

    h.actions.startMove('meta.md', 'cat2.md');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });

    // Before round 2, only the *success* path was ever exercised here — a failed `commitPlan`
    // resolving with `false` (not rejecting) still needs to clear `committing`, or every action
    // after a failure would be silently ignored as "still applying the previous change".
    h.actions.startMove('child.md', 'cat1.md');

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalledTimes(2);
    });
    expect(
      NoticeMock.instances.some(
        (notice) => notice.message === 'Structure: still applying the previous change',
      ),
    ).toBe(false);
  });

  it('ignores a second move started while the first is still committing, with its own Notice (I5)', async () => {
    const h = makeHarness(moveFiles(), { schemaConfig: MOVE_SCHEMA_CONFIG });

    h.actions.startMove('meta.md', 'cat2.md');
    const noticesBeforeSecond = NoticeMock.instances.length;
    // Synchronous, before the first commit's promise chain has had a chance to settle: `committing`
    // is already `true` at this point (set before any `await` in the first call), so this must be
    // ignored rather than racing the first move's apply.
    h.actions.startMove('child.md', 'cat1.md');

    expect(NoticeMock.instances).toHaveLength(noticesBeforeSecond + 1);
    expect(NoticeMock.instances[noticesBeforeSecond]?.message).toBe(
      'Structure: still applying the previous change',
    );

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    // The ignored second move never wrote anything: child.md still has its original parent.
    const childFile = mustFile(h.app, 'child.md');
    expect(h.app.metadataCache.getFileCache(childFile)?.frontmatter?.['meta']).toBe('[[meta]]');
  });

  it('allows a new move once the previous commit has settled', async () => {
    const h = makeHarness(moveFiles(), { schemaConfig: MOVE_SCHEMA_CONFIG });

    h.actions.startMove('meta.md', 'cat2.md');
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });

    h.actions.startMove('child.md', 'cat1.md');

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalledTimes(2);
    });
    expect(
      NoticeMock.instances.some(
        (notice) => notice.message === 'Structure: still applying the previous change',
      ),
    ).toBe(false);
  });
});

describe('startConvert', () => {
  it('commits immediately when exactly one type fits, writing the new recipe and parent link, and shows an undo notice', async () => {
    const h = makeHarness(convertFiles(), { schemaConfig: CONVERT_SCHEMA_CONFIG });

    h.actions.startConvert('b.md', 'solo.md', { x: 10, y: 20 });

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    const bFile = mustFile(h.app, 'b.md');
    const cache = h.app.metadataCache.getFileCache(bFile);
    expect(cache?.frontmatter?.['tags']).toStrictEqual(['a']);
    expect(cache?.frontmatter?.['up']).toBe('[[solo]]');
    expect(h.undo.canUndo).toBe(true);
    const notice = lastNotice();
    const fragment = notice?.message as DocumentFragment;
    expect(fragment.querySelector('span')?.textContent).toBe('Converted "b" to "A" under "solo"');
  });

  it('shows a menu with one item per fitting type at the drop position when several fit', () => {
    const h = makeHarness(convertFiles(), { schemaConfig: CONVERT_SCHEMA_CONFIG });
    const showAtPositionSpy = vi
      .spyOn(Menu.prototype, 'showAtPosition')
      .mockImplementation(function (this: Menu) {
        return this;
      });

    h.actions.startConvert('leaf.md', 'cat.md', { x: 10, y: 20 });

    expect(showAtPositionSpy).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 20 });
    const menu = showAtPositionSpy.mock.contexts[0] as Menu;
    const titles = menu.items__.map((item) => item.title__);
    expect(titles).toHaveLength(2);
    expect(titles).toContain('A');
    expect(titles).toContain('B');
  });

  it('commits the type chosen from the menu', async () => {
    const h = makeHarness(convertFiles(), { schemaConfig: CONVERT_SCHEMA_CONFIG });
    const showAtPositionSpy = vi
      .spyOn(Menu.prototype, 'showAtPosition')
      .mockImplementation(function (this: Menu) {
        return this;
      });
    h.actions.startConvert('leaf.md', 'cat.md', { x: 0, y: 0 });
    const menu = showAtPositionSpy.mock.contexts[0] as Menu;
    const aItem = menu.items__.find((item) => item.title__ === 'A');
    if (aItem === undefined) throw new Error('Test setup error: no "A" menu item');

    aItem.onClick__?.(new MouseEvent('click'));

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    const leafFile = mustFile(h.app, 'leaf.md');
    const cache = h.app.metadataCache.getFileCache(leafFile);
    expect(cache?.frontmatter?.['tags']).toStrictEqual(['a']);
    expect(cache?.frontmatter?.['up']).toBe('[[cat]]');
  });

  it('shows a Notice and writes nothing when no type fits (e.g. dropping onto itself)', () => {
    const h = makeHarness(convertFiles(), { schemaConfig: CONVERT_SCHEMA_CONFIG });

    h.actions.startConvert('leaf.md', 'leaf.md', { x: 0, y: 0 });

    expect(NoticeMock.instances).toHaveLength(1);
    expect(NoticeMock.instances[0]?.message).toBe(
      'Structure: "leaf" has no type that fits under "leaf"',
    );
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('ignores a second convert commit started while the first is still committing, with its own Notice (I5)', async () => {
    const h = makeHarness(convertFiles(), { schemaConfig: CONVERT_SCHEMA_CONFIG });

    h.actions.startConvert('b.md', 'solo.md', { x: 0, y: 0 });
    const noticesBeforeSecond = NoticeMock.instances.length;
    h.actions.startConvert('b.md', 'solo.md', { x: 0, y: 0 });

    expect(NoticeMock.instances).toHaveLength(noticesBeforeSecond + 1);
    expect(NoticeMock.instances[noticesBeforeSecond]?.message).toBe(
      'Structure: still applying the previous change',
    );
    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
  });

  it('shows the planner rejection reason and writes nothing when the sole fit is rejected at commit time because of a child Bases has not reported yet (I5)', async () => {
    const schemaConfig = {
      types: {
        Cat: { tag: 'cat', children: { Start: 'up', Target: 'up' } },
        Start: { tag: 'start', children: { Kid: 'up' } },
        Target: { tag: 'target' },
        Kid: { tag: 'kid' },
      },
    };
    const files = {
      'cat1.md': '---\ntags: [cat]\n---\n',
      'cat2.md': '---\ntags: [cat]\n---\n',
      'x.md': '---\ntags: [start]\nup: "[[cat1]]"\n---\n',
    };
    const h = makeHarness(files, { schemaConfig });
    // Created directly on the vault, bypassing the harness's own frozen `visiblePaths` (I5):
    // `getInput()` (used to list `convertOptions`) still sees "x.md" as childless, so "Target"
    // lists as the sole fit; `freshInput()` (used to actually plan) sees the real child and
    // rejects it, since "Target" has no rule that could carry a "Kid".
    await h.app.vault.create('kid.md', '---\ntags: [kid]\nup: "[[x]]"\n---\n');

    h.actions.startConvert('x.md', 'cat2.md', { x: 0, y: 0 });

    expect(NoticeMock.instances[0]?.message).toBe(
      'Structure: "x" cannot become "Target": "kid" would have no parent',
    );
    expect(h.refresh).not.toHaveBeenCalled();
  });
});

describe('fixInherit', () => {
  it('commits the fix, cascades to the child, refreshes and shows an undo notice', async () => {
    const h = makeHarness(fixInheritFiles(), { schemaConfig: FIX_INHERIT_SCHEMA_CONFIG });

    await h.actions.fixInherit('bad.md');

    expect(h.refresh).toHaveBeenCalled();
    const badFile = mustFile(h.app, 'bad.md');
    const childFile = mustFile(h.app, 'child.md');
    expect(h.app.metadataCache.getFileCache(badFile)?.frontmatter?.['category']).toBe('[[cat1]]');
    expect(h.app.metadataCache.getFileCache(childFile)?.frontmatter?.['category']).toBe('[[cat1]]');
    expect(h.undo.canUndo).toBe(true);
    const notice = lastNotice();
    const fragment = notice?.message as DocumentFragment;
    expect(fragment.querySelector('span')?.textContent).toBe('Fixed inherited properties on "bad"');
  });

  it('shows the planner rejection reason and writes nothing when there is nothing to fix', async () => {
    const h = makeHarness(fixInheritFiles(), { schemaConfig: FIX_INHERIT_SCHEMA_CONFIG });

    await h.actions.fixInherit('ok.md');

    expect(NoticeMock.instances).toHaveLength(1);
    expect(NoticeMock.instances[0]?.message).toBe('Structure: "ok" already matches its parent');
    expect(h.undo.canUndo).toBe(false);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('ignores a second call started while the first is still committing, with its own Notice (I5)', async () => {
    const h = makeHarness(fixInheritFiles(), { schemaConfig: FIX_INHERIT_SCHEMA_CONFIG });

    const first = h.actions.fixInherit('bad.md');
    const noticesBeforeSecond = NoticeMock.instances.length;
    await h.actions.fixInherit('bad.md');

    expect(NoticeMock.instances).toHaveLength(noticesBeforeSecond + 1);
    expect(NoticeMock.instances[noticesBeforeSecond]?.message).toBe(
      'Structure: still applying the previous change',
    );
    await first;
  });

  it('propagates an unexpected commit failure to the caller instead of catching it itself', async () => {
    // Unlike `startMove`/`commitRetype` (void, self-contained), `fixInherit` returns a `Promise`
    // that rejects on a commit failure — its one caller (`buildEditItems`'s own `onClick`) is what
    // catches it; see the menu-level test for that half of the contract.
    const h = makeHarness(fixInheritFiles(), { schemaConfig: FIX_INHERIT_SCHEMA_CONFIG });
    vi.spyOn(h.undo, 'push').mockImplementation(() => {
      throw new Error('push boom');
    });

    await expect(h.actions.fixInherit('bad.md')).rejects.toThrow('push boom');
  });
});

interface MoveModal {
  getItems(): string[];
  getItemText(item: string): string;
  onChooseItem(item: string, evt: MouseEvent): void;
  renderSuggestion(match: { item: string }, el: HTMLElement): void;
}

function mockModalOpen() {
  return vi.spyOn(Modal.prototype, 'open').mockImplementation(function (this: Modal): void {
    return undefined;
  });
}

describe('startMovePicker', () => {
  it('shows a Notice and opens no modal when there is nowhere to move the node', () => {
    const h = makeHarness(moveFiles(), { schemaConfig: MOVE_SCHEMA_CONFIG });
    const openSpy = mockModalOpen();

    h.actions.startMovePicker('cat1.md');

    expect(openSpy).not.toHaveBeenCalled();
    expect(NoticeMock.instances).toHaveLength(1);
    expect(NoticeMock.instances[0]?.message).toBe('Structure: nowhere to move "cat1"');
  });

  it('lists moveTargets display names and moves the node when one is chosen', async () => {
    const h = makeHarness(moveFiles(), { schemaConfig: MOVE_SCHEMA_CONFIG });
    const openSpy = mockModalOpen();

    h.actions.startMovePicker('meta.md');

    expect(openSpy).toHaveBeenCalledTimes(1);
    const modal = openSpy.mock.contexts[0] as MoveModal;
    expect(modal.getItems()).toStrictEqual(['cat2.md']);
    expect(modal.getItemText('cat2.md')).toBe('cat2');

    modal.onChooseItem('cat2.md', new MouseEvent('click'));

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    const metaFile = mustFile(h.app, 'meta.md');
    expect(h.app.metadataCache.getFileCache(metaFile)?.frontmatter?.['category']).toBe('[[cat2]]');
  });

  it('renders the display name plus, for a note in a subfolder, a muted folder suffix', () => {
    const files = { ...moveFiles(), 'archive/cat3.md': '---\ntags: [category]\n---\n' };
    const h = makeHarness(files, { schemaConfig: MOVE_SCHEMA_CONFIG });
    const openSpy = mockModalOpen();

    h.actions.startMovePicker('meta.md');

    const modal = openSpy.mock.contexts[0] as MoveModal;
    expect(modal.getItems().sort((a, b) => a.localeCompare(b))).toStrictEqual([
      'archive/cat3.md',
      'cat2.md',
    ]);

    const rootEl = createDiv();
    modal.renderSuggestion({ item: 'cat2.md' }, rootEl);
    expect(rootEl.textContent).toBe('cat2');
    expect(rootEl.querySelector('.bases-structure-suggest-folder')).toBeNull();

    const folderedEl = createDiv();
    modal.renderSuggestion({ item: 'archive/cat3.md' }, folderedEl);
    expect(folderedEl.querySelector('.bases-structure-suggest-folder')?.textContent).toBe(
      'archive',
    );
  });
});

describe('startRetype', () => {
  it('shows a Notice when the node has no compatible retype options', () => {
    const h = makeHarness(retypeFiles(), { schemaConfig: RETYPE_SCHEMA_CONFIG });
    const catEl = h.nodes.get('cat.md');
    if (catEl === undefined) throw new Error('missing cat element');

    h.actions.startRetype('cat.md', catEl);

    expect(NoticeMock.instances).toHaveLength(1);
    expect(NoticeMock.instances[0]?.message).toBe('Structure: "cat" cannot change type here');
  });

  it('shows a menu matching retypeOptions, and choosing one commits and shows the notice', async () => {
    const h = makeHarness(retypeFiles(), { schemaConfig: RETYPE_SCHEMA_CONFIG });
    const itemEl = h.nodes.get('item.md');
    if (itemEl === undefined) throw new Error('missing item element');
    const showAtPositionSpy = vi
      .spyOn(Menu.prototype, 'showAtPosition')
      .mockImplementation(function (this: Menu) {
        return this;
      });

    h.actions.startRetype('item.md', itemEl);

    expect(showAtPositionSpy).toHaveBeenCalledTimes(1);
    const menu = showAtPositionSpy.mock.contexts[0] as Menu;
    expect(menu.items__.map((item) => item.title__)).toStrictEqual(['B']);
    menu.items__[0]?.onClick__?.(new MouseEvent('click'));

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    const itemFile = mustFile(h.app, 'item.md');
    expect(h.app.metadataCache.getFileCache(itemFile)?.frontmatter?.['tags']).toStrictEqual(['b']);
    const notice = lastNotice();
    const fragment = notice?.message as DocumentFragment;
    expect(fragment.querySelector('span')?.textContent).toBe('Changed "item" to "B"');
  });

  it('shows the menu at the mouse event when one is provided', () => {
    const h = makeHarness(retypeFiles(), { schemaConfig: RETYPE_SCHEMA_CONFIG });
    const itemEl = h.nodes.get('item.md');
    if (itemEl === undefined) throw new Error('missing item element');
    const showAtMouseEventSpy = vi
      .spyOn(Menu.prototype, 'showAtMouseEvent')
      .mockImplementation(function (this: Menu) {
        return this;
      });
    const event = new MouseEvent('click');

    h.actions.startRetype('item.md', itemEl, event);

    expect(showAtMouseEventSpy).toHaveBeenCalledExactlyOnceWith(event);
  });

  it('shows the planner rejection reason when a listed option is rejected at commit time', () => {
    // `retypeOptions` doesn't check folder occupancy (only `planRetype` does), so a type whose
    // recipe folder collides with an existing note is still listed here, then rejected once
    // actually planned — exercising `commitRetype`'s own rejection branch.
    const schemaConfig = {
      types: {
        Cat: { tag: 'cat', children: { A: 'up', B: 'up' } },
        A: { tag: 'a' },
        B: { tag: 'b', folder: 'moved' },
      },
    };
    const files = {
      'cat.md': '---\ntags: [cat]\n---\n',
      'item.md': '---\ntags: [a]\nup: "[[cat]]"\n---\n',
      'moved/item.md': '---\ntags: [b]\n---\n',
    };
    const h = makeHarness(files, { schemaConfig });
    const itemEl = h.nodes.get('item.md');
    if (itemEl === undefined) throw new Error('missing item element');
    const showAtPositionSpy = vi
      .spyOn(Menu.prototype, 'showAtPosition')
      .mockImplementation(function (this: Menu) {
        return this;
      });

    h.actions.startRetype('item.md', itemEl);
    const menu = showAtPositionSpy.mock.contexts[0] as Menu;
    menu.items__[0]?.onClick__?.(new MouseEvent('click'));

    expect(NoticeMock.instances[0]?.message).toBe(
      'Structure: A note already exists at "moved/item.md"',
    );
    expect(h.undo.canUndo).toBe(false);
  });
});

describe('commitAndNotify — unexpected failure', () => {
  it('logs and shows a Notice when commitPlan itself rejects', async () => {
    const h = makeHarness(moveFiles(), { schemaConfig: MOVE_SCHEMA_CONFIG });
    vi.spyOn(h.undo, 'push').mockImplementation(() => {
      throw new Error('push boom');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    h.actions.startMove('meta.md', 'cat2.md');

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
    });
    expect(
      NoticeMock.instances.some(
        (notice) =>
          typeof notice.message === 'string' &&
          notice.message === 'Structure: could not apply the change. push boom',
      ),
    ).toBe(true);
  });
});

// I11: the planner already verifies a plan by simulating it (`applyPlan`) before this ever calls
// `commitPlan` — showing that exact, already-computed result immediately (rather than waiting for
// the real write, and Bases' own later re-query, to land) is free. `showOptimistic` is what
// `structure-view.ts` renders from until the next real `onDataUpdated`.
describe('optimistic rendering (I11)', () => {
  it('shows the planned move result via showOptimistic synchronously, before the commit settles', () => {
    const h = makeHarness(moveFiles(), { schemaConfig: MOVE_SCHEMA_CONFIG });

    h.actions.startMove('meta.md', 'cat2.md');

    expect(h.showOptimistic).toHaveBeenCalledTimes(1);
    const optimistic = h.showOptimistic.mock.calls[0]?.[0] as Snapshot;
    expect(optimistic.notes.get('meta.md')?.frontmatter['category']).toBe('[[cat2]]');
  });

  it('reverts to the original snapshot when the move commit itself throws (plus the existing error notice)', async () => {
    const h = makeHarness(moveFiles(), { schemaConfig: MOVE_SCHEMA_CONFIG });
    vi.spyOn(h.undo, 'push').mockImplementation(() => {
      throw new Error('push boom');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    h.actions.startMove('meta.md', 'cat2.md');

    await vi.waitFor(() => {
      expect(h.showOptimistic).toHaveBeenCalledTimes(2);
    });
    const optimistic = h.showOptimistic.mock.calls[0]?.[0] as Snapshot;
    const reverted = h.showOptimistic.mock.calls[1]?.[0] as Snapshot;
    expect(optimistic.notes.get('meta.md')?.frontmatter['category']).toBe('[[cat2]]');
    expect(reverted.notes.get('meta.md')?.frontmatter['category']).toBe('[[cat1]]');
    expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
  });

  it('shows the planned create result via showOptimistic synchronously, before the note is written', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'New Sub';

    pressKey(draftInput(h.root), 'Enter');

    expect(h.showOptimistic).toHaveBeenCalledTimes(1);
    const optimistic = h.showOptimistic.mock.calls[0]?.[0] as Snapshot;
    expect(optimistic.notes.has('New Sub.md')).toBe(true);
    expect(optimistic.notes.get('New Sub.md')?.tags).toContain('sub');
  });

  it('reverts to the original snapshot when the create commit itself throws (plus the existing error notice)', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    vi.spyOn(h.undo, 'push').mockImplementation(() => {
      throw new Error('push boom');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'New Sub';

    pressKey(draftInput(h.root), 'Enter');

    await vi.waitFor(() => {
      expect(h.showOptimistic).toHaveBeenCalledTimes(2);
    });
    const optimistic = h.showOptimistic.mock.calls[0]?.[0] as Snapshot;
    const reverted = h.showOptimistic.mock.calls[1]?.[0] as Snapshot;
    expect(optimistic.notes.has('New Sub.md')).toBe(true);
    expect(reverted.notes.has('New Sub.md')).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
  });
});

describe('committing guard — ignores a new action while one is still applying (I5)', () => {
  it('ignores a create-draft commit started while an earlier move is still in flight, keeping the draft open', async () => {
    const files = { ...baseFiles(), 'leaf2.md': '---\ntags: [leaf]\nup: "[[cat]]"\n---\n' };
    const h = makeHarness(files);
    h.actions.startMove('sub.md', 'leaf2.md'); // in flight, not awaited
    const noticesBeforeDraft = NoticeMock.instances.length;
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    const inputEl = draftInput(h.root);
    inputEl.value = 'New Sub';

    pressKey(inputEl, 'Enter');

    expect(NoticeMock.instances).toHaveLength(noticesBeforeDraft + 1);
    expect(NoticeMock.instances[noticesBeforeDraft]?.message).toBe(
      'Structure: still applying the previous change',
    );
    expect(h.root.querySelector('.bases-structure-draft-input')).toBe(inputEl);
    expect(h.app.vault.getFileByPath('New Sub.md')).toBeNull();

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
  });
});

describe('openNodeMenu', () => {
  function targetEvent(target: HTMLElement): MouseEvent {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: target, configurable: true });
    return event;
  }

  function mockShowAtMouseEvent() {
    return vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
      return this;
    });
  }

  it('lists Open, Open in new tab, Add child, Move to…, Change type — no Undo when nothing can be undone', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    const showAtMouseEventSpy = mockShowAtMouseEvent();

    h.actions.openNodeMenu('leaf.md', targetEvent(leafEl));

    const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
    expect(menu.items__.map((item) => item.title__)).toStrictEqual([
      'Open',
      'Open in new tab',
      'Add child',
      'Move to…',
      'Change type',
    ]);
  });

  it('adds "Undo last change" as the last item when undo.canUndo is true', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    vi.spyOn(h.undo, 'canUndo', 'get').mockReturnValue(true);
    const showAtMouseEventSpy = mockShowAtMouseEvent();

    h.actions.openNodeMenu('leaf.md', targetEvent(leafEl));

    const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
    expect(menu.items__.map((item) => item.title__)).toStrictEqual([
      'Open',
      'Open in new tab',
      'Add child',
      'Move to…',
      'Change type',
      'Undo last change',
    ]);
  });

  it('"Open" opens the node in the current pane (no forced new leaf)', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    const showAtMouseEventSpy = mockShowAtMouseEvent();
    const openLinkTextSpy = vi.spyOn(h.app.workspace, 'openLinkText').mockResolvedValue();

    h.actions.openNodeMenu('leaf.md', targetEvent(leafEl));
    const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
    menu.items__[0]?.onClick__?.(new MouseEvent('click'));

    expect(openLinkTextSpy).toHaveBeenCalledExactlyOnceWith('leaf.md', '', false);
  });

  it('logs and shows a Notice with the note\'s display name when "Open" fails', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    const showAtMouseEventSpy = mockShowAtMouseEvent();
    const error = new Error('boom');
    vi.spyOn(h.app.workspace, 'openLinkText').mockRejectedValue(error);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    h.actions.openNodeMenu('leaf.md', targetEvent(leafEl));
    const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
    menu.items__[0]?.onClick__?.(new MouseEvent('click'));

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', error);
    });
    expect(NoticeMock.instances[0]?.message).toBe('Structure: could not open "leaf"');
  });

  it('"Open in new tab" defaults to a new tab when no modifier is held', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    const showAtMouseEventSpy = mockShowAtMouseEvent();
    const openLinkTextSpy = vi.spyOn(h.app.workspace, 'openLinkText').mockResolvedValue();

    h.actions.openNodeMenu('leaf.md', targetEvent(leafEl));
    const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
    menu.items__[1]?.onClick__?.(new MouseEvent('click'));

    expect(openLinkTextSpy).toHaveBeenCalledExactlyOnceWith('leaf.md', '', 'tab');
  });

  it('"Open in new tab" escalates to split/window via extra modifiers (mod-aware)', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    const showAtMouseEventSpy = mockShowAtMouseEvent();
    const openLinkTextSpy = vi.spyOn(h.app.workspace, 'openLinkText').mockResolvedValue();
    // Mod (either Ctrl or Meta, platform-independent here) + Alt, no Shift → 'split' per
    // `Keymap.isModEvent` — proves `mod` (not the `'tab'` literal) is what gets forwarded.
    const modClick = new MouseEvent('click', { ctrlKey: true, metaKey: true, altKey: true });

    h.actions.openNodeMenu('leaf.md', targetEvent(leafEl));
    const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
    menu.items__[1]?.onClick__?.(modClick);

    expect(openLinkTextSpy).toHaveBeenCalledExactlyOnceWith('leaf.md', '', 'split');
  });

  it('logs and shows a Notice with the note\'s display name when "Open in new tab" fails', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    const showAtMouseEventSpy = mockShowAtMouseEvent();
    const error = new Error('boom');
    vi.spyOn(h.app.workspace, 'openLinkText').mockRejectedValue(error);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    h.actions.openNodeMenu('leaf.md', targetEvent(leafEl));
    const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
    menu.items__[1]?.onClick__?.(new MouseEvent('click'));

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', error);
    });
    expect(NoticeMock.instances[0]?.message).toBe('Structure: could not open "leaf"');
  });

  it('falls back to no anchor (Add child / Change type become no-ops) when the event target is not an HTMLElement', () => {
    const h = makeHarness(baseFiles());
    const showAtMouseEventSpy = mockShowAtMouseEvent();
    const target = document.createTextNode('x');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: target, configurable: true });

    h.actions.openNodeMenu('leaf.md', event);
    const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
    menu.items__[2]?.onClick__?.(new MouseEvent('click')); // Add child
    menu.items__[4]?.onClick__?.(new MouseEvent('click')); // Change type

    expect(NoticeMock.instances).toHaveLength(0);
  });

  it('"Add child" positions the type menu at the anchor (not the mouse) when activated via keyboard', () => {
    const h = makeHarness(baseFiles());
    const catEl = h.nodes.get('cat.md');
    if (catEl === undefined) throw new Error('missing cat element');
    const showAtMouseEventSpy = mockShowAtMouseEvent();
    const showAtPositionSpy = vi
      .spyOn(Menu.prototype, 'showAtPosition')
      .mockImplementation(function (this: Menu) {
        return this;
      });

    h.actions.openNodeMenu('cat.md', targetEvent(catEl));
    const contextMenu = showAtMouseEventSpy.mock.contexts[0] as Menu;
    // A keyboard "activate" (not a real click) reaches the same onClick callback; only a real
    // MouseEvent is a sensible anchor for the follow-up type menu's own `showAtMouseEvent`.
    contextMenu.items__[2]?.onClick__?.(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(showAtPositionSpy).toHaveBeenCalledTimes(1);
  });

  it('"Add child" opens a draft anchored to the right-clicked node', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    const showAtMouseEventSpy = mockShowAtMouseEvent();

    h.actions.openNodeMenu('leaf.md', targetEvent(leafEl));
    const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
    menu.items__[2]?.onClick__?.(new MouseEvent('click'));

    expect(leafEl.querySelector('.bases-structure-draft-input')).not.toBeNull();
  });

  it('"Move to…" reaches startMovePicker', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    const showAtMouseEventSpy = mockShowAtMouseEvent();

    // `leaf.md` has no compatible move target under `SCHEMA_CONFIG` (its only Leaf-accepting
    // parent is its own current one), so the picker's own "nowhere to move" Notice is proof
    // enough that the click reached `startMovePicker`.
    h.actions.openNodeMenu('leaf.md', targetEvent(leafEl));
    const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
    menu.items__[3]?.onClick__?.(new MouseEvent('click'));

    expect(NoticeMock.instances[0]?.message).toBe('Structure: nowhere to move "leaf"');
  });

  it('"Change type" reaches startRetype', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    const showAtMouseEventSpy = mockShowAtMouseEvent();

    // `leaf.md` has no compatible retype option under `SCHEMA_CONFIG` either, so this only
    // proves the click reached `startRetype`, via its own "cannot change type" Notice.
    h.actions.openNodeMenu('leaf.md', targetEvent(leafEl));
    const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
    menu.items__[4]?.onClick__?.(new MouseEvent('click'));

    expect(NoticeMock.instances[0]?.message).toBe('Structure: "leaf" cannot change type here');
  });

  it('"Undo last change" calls undo.undo()', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    vi.spyOn(h.undo, 'canUndo', 'get').mockReturnValue(true);
    const undoSpy = vi.spyOn(h.undo, 'undo').mockResolvedValue({ label: null, skipped: [] });
    const showAtMouseEventSpy = mockShowAtMouseEvent();

    h.actions.openNodeMenu('leaf.md', targetEvent(leafEl));
    const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
    menu.items__[5]?.onClick__?.(new MouseEvent('click'));

    await vi.waitFor(() => {
      expect(undoSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('"Fix inheritance" — only offered for a node the diagnostic actually flagged', () => {
    it('appears, after "Change type", for a node with an inherit-mismatch', () => {
      const h = makeHarness(fixInheritFiles(), { schemaConfig: FIX_INHERIT_SCHEMA_CONFIG });
      const badEl = h.nodes.get('bad.md');
      if (badEl === undefined) throw new Error('missing bad element');
      const showAtMouseEventSpy = mockShowAtMouseEvent();

      h.actions.openNodeMenu('bad.md', targetEvent(badEl));

      const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
      expect(menu.items__.map((item) => item.title__)).toStrictEqual([
        'Open',
        'Open in new tab',
        'Add child',
        'Move to…',
        'Change type',
        'Fix inheritance',
      ]);
    });

    it('is absent for a node that already matches its parent', () => {
      const h = makeHarness(fixInheritFiles(), { schemaConfig: FIX_INHERIT_SCHEMA_CONFIG });
      const okEl = h.nodes.get('ok.md');
      if (okEl === undefined) throw new Error('missing ok element');
      const showAtMouseEventSpy = mockShowAtMouseEvent();

      h.actions.openNodeMenu('ok.md', targetEvent(okEl));

      const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
      expect(menu.items__.some((item) => item.title__ === 'Fix inheritance')).toBe(false);
    });

    it('commits the fix when clicked', async () => {
      const h = makeHarness(fixInheritFiles(), { schemaConfig: FIX_INHERIT_SCHEMA_CONFIG });
      const badEl = h.nodes.get('bad.md');
      if (badEl === undefined) throw new Error('missing bad element');
      const showAtMouseEventSpy = mockShowAtMouseEvent();

      h.actions.openNodeMenu('bad.md', targetEvent(badEl));
      const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
      const fixItem = menu.items__.find((item) => item.title__ === 'Fix inheritance');
      fixItem?.onClick__?.(new MouseEvent('click'));

      await vi.waitFor(() => {
        expect(h.refresh).toHaveBeenCalled();
      });
      const badFile = mustFile(h.app, 'bad.md');
      expect(h.app.metadataCache.getFileCache(badFile)?.frontmatter?.['category']).toBe('[[cat1]]');
    });

    it('catches an unexpected commit failure, notifies, and clears the committing lock', async () => {
      const h = makeHarness(fixInheritFiles(), { schemaConfig: FIX_INHERIT_SCHEMA_CONFIG });
      const badEl = h.nodes.get('bad.md');
      if (badEl === undefined) throw new Error('missing bad element');
      vi.spyOn(h.undo, 'push').mockImplementation(() => {
        throw new Error('push boom');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const showAtMouseEventSpy = mockShowAtMouseEvent();

      h.actions.openNodeMenu('bad.md', targetEvent(badEl));
      const menu = showAtMouseEventSpy.mock.contexts[0] as Menu;
      const fixItem = menu.items__.find((item) => item.title__ === 'Fix inheritance');
      fixItem?.onClick__?.(new MouseEvent('click'));

      await vi.waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
      });
      expect(
        NoticeMock.instances.some(
          (notice) => notice.message === 'Structure: could not apply the change. push boom',
        ),
      ).toBe(true);

      // The lock cleared: a follow-up call is no longer ignored as "still applying".
      const noticesBefore = NoticeMock.instances.length;
      await h.actions.fixInherit('ok.md');
      expect(NoticeMock.instances[noticesBefore]?.message).toBe(
        'Structure: "ok" already matches its parent',
      );
    });
  });
});

describe('openNodeMenuFromButton (I10 — touch-only node-menu button)', () => {
  it('lists the identical items openNodeMenu (contextmenu) does', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    const buttonEl = createEl('button');
    const showAtPositionSpy = vi
      .spyOn(Menu.prototype, 'showAtPosition')
      .mockImplementation(function (this: Menu) {
        return this;
      });

    h.actions.openNodeMenuFromButton('leaf.md', leafEl, buttonEl);

    const menu = showAtPositionSpy.mock.contexts[0] as Menu;
    expect(menu.items__.map((item) => item.title__)).toStrictEqual([
      'Open',
      'Open in new tab',
      'Add child',
      'Move to…',
      'Change type',
    ]);
  });

  it('positions from the button’s own rect (U1), not showAtMouseEvent', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    const buttonEl = createEl('button');
    vi.spyOn(buttonEl, 'getBoundingClientRect').mockReturnValue({
      left: 30,
      bottom: 40,
    } as DOMRect);
    const showAtMouseEventSpy = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
    const showAtPositionSpy = vi
      .spyOn(Menu.prototype, 'showAtPosition')
      .mockImplementation(function (this: Menu) {
        return this;
      });

    h.actions.openNodeMenuFromButton('leaf.md', leafEl, buttonEl);

    expect(showAtMouseEventSpy).not.toHaveBeenCalled();
    expect(showAtPositionSpy).toHaveBeenCalledExactlyOnceWith(
      { x: 30, y: 44 },
      buttonEl.ownerDocument,
    );
  });

  it('"Add child" from the touch node menu opens a draft anchored to the node', () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    const buttonEl = createEl('button');
    const showAtPositionSpy = vi
      .spyOn(Menu.prototype, 'showAtPosition')
      .mockImplementation(function (this: Menu) {
        return this;
      });

    h.actions.openNodeMenuFromButton('leaf.md', leafEl, buttonEl);
    const menu = showAtPositionSpy.mock.contexts[0] as Menu;
    menu.items__[2]?.onClick__?.(new MouseEvent('click'));

    expect(leafEl.querySelector('.bases-structure-draft-input')).not.toBeNull();
  });
});

describe('undoLast', () => {
  it('shows "nothing to undo" and still refreshes when the stack is empty', async () => {
    const h = makeHarness(baseFiles());

    h.actions.undoLast();

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    expect(NoticeMock.instances[0]?.message).toBe('Structure: nothing to undo');
  });

  it('undoes the last transaction, refreshes, and shows the "undone" notice with the skip suffix', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'New Sub';
    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.app.vault.getFileByPath('New Sub.md')).not.toBeNull();
    });
    h.refresh.mockClear();
    NoticeMock.instances.length = 0;
    vi.spyOn(h.undo, 'undo').mockResolvedValue({ label: 'Create "New Sub"', skipped: ['a.md'] });

    h.actions.undoLast();

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    expect(NoticeMock.instances[0]?.message).toBe(
      'Structure: undone "Create "New Sub"" (skipped a)',
    );
  });

  it('shows the "undone" notice with no suffix when nothing was skipped', async () => {
    const h = makeHarness(baseFiles());
    vi.spyOn(h.undo, 'undo').mockResolvedValue({ label: 'Move "leaf"', skipped: [] });

    h.actions.undoLast();

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    expect(NoticeMock.instances[0]?.message).toBe('Structure: undone "Move "leaf""');
  });

  it('logs and shows a failure notice when undo.undo() rejects', async () => {
    const h = makeHarness(baseFiles());
    vi.spyOn(h.undo, 'undo').mockRejectedValueOnce(new Error('undo boom'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    h.actions.undoLast();

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
    });
    expect(NoticeMock.instances[0]?.message).toBe('Structure: undo failed');
  });

  // I11 regression: an undo is a real vault mutation, not a planned+simulated action — leaving a
  // prior `showOptimistic` prediction on screen after undoing the very change it predicted would
  // show something the vault no longer has.
  it('clears the optimistic prediction once the undo actually reverts something', async () => {
    const h = makeHarness(baseFiles());
    vi.spyOn(h.undo, 'undo').mockResolvedValue({ label: 'Move "leaf"', skipped: [] });

    h.actions.undoLast();

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    expect(h.clearOptimistic).toHaveBeenCalledTimes(1);
  });

  it('leaves the optimistic prediction alone when there is nothing to undo', async () => {
    const h = makeHarness(baseFiles());

    h.actions.undoLast();

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    expect(h.clearOptimistic).not.toHaveBeenCalled();
  });

  it('leaves the optimistic prediction alone when the undo is blocked', async () => {
    const h = makeHarness(baseFiles());
    vi.spyOn(h.undo, 'undo').mockResolvedValue({ blocked: true });

    h.actions.undoLast();

    await vi.waitFor(() => {
      expect(h.refresh).toHaveBeenCalled();
    });
    expect(h.clearOptimistic).not.toHaveBeenCalled();
  });
});

describe('formatUndoResult (I1)', () => {
  it('reports "a newer change must be undone first" for a blocked result', () => {
    expect(formatUndoResult({ blocked: true })).toBe('a newer change must be undone first');
  });

  it('reports "nothing to undo" for an empty stack', () => {
    expect(formatUndoResult({ label: null, skipped: [] })).toBe('nothing to undo');
  });

  it('reports the label with no suffix when nothing was skipped', () => {
    expect(formatUndoResult({ label: 'Move "leaf"', skipped: [] })).toBe('undone "Move "leaf""');
  });

  it('lists every skipped name (resolved via nameOf) when there are 3 or fewer', () => {
    const result = formatUndoResult({ label: 'Cascade', skipped: ['a.md', 'b.md', 'c.md'] }, (p) =>
      p.toUpperCase(),
    );

    expect(result).toBe('undone "Cascade" (skipped A.MD, B.MD, C.MD)');
  });

  it('shows the first 3 names then a "+N more" tail once there are more than 3', () => {
    const result = formatUndoResult({
      label: 'Cascade',
      skipped: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'],
    });

    // Default `nameOf` (no snapshot given) falls back to the bare path basename.
    expect(result).toBe('undone "Cascade" (skipped a, b, c, +2 more)');
  });
});

describe('undo notice — transaction identity and disabling (I1)', () => {
  it('the notice button passes its own transaction — clicking an older notice after a newer change reports "a newer change must be undone first" and reverts nothing', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    const catEl = h.nodes.get('cat.md');
    if (leafEl === undefined || catEl === undefined) throw new Error('missing elements');

    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'First Sub';
    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.app.vault.getFileByPath('First Sub.md')).not.toBeNull();
    });
    const olderNotice = lastNotice();
    const olderButton = (olderNotice?.message as DocumentFragment).querySelector<HTMLButtonElement>(
      '.bases-structure-undo',
    );

    h.actions.startCreate('cat.md', catEl);
    draftInput(h.root).value = 'Second Leaf';
    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.app.vault.getFileByPath('Second Leaf.md')).not.toBeNull();
    });

    olderButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => {
      expect(
        NoticeMock.instances.some(
          (notice) => notice.message === 'Structure: a newer change must be undone first',
        ),
      ).toBe(true);
    });
    // Neither note was reverted — the click was blocked, not silently redirected to the newer one.
    expect(h.app.vault.getFileByPath('First Sub.md')).not.toBeNull();
    expect(h.app.vault.getFileByPath('Second Leaf.md')).not.toBeNull();
    expect(h.undo.canUndo).toBe(true);
  });

  it('the newer notice’s own button still undoes its own change normally', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    const catEl = h.nodes.get('cat.md');
    if (leafEl === undefined || catEl === undefined) throw new Error('missing elements');

    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'First Sub';
    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.app.vault.getFileByPath('First Sub.md')).not.toBeNull();
    });

    h.actions.startCreate('cat.md', catEl);
    draftInput(h.root).value = 'Second Leaf';
    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.app.vault.getFileByPath('Second Leaf.md')).not.toBeNull();
    });
    const newerNotice = lastNotice();
    const newerButton = (newerNotice?.message as DocumentFragment).querySelector<HTMLButtonElement>(
      '.bases-structure-undo',
    );

    newerButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => {
      expect(h.app.vault.getFileByPath('Second Leaf.md')).toBeNull();
    });
    expect(h.app.vault.getFileByPath('First Sub.md')).not.toBeNull();
  });

  it('disables the button after one click, so a second click does not call undo twice', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'New Sub';
    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.app.vault.getFileByPath('New Sub.md')).not.toBeNull();
    });
    const undoSpy = vi.spyOn(h.undo, 'undo');
    const notice = lastNotice();
    const button = (notice?.message as DocumentFragment).querySelector<HTMLButtonElement>(
      '.bases-structure-undo',
    );

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(button?.disabled).toBe(true);
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => {
      expect(undoSpy).toHaveBeenCalled();
    });
    expect(undoSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves skipped names via the current snapshot’s display names, not just the bare path', async () => {
    const h = makeHarness(baseFiles());
    const leafEl = h.nodes.get('leaf.md');
    if (leafEl === undefined) throw new Error('missing leaf element');
    h.actions.startCreate('leaf.md', leafEl);
    draftInput(h.root).value = 'New Sub';
    pressKey(draftInput(h.root), 'Enter');
    await vi.waitFor(() => {
      expect(h.app.vault.getFileByPath('New Sub.md')).not.toBeNull();
    });
    // 'other.md' is a real note in the harness's vault (basename "other") — reusing it as the
    // "skipped" path proves the resolver goes through the current snapshot's displayName, not
    // just a bare last-path-segment fallback.
    vi.spyOn(h.undo, 'undo').mockResolvedValue({
      label: 'Create "New Sub"',
      skipped: ['other.md'],
    });
    const notice = lastNotice();
    const button = (notice?.message as DocumentFragment).querySelector<HTMLButtonElement>(
      '.bases-structure-undo',
    );

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => {
      expect(
        NoticeMock.instances.some(
          (n) => n.message === 'Structure: undone "Create "New Sub"" (skipped other)',
        ),
      ).toBe(true);
    });
  });
});
