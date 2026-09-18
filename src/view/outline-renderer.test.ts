import { App, Component } from 'obsidian-test-mocks/obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { note, snapshot } from '../core/__tests__/notes.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { parseSchema } from '../core/schema.js';
import type { Structure, StructureNode } from '../core/structure.js';
import { buildStructure } from '../core/structure.js';
import * as superchargedLinksModule from '../obsidian/supercharged-links.js';
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
    onContextMenu: () => undefined,
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

/** Unwraps a nullable query result so assertions can use plain member access instead of a
 * non-null assertion. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('expected a value, got null/undefined');
  }
  return value;
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

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-nesting'),
    });

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

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-shape'),
    });

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
      diagnostics: [],
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

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-orphans'),
    });

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

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-cycle'),
    });

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
      diagnostics: [],
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

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-empty'),
    });

    const emptyEl = container.querySelector('.bases-structure-empty');
    expect(emptyEl?.classList.contains('is-hidden')).toBe(false);
    expect(emptyEl?.textContent).toBe('Nothing to show yet');
    expect(container.querySelector('.bases-structure-outline-list')).toBeNull();

    const snap2 = snapshot([note('a.md')], { results: ['a.md'] });
    const structure2 = buildStructure(schema, snap2);
    renderer.update({
      diagnostics: [],
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

    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

    const rootToggle = container.querySelector<HTMLButtonElement>(
      '[data-path="root.md"] > .bases-structure-toggle',
    );
    expect(rootToggle).not.toBeNull();
    expect(container.querySelector('[data-path="child.md"] .bases-structure-toggle')).toBeNull();
    expect(rootToggle?.getAttribute('aria-expanded')).toBe('true');

    rootToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(state.collapsed.has('root.md')).toBe(true);
  });

  it('reserves the toggle gutter on a leaf row with an inert spacer in the same slot', () => {
    // Regression: a leaf row used to have no toggle at all, so its title started 20px+margin
    // to the left of a sibling row that does have children — depth stopped being the only thing
    // that decided a title's x position. The fix reserves the same box on every row.
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
      { results: ['child.md', 'root.md'] },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-gutter'),
    });

    const rootEl = must(container.querySelector<HTMLElement>('[data-path="root.md"]'));
    const childEl = must(container.querySelector<HTMLElement>('[data-path="child.md"]'));
    const rootTitle = must(rootEl.querySelector('.bases-structure-title'));
    const childTitle = must(childEl.querySelector('.bases-structure-title'));

    // Parent row: the toggle itself sits first, ahead of the title.
    expect(rootEl.firstElementChild?.classList.contains('bases-structure-toggle')).toBe(true);
    expect(rootEl.firstElementChild).not.toBe(rootTitle);

    // Leaf row: an inert spacer occupies the exact same slot, also ahead of the title.
    const spacer = childEl.firstElementChild;
    expect(spacer?.classList.contains('bases-structure-toggle-spacer')).toBe(true);
    expect(spacer).not.toBe(childTitle);
    expect(spacer?.tagName).not.toBe('BUTTON');
    expect(spacer?.getAttribute('aria-hidden')).toBe('true');
    expect(spacer?.hasAttribute('tabindex')).toBe(false);
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

    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });
    container
      .querySelector('[data-path="root.md"] .bases-structure-toggle')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(container.querySelector('[data-path="child.md"]')).toBeNull();
    expect(
      container
        .querySelector('[data-path="root.md"] .bases-structure-toggle')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');

    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

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

    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });
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

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-alsoin'),
    });

    const metaChip = container.querySelector('[data-path="meta.md"] .bases-structure-alsoin');
    expect(metaChip?.textContent).toBe('other');
    const hierChip = container.querySelector('[data-path="hierarchy.md"] .bases-structure-alsoin');
    expect(hierChip).toBeNull();
  });

  it('marks a two-way node with a small icon right before the title, and omits it otherwise (I8)', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
      { results: ['child.md', 'root.md'] },
    );
    const base = buildStructure(schema, snap);
    const childNode = base.nodes.get('child.md');
    if (childNode === undefined) throw new Error('missing child node');
    const nodes = new Map(base.nodes).set('child.md', { ...childNode, twoWay: true });
    const structure: Structure = { ...base, nodes };
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-twoway'),
    });

    const childEl = container.querySelector('[data-path="child.md"]');
    const icon = childEl?.querySelector('.bases-structure-two-way-icon');
    expect(icon).not.toBeNull();
    const title = childEl?.querySelector('.bases-structure-title');
    expect(icon?.nextElementSibling).toBe(title);
    const rootEl = container.querySelector('[data-path="root.md"]');
    expect(rootEl?.querySelector('.bases-structure-two-way-icon')).toBeNull();
  });

  it('renders the extras chip ("also under <names>") for a node with extra candidate parents, and omits it otherwise (I8)', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [
        note('root.md'),
        note('other.md', { basename: 'Other' }),
        note('child.md', { propertyLinks: { up: ['root.md'] } }),
      ],
      { results: ['child.md', 'root.md'] },
    );
    const base = buildStructure(schema, snap);
    const childNode = base.nodes.get('child.md');
    if (childNode === undefined) throw new Error('missing child node');
    const nodes = new Map(base.nodes).set('child.md', {
      ...childNode,
      extras: [{ parent: 'other.md', kind: 'property' }],
    });
    const structure: Structure = { ...base, nodes };
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-extras'),
    });

    const chip = container.querySelector('[data-path="child.md"] .bases-structure-extras');
    expect(chip?.querySelector('.bases-structure-extras-icon')).not.toBeNull();
    expect(chip?.textContent).toBe('also under Other');
    expect(chip?.getAttribute('title')).toBe('also under Other');
    const rootChip = container.querySelector('[data-path="root.md"] .bases-structure-extras');
    expect(rootChip).toBeNull();
  });

  it('the "+" button reuses the shared onAdd handler', () => {
    const onAdd = vi.fn();
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md')], { results: ['a.md'] });
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap, onAdd }));

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-add'),
    });
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

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-drag'),
    });

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
    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-click'),
    });

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
    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-hover'),
    });

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
      diagnostics: [],
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
      diagnostics: [],
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
    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-click-miss'),
    });

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
    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-hover-miss'),
    });

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
      renderer.update({
        diagnostics: [],
        schema,
        snapshot: snap,
        structure,
        state: getUiState('outline-getnode'),
      });

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
        diagnostics: [],
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

    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

    let childEl = container.querySelector<HTMLElement>('[data-path="child.md"]');
    let rootEl = container.querySelector<HTMLElement>('[data-path="root.md"]');
    expect(childEl?.classList.contains('is-active')).toBe(true);
    expect(childEl?.tabIndex).toBe(0);
    expect(rootEl?.classList.contains('is-active')).toBe(false);
    expect(rootEl?.tabIndex).toBe(-1);

    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

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

    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

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
    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state }); // First render: nothing active.

    state.active = 'child.md';
    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });
    const childEl = container.querySelector<HTMLElement>('[data-path="child.md"]');
    expect(document.activeElement).toBe(childEl);

    state.active = 'root.md';
    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });
    const rootEl = container.querySelector<HTMLElement>('[data-path="root.md"]');
    expect(document.activeElement).toBe(rootEl);
  });

  it('keeps real focus on the active node across a same-active-path re-render when focus was already inside', () => {
    // See the graph renderer's identical test for why: node elements are reused across
    // `update()` now (perf task), so `childEl` never actually loses real focus here — but
    // `applyActiveState` still has to *ask* to focus it again (via `hadFocus`) on every render
    // regardless, for whichever node a render *does* have to replace.
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
    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state }); // First render: nothing active.

    state.active = 'child.md';
    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state }); // Active newly set: focus follows.
    const childEl = container.querySelector<HTMLElement>('[data-path="child.md"]');
    expect(document.activeElement).toBe(childEl);

    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

    const sameChildEl = container.querySelector<HTMLElement>('[data-path="child.md"]');
    expect(sameChildEl).toBe(childEl);
    expect(document.activeElement).toBe(sameChildEl);
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
    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });
    const outside = createEl('input');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

    expect(document.activeElement).toBe(outside);
  });

  // I11 regression: mirrors the graph renderer's identical test — a create draft's own input can
  // be nested inside the active node's own element (a Tab-created child draft, anchored on it),
  // so `hadFocus` is true even though focus belongs to the draft, not the node. `suppressFocus` is
  // `showOptimistic`'s own signal (see `structure-view.ts`) that this render must not move focus.
  it('does not move focus onto the active node when suppressFocus is set, even with focus nested inside it (I11)', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot(
      [note('root.md'), note('child.md', { propertyLinks: { up: ['root.md'] } })],
      { results: ['child.md', 'root.md'] },
    );
    const structure = buildStructure(schema, snap);
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-active-suppress-focus');
    state.active = 'child.md';
    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });
    const childEl = must(container.querySelector<HTMLElement>('[data-path="child.md"]'));
    const draftInput = createEl('input');
    childEl.appendChild(draftInput);
    draftInput.focus();
    expect(document.activeElement).toBe(draftInput);

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state,
      suppressFocus: true,
    });

    expect(document.activeElement).toBe(draftInput);
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

    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

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
    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

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
    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

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
    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure,
      state: getUiState('outline-destroy'),
    });

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
      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state }); // First render: I9.

      state.active = 'child.md';
      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state }); // Active newly set: focus follows.
      const childEl = container.querySelector<HTMLElement>('[data-path="child.md"]');
      expect(otherDoc.activeElement).toBe(childEl);

      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state }); // Same path: only hadFocus can trigger refocus.

      // `childEl` is reused now (perf task) and never actually lost focus — this still guards
      // `hadFocus` reading the right document for whichever node a render *does* have to replace.
      const sameChildEl = container.querySelector<HTMLElement>('[data-path="child.md"]');
      expect(sameChildEl).toBe(childEl);
      expect(otherDoc.activeElement).toBe(sameChildEl);
    });
  });

  describe('Supercharged Links (D1)', () => {
    it('hooks the outline container once at construction, and unhooks it once on destroy', () => {
      const hookSpy = vi.spyOn(superchargedLinksModule, 'hookSuperchargedLinks');
      const unhookSpy = vi.spyOn(superchargedLinksModule, 'unhookSuperchargedLinks');
      const container = createDiv();
      const ctx = makeCtx();

      const renderer = new OutlineRenderer(container, ctx, { ownerId: 'bases-structure' });

      expect(hookSpy).toHaveBeenCalledExactlyOnceWith(
        ctx.app,
        expect.objectContaining({ ownerId: 'bases-structure' }),
        outlineEl(container),
        'a.bases-structure-title',
        'bases-structure-node',
      );

      renderer.destroy();

      expect(unhookSpy).toHaveBeenCalledExactlyOnceWith(
        ctx.app,
        expect.objectContaining({ ownerId: 'bases-structure' }),
      );
    });

    it('re-rendering does not hook again (no duplicate observers)', () => {
      const hookSpy = vi.spyOn(superchargedLinksModule, 'hookSuperchargedLinks');
      const { schema } = parseSchema(makeRead({ parent: 'up' }));
      const snap = snapshot([note('root.md')]);
      const structure = buildStructure(schema, snap);
      const container = createDiv();
      const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
      hookSpy.mockClear();

      renderer.update({
        diagnostics: [],
        schema,
        snapshot: snap,
        structure,
        state: getUiState('outline-sl-rerender'),
      });
      renderer.update({
        diagnostics: [],
        schema,
        snapshot: snap,
        structure,
        state: getUiState('outline-sl-rerender'),
      });

      expect(hookSpy).not.toHaveBeenCalled();
    });

    it('logs and continues when hooking throws instead of breaking construction', () => {
      vi.spyOn(superchargedLinksModule, 'hookSuperchargedLinks').mockImplementation(() => {
        throw new Error('unexpected shape');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const container = createDiv();
      let renderer: OutlineRenderer | undefined;

      expect(() => {
        renderer = new OutlineRenderer(container, makeCtx());
      }).not.toThrow();
      expect(renderer).toBeDefined();
      expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
    });

    it('logs and continues when unhooking throws, still finishing destroy()', () => {
      vi.spyOn(superchargedLinksModule, 'unhookSuperchargedLinks').mockImplementation(() => {
        throw new Error('unexpected shape');
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const container = createDiv();
      const renderer = new OutlineRenderer(container, makeCtx());

      expect(() => {
        renderer.destroy();
      }).not.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
      expect(container.childElementCount).toBe(0);
    });
  });

  describe('Supercharged Links attribute carry-over (D1 follow-up)', () => {
    it('carries a Supercharged-Links-added attribute over while its frontmatter key is still there', () => {
      const app = App.createConfigured__();
      app.metadataCache.setCache__('root.md', { frontmatter: { related: ['x', 'y'] } });
      const { schema } = parseSchema(makeRead({ parent: 'up' }));
      const snap = snapshot([note('root.md')]);
      const structure = buildStructure(schema, snap);
      const container = createDiv();
      const renderer = new OutlineRenderer(
        container,
        makeCtx({ app: app.asOriginalType__(), snapshot: snap }),
      );
      const state = getUiState('outline-sl-carry-over');
      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });
      // Simulate Supercharged Links' own observer adding a non-scalar attribute asynchronously,
      // some time after the first render — `applySuperchargedLinkAttributes` never sets one
      // itself (scalars only), by design.
      const title = must(
        container.querySelector<HTMLElement>('[data-path="root.md"] .bases-structure-title'),
      );
      title.setAttribute('data-link-related', 'x y');

      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

      // Node elements are reused across updates now (perf task): the title is the *same*
      // instance, so the attribute simply survives — nothing has to copy it onto a replacement.
      const sameTitle = container.querySelector('[data-path="root.md"] .bases-structure-title');
      expect(sameTitle).toBe(title);
      expect(sameTitle?.getAttribute('data-link-related')).toBe('x y');
    });

    it('drops a data-link-* attribute and its CSS variable once its frontmatter key is removed', () => {
      const app = App.createConfigured__();
      app.metadataCache.setCache__('root.md', { frontmatter: { type: 'A' } });
      const { schema } = parseSchema(makeRead({ parent: 'up' }));
      const snap = snapshot([note('root.md')]);
      const structure = buildStructure(schema, snap);
      const container = createDiv();
      const renderer = new OutlineRenderer(
        container,
        makeCtx({ app: app.asOriginalType__(), snapshot: snap }),
      );
      const state = getUiState('outline-sl-key-removed');
      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });
      const firstTitle = must(
        container.querySelector<HTMLElement>('[data-path="root.md"] .bases-structure-title'),
      );
      expect(firstTitle.getAttribute('data-link-type')).toBe('A');
      expect(firstTitle.style.getPropertyValue('--data-link-type')).toBe('A');

      app.metadataCache.setCache__('root.md', { frontmatter: {} });
      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

      const title = container.querySelector<HTMLElement>(
        '[data-path="root.md"] .bases-structure-title',
      );
      expect(title?.hasAttribute('data-link-type')).toBe(false);
      expect(title?.style.getPropertyValue('--data-link-type')).toBe('');
    });

    it('drops data-link-tags once the note has no tags left at all', () => {
      const app = App.createConfigured__();
      app.metadataCache.setCache__('root.md', { frontmatter: { tags: ['x'] } });
      const { schema } = parseSchema(makeRead({ parent: 'up' }));
      const snap = snapshot([note('root.md')]);
      const structure = buildStructure(schema, snap);
      const container = createDiv();
      const renderer = new OutlineRenderer(
        container,
        makeCtx({ app: app.asOriginalType__(), snapshot: snap }),
      );
      const state = getUiState('outline-sl-tags-removed');
      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });
      const firstTitle = must(
        container.querySelector<HTMLElement>('[data-path="root.md"] .bases-structure-title'),
      );
      firstTitle.setAttribute('data-link-tags', '#x');

      app.metadataCache.setCache__('root.md', { frontmatter: {} });
      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

      const title = container.querySelector('[data-path="root.md"] .bases-structure-title');
      expect(title?.hasAttribute('data-link-tags')).toBe(false);
    });

    it('always carries data-link-path over — a path-derived attribute, never frontmatter-sourced', () => {
      const { schema } = parseSchema(makeRead({ parent: 'up' }));
      const snap = snapshot([note('root.md')]);
      const structure = buildStructure(schema, snap);
      const container = createDiv();
      const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
      const state = getUiState('outline-sl-path-carried');
      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });
      const firstTitle = must(
        container.querySelector<HTMLElement>('[data-path="root.md"] .bases-structure-title'),
      );
      firstTitle.setAttribute('data-link-path', 'root.md');

      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

      const title = container.querySelector('[data-path="root.md"] .bases-structure-title');
      expect(title?.getAttribute('data-link-path')).toBe('root.md');
    });

    it('lets current scalar frontmatter win over a carried-over stale value for the same attribute', () => {
      const app = App.createConfigured__();
      app.metadataCache.setCache__('root.md', { frontmatter: { type: 'A' } });
      const { schema } = parseSchema(makeRead({ parent: 'up' }));
      const snap = snapshot([note('root.md')]);
      const structure = buildStructure(schema, snap);
      const container = createDiv();
      const renderer = new OutlineRenderer(
        container,
        makeCtx({ app: app.asOriginalType__(), snapshot: snap }),
      );
      const state = getUiState('outline-sl-current-wins');
      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

      app.metadataCache.setCache__('root.md', { frontmatter: { type: 'B' } });
      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

      const title = container.querySelector('[data-path="root.md"] .bases-structure-title');
      expect(title?.getAttribute('data-link-type')).toBe('B');
    });

    it('does not hook again while carrying attributes over across renders (no duplicate observers)', () => {
      const hookSpy = vi.spyOn(superchargedLinksModule, 'hookSuperchargedLinks');
      const { schema } = parseSchema(makeRead({ parent: 'up' }));
      const snap = snapshot([note('root.md')]);
      const structure = buildStructure(schema, snap);
      const container = createDiv();
      const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
      const state = getUiState('outline-sl-carry-over-no-double-hook');
      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });
      const title = must(
        container.querySelector<HTMLElement>('[data-path="root.md"] .bases-structure-title'),
      );
      title.setAttribute('data-link-tags', '#a');
      hookSpy.mockClear();

      renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

      expect(hookSpy).not.toHaveBeenCalled();
    });
  });
});

/** Builds a `Structure` directly (no `buildStructure`/schema round-trip) so a test can control
 * exactly which paths are tops and which are whose children between two `update()` calls —
 * `node.parent` is left `null` throughout since `outline-renderer.ts` never reads it (only
 * `children` drives its depth-first traversal). */
