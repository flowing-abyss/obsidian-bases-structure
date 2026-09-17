// Unit tests for `attachKeyboard` — the roving-focus keyboard controller for the structure view
// (task 16). Drives the whole module through dispatched `Keyboard`/`Mouse`/`Focus` events against
// a small hand-built `Structure` and plain `.bases-structure-node` markup, mirroring how
// `drag.test.ts` tests `attachDrag` in isolation from the renderers/`StructureView`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Structure, StructureNode } from '../core/structure.js';
import { attachKeyboard, type KeyboardDeps } from './keyboard.js';
import type { ViewUiState } from './view-state.js';

function makeNode(path: string, overrides: Partial<StructureNode> = {}): StructureNode {
  return {
    path,
    type: null,
    parent: null,
    edge: null,
    children: [],
    extras: [],
    alsoIn: [],
    twoWay: false,
    ...overrides,
  };
}

/** root.md (tops: [root]) -> a.md -> [a1.md, a2.md]; root.md -> b.md (leaf); orphan.md is a
 * parentless orphan top. Covers: a branch with children (a.md), leaves at two depths (a1/a2/b),
 * and a second top-level group (orphans) for sibling navigation at the root level. */
function makeStructure(): Structure {
  const nodes = new Map<string, StructureNode>([
    ['root.md', makeNode('root.md', { children: ['a.md', 'b.md'] })],
    ['a.md', makeNode('a.md', { parent: 'root.md', children: ['a1.md', 'a2.md'] })],
    ['a1.md', makeNode('a1.md', { parent: 'a.md' })],
    ['a2.md', makeNode('a2.md', { parent: 'a.md' })],
    ['b.md', makeNode('b.md', { parent: 'root.md' })],
    ['orphan.md', makeNode('orphan.md')],
  ]);
  return { root: 'root.md', tops: ['root.md'], orphans: ['orphan.md'], nodes, issues: [] };
}

/** A copy of `structure` with `node` added to its node map — `Structure.nodes` is a
 * `ReadonlyMap`, so tests that need a node the base fixture doesn't have (a broken-invariant
 * edge case) build a fresh `Structure` rather than mutating the shared one in place. */
function withNode(structure: Structure, node: StructureNode): Structure {
  const nodes = new Map(structure.nodes);
  nodes.set(node.path, node);
  return { ...structure, nodes };
}

function makeState(overrides: Partial<ViewUiState> = {}): ViewUiState {
  return {
    collapsed: new Set(),
    zoom: 1,
    zoomTouched: false,
    scrollLeft: 0,
    scrollTop: 0,
    active: null,
    ...overrides,
  };
}

function makeNodeEl(path: string): HTMLElement {
  const el = createDiv();
  el.className = 'bases-structure-node';
  el.setAttribute('data-path', path);
  return el;
}

function keyEvent(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
}

interface Harness {
  readonly container: HTMLElement;
  readonly state: ViewUiState;
  readonly deps: KeyboardDeps;
  readonly dispose: () => void;
}

