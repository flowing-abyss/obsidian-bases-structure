import { App, Component } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it } from 'vitest';
import { note, snapshot } from '../core/__tests__/notes.js';
import type { Size } from '../core/layout.js';
import { parseSchema } from '../core/schema.js';
import type { Structure } from '../core/structure.js';
import { GraphRenderer } from './graph-renderer.js';
import type { NodeElementContext } from './node-element.js';
import type { RenderInput } from './structure-view.js';
import type { ViewUiState } from './view-state.js';

function makeCtx(overrides: Partial<NodeElementContext> = {}): NodeElementContext {
  const app = App.createConfigured__();
  return {
    app: app.asOriginalType__(),
    sourcePath: '',
    hoverParent: Component.create__().asOriginalType__(),
    snapshot: snapshot([]),
    onAdd: () => undefined,
    ...overrides,
  };
}

function makeState(overrides: Partial<ViewUiState> = {}): ViewUiState {
  return { collapsed: new Set(), zoom: 1, scrollLeft: 0, scrollTop: 0, ...overrides };
}

const fixedMeasure = (): Size => ({ width: 100, height: 20 });

/** Unwraps a nullable query result so assertions can use plain member access instead of a long
 * chain of `?.`, which is what pushed the biggest test over ESLint's complexity budget. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('expected a value, got null/undefined');
  }
  return value;
}

/** root.md -> a.md -> b.md, a straight chain so `a.md` (depth 1, with a child) gets a group
 * frame. Every box is a fixed 100x20 via `fixedMeasure`, so the resulting geometry (computed
 * once from `layoutTree` directly with the same inputs/options) is hand-checkable. */
function chainStructure(): Structure {
  return {
    root: 'root.md',
    tops: ['root.md'],
    orphans: [],
    nodes: new Map([
      [
        'root.md',
        {
          path: 'root.md',
          type: 'X',
          parent: null,
          edge: null,
          children: ['a.md'],
          extras: [],
          alsoIn: [],
          twoWay: false,
        },
      ],
      [
        'a.md',
        {
          path: 'a.md',
          type: 'X',
          parent: 'root.md',
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
          type: 'X',
          parent: 'a.md',
          edge: null,
          children: [],
          extras: [],
          alsoIn: [],
          twoWay: false,
        },
      ],
    ]),
    issues: [],
  };
}

/** Same chain, but `b.md` also has a visible extra parent (`extra.md`, rendered as an orphan
 * top) and is two-way with its primary parent `a.md`. */
function chainWithExtrasStructure(): Structure {
  const base = chainStructure();
  return {
    ...base,
    orphans: ['extra.md'],
    nodes: new Map([
      ...base.nodes,
      [
        'b.md',
        {
          path: 'b.md',
          type: 'X',
          parent: 'a.md',
          edge: null,
          children: [],
          extras: [{ parent: 'extra.md', kind: 'links' }],
          alsoIn: [],
          twoWay: true,
        },
      ],
      [
        'extra.md',
        {
          path: 'extra.md',
          type: 'X',
          parent: null,
          edge: null,
          children: [],
          extras: [],
          alsoIn: [],
          twoWay: false,
        },
      ],
    ]),
  };
}

function chainSnapshot(): ReturnType<typeof snapshot> {
  return snapshot([note('root.md'), note('a.md'), note('b.md'), note('extra.md')]);
}

function makeInput(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    schema: parseSchema(() => undefined).schema,
    snapshot: chainSnapshot(),
    structure: chainStructure(),
    state: makeState(),
    ...overrides,
  };
}