function outlineStructure(
  tops: readonly string[],
  childrenByPath: Record<string, readonly string[]> = {},
): Structure {
  const paths = new Set<string>(tops);
  for (const [path, children] of Object.entries(childrenByPath)) {
    paths.add(path);
    for (const child of children) {
      paths.add(child);
    }
  }
  const nodes = new Map<string, StructureNode>();
  for (const path of paths) {
    nodes.set(path, {
      path,
      type: null,
      parent: null,
      edge: null,
      children: childrenByPath[path] ?? [],
      extras: [],
      alsoIn: [],
      twoWay: false,
    });
  }
  return { root: tops[0] ?? null, tops, orphans: [], nodes, issues: [] };
}

/** The `<ul>` directly nesting `path`'s own children, or `undefined` if `path` isn't currently
 * rendered — split out from the nesting-order test below purely to stay under this project's
 * `complexity` budget (each optional-chain step counts against it). */
function childListOf(renderer: OutlineRenderer, path: string): Element | null | undefined {
  return renderer.getNodeElement(path)?.closest('li')?.querySelector(':scope > ul');
}

describe('OutlineRenderer — reconciling node elements instead of rebuilding them', () => {
  it('reuses node elements across updates', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md'), note('b.md'), note('c.md')]);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-reconcile-reuse');
    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure: outlineStructure(['a.md', 'b.md']),
      state,
    });
    const first = renderer.getNodeElement('a.md');

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure: outlineStructure(['a.md', 'b.md', 'c.md']),
      state,
    });

    expect(renderer.getNodeElement('a.md')).toBe(first);
    expect(renderer.getNodeElement('c.md')).not.toBeNull();
  });

  it('drops elements for nodes that are gone', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md'), note('b.md')]);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-reconcile-drop');
    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure: outlineStructure(['a.md', 'b.md']),
      state,
    });

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure: outlineStructure(['a.md']),
      state,
    });

    expect(renderer.getNodeElement('b.md')).toBeNull();
    expect(container.querySelectorAll('.bases-structure-node')).toHaveLength(1);
  });

  it('keeps nesting in sync with structure after a reconcile that moves a node to a different parent', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('root.md'), note('a.md'), note('b.md')]);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-reconcile-move');
    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure: outlineStructure(['root.md'], { 'root.md': ['a.md', 'b.md'] }),
      state,
    });
    const rootListBefore = childListOf(renderer, 'root.md');
    expect(rootListBefore?.contains(renderer.getNodeElement('a.md'))).toBe(true);

    // `a.md` moves from being a direct child of `root.md` to being `b.md`'s child instead.
    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure: outlineStructure(['root.md'], { 'root.md': ['b.md'], 'b.md': ['a.md'] }),
      state,
    });

    const aEl = renderer.getNodeElement('a.md');
    const bList = childListOf(renderer, 'b.md');
    const rootListAfter = childListOf(renderer, 'root.md');
    // `a.md`'s own `<li>` sits directly inside `b.md`'s list now, not root's — `contains()` alone
    // can't tell "direct child" from "nested several levels down", so this checks the immediate
    // parent instead.
    expect(aEl?.closest('li')?.parentElement).toBe(bList);
    expect(rootListAfter?.children).toHaveLength(1);
  });

  it('clears is-new on a later render once focusPath no longer names the node (I7)', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md')]);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-reconcile-is-new');
    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure: outlineStructure(['a.md']),
      state,
      focusPath: 'a.md',
    });
    expect(renderer.getNodeElement('a.md')?.classList.contains('is-new')).toBe(true);

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure: outlineStructure(['a.md']),
      state,
    });

    expect(renderer.getNodeElement('a.md')?.classList.contains('is-new')).toBe(false);
  });

  it('adds a toggle to a reused node once it gains children, and restores the spacer once they are gone', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md'), note('b.md')]);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-reconcile-toggle');
    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure: outlineStructure(['a.md']),
      state,
    });
    expect(renderer.getNodeElement('a.md')?.querySelector('.bases-structure-toggle')).toBeNull();
    expect(
      renderer.getNodeElement('a.md')?.querySelector('.bases-structure-toggle-spacer'),
    ).not.toBeNull();

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure: outlineStructure(['a.md'], { 'a.md': ['b.md'] }),
      state,
    });
    expect(
      renderer.getNodeElement('a.md')?.querySelector('.bases-structure-toggle'),
    ).not.toBeNull();
    expect(
      renderer.getNodeElement('a.md')?.querySelector('.bases-structure-toggle-spacer'),
    ).toBeNull();

    renderer.update({
      diagnostics: [],
      schema,
      snapshot: snap,
      structure: outlineStructure(['a.md']),
      state,
    });
    expect(renderer.getNodeElement('a.md')?.querySelector('.bases-structure-toggle')).toBeNull();
    expect(
      renderer.getNodeElement('a.md')?.querySelector('.bases-structure-toggle-spacer'),
    ).not.toBeNull();
  });

  it('adds/removes the two-way icon on a reused node as node.twoWay changes', () => {
    const { schema } = parseSchema(makeRead({ parent: 'up' }));
    const snap = snapshot([note('a.md')]);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const state = getUiState('outline-reconcile-twoway');
    const notTwoWay = outlineStructure(['a.md']);
    renderer.update({ diagnostics: [], schema, snapshot: snap, structure: notTwoWay, state });
    expect(
      renderer.getNodeElement('a.md')?.querySelector('.bases-structure-two-way-icon'),
    ).toBeNull();

    const baseNode = notTwoWay.nodes.get('a.md');
    if (baseNode === undefined) throw new Error('Test setup error: missing a.md node');
    const twoWayStructure: Structure = {
      ...notTwoWay,
      nodes: new Map(notTwoWay.nodes).set('a.md', { ...baseNode, twoWay: true }),
    };
    renderer.update({ diagnostics: [], schema, snapshot: snap, structure: twoWayStructure, state });

    expect(
      renderer.getNodeElement('a.md')?.querySelector('.bases-structure-two-way-icon'),
    ).not.toBeNull();
  });
});

