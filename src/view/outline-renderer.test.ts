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
    ...overrides,
  };
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

  it('renders orphans, inside a list, under a final "Without a parent" section when a root exists', () => {
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
    // Carried-over fix: the orphan `<li>` must live inside a `<ul>`, not directly under the
    // container.
    expect(orphansLi?.parentElement?.tagName).toBe('UL');
    expect(orphansLi?.parentElement?.parentElement).toBe(container);
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
    container.appendChild(textNode);

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

    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));

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

    container.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    expect(trigger).not.toHaveBeenCalled();
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
});