describe('GraphRenderer', () => {
  it('positions every node from the layout and marks the root', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    renderer.update(makeInput());

    const rootEl = must(container.querySelector<HTMLElement>('[data-path="root.md"]'));
    const aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    const bEl = must(container.querySelector<HTMLElement>('[data-path="b.md"]'));
    expect(rootEl.style.left).toBe('0px');
    expect(rootEl.style.top).toBe('12px');
    expect(rootEl.classList.contains('is-root')).toBe(true);
    expect(must(rootEl.querySelector('.bases-structure-title')).textContent).toBe('root');
    expect(aEl.style.left).toBe('172px');
    expect(aEl.style.top).toBe('12px');
    expect(bEl.style.left).toBe('344px');
    expect(bEl.style.top).toBe('12px');
  });

  it('flags only the node matching focusPath with is-new', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    renderer.update(makeInput({ focusPath: 'a.md' }));

    const rootEl = must(container.querySelector<HTMLElement>('[data-path="root.md"]'));
    const aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    expect(aEl.classList.contains('is-new')).toBe(true);
    expect(rootEl.classList.contains('is-new')).toBe(false);
  });

  it('getNodeElement returns the rendered node, and null for a path not currently on screen', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    renderer.update(makeInput());

    expect(renderer.getNodeElement('a.md')).toBe(container.querySelector('[data-path="a.md"]'));
    expect(renderer.getNodeElement('nope.md')).toBeNull();
  });

  it('draws one tree edge per parent-child relationship and frames the depth-1 parent', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    renderer.update(makeInput());

    const edges = Array.from(
      container.querySelectorAll<SVGPathElement>('.bases-structure-edge:not(.is-extra)'),
    );
    expect(edges.map((edge) => edge.getAttribute('d'))).toStrictEqual([
      'M 100 22 C 136 22, 136 22, 172 22',
      'M 272 22 C 308 22, 308 22, 344 22',
    ]);
    expect(
      edges.every((edge) => edge.getAttribute('marker-end') === 'url(#bases-structure-arrow)'),
    ).toBe(true);
    expect(edges.every((edge) => edge.getAttribute('marker-start') === null)).toBe(true);

    const group = must(container.querySelector<SVGRectElement>('.bases-structure-group'));
    expect(group.getAttribute('x')).toBe('160');
    expect(group.getAttribute('y')).toBe('0');
    expect(group.getAttribute('width')).toBe('296');
    expect(group.getAttribute('height')).toBe('44');

    const svg = must(container.querySelector('svg.bases-structure-edges'));
    expect(svg.getAttribute('width')).toBe('456');
    expect(svg.getAttribute('height')).toBe('44');
  });

  it('draws a dashed edge for a visible extra parent, with marker-start on a two-way child', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    renderer.update(makeInput({ structure: chainWithExtrasStructure() }));

    const treeEdges = Array.from(
      container.querySelectorAll<SVGPathElement>('.bases-structure-edge:not(.is-extra)'),
    );
    const abEdge = treeEdges.find(
      (edge) => edge.getAttribute('d') === 'M 272 22 C 308 22, 308 22, 344 22',
    );
    expect(abEdge?.getAttribute('marker-start')).toBe('url(#bases-structure-arrow)');
    expect(abEdge?.getAttribute('marker-end')).toBe('url(#bases-structure-arrow)');

    const extraEdges = Array.from(
      container.querySelectorAll<SVGPathElement>('.bases-structure-edge.is-extra'),
    );
    expect(extraEdges).toHaveLength(1);
    expect(extraEdges[0]?.getAttribute('d')).toBe('M 100 86 C 222 86, 222 22, 344 22');
    expect(extraEdges[0]?.getAttribute('marker-start')).toBeNull();

    expect(container.querySelector('[data-path="extra.md"]')?.classList.contains('is-orphan')).toBe(
      true,
    );
  });

  it('collapsing a node via its toggle hides its descendants and survives a later update', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState();

    renderer.update(makeInput({ state }));
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-path="a.md"] .bases-structure-toggle',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(state.collapsed.has('a.md')).toBe(true);
    expect(container.querySelector('[data-path="b.md"]')).toBeNull();
    expect(
      container
        .querySelector('[data-path="a.md"] .bases-structure-toggle')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');

    renderer.update(makeInput({ state }));

    expect(container.querySelector('[data-path="b.md"]')).toBeNull();
    expect(container.querySelector('[data-path="a.md"]')).not.toBeNull();
  });

  it('zoom buttons change the canvas scale and label, and the change survives update', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState();
    renderer.update(makeInput({ state }));
    const canvas = container.querySelector<HTMLElement>('.bases-structure-canvas');

    container
      .querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(state.zoom).toBeCloseTo(1.1);
    expect(canvas?.style.transform).toBe('scale(1.1)');
    expect(container.querySelector('.bases-structure-zoom-label')?.textContent).toBe('110%');

    renderer.update(makeInput({ state }));

    expect(canvas?.style.transform).toBe('scale(1.1)');
    expect(container.querySelector('.bases-structure-zoom-label')?.textContent).toBe('110%');
  });

  it('zoom out steps down and clamps at the minimum', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState({ zoom: 0.35 });
    renderer.update(makeInput({ state }));

    container
      .querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(state.zoom).toBeCloseTo(0.3);

    container
      .querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(state.zoom).toBeCloseTo(0.3);
  });

  it('ctrl/cmd+wheel zooms and prevents default; a plain wheel is left to native scrolling', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState();
    renderer.update(makeInput({ state }));
    const graphEl = container.querySelector<HTMLElement>('.bases-structure-graph');

    const plain = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    graphEl?.dispatchEvent(plain);
    expect(state.zoom).toBe(1);
    expect(plain.defaultPrevented).toBe(false);

    const zoomWheel = new WheelEvent('wheel', {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    graphEl?.dispatchEvent(zoomWheel);
    expect(state.zoom).toBeCloseTo(1.2);
    expect(zoomWheel.defaultPrevented).toBe(true);
  });

  it('fit computes zoom from the container and layout size, guarding zero sizes', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(makeInput());
    const graphEl = container.querySelector<HTMLElement>('.bases-structure-graph');
    const canvas = container.querySelector<HTMLElement>('.bases-structure-canvas');
    const fitBtn = container.querySelector<HTMLButtonElement>('[aria-label="Fit to view"]');

    // jsdom always reports 0 for clientWidth/clientHeight; Fit must not divide by zero.
    fitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(canvas?.style.transform).toBe('scale(1)');

    // Layout is 456x44 (see the geometry test above); a 228x22 viewport fits at 0.5.
    if (graphEl !== null) {
      Object.defineProperty(graphEl, 'clientWidth', { value: 228, configurable: true });
      Object.defineProperty(graphEl, 'clientHeight', { value: 22, configurable: true });
    }
    fitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(canvas?.style.transform).toBe('scale(0.5)');
  });

  it('restores the scroll position from state after layout, and scrolling updates state back', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState({ scrollLeft: 40, scrollTop: 15 });

    renderer.update(makeInput({ state }));
    const graphEl = container.querySelector<HTMLElement>('.bases-structure-graph');

    expect(graphEl?.scrollLeft).toBe(40);
    expect(graphEl?.scrollTop).toBe(15);

    if (graphEl !== null) {
      graphEl.scrollLeft = 7;
      graphEl.scrollTop = 3;
    }
    graphEl?.dispatchEvent(new Event('scroll'));

    expect(state.scrollLeft).toBe(7);
    expect(state.scrollTop).toBe(3);
  });

  it('shows the empty message for a structure with no visible nodes', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const emptyStructure: Structure = {
      root: null,
      tops: [],
      orphans: [],
      nodes: new Map(),
      issues: [],
    };

    renderer.update(makeInput({ structure: emptyStructure, snapshot: snapshot([]) }));

    const emptyEl = container.querySelector('.bases-structure-empty');
    expect(emptyEl?.classList.contains('is-hidden')).toBe(false);
    expect(emptyEl?.textContent).toBe('Nothing to show yet');
    expect(
      container.querySelector('.bases-structure-canvas')?.classList.contains('is-hidden'),
    ).toBe(true);
    expect(container.querySelectorAll('.bases-structure-node')).toHaveLength(0);
  });

  it('destroy empties the container and removes every listener', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState();
    renderer.update(makeInput({ state }));
    const graphEl = container.querySelector<HTMLElement>('.bases-structure-graph');
    const zoomInBtn = container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');

    renderer.destroy();

    expect(container.childElementCount).toBe(0);
    zoomInBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(state.zoom).toBe(1);
    graphEl?.dispatchEvent(new Event('scroll'));
    expect(state.scrollLeft).toBe(0);
  });

  it('falls back to the default measure (offsetWidth/Height, or 180x32) when none is injected', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx());

    renderer.update(makeInput());

    // jsdom always reports 0 for offsetWidth/offsetHeight, so the fallback constants apply.
    expect(container.querySelector<HTMLElement>('[data-path="root.md"]')?.style.width).toBe(
      '180px',
    );
  });

  it('does not loop and renders each path once when children form a cycle', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const structure: Structure = {
      root: null,
      tops: ['a.md'],
      orphans: [],
      nodes: new Map([
        [
          'a.md',
          {
            path: 'a.md',
            type: 'X',
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
            type: 'X',
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

    renderer.update(makeInput({ structure, snapshot: snapshot([note('a.md'), note('b.md')]) }));

    expect(container.querySelectorAll('.bases-structure-node')).toHaveLength(2);
  });

  it('skips a child path with no corresponding structure node (defensive)', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const structure: Structure = {
      root: null,
      tops: ['a.md'],
      orphans: [],
      nodes: new Map([
        [
          'a.md',
          {
            path: 'a.md',
            type: 'X',
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

    renderer.update(makeInput({ structure, snapshot: snapshot([note('a.md')]) }));

    expect(container.querySelectorAll('.bases-structure-node')).toHaveLength(1);
  });

  it('skips a tree edge whose parent is not currently visible (defensive dangling parent)', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const structure: Structure = {
      root: null,
      tops: ['a.md'],
      orphans: [],
      nodes: new Map([
        [
          'a.md',
          {
            path: 'a.md',
            type: 'X',
            parent: 'ghost.md',
            edge: null,
            children: [],
            extras: [],
            alsoIn: [],
            twoWay: false,
          },
        ],
      ]),
      issues: [],
    };

    renderer.update(makeInput({ structure, snapshot: snapshot([note('a.md')]) }));

    expect(container.querySelectorAll('.bases-structure-node')).toHaveLength(1);
    expect(container.querySelectorAll('.bases-structure-edge')).toHaveLength(0);
  });

  it('skips an extra edge whose parent is not currently visible', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const structure: Structure = {
      root: 'root.md',
      tops: ['root.md'],
      orphans: [],
      nodes: new Map([
        [
          'root.md',
          {
            path: 'root.md',
            type: 'X',
            parent: null,
            edge: null,
            children: ['a.md'],
            extras: [],
            alsoIn: [],
            twoWay: false,
          },
        ],
        [
          'a.md',
          {
            path: 'a.md',
            type: 'X',
            parent: 'root.md',
            edge: null,
            children: [],
            extras: [{ parent: 'hidden.md', kind: 'links' }],
            alsoIn: [],
            twoWay: false,
          },
        ],
      ]),
      issues: [],
    };

    renderer.update(makeInput({ structure, snapshot: snapshot([note('root.md'), note('a.md')]) }));

    expect(container.querySelectorAll('.bases-structure-edge.is-extra')).toHaveLength(0);
  });

  it('ignores zoom, wheel, scroll and node-layer clicks before the first update (no crash)', () => {
    const container = createDiv();
    expect(new GraphRenderer(container, makeCtx(), { measure: fixedMeasure })).toBeInstanceOf(
      GraphRenderer,
    );

    container
      .querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    container.querySelector('.bases-structure-graph')?.dispatchEvent(new Event('scroll'));
    container
      .querySelector('.bases-structure-nodes')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const wheel = new WheelEvent('wheel', {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    container.querySelector('.bases-structure-graph')?.dispatchEvent(wheel);

    expect(container.querySelector('.bases-structure-zoom-label')?.textContent).toBe('100%');
  });

  it('ignores a click on a stray non-element node inside the nodes layer (defensive)', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState();
    renderer.update(makeInput({ state }));
    const nodesEl = container.querySelector('.bases-structure-nodes');
    const textNode = document.createTextNode('stray');
    nodesEl?.appendChild(textNode);

    textNode.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(state.collapsed.size).toBe(0);
  });

  it('a title click inside the graph does not toggle collapse, and toggling twice re-expands', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState();
    renderer.update(makeInput({ state }));

    container
      .querySelector('[data-path="b.md"] .bases-structure-title')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(state.collapsed.size).toBe(0);

    const toggleSelector = '[data-path="a.md"] .bases-structure-toggle';
    container
      .querySelector<HTMLButtonElement>(toggleSelector)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(state.collapsed.has('a.md')).toBe(true);

    container
      .querySelector<HTMLButtonElement>(toggleSelector)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(state.collapsed.has('a.md')).toBe(false);
    expect(container.querySelector('[data-path="b.md"]')).not.toBeNull();
  });
});
