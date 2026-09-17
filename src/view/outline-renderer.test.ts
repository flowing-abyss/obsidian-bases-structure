import { App, Component } from 'obsidian-test-mocks/obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { note, snapshot } from '../core/__tests__/notes.js';
import { parseSchema } from '../core/schema.js';
import type { Structure } from '../core/structure.js';
import { buildStructure } from '../core/structure.js';
import type { NodeElementContext } from './node-element.js';
import { OutlineRenderer } from './outline-renderer.js';
import { clearUiState, getUiState } from './view-state.js';

function makeRead(config: Record<string, unknown>): (key: string) => unknown {
  return (key: string): unknown => config[key];
}

function makeCtx(overrides: Partial<NodeElementContext> = {}): NodeElementContext {
  const app = App.createConfigured__();
  return {
    app: app.asOriginalType__(),
    sourcePath: '',
    hoverParent: Component.create__().asOriginalType__(),
    snapshot: snapshot([]),
    onAdd: () => undefined,
    onMenu: () => undefined,
    ...overrides,
  };
}

/** The outline's own scrollable wrapper — tests reach into it for things (a stray text node,
 * scrollTop) that must land inside the element the renderer actually wires listeners/scrolling
 * to, not on the outer `container` the constructor was given. */
function outlineEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('.bases-structure-outline');
  if (el === null) {
    throw new Error('Test setup error: .bases-structure-outline not found');
  }
  return el;
}

afterEach(() => {
  clearUiState();
  vi.restoreAllMocks();
});