function makeHarness(structure: Structure, active: string | null): Harness {
  const container = createDiv();
  document.body.appendChild(container);
  for (const path of structure.nodes.keys()) {
    container.appendChild(makeNodeEl(path));
  }
  const state = makeState({ active });
  const deps: KeyboardDeps = {
    container,
    getStructure: vi.fn(() => structure),
    getState: vi.fn(() => state),
    refresh: vi.fn(),
    open: vi.fn(),
    addChild: vi.fn(),
    addSibling: vi.fn(),
    movePicker: vi.fn(),
    retype: vi.fn(),
    undo: vi.fn(),
  };
  const dispose = attachKeyboard(deps);
  return { container, state, deps, dispose };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('attachKeyboard — arrow navigation', () => {
  it.each([
    { key: 'ArrowDown', start: 'a.md', expected: 'b.md' },
    { key: 'ArrowUp', start: 'b.md', expected: 'a.md' },
  ])(
    '$key moves the active sibling ($start -> $expected) without a full refresh',
    ({ key, start, expected }) => {
      const h = makeHarness(makeStructure(), start);

      h.container.dispatchEvent(keyEvent(key));

      expect(h.state.active).toBe(expected);
      // A pure move among already-rendered siblings patches `.is-active`/tabindex on the current
      // DOM directly (see `setActive`) — no full `StructureView.render()` pipeline is needed, and
      // running one here would double up with a renderer's own re-render for a click that also
      // landed on e.g. a collapse toggle (see the toggle-click regression coverage in
      // `structure-view.test.ts`).
      expect(h.deps.refresh).not.toHaveBeenCalled();
      expect(
        h.container.querySelector('.bases-structure-node.is-active')?.getAttribute('data-path'),
      ).toBe(expected);
    },
  );

  it.each([
    { key: 'ArrowDown', start: 'b.md' },
    { key: 'ArrowUp', start: 'a.md' },
  ])('$key at the sibling-list edge stays put (still prevents default)', ({ key, start }) => {
    const h = makeHarness(makeStructure(), start);
    const event = keyEvent(key);

    h.container.dispatchEvent(event);

    expect(h.state.active).toBe(start);
    expect(event.defaultPrevented).toBe(true);
    expect(h.deps.refresh).not.toHaveBeenCalled();
  });

  it('ArrowRight on an expanded branch moves into the first child', () => {
    const h = makeHarness(makeStructure(), 'a.md');

    h.container.dispatchEvent(keyEvent('ArrowRight'));

    expect(h.state.active).toBe('a1.md');
  });

  it('ArrowLeft on a leaf moves back to the parent', () => {
    const h = makeHarness(makeStructure(), 'a1.md');

    h.container.dispatchEvent(keyEvent('ArrowLeft'));

    expect(h.state.active).toBe('a.md');
  });

  it('ArrowLeft on a parentless leaf does nothing but still prevents default', () => {
    const h = makeHarness(makeStructure(), 'orphan.md');
    const event = keyEvent('ArrowLeft');

    h.container.dispatchEvent(event);

    expect(h.state.active).toBe('orphan.md');
    expect(event.defaultPrevented).toBe(true);
    expect(h.deps.refresh).not.toHaveBeenCalled();
  });

  it('ArrowRight on a leaf does nothing', () => {
    const h = makeHarness(makeStructure(), 'b.md');

    h.container.dispatchEvent(keyEvent('ArrowRight'));

    expect(h.state.active).toBe('b.md');
    expect(h.deps.refresh).not.toHaveBeenCalled();
  });

  it('Home moves to the first sibling, End to the last', () => {
    const h = makeHarness(makeStructure(), 'a1.md');

    h.container.dispatchEvent(keyEvent('End'));
    expect(h.state.active).toBe('a2.md');

    h.container.dispatchEvent(keyEvent('Home'));
    expect(h.state.active).toBe('a1.md');
  });

  it('ArrowDown at the top level moves from the root to the first orphan', () => {
    const h = makeHarness(makeStructure(), 'root.md');

    h.container.dispatchEvent(keyEvent('ArrowDown'));

    expect(h.state.active).toBe('orphan.md');
  });

  it('does nothing if the active node is not found among its own computed siblings', () => {
    // 'a.md'.children is ['a1.md', 'a2.md'] and does not list this node — a broken invariant, but
    // the handler must not throw or move anywhere.
    const structure = withNode(makeStructure(), makeNode('orphaned.md', { parent: 'a.md' }));
    const h = makeHarness(structure, 'orphaned.md');

    h.container.dispatchEvent(keyEvent('ArrowDown'));

    expect(h.state.active).toBe('orphaned.md');
    expect(h.deps.refresh).not.toHaveBeenCalled();
  });

  it('treats a node with a dangling parent reference as its own only sibling', () => {
    const structure = withNode(makeStructure(), makeNode('dangling.md', { parent: 'missing.md' }));
    const h = makeHarness(structure, 'dangling.md');

    h.container.dispatchEvent(keyEvent('ArrowDown'));

    expect(h.state.active).toBe('dangling.md');
  });

  it('Home/End do nothing when the sibling list is empty', () => {
    // 'b.md' has no children, so a node claiming it as parent has an empty sibling list.
    const structure = withNode(makeStructure(), makeNode('lonely.md', { parent: 'b.md' }));
    const h = makeHarness(structure, 'lonely.md');

    h.container.dispatchEvent(keyEvent('Home'));

    expect(h.state.active).toBe('lonely.md');
    expect(h.deps.refresh).not.toHaveBeenCalled();
  });
});

describe('attachKeyboard — collapse/expand', () => {
  it('ArrowLeft collapses an expanded branch instead of moving to the parent', () => {
    const h = makeHarness(makeStructure(), 'a.md');

    h.container.dispatchEvent(keyEvent('ArrowLeft'));

    expect(h.state.collapsed.has('a.md')).toBe(true);
    expect(h.state.active).toBe('a.md');
    expect(h.deps.refresh).toHaveBeenCalledTimes(1);
  });

  it('ArrowRight expands a collapsed branch instead of moving to the first child', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    h.state.collapsed.add('a.md');

    h.container.dispatchEvent(keyEvent('ArrowRight'));

    expect(h.state.collapsed.has('a.md')).toBe(false);
    expect(h.state.active).toBe('a.md');
  });

  it('Space toggles collapse on the active branch', () => {
    const h = makeHarness(makeStructure(), 'a.md');

    h.container.dispatchEvent(keyEvent(' '));
    expect(h.state.collapsed.has('a.md')).toBe(true);

    h.container.dispatchEvent(keyEvent(' '));
    expect(h.state.collapsed.has('a.md')).toBe(false);
  });

  it('Space does nothing on a leaf (still prevents default)', () => {
    const h = makeHarness(makeStructure(), 'a1.md');
    const event = keyEvent(' ');

    h.container.dispatchEvent(event);

    expect(h.state.collapsed.size).toBe(0);
    expect(event.defaultPrevented).toBe(true);
    expect(h.deps.refresh).not.toHaveBeenCalled();
  });
});

