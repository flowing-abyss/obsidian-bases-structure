import type * as ObsidianModule from 'obsidian';
import { App, Component } from 'obsidian-test-mocks/obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { note, snapshot } from '../core/__tests__/notes.js';
import type { StructureNode } from '../core/structure.js';
import {
  applyActiveNode,
  attachNodeInteractions,
  createNodeElement,
  focusActiveNode,
  type NodeElementContext,
} from './node-element.js';

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

afterEach(() => {
  NoticeMock.instances.length = 0;
  vi.restoreAllMocks();
});

function makeNode(overrides: Partial<StructureNode> = {}): StructureNode {
  return {
    path: 'a.md',
    type: 'Task',
    parent: null,
    edge: null,
    children: [],
    extras: [],
    alsoIn: [],
    twoWay: false,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<NodeElementContext> = {}): NodeElementContext {
  const app = App.createConfigured__();
  return {
    app: app.asOriginalType__(),
    sourcePath: '',
    hoverParent: Component.create__().asOriginalType__(),
    snapshot: snapshot([note('a.md')]),
    onAdd: () => undefined,
    onMenu: () => undefined,
    ...overrides,
  };
}

function makeNodes(paths: readonly string[]): HTMLElement {
  const root = createDiv();
  for (const path of paths) {
    const ctx = makeCtx({ snapshot: snapshot(paths.map((p) => note(p))) });
    root.appendChild(createNodeElement(ctx, makeNode({ path })));
  }
  return root;
}

describe('createNodeElement', () => {
  it('builds a node div with data attributes and the title link', () => {
    const ctx = makeCtx({ snapshot: snapshot([note('a.md', { basename: 'Alpha' })]) });

    const el = createNodeElement(ctx, makeNode({ type: 'Task' }));

    expect(el.classList.contains('bases-structure-node')).toBe(true);
    expect(el.getAttribute('data-path')).toBe('a.md');
    expect(el.getAttribute('data-type')).toBe('Task');
    const title = el.querySelector('.bases-structure-title');
    expect(title?.classList.contains('internal-link')).toBe(true);
    expect(title?.getAttribute('data-href')).toBe('a.md');
    expect(title?.textContent).toBe('Alpha');
  });

  it('gives the title tabindex -1 so the node itself is the only tab stop (M10)', () => {
    const ctx = makeCtx();

    const el = createNodeElement(ctx, makeNode());

    const title = el.querySelector('.bases-structure-title');
    expect(title?.getAttribute('tabindex')).toBe('-1');
  });

  it('uses an empty data-type attribute when the node type is null', () => {
    const ctx = makeCtx();

    const el = createNodeElement(ctx, makeNode({ type: null }));

    expect(el.getAttribute('data-type')).toBe('');
  });

  it('adds the is-root class only when flagged', () => {
    const ctx = makeCtx();

    const rootEl = createNodeElement(ctx, makeNode(), { isRoot: true });
    const plainEl = createNodeElement(ctx, makeNode());

    expect(rootEl.classList.contains('is-root')).toBe(true);
    expect(plainEl.classList.contains('is-root')).toBe(false);
  });

  it('adds the is-orphan class only when flagged', () => {
    const ctx = makeCtx();

    const orphanEl = createNodeElement(ctx, makeNode(), { isOrphan: true });
    const plainEl = createNodeElement(ctx, makeNode());

    expect(orphanEl.classList.contains('is-orphan')).toBe(true);
    expect(plainEl.classList.contains('is-orphan')).toBe(false);
  });

  it('renders an alsoIn chip with an icon, basenames and a title listing them, when present', () => {
    const ctx = makeCtx({
      snapshot: snapshot([
        note('a.md'),
        note('b.md', { basename: 'Beta' }),
        note('c.md', { basename: 'Gamma' }),
      ]),
    });

    const el = createNodeElement(ctx, makeNode({ alsoIn: ['b.md', 'c.md'] }));

    const chip = el.querySelector('.bases-structure-alsoin');
    expect(chip?.querySelector('.bases-structure-alsoin-icon')).not.toBeNull();
    expect(chip?.textContent).toBe('Beta, Gamma');
    expect(chip?.getAttribute('title')).toBe('Beta, Gamma');
  });

  it('omits the alsoIn chip when there are no extra parents', () => {
    const ctx = makeCtx();

    const el = createNodeElement(ctx, makeNode({ alsoIn: [] }));

    expect(el.querySelector('.bases-structure-alsoin')).toBeNull();
  });

  it('always includes an add-child button, after the title', () => {
    const ctx = makeCtx();

    const el = createNodeElement(ctx, makeNode());

    const button = el.querySelector('.bases-structure-add');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('data-action')).toBe('add');
    expect(button?.getAttribute('aria-label')).toBe('Add child');
    expect(button?.getAttribute('type')).toBe('button');
    const children = Array.from(el.children);
    expect(children.indexOf(button as Element)).toBeGreaterThan(
      children.indexOf(el.querySelector('.bases-structure-title') as Element),
    );
  });

  it('gives the title the Supercharged Links classes (D1)', () => {
    const ctx = makeCtx();

    const el = createNodeElement(ctx, makeNode());

    const title = el.querySelector('.bases-structure-title');
    expect(title?.classList.contains('data-link-icon')).toBe(true);
    expect(title?.classList.contains('data-link-icon-after')).toBe(true);
    expect(title?.classList.contains('data-link-text')).toBe(true);
  });

  it("stamps the title with data-link-* attributes from the note's own frontmatter (D1)", () => {
    const app = App.createConfigured__();
    app.metadataCache.setCache__('a.md', { frontmatter: { type: 'book' } });
    const ctx = makeCtx({ app: app.asOriginalType__() });

    const el = createNodeElement(ctx, makeNode({ path: 'a.md' }));

    const title = el.querySelector('.bases-structure-title');
    expect(title?.getAttribute('data-link-type')).toBe('book');
  });

  it('carries a non-scalar Supercharged Links attribute over from the previous title (D1 follow-up)', () => {
    // `data-link-tags` is exactly what Supercharged Links sets itself, asynchronously, for a list
    // frontmatter value — `applySuperchargedLinkAttributes` never does (scalars only, by design),
    // so there is no way to produce this attribute through that function at all; it's set directly
    // here, standing in for Supercharged Links' own `MutationObserver`. The only way a rebuilt
    // node keeps it without waiting for another observer pass is carrying it over.
    const previousTitle = createDiv().createEl('a');
    previousTitle.setAttribute('data-link-tags', '#a #b');
    const ctx = makeCtx();

    const el = createNodeElement(ctx, makeNode(), { previousTitle });

    const title = el.querySelector('.bases-structure-title');
    expect(title?.getAttribute('data-link-tags')).toBe('#a #b');
  });

  it('carries over classes from the previous title (D1 follow-up)', () => {
    const previousTitle = createDiv().createEl('a');
    previousTitle.classList.add('some-supercharged-links-class');
    const ctx = makeCtx();

    const el = createNodeElement(ctx, makeNode(), { previousTitle });

    const title = el.querySelector('.bases-structure-title');
    expect(title?.classList.contains('some-supercharged-links-class')).toBe(true);
  });

  it('lets current frontmatter win over a carried-over value for the same attribute (D1 follow-up)', () => {
    const previousTitle = createDiv().createEl('a');
    previousTitle.setAttribute('data-link-type', 'stale');
    const app = App.createConfigured__();
    app.metadataCache.setCache__('a.md', { frontmatter: { type: 'fresh' } });
    const ctx = makeCtx({ app: app.asOriginalType__() });

    const el = createNodeElement(ctx, makeNode({ path: 'a.md' }), { previousTitle });

    const title = el.querySelector('.bases-structure-title');
    expect(title?.getAttribute('data-link-type')).toBe('fresh');
  });

  it('does nothing when there is no previous title (D1 follow-up)', () => {
    const ctx = makeCtx();

    expect(() => {
      createNodeElement(ctx, makeNode());
    }).not.toThrow();
  });

  it('always includes a touch-only node-menu button, after the "+" (I10)', () => {
    const ctx = makeCtx();

    const el = createNodeElement(ctx, makeNode());

    const button = el.querySelector('.bases-structure-node-menu');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('data-action')).toBe('menu');
    expect(button?.getAttribute('aria-label')).toBe('Node menu');
    expect(button?.getAttribute('type')).toBe('button');
    const children = Array.from(el.children);
    expect(children.indexOf(button as Element)).toBeGreaterThan(
      children.indexOf(el.querySelector('.bases-structure-add') as Element),
    );
  });
});