describe('OutlineRenderer — diagnostics (task 5)', () => {
  const illegalParent: Diagnostic = {
    kind: 'illegal-parent',
    node: 'h.md',
    target: 'p.md',
    property: 'category',
    message: '"Problem" cannot be the category of "Hierarchy"',
  };

  it('gives a row with a diagnostic a problem marker with the diagnostic message as its title', () => {
    const { schema } = parseSchema(makeRead({}));
    const snap = snapshot([note('h.md')]);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));

    renderer.update({
      diagnostics: [illegalParent],
      schema,
      snapshot: snap,
      structure: outlineStructure(['h.md']),
      state: getUiState('outline-diag-marker'),
    });

    const marker = renderer.getNodeElement('h.md')?.querySelector('.bases-structure-problem');
    expect(marker).not.toBeNull();
    expect(marker?.getAttribute('title')).toBe(illegalParent.message);
  });

  it('leaves a clean row (no diagnostic) without a problem marker', () => {
    const { schema } = parseSchema(makeRead({}));
    const snap = snapshot([note('h.md'), note('p.md')]);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));

    renderer.update({
      diagnostics: [illegalParent],
      schema,
      snapshot: snap,
      structure: outlineStructure(['h.md', 'p.md']),
      state: getUiState('outline-diag-clean-row'),
    });

    expect(renderer.getNodeElement('p.md')?.querySelector('.bases-structure-problem')).toBeNull();
  });

  it('joins several diagnostics naming the same row into one marker title', () => {
    const { schema } = parseSchema(makeRead({}));
    const snap = snapshot([note('h.md')]);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const second: Diagnostic = {
      kind: 'broken-link',
      node: 'h.md',
      target: 'missing.md',
      property: 'meta',
      message: 'second message',
    };

    renderer.update({
      diagnostics: [illegalParent, second],
      schema,
      snapshot: snap,
      structure: outlineStructure(['h.md']),
      state: getUiState('outline-diag-join'),
    });

    const marker = renderer.getNodeElement('h.md')?.querySelector('.bases-structure-problem');
    expect(marker?.getAttribute('title')).toBe(`${illegalParent.message}\n${second.message}`);
  });

  it('drops the marker once a reused row no longer has a diagnostic (no leaked marker between renders)', () => {
    const { schema } = parseSchema(makeRead({}));
    const snap = snapshot([note('h.md')]);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const structure = outlineStructure(['h.md']);
    const state = getUiState('outline-diag-clears');
    renderer.update({ diagnostics: [illegalParent], schema, snapshot: snap, structure, state });
    expect(
      renderer.getNodeElement('h.md')?.querySelector('.bases-structure-problem'),
    ).not.toBeNull();

    renderer.update({ diagnostics: [], schema, snapshot: snap, structure, state });

    expect(renderer.getNodeElement('h.md')?.querySelector('.bases-structure-problem')).toBeNull();
  });

  it('draws no edges at all for a diagnostic naming an unrendered target (the outline has none)', () => {
    const { schema } = parseSchema(makeRead({}));
    const snap = snapshot([note('h.md')]);
    const container = createDiv();
    const renderer = new OutlineRenderer(container, makeCtx({ snapshot: snap }));
    const brokenLink: Diagnostic = {
      kind: 'broken-link',
      node: 'h.md',
      target: 'missing.md',
      property: 'category',
      message: 'broken',
    };

    renderer.update({
      diagnostics: [brokenLink],
      schema,
      snapshot: snap,
      structure: outlineStructure(['h.md']),
      state: getUiState('outline-diag-no-edges'),
    });

    expect(container.querySelectorAll('svg, path')).toHaveLength(0);
  });
});