describe('attachKeyboard — Enter / Mod+Enter', () => {
  it('Enter opens the note in the current tab', () => {
    const h = makeHarness(makeStructure(), 'a.md');

    h.container.dispatchEvent(keyEvent('Enter'));

    expect(h.deps.open).toHaveBeenCalledExactlyOnceWith('a.md', false);
  });

  it('Mod+Enter opens the note in a new tab', () => {
    const h = makeHarness(makeStructure(), 'a.md');

    h.container.dispatchEvent(keyEvent('Enter', { ctrlKey: true }));

    expect(h.deps.open).toHaveBeenCalledExactlyOnceWith('a.md', true);
  });
});

describe('attachKeyboard — Tab / Shift+Enter', () => {
  it('Tab calls addChild with the active node and its own element', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    const nodeEl = h.container.querySelector('[data-path="a.md"]');

    h.container.dispatchEvent(keyEvent('Tab'));

    expect(h.deps.addChild).toHaveBeenCalledExactlyOnceWith('a.md', nodeEl);
  });

  it('Shift+Enter calls addSibling with the active node and its own element', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    const nodeEl = h.container.querySelector('[data-path="a.md"]');

    h.container.dispatchEvent(keyEvent('Enter', { shiftKey: true }));

    expect(h.deps.addSibling).toHaveBeenCalledExactlyOnceWith('a.md', nodeEl);
  });

  it('Tab, Shift+Enter and t do nothing when the active node has no rendered element', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    h.container.querySelector('[data-path="a.md"]')?.remove();

    h.container.dispatchEvent(keyEvent('Tab'));
    h.container.dispatchEvent(keyEvent('Enter', { shiftKey: true }));
    h.container.dispatchEvent(keyEvent('t'));

    expect(h.deps.addChild).not.toHaveBeenCalled();
    expect(h.deps.addSibling).not.toHaveBeenCalled();
    expect(h.deps.retype).not.toHaveBeenCalled();
  });
});