describe('attachNodeInteractions', () => {
  it('opens the link on a title click with the source path and mod-event state', () => {
    const app = App.createConfigured__();
    const openLinkText = vi.spyOn(app.workspace, 'openLinkText').mockResolvedValue();
    const ctx = makeCtx({ app: app.asOriginalType__(), sourcePath: 'host.md' });
    const container = createDiv();
    container.appendChild(createNodeElement(ctx, makeNode()));
    attachNodeInteractions(ctx, container);

    const title = container.querySelector('.bases-structure-title');
    title?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(openLinkText).toHaveBeenCalledWith('a.md', 'host.md', expect.anything());
  });

  it('prevents the default navigation on a title click', () => {
    const app = App.createConfigured__();
    vi.spyOn(app.workspace, 'openLinkText').mockResolvedValue();
    const ctx = makeCtx({ app: app.asOriginalType__() });
    const container = createDiv();
    container.appendChild(createNodeElement(ctx, makeNode()));
    attachNodeInteractions(ctx, container);
    const title = container.querySelector('.bases-structure-title');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });

    title?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('triggers hover-link on a title mouseover with the hoverParent and target element', () => {
    const app = App.createConfigured__();
    const trigger = vi.spyOn(app.workspace, 'trigger');
    const hoverParent = Component.create__().asOriginalType__();
    const ctx = makeCtx({ app: app.asOriginalType__(), sourcePath: 'host.md', hoverParent });
    const container = createDiv();
    container.appendChild(createNodeElement(ctx, makeNode()));
    attachNodeInteractions(ctx, container);

    const title = container.querySelector('.bases-structure-title');
    title?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    expect(trigger).toHaveBeenCalledTimes(1);
    const [name, payload] = trigger.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('hover-link');
    expect(payload).toMatchObject({
      source: 'bases-structure',
      linktext: 'a.md',
      sourcePath: 'host.md',
    });
    expect(payload['hoverParent']).toBe(hoverParent);
    expect(payload['targetEl']).toBe(title);
  });

  it('ignores a click that does not land on the title (e.g. the node background)', () => {
    const app = App.createConfigured__();
    const openLinkText = vi.spyOn(app.workspace, 'openLinkText').mockResolvedValue();
    const ctx = makeCtx({ app: app.asOriginalType__() });
    const container = createDiv();
    const nodeEl = createNodeElement(ctx, makeNode());
    container.appendChild(nodeEl);
    attachNodeInteractions(ctx, container);

    nodeEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(openLinkText).not.toHaveBeenCalled();
  });

  it('calls onAdd with the node path, node element and the add button itself, without opening the note (U1)', () => {
    const app = App.createConfigured__();
    const openLinkText = vi.spyOn(app.workspace, 'openLinkText').mockResolvedValue();
    const onAdd = vi.fn();
    const ctx = makeCtx({ app: app.asOriginalType__(), onAdd });
    const container = createDiv();
    const nodeEl = createNodeElement(ctx, makeNode({ path: 'a.md' }));
    container.appendChild(nodeEl);
    attachNodeInteractions(ctx, container);
    const buttonEl = container.querySelector('.bases-structure-add');

    buttonEl?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(onAdd).toHaveBeenCalledExactlyOnceWith('a.md', nodeEl, buttonEl);
    expect(openLinkText).not.toHaveBeenCalled();
  });

  it('calls onMenu with the node path, element and the node-menu button on its click, without opening the note (I10)', () => {
    const app = App.createConfigured__();
    const openLinkText = vi.spyOn(app.workspace, 'openLinkText').mockResolvedValue();
    const onMenu = vi.fn();
    const ctx = makeCtx({ app: app.asOriginalType__(), onMenu });
    const container = createDiv();
    const nodeEl = createNodeElement(ctx, makeNode({ path: 'a.md' }));
    container.appendChild(nodeEl);
    attachNodeInteractions(ctx, container);
    const buttonEl = container.querySelector('.bases-structure-node-menu');

    buttonEl?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(onMenu).toHaveBeenCalledExactlyOnceWith('a.md', nodeEl, buttonEl);
    expect(openLinkText).not.toHaveBeenCalled();
  });

  it('stops the node-menu button click from propagating past the container', () => {
    const app = App.createConfigured__();
    const ctx = makeCtx({ app: app.asOriginalType__(), onMenu: vi.fn() });
    const outer = createDiv();
    const container = outer.createDiv();
    container.appendChild(createNodeElement(ctx, makeNode()));
    attachNodeInteractions(ctx, container);
    const outerHandler = vi.fn();
    outer.addEventListener('click', outerHandler);

    container
      .querySelector('.bases-structure-node-menu')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(outerHandler).not.toHaveBeenCalled();
  });

  it('stops the add-button click from propagating past the container', () => {
    const app = App.createConfigured__();
    const ctx = makeCtx({ app: app.asOriginalType__(), onAdd: vi.fn() });
    const outer = createDiv();
    const container = outer.createDiv();
    container.appendChild(createNodeElement(ctx, makeNode()));
    attachNodeInteractions(ctx, container);
    const outerHandler = vi.fn();
    outer.addEventListener('click', outerHandler);

    container
      .querySelector('.bases-structure-add')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(outerHandler).not.toHaveBeenCalled();
  });

  it('ignores a mouseover that does not land on the title', () => {
    const app = App.createConfigured__();
    const trigger = vi.spyOn(app.workspace, 'trigger');
    const ctx = makeCtx({ app: app.asOriginalType__() });
    const container = createDiv();
    container.appendChild(createNodeElement(ctx, makeNode()));
    attachNodeInteractions(ctx, container);

    container.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    expect(trigger).not.toHaveBeenCalled();
  });

  it('ignores an event whose target is not an HTMLElement (e.g. a text node)', () => {
    const app = App.createConfigured__();
    const openLinkText = vi.spyOn(app.workspace, 'openLinkText').mockResolvedValue();
    const ctx = makeCtx({ app: app.asOriginalType__() });
    const container = createDiv();
    attachNodeInteractions(ctx, container);
    const textNode = document.createTextNode('stray');
    container.appendChild(textNode);

    textNode.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(openLinkText).not.toHaveBeenCalled();
  });

  it("logs an error and shows a Notice with the note's display name when opening the link rejects", async () => {
    const app = App.createConfigured__();
    const error = new Error('failed to open');
    vi.spyOn(app.workspace, 'openLinkText').mockRejectedValue(error);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = makeCtx({ app: app.asOriginalType__() });
    const container = createDiv();
    container.appendChild(createNodeElement(ctx, makeNode()));
    attachNodeInteractions(ctx, container);

    container
      .querySelector('.bases-structure-title')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', error);
    expect(NoticeMock.instances).toHaveLength(1);
    expect(NoticeMock.instances[0]?.message).toBe('Structure: could not open "a"');
  });

  it('the disposer removes both listeners from the container', () => {
    const app = App.createConfigured__();
    const openLinkText = vi.spyOn(app.workspace, 'openLinkText').mockResolvedValue();
    const trigger = vi.spyOn(app.workspace, 'trigger');
    const ctx = makeCtx({ app: app.asOriginalType__() });
    const container = createDiv();
    container.appendChild(createNodeElement(ctx, makeNode()));
    const dispose = attachNodeInteractions(ctx, container);

    dispose();
    const title = container.querySelector('.bases-structure-title');
    title?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    title?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    expect(openLinkText).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe('applyActiveNode', () => {
  it('gives the matching node tabindex 0 and is-active, every other node tabindex -1', () => {
    const root = makeNodes(['a.md', 'b.md', 'c.md']);

    const activeEl = applyActiveNode(root, 'b.md');

    const [a, b, c] = Array.from(root.querySelectorAll<HTMLElement>('.bases-structure-node'));
    expect(activeEl).toBe(b);
    expect(b?.classList.contains('is-active')).toBe(true);
    expect(b?.tabIndex).toBe(0);
    expect(a?.classList.contains('is-active')).toBe(false);
    expect(a?.tabIndex).toBe(-1);
    expect(c?.classList.contains('is-active')).toBe(false);
    expect(c?.tabIndex).toBe(-1);
  });

  it('returns null and marks nothing active when activePath is null', () => {
    const root = makeNodes(['a.md', 'b.md']);

    const activeEl = applyActiveNode(root, null);

    expect(activeEl).toBeNull();
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('.bases-structure-node'))) {
      expect(el.classList.contains('is-active')).toBe(false);
      expect(el.tabIndex).toBe(-1);
    }
  });

  it('returns null when activePath does not match any rendered node', () => {
    const root = makeNodes(['a.md']);

    expect(applyActiveNode(root, 'nope.md')).toBeNull();
  });
});

describe('focusActiveNode', () => {
  it('moves real DOM focus to the element', () => {
    const root = makeNodes(['a.md']);
    document.body.appendChild(root);
    applyActiveNode(root, 'a.md');
    const el = root.querySelector<HTMLElement>('.bases-structure-node');
    if (el === null) throw new Error('Test setup error: missing node element');

    focusActiveNode(el);

    expect(document.activeElement).toBe(el);
  });

  it('does not throw even though jsdom has no scrollIntoView implementation', () => {
    const root = makeNodes(['a.md']);
    document.body.appendChild(root);
    applyActiveNode(root, 'a.md');
    const el = root.querySelector<HTMLElement>('.bases-structure-node');
    if (el === null) throw new Error('Test setup error: missing node element');
    expect(typeof el.scrollIntoView).toBe('undefined');

    expect(() => {
      focusActiveNode(el);
    }).not.toThrow();
  });
});