describe('OutlineRenderer', () => {
  it('renders tops depth-first, nesting children under their parent in children order', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [
        note('root.md'),
        note('child1.md', { propertyLinks: { up: ['root.md'] } }),
        note('child2.md', { propertyLinks: { up: ['root.md'] } }),
        note('grandchild.md', { propertyLinks: { up: ['child1.md'] } }),
      ],
      { results: ['grandchild.md', 'child2.md', 'child1.md', 'root.md'] },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));

    renderer.update({ schema, snapshot: snap, structure, state: getUiState('outline-nesting') });

    const nodes = container.querySelectorAll('.bases-structure-title');
    expect(Array.from(nodes).map((el) => el.textContent)).toStrictEqual([
      'root',
      'child2',
      'child1',
      'grandchild',
    ]);
    const grandchildEl = container.querySelector('[data-path="grandchild.md"]');
    const child1Li = container.querySelector('[data-path="child1.md"]')?.closest('li');
    expect(child1Li?.contains(grandchildEl ?? null)).toBe(true);
  });

  it('wraps the whole tree in the documented DOM shape (outline > list > item > node)', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
      { results: ['child.md', 'root.md'] },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));

    renderer.update({ schema, snapshot: snap, structure, state: getUiState('outline-shape') });

    const outline = outlineEl(container);
    const topList = outline.querySelector(':scope > ul.bases-structure-outline-list');
    expect(topList).not.toBeNull();
    const rootLi = topList?.querySelector<HTMLElement>(':scope > li.bases-structure-outline-item');
    expect(rootLi?.querySelector(':scope > .bases-structure-node')).not.toBeNull();
    const childList = rootLi?.querySelector(':scope > ul.bases-structure-outline-list');
    expect(childList?.querySelector('[data-path="child.md"]')).not.toBeNull();
  });

  it('flags only the node matching focusPath with is-new', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
      { results: ['child.md', 'root.md'] },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));

    renderer.update({
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-focus'),
      focusPath: 'child.md',
    });

    const rootEl = container.querySelector('[data-path="root.md"]');
    const childEl = container.querySelector('[data-path="child.md"]');
    expect(childEl?.classList.contains('is-new')).toBe(true);
    expect(rootEl?.classList.contains('is-new')).toBe(false);
  });

  it('renders orphans, inside the top-level list, under a final "Without a parent" section', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('host.md'), note('a.md', { propertyLinks: { up: ['host.md'] } }), note('orphan.md')],
      { results: ['a.md', 'orphan.md'], host: 'host.md' },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(
      container,
      makeCtx({ snapshot: snap, sourcePath: 'host.md' }),
    );

    renderer.update({ schema, snapshot: snap, structure, state: getUiState('outline-orphans') });

    const orphansLi = container.querySelector('.bases-structure-orphans');
    expect(orphansLi?.textContent).toContain('Without a parent');
    expect(orphansLi?.querySelector('.bases-structure-title')?.textContent).toBe('orphan');
    expect(
      container.querySelector('[data-path="orphan.md"]')?.classList.contains('is-orphan'),
    ).toBe(true);
    // The orphan section is a final `li` INSIDE the same top-level `<ul>` as the tops, not a
    // second sibling list.
    const topList = outlineEl(container).querySelector('ul.bases-structure-outline-list');
    expect(orphansLi?.parentElement).toBe(topList);
  });

  it('does not infinite-loop and renders each path once when children form a cycle', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md'), note('b.md')], { results: ['a.md', 'b.md'] });
    const structure: Structure = {
      root: null,
      tops: ['a.md'],
      orphans: [],
      nodes: new Map([
        [
          'a.md',
          {
            path: 'a.md',
            type: '',
            parent: null,
            edge: null,
            children: ['b.md'],
            extras: [],
            alsoIn: [],
            twoWay: false,
          },
        ],
        [
          'b.md',
          {
            path: 'b.md',
            type: '',
            parent: 'a.md',
            edge: null,
            children: ['a.md'],
            extras: [],
            alsoIn: [],
            twoWay: false,
          },
        ],
      ]),
      issues: [],
    };
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));

    renderer.update({ schema, snapshot: snap, structure, state: getUiState('outline-cycle') });

    expect(container.querySelectorAll('.bases-structure-node')).toHaveLength(2);
  });

  it('skips a child path with no corresponding structure node (defensive)', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md')], { results: ['a.md'] });
    const structure: Structure = {
      root: null,
      tops: ['a.md'],
      orphans: [],
      nodes: new Map([
        [
          'a.md',
          {
            path: 'a.md',
            type: '',
            parent: null,
            edge: null,
            children: ['missing.md'],
            extras: [],
            alsoIn: [],
            twoWay: false,
          },
        ],
      ]),
      issues: [],
    };
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));

    renderer.update({
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-missing-node'),
    });

    expect(container.querySelectorAll('.bases-structure-node')).toHaveLength(1);
  });

  it('shows the empty message with no data, and hides it again once content renders', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([], { results: [] });
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));

    renderer.update({ schema, snapshot: snap, structure, state: getUiState('outline-empty') });

    const emptyEl = container.querySelector('.bases-structure-empty');
    expect(emptyEl?.classList.contains('is-hidden')).toBe(false);
    expect(emptyEl?.textContent).toBe('Nothing to show yet');
    expect(container.querySelector('.bases-structure-outline-list')).toBeNull();

    const snap2 = snapshot([note('a.md')], { results: ['a.md'] });
    const structure2 = buildStructure(schema, snap2);
    renderer.update({
      schema,
      snapshot: snap2,
      structure: structure2,
      state: getUiState('outline-empty'),
    });

    expect(emptyEl?.classList.contains('is-hidden')).toBe(true);
    expect(container.querySelector('[data-path="a.md"]')).not.toBeNull();
  });

  it('adds a toggle only for nodes with children, and toggling it flips state.collapsed', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
      { results: ['child.md', 'root.md'] },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-toggle');

    renderer.update({ schema, snapshot: snap, structure, state });

    const rootToggle = container.querySelector<HTMLButtonElement>(
      '[data-path="root.md"] > .bases-structure-toggle',
    );
    expect(rootToggle).not.toBeNull();
    expect(container.querySelector('[data-path="child.md"] .bases-structure-toggle')).toBeNull();
    expect(rootToggle?.getAttribute('aria-expanded')).toBe('true');

    rootToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(state.collapsed.has('root.md')).toBe(true);
  });

  it('collapsing a node via its toggle omits its child list, and survives a later update', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
      { results: ['child.md', 'root.md'] },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-collapse-persist');

    renderer.update({ schema, snapshot: snap, structure, state });
    container
      .querySelector('[data-path="root.md"] .bases-structure-toggle')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(container.querySelector('[data-path="child.md"]')).toBeNull();
    expect(
      container
        .querySelector('[data-path="root.md"] .bases-structure-toggle')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');

    renderer.update({ schema, snapshot: snap, structure, state });

    expect(container.querySelector('[data-path="child.md"]')).toBeNull();
    expect(container.querySelector('[data-path="root.md"]')).not.toBeNull();

    container
      .querySelector('[data-path="root.md"] .bases-structure-toggle')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(container.querySelector('[data-path="child.md"]')).not.toBeNull();
  });

  it('a click that does not land on the toggle does not change state.collapsed', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
      { results: ['child.md', 'root.md'] },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-toggle-miss');

    renderer.update({ schema, snapshot: snap, structure, state });
    container
      .querySelector('[data-path="root.md"] .bases-structure-title')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(state.collapsed.size).toBe(0);
  });

  it('renders the alsoIn chip for a node with extra parents and omits it otherwise', () => {
    // Mirrors `structure.test.ts`'s "external targets and alsoIn" fixture: `other.md` is a real
    // note (so `displayName` resolves it) but not a result, so it never becomes a structure node
    // — exactly the "right type, outside the node set" case `alsoIn` is for.
    const config = {
      types: {
        Category: { tag: 'cat', children: { Meta: 'category', Hierarchy: 'category' } },
        Meta: { tag: 'meta', children: { Hierarchy: 'meta' } },
        Hierarchy: { tag: 'hier' },
      },
    };
    const { schema } = parseSchema(makeRead(config));
    const base = snapshot([
      note('root.md', { tags: ['cat'] }),
      note('meta.md', { tags: ['meta'], propertyLinks: { category: ['root.md', 'other.md'] } }),
      note('hierarchy.md', {
        tags: ['hier'],
        propertyLinks: { meta: ['meta.md'], category: ['root.md', 'other.md'] },
      }),
    ]);
    const notes = new Map(base.notes).set('other.md', note('other.md', { tags: ['cat'] }));
    const snap = { ...base, notes };
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));

    renderer.update({ schema, snapshot: snap, structure, state: getUiState('outline-alsoin') });

    const metaChip = container.querySelector('[data-path="meta.md"] .bases-structure-alsoin');
    expect(metaChip?.textContent).toBe('other');
    const hierChip = container.querySelector('[data-path="hierarchy.md"] .bases-structure-alsoin');
    expect(hierChip).toBeNull();
  });

  it('the "+" button reuses the shared onAdd handler', () => {
    const onAdd = vi.fn();
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md')], { results: ['a.md'] });
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap, onAdd }));

    renderer.update({ schema, snapshot: snap, structure, state: getUiState('outline-add') });
    const nodeEl = container.querySelector<HTMLElement>('[data-path="a.md"]');
    const buttonEl = container.querySelector('[data-path="a.md"] .bases-structure-add');
    buttonEl?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(onAdd).toHaveBeenCalledExactlyOnceWith('a.md', nodeEl, buttonEl);
  });

  it('a pointerdown on an outline row is a valid drag source (data-path present)', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md')], { results: ['a.md'] });
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));

    renderer.update({ schema, snapshot: snap, structure, state: getUiState('outline-drag') });

    const nodeEl = container.querySelector<HTMLElement>('[data-path="a.md"]');
    expect(nodeEl?.getAttribute('data-path')).toBe('a.md');
    expect(nodeEl?.classList.contains('bases-structure-node')).toBe(true);
  });

  it('opens the link on click with the host path as source and the mod-event state', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('host.md'), note('a.md', { propertyLinks: { up: ['host.md'] } })], {
      results: ['a.md'],
      host: 'host.md',
    });
    const structure = buildStructure(schema, snap);
    const app = App.createConfigured__();
    const openLinkText = vi.spyOn(app.workspace, 'openLinkText').mockResolvedValue();
    const container = createDiv();
    const renderer = new OutlineRenderer(
      container,
      makeCtx({ app: app.asOriginalType__(), snapshot: snap, sourcePath: 'host.md' }),
    );
    renderer.update({ schema, snapshot: snap, structure, state: getUiState('outline-click') });

    const title = container.querySelector('[data-path="a.md"] .bases-structure-title');
    title?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(openLinkText).toHaveBeenCalledWith('a.md', 'host.md', expect.anything());
  });

  it('triggers hover-link on mouseover with the linktext and source', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('host.md'), note('a.md', { propertyLinks: { up: ['host.md'] } })], {
      results: ['a.md'],
      host: 'host.md',
    });
    const structure = buildStructure(schema, snap);
    const app = App.createConfigured__();
    const trigger = vi.spyOn(app.workspace, 'trigger');
    const container = createDiv();
    const renderer = new OutlineRenderer(
      container,
      makeCtx({ app: app.asOriginalType__(), snapshot: snap, sourcePath: 'host.md' }),
    );
    renderer.update({ schema, snapshot: snap, structure, state: getUiState('outline-hover') });

    const title = container.querySelector('[data-path="a.md"] .bases-structure-title');
    title?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    expect(trigger).toHaveBeenCalledWith(
      'hover-link',
      expect.objectContaining({
        source: 'bases-structure',
        linktext: 'a.md',
        sourcePath: 'host.md',
      }),
    );
  });

  it('logs an error when opening the link rejects', async () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md')], { results: ['a.md'] });
    const structure = buildStructure(schema, snap);
    const app = App.createConfigured__();
    const error = new Error('failed to open');
    vi.spyOn(app.workspace, 'openLinkText').mockRejectedValue(error);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const container = createDiv();
    const renderer = new OutlineRenderer(
      container,
      makeCtx({ app: app.asOriginalType__(), snapshot: snap }),
    );
    renderer.update({
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-click-error'),
    });

    const title = container.querySelector('[data-path="a.md"] .bases-structure-title');
    title?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', error);
  });

  it('ignores an event whose target is not an HTMLElement (e.g. a text node)', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md')], { results: ['a.md'] });
    const structure = buildStructure(schema, snap);
    const app = App.createConfigured__();
    const openLinkText = vi.spyOn(app.workspace, 'openLinkText').mockResolvedValue();
    const container = createDiv();
    const renderer = new OutlineRenderer(
      container,
      makeCtx({ app: app.asOriginalType__(), snapshot: snap }),
    );
    renderer.update({
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-text-target'),
    });
    const textNode = document.createTextNode('stray text');
    outlineEl(container).appendChild(textNode);

    textNode.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(openLinkText).not.toHaveBeenCalled();
  });

  it('ignores a click that does not land on a title', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md')], { results: ['a.md'] });
    const structure = buildStructure(schema, snap);
    const app = App.createConfigured__();
    const openLinkText = vi.spyOn(app.workspace, 'openLinkText').mockResolvedValue();
    const container = createDiv();
    const renderer = new OutlineRenderer(
      container,
      makeCtx({ app: app.asOriginalType__(), snapshot: snap }),
    );
    renderer.update({ schema, snapshot: snap, structure, state: getUiState('outline-click-miss') });

    outlineEl(container).dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(openLinkText).not.toHaveBeenCalled();
  });

  it('ignores a mouseover that does not land on a title', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md')], { results: ['a.md'] });
    const structure = buildStructure(schema, snap);
    const app = App.createConfigured__();
    const trigger = vi.spyOn(app.workspace, 'trigger');
    const container = createDiv();
    const renderer = new OutlineRenderer(
      container,
      makeCtx({ app: app.asOriginalType__(), snapshot: snap }),
    );
    renderer.update({ schema, snapshot: snap, structure, state: getUiState('outline-hover-miss') });

    outlineEl(container).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    expect(trigger).not.toHaveBeenCalled();
  });

  describe('getNodeElement', () => {
    it('returns the element for a path with spaces and quotes in it', () => {
      const { schema } = parseSchema(makeRead({ parent: 'up' }));
      const path = 'a "weird" note.md';
      const snap = snapshot([note(path)], { results: [path] });
      const structure = buildStructure(schema, snap);
      const container = createDiv();
      const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
      renderer.update({ schema, snapshot: snap, structure, state: getUiState('outline-getnode') });

      const el = renderer.getNodeElement(path);

      expect(el).not.toBeNull();
      expect(el?.getAttribute('data-path')).toBe(path);
    });

    it('returns null for an unknown path', () => {
      const { schema } = parseSchema(makeRead({ parent: 'up' }));
      const snap = snapshot([note('a.md')], { results: ['a.md'] });
      const structure = buildStructure(schema, snap);
      const container = createDiv();
      const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
      renderer.update({
        schema,
        snapshot: snap,
        structure,
        state: getUiState('outline-getnode-miss'),
      });

      expect(renderer.getNodeElement('nope.md')).toBeNull();
    });
  });

  it('marks state.active is-active with tabindex 0, and the class survives a re-render', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
      { results: ['child.md', 'root.md'] },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-active');
    state.active = 'child.md';

    renderer.update({ schema, snapshot: snap, structure, state });

    let childEl = container.querySelector<HTMLElement>('[data-path="child.md"]');
    let rootEl = container.querySelector<HTMLElement>('[data-path="root.md"]');
    expect(childEl?.classList.contains('is-active')).toBe(true);
    expect(childEl?.tabIndex).toBe(0);
    expect(rootEl?.classList.contains('is-active')).toBe(false);
    expect(rootEl?.tabIndex).toBe(-1);

    renderer.update({ schema, snapshot: snap, structure, state });

    childEl = container.querySelector<HTMLElement>('[data-path="child.md"]');
    rootEl = container.querySelector<HTMLElement>('[data-path="root.md"]');
    expect(childEl?.classList.contains('is-active')).toBe(true);
    expect(childEl?.tabIndex).toBe(0);
    expect(rootEl?.tabIndex).toBe(-1);
  });

  it('does not move focus on the very first render, even when state.active already names a node (I9)', () => {
    // `state` survives a renderer being torn down and recreated (`getUiState` is keyed
    // independent of any one renderer instance) — a fresh renderer's first render must not treat
    // an already-non-null `state.active` as "just changed" and steal focus/scroll nobody asked for.
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
      { results: ['child.md', 'root.md'] },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-active-first-render');
    state.active = 'child.md';

    renderer.update({ schema, snapshot: snap, structure, state });

    const childEl = container.querySelector<HTMLElement>('[data-path="child.md"]');
    expect(childEl?.classList.contains('is-active')).toBe(true);
    expect(document.activeElement).not.toBe(childEl);
  });

  it('moves real focus to the active node when the active path changes between renders (after the first)', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
      { results: ['child.md', 'root.md'] },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-active-focus');
    renderer.update({ schema, snapshot: snap, structure, state }); // First render: nothing active.

    state.active = 'child.md';
    renderer.update({ schema, snapshot: snap, structure, state });
    const childEl = container.querySelector<HTMLElement>('[data-path="child.md"]');
    expect(document.activeElement).toBe(childEl);

    state.active = 'root.md';
    renderer.update({ schema, snapshot: snap, structure, state });
    const rootEl = container.querySelector<HTMLElement>('[data-path="root.md"]');
    expect(document.activeElement).toBe(rootEl);
  });

  it('re-focuses the rebuilt active node on a same-active-path re-render when focus was already inside', () => {
    // See the graph renderer's identical test for why: every `update()` rebuilds the node
    // elements from scratch (destroying whatever had real focus), even for a collapse/expand
    // refresh where `state.active` itself doesn't change.
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
      { results: ['child.md', 'root.md'] },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-active-refocus');
    renderer.update({ schema, snapshot: snap, structure, state }); // First render: nothing active.

    state.active = 'child.md';
    renderer.update({ schema, snapshot: snap, structure, state }); // Active newly set: focus follows.
    const childEl = container.querySelector<HTMLElement>('[data-path="child.md"]');
    expect(document.activeElement).toBe(childEl);

    renderer.update({ schema, snapshot: snap, structure, state });

    const rebuiltChildEl = container.querySelector<HTMLElement>('[data-path="child.md"]');
    expect(rebuiltChildEl).not.toBe(childEl);
    expect(document.activeElement).toBe(rebuiltChildEl);
  });

  it('does not steal focus on a same-active-path re-render when focus was elsewhere', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
      { results: ['child.md', 'root.md'] },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-active-no-steal');
    state.active = 'child.md';
    renderer.update({ schema, snapshot: snap, structure, state });
    const outside = createEl('input');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    renderer.update({ schema, snapshot: snap, structure, state });

    expect(document.activeElement).toBe(outside);
  });

  it('restores scrollTop across updates, on the element that actually scrolls (M5)', () => {
    // `container` (what the constructor is given) is `.bases-structure-body` in production — the
    // element with `overflow: auto` — not `.bases-structure-outline` (`outlineEl`), which is a
    // plain flex column with no height constraint of its own and so never actually scrolls.
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md')], { results: ['a.md'] });
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-scroll');
    state.scrollTop = 42;

    renderer.update({ schema, snapshot: snap, structure, state });

    expect(container.scrollTop).toBe(42);
  });

  it('keeps a scrolled position across a toggle-triggered update (regression)', () => {
    // Reviewer-reported sequence: scroll down, then collapse/expand a node — `handleToggleClick`
    // re-runs `update(lastInput)`, which re-applies `state.scrollTop` to the DOM. Before this fix,
    // nothing ever wrote the live scroll position *back* into `state`, so that re-render snapped
    // the view back to whatever `state.scrollTop` was left at (0, by default).
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
      { results: ['child.md', 'root.md'] },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-scroll-toggle');
    renderer.update({ schema, snapshot: snap, structure, state });

    container.scrollTop = 77;
    container.dispatchEvent(new Event('scroll'));
    expect(state.scrollTop).toBe(77);

    container
      .querySelector('[data-path="root.md"] .bases-structure-toggle')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(state.scrollTop).toBe(77);
    expect(container.scrollTop).toBe(77);
  });

  it('stops writing scrollTop into state once destroyed', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md')], { results: ['a.md'] });
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-scroll-destroy');
    renderer.update({ schema, snapshot: snap, structure, state });

    renderer.destroy();
    container.scrollTop = 99;
    container.dispatchEvent(new Event('scroll'));

    expect(state.scrollTop).toBe(0);
  });

  it('destroy empties the container and removes its listeners', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md')], { results: ['a.md'] });
    const structure = buildStructure(schema, snap);
    const app = App.createConfigured__();
    const openLinkText = vi.spyOn(app.workspace, 'openLinkText').mockResolvedValue();
    const container = createDiv();
    const renderer = new OutlineRenderer(
      container,
      makeCtx({ app: app.asOriginalType__(), snapshot: snap }),
    );
    renderer.update({ schema, snapshot: snap, structure, state: getUiState('outline-destroy') });

    renderer.destroy();

    expect(container.childElementCount).toBe(0);
    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(openLinkText).not.toHaveBeenCalled();
  });

  describe('pop-out window (M3)', () => {
    it('checks focus against the container’s own document on a same-active-path re-render, not the global one', () => {
      // See `keyboard.test.ts`'s identical pop-out test for why an `<iframe>` (real focus
      // tracking) and a main-realm `container` merely *adopted* into it.
      const { schema } = parseSchema(makeRead({ parent: 'up' }));
      const snap = snapshot(
        [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
        { results: ['child.md', 'root.md'] },
      );
      const structure = buildStructure(schema, snap);
      const iframe = createEl('iframe');
      document.body.appendChild(iframe);
      const otherDoc = iframe.contentDocument;
      if (otherDoc === null) throw new Error('Test setup error: iframe has no contentDocument');
      const container = createDiv();
      otherDoc.body.appendChild(container);
      const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
      const state = getUiState('outline-popout');
      renderer.update({ schema, snapshot: snap, structure, state }); // First render: I9.

      state.active = 'child.md';
      renderer.update({ schema, snapshot: snap, structure, state }); // Active newly set: focus follows.
      const childEl = container.querySelector<HTMLElement>('[data-path="child.md"]');
      expect(otherDoc.activeElement).toBe(childEl);

      renderer.update({ schema, snapshot: snap, structure, state }); // Same path: only hadFocus can trigger refocus.

      const rebuiltChildEl = container.querySelector<HTMLElement>('[data-path="child.md"]');
      expect(rebuiltChildEl).not.toBe(childEl);
      expect(otherDoc.activeElement).toBe(rebuiltChildEl);
    });
  });
});