describe('attachKeyboard — m / t / Mod+Z', () => {
  it('m opens the move picker', () => {
    const h = makeHarness(makeStructure(), 'a.md');

    h.container.dispatchEvent(keyEvent('m'));

    expect(h.deps.movePicker).toHaveBeenCalledExactlyOnceWith('a.md');
  });

  it('t opens the retype menu anchored to the active node', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    const nodeEl = h.container.querySelector('[data-path="a.md"]');

    h.container.dispatchEvent(keyEvent('t'));

    expect(h.deps.retype).toHaveBeenCalledExactlyOnceWith('a.md', nodeEl);
  });

  it('Mod+Z calls undo', () => {
    const h = makeHarness(makeStructure(), 'a.md');

    h.container.dispatchEvent(keyEvent('z', { ctrlKey: true }));

    expect(h.deps.undo).toHaveBeenCalledTimes(1);
  });

  it('Mod+Shift+Z (reserved for a future redo) does not call undo', () => {
    const h = makeHarness(makeStructure(), 'a.md');

    h.container.dispatchEvent(keyEvent('z', { ctrlKey: true, shiftKey: true }));

    expect(h.deps.undo).not.toHaveBeenCalled();
  });

  it('m/t with a modifier held do not act (plain letters only)', () => {
    const h = makeHarness(makeStructure(), 'a.md');

    h.container.dispatchEvent(keyEvent('m', { ctrlKey: true }));
    h.container.dispatchEvent(keyEvent('t', { shiftKey: true }));

    expect(h.deps.movePicker).not.toHaveBeenCalled();
    expect(h.deps.retype).not.toHaveBeenCalled();
  });

  it('m, t and Mod+Z inside an input are ignored', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    const input = createEl('input');
    h.container.appendChild(input);

    input.dispatchEvent(keyEvent('m'));
    input.dispatchEvent(keyEvent('t'));
    input.dispatchEvent(keyEvent('z', { ctrlKey: true }));

    expect(h.deps.movePicker).not.toHaveBeenCalled();
    expect(h.deps.retype).not.toHaveBeenCalled();
    expect(h.deps.undo).not.toHaveBeenCalled();
  });

  it('keys inside a textarea or a contenteditable are also ignored', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    const textarea = createEl('textarea');
    const editable = createDiv();
    editable.setAttribute('contenteditable', 'true');
    h.container.append(textarea, editable);

    textarea.dispatchEvent(keyEvent('ArrowDown'));
    editable.dispatchEvent(keyEvent('ArrowDown'));

    expect(h.state.active).toBe('a.md');
    expect(h.deps.refresh).not.toHaveBeenCalled();
  });

  it('an inner contenteditable="false" island wins over an outer contenteditable="true" editor root', () => {
    // Regression: Obsidian renders an embedded Bases view as a `contenteditable="false"` island
    // (`.bases-structure`, an ancestor of the keyboard's own `container`) inside a live-preview
    // note's own `contenteditable="true"` editor root. A selector match on any
    // `[contenteditable="true"]` ancestor (rather than the *nearest explicit* value) would treat
    // every keypress inside the embed as "typing" and disable keyboard control entirely outside
    // Reading view.
    const editorRoot = createDiv();
    editorRoot.setAttribute('contenteditable', 'true');
    const embedIsland = createDiv();
    embedIsland.setAttribute('contenteditable', 'false');
    document.body.appendChild(editorRoot);
    editorRoot.appendChild(embedIsland);
    const h = makeHarness(makeStructure(), 'a.md');
    embedIsland.appendChild(h.container);
    const nodeEl = h.container.querySelector('[data-path="a.md"]');
    if (nodeEl === null) throw new Error('Test setup error: missing node element');

    nodeEl.dispatchEvent(keyEvent('ArrowDown'));

    expect(h.state.active).toBe('b.md');
  });
});

describe('attachKeyboard — Escape', () => {
  it('clears the active node without a full refresh, and restores tabindex 0', () => {
    const h = makeHarness(makeStructure(), 'a.md');

    h.container.dispatchEvent(keyEvent('Escape'));

    expect(h.state.active).toBeNull();
    expect(h.deps.refresh).not.toHaveBeenCalled();
    expect(h.container.tabIndex).toBe(0);
    expect(h.container.querySelector('.bases-structure-node.is-active')).toBeNull();
  });

  it('moves real focus off the old node onto the container, so a later Tab can re-enter', () => {
    // Regression: `applyActiveNode(container, null)` marks every node inactive but returns no
    // element for `focusActiveNode` to focus — left alone, real DOM focus stays on the *old* node,
    // which now has `tabindex="-1"`. The browser's next Tab starts from wherever real focus
    // currently is, not from the roving-tabindex bookkeeping, so a stuck-on-a-`-1`-element focus
    // would skip right past the container's restored `tabindex="0"` re-entry point.
    const h = makeHarness(makeStructure(), null);
    const nodeEl = h.container.querySelector<HTMLElement>('[data-path="a.md"]');
    if (nodeEl === null) throw new Error('Test setup error: missing node element');
    nodeEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.activeElement).toBe(nodeEl);

    h.container.dispatchEvent(keyEvent('Escape'));

    expect(document.activeElement).toBe(h.container);
    expect(nodeEl.tabIndex).toBe(-1);
  });

  it('does not move focus when Escape fires while focus was already outside the container', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    const outside = createEl('input');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    h.container.dispatchEvent(keyEvent('Escape'));

    expect(document.activeElement).toBe(outside);
  });
});

describe('attachKeyboard — no active node / unhandled keys', () => {
  it('does nothing when no node is active', () => {
    const h = makeHarness(makeStructure(), null);
    const event = keyEvent('ArrowDown');

    h.container.dispatchEvent(event);

    expect(h.deps.refresh).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('clears a stale active path and restores tabindex 0, so Tab can re-enter the view', () => {
    // The node the last-known `state.active` pointed to is gone from the structure (moved,
    // retyped away, or deleted) — rather than leaving it active forever (which would also leave
    // the container's tabindex at -1, trapping a keyboard user with nothing tabbable in the
    // view), this must fall back to the "nothing active" state.
    const h = makeHarness(makeStructure(), 'gone.md');
    expect(h.container.tabIndex).toBe(-1);

    h.container.dispatchEvent(keyEvent('ArrowDown'));

    expect(h.deps.refresh).not.toHaveBeenCalled();
    expect(h.state.active).toBeNull();
    expect(h.container.tabIndex).toBe(0);
  });

  it('does not prevent default for an unrecognized key', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    const event = keyEvent('x');

    h.container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('a keydown whose target is not an HTMLElement (e.g. an SVG edge) is still handled normally', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    const svgEl = createSvg('path');
    h.container.appendChild(svgEl);

    svgEl.dispatchEvent(keyEvent('ArrowDown'));

    expect(h.state.active).toBe('b.md');
  });

  it('Alt+ArrowDown is not a recognized binding', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    const event = keyEvent('ArrowDown', { altKey: true });

    h.container.dispatchEvent(event);

    expect(h.state.active).toBe('a.md');
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('attachKeyboard — roving tabindex on the container', () => {
  it('starts at tabindex 0 with no active node', () => {
    const h = makeHarness(makeStructure(), null);

    expect(h.container.tabIndex).toBe(0);
  });

  it('initializes tabindex -1 when attached with an already-active node', () => {
    const h = makeHarness(makeStructure(), 'a.md');

    expect(h.container.tabIndex).toBe(-1);
  });

  it('flips to -1 once a node becomes active via click, and back to 0 after Escape', () => {
    const h = makeHarness(makeStructure(), null);

    h.container
      .querySelector('[data-path="a.md"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.container.tabIndex).toBe(-1);

    h.container.dispatchEvent(keyEvent('Escape'));
    expect(h.container.tabIndex).toBe(0);
  });
});

describe('attachKeyboard — entering via focus', () => {
  it('activates the structure root when the container itself receives focus', () => {
    const h = makeHarness(makeStructure(), null);

    h.container.dispatchEvent(new FocusEvent('focus'));

    expect(h.state.active).toBe('root.md');
  });

  it('activates the first top when there is no root', () => {
    const structure = { ...makeStructure(), root: null };
    const h = makeHarness(structure, null);

    h.container.dispatchEvent(new FocusEvent('focus'));

    expect(h.state.active).toBe('root.md');
  });

  it('activates the first orphan when there is neither a root nor tops', () => {
    const structure: Structure = {
      root: null,
      tops: [],
      orphans: ['orphan.md'],
      nodes: makeStructure().nodes,
      issues: [],
    };
    const h = makeHarness(structure, null);

    h.container.dispatchEvent(new FocusEvent('focus'));

    expect(h.state.active).toBe('orphan.md');
  });

  it('does nothing for a completely empty structure', () => {
    const empty: Structure = { root: null, tops: [], orphans: [], nodes: new Map(), issues: [] };
    const h = makeHarness(empty, null);

    h.container.dispatchEvent(new FocusEvent('focus'));

    expect(h.state.active).toBeNull();
    expect(h.deps.refresh).not.toHaveBeenCalled();
  });

  it('does not change the active node when the container is focused while one is already active', () => {
    const h = makeHarness(makeStructure(), 'a.md');

    h.container.dispatchEvent(new FocusEvent('focus'));

    expect(h.state.active).toBe('a.md');
    expect(h.deps.refresh).not.toHaveBeenCalled();
  });
});

describe('attachKeyboard — click sets active', () => {
  it('a click on a node sets it active without preventing the click', () => {
    const h = makeHarness(makeStructure(), null);
    const nodeEl = h.container.querySelector('[data-path="b.md"]');
    if (nodeEl === null) throw new Error('Test setup error: missing node element');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });

    nodeEl.dispatchEvent(event);

    expect(h.state.active).toBe('b.md');
    expect(event.defaultPrevented).toBe(false);
  });

  it('a click outside any node does not change the active node', () => {
    const h = makeHarness(makeStructure(), 'a.md');

    h.container.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(h.state.active).toBe('a.md');
  });

  it('ignores a click whose target is not an HTMLElement (e.g. an SVG edge in the graph)', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    const svgEl = createSvg('path');
    h.container.appendChild(svgEl);

    svgEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(h.state.active).toBe('a.md');
  });

  it('a click inside a typing target (draft input) does not change the active node', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    const nodeEl = h.container.querySelector('[data-path="b.md"]');
    const input = createEl('input');
    nodeEl?.appendChild(input);

    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(h.state.active).toBe('a.md');
  });

  it('a click on the node title does not change the active node (I9 — that gesture opens the note instead)', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    const nodeEl = h.container.querySelector('[data-path="b.md"]');
    if (nodeEl === null) throw new Error('Test setup error: missing node element');
    const titleEl = createEl('a', { cls: 'bases-structure-title' });
    nodeEl.appendChild(titleEl);

    titleEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(h.state.active).toBe('a.md');
  });

  it('a click on some other part of the same node (not its title) still changes the active node', () => {
    const h = makeHarness(makeStructure(), 'a.md');
    const nodeEl = h.container.querySelector('[data-path="b.md"]');
    if (nodeEl === null) throw new Error('Test setup error: missing node element');
    const titleEl = createEl('a', { cls: 'bases-structure-title' });
    nodeEl.appendChild(titleEl);

    // The click lands on the node itself (e.g. its background), not the title link.
    nodeEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(h.state.active).toBe('b.md');
  });
});

describe('attachKeyboard — disposer', () => {
  it('removes the keydown, focus and click listeners', () => {
    const h = makeHarness(makeStructure(), null);

    h.dispose();

    h.container.dispatchEvent(new FocusEvent('focus'));
    expect(h.state.active).toBeNull();

    h.container
      .querySelector('[data-path="a.md"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.state.active).toBeNull();
  });

  it('removes the keydown listener (no more refresh calls after dispose)', () => {
    const h = makeHarness(makeStructure(), 'a.md');

    h.dispose();
    h.container.dispatchEvent(keyEvent('ArrowDown'));

    expect(h.deps.refresh).not.toHaveBeenCalled();
  });
});
