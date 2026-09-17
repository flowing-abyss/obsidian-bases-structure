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
    onMenu: () => undefined,
    ...overrides,
  };
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

/** Fakes `.bases-structure-graph`'s `clientWidth`/`clientHeight` (jsdom always reports 0), the
 * container-size half of the fit-zoom computation — mirrors what the "Fit to view" test already
 * does, factored out since the auto-fit tests below need the same setup before their first
 * `update()` call. */
function fakeGraphViewport(container: HTMLElement, width: number, height: number): void {
  const graphEl = container.querySelector<HTMLElement>('.bases-structure-graph');
  if (graphEl === null) {
    return;
  }
  Object.defineProperty(graphEl, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(graphEl, 'clientHeight', { value: height, configurable: true });
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
    expect(aEl.style.left).toBe('148px');
    expect(aEl.style.top).toBe('12px');
    expect(bEl.style.left).toBe('296px');
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

  it('marks state.active is-active with tabindex 0, and the class survives a re-render', () => {
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    renderer.update(makeInput({ state: makeState({ active: 'a.md' }) }));

    let aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    let rootEl = must(container.querySelector<HTMLElement>('[data-path="root.md"]'));
    expect(aEl.classList.contains('is-active')).toBe(true);
    expect(aEl.tabIndex).toBe(0);
    expect(rootEl.classList.contains('is-active')).toBe(false);
    expect(rootEl.tabIndex).toBe(-1);

    renderer.update(makeInput({ state: makeState({ active: 'a.md' }) }));

    aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    rootEl = must(container.querySelector<HTMLElement>('[data-path="root.md"]'));
    expect(aEl.classList.contains('is-active')).toBe(true);
    expect(aEl.tabIndex).toBe(0);
    expect(rootEl.tabIndex).toBe(-1);
  });

  it('does not move focus on the very first render, even when state.active already names a node (I9)', () => {
    // `state` survives a renderer being torn down and recreated (`getUiState` is keyed
    // independent of any one renderer instance) — a fresh renderer's first render must not treat
    // an already-non-null `state.active` as "just changed" and steal focus/scroll nobody asked
    // for (e.g. switching back to a note whose embedded view had an active node before).
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState({ active: 'a.md' });

    renderer.update(makeInput({ state }));

    const aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    expect(aEl.classList.contains('is-active')).toBe(true);
    expect(document.activeElement).not.toBe(aEl);
  });

  it('moves real focus to the active node when the active path changes between renders (after the first)', () => {
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState({ active: null });
    renderer.update(makeInput({ state })); // First render: nothing active, nothing to focus.

    state.active = 'a.md';
    renderer.update(makeInput({ state }));
    const aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    expect(document.activeElement).toBe(aEl);

    state.active = 'root.md';
    renderer.update(makeInput({ state }));
    const rootEl = must(container.querySelector<HTMLElement>('[data-path="root.md"]'));
    expect(document.activeElement).toBe(rootEl);
  });

  it('re-focuses the rebuilt active node on a same-active-path re-render when focus was already inside', () => {
    // Every `update()` rebuilds the node elements from scratch, even when nothing about `active`
    // changed (e.g. a collapse/expand `refresh()`) — the *old* element that had real focus is
    // gone, so without re-focusing the new one, `document.activeElement` would silently fall back
    // to `document.body`, and the next real keydown would never reach the container's delegated
    // listener again (the whole reason `keyboard.ts` can use one listener instead of one per node).
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState({ active: null });
    renderer.update(makeInput({ state })); // First render: nothing active yet (I9).

    state.active = 'a.md';
    renderer.update(makeInput({ state })); // Active newly set: real focus follows.
    const aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    expect(document.activeElement).toBe(aEl);

    renderer.update(makeInput({ state }));

    const rebuiltAEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    expect(rebuiltAEl).not.toBe(aEl);
    expect(document.activeElement).toBe(rebuiltAEl);
  });

  it('does not steal focus on a same-active-path re-render when focus was elsewhere', () => {
    // The flip side of the above: an *unrelated* re-render (e.g. a create commit while the user
    // is typing in a draft input, or has focus on some other page element entirely) must not yank
    // focus back into the graph just because `state.active` happens to still name the same path.
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState({ active: 'a.md' });
    renderer.update(makeInput({ state }));
    const outside = createEl('input');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    renderer.update(makeInput({ state }));

    expect(document.activeElement).toBe(outside);
  });

  it('draws one tree edge per parent-child relationship, with no markers and no group frames', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    renderer.update(makeInput());

    const edges = Array.from(
      container.querySelectorAll<SVGPathElement>('.bases-structure-edge:not(.is-extra)'),
    );
    expect(edges.map((edge) => edge.getAttribute('d'))).toStrictEqual([
      'M 100 22 C 124 22, 124 22, 148 22',
      'M 248 22 C 272 22, 272 22, 296 22',
    ]);
    expect(edges.every((edge) => edge.getAttribute('marker-end') === null)).toBe(true);
    expect(edges.every((edge) => edge.getAttribute('marker-start') === null)).toBe(true);
    expect(edges.every((edge) => edge.classList.contains('is-two-way'))).toBe(false);

    expect(container.querySelector('.bases-structure-group')).toBeNull();

    const svg = must(container.querySelector('svg.bases-structure-edges'));
    expect(svg.getAttribute('width')).toBe('408');
    expect(svg.getAttribute('height')).toBe('44');
  });

  it('draws a dashed accent edge for a visible extra parent, with matching markers on a two-way child', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    renderer.update(makeInput({ structure: chainWithExtrasStructure() }));

    const treeEdges = Array.from(
      container.querySelectorAll<SVGPathElement>('.bases-structure-edge:not(.is-extra)'),
    );
    const abEdge = treeEdges.find(
      (edge) => edge.getAttribute('d') === 'M 248 22 C 272 22, 272 22, 296 22',
    );
    expect(abEdge?.classList.contains('is-two-way')).toBe(true);
    expect(abEdge?.getAttribute('marker-start')).toBe('url(#bases-structure-arrow-tree)');
    expect(abEdge?.getAttribute('marker-end')).toBe('url(#bases-structure-arrow-tree)');

    const extraEdges = Array.from(
      container.querySelectorAll<SVGPathElement>('.bases-structure-edge.is-extra'),
    );
    expect(extraEdges).toHaveLength(1);
    expect(extraEdges[0]?.getAttribute('d')).toBe('M 100 86 C 198 86, 198 22, 296 22');
    expect(extraEdges[0]?.getAttribute('marker-start')).toBeNull();
    expect(extraEdges[0]?.getAttribute('marker-end')).toBe('url(#bases-structure-arrow-extra)');

    expect(container.querySelector('[data-path="extra.md"]')?.classList.contains('is-orphan')).toBe(
      true,
    );
  });

  it('hovering a node marks its own edges active, and mouseout clears them', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(makeInput());
    const aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    const edges = Array.from(container.querySelectorAll<SVGPathElement>('.bases-structure-edge'));
    const rootToA = must(
      edges.find((edge) => edge.getAttribute('d') === 'M 100 22 C 124 22, 124 22, 148 22'),
    );
    const aToB = must(
      edges.find((edge) => edge.getAttribute('d') === 'M 248 22 C 272 22, 272 22, 296 22'),
    );

    aEl.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, relatedTarget: container.parentElement }),
    );

    expect(rootToA.classList.contains('is-edge-active')).toBe(true);
    expect(aToB.classList.contains('is-edge-active')).toBe(true);

    aEl.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: container.parentElement }),
    );

    expect(rootToA.classList.contains('is-edge-active')).toBe(false);
    expect(aToB.classList.contains('is-edge-active')).toBe(false);
  });

  it('moving the pointer between elements inside the same node does not toggle edge state', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(makeInput());
    const aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    const aTitle = must(aEl.querySelector<HTMLElement>('.bases-structure-title'));
    const aAdd = must(aEl.querySelector<HTMLElement>('.bases-structure-add'));
    const edges = Array.from(container.querySelectorAll<SVGPathElement>('.bases-structure-edge'));
    const aToB = must(
      edges.find((edge) => edge.getAttribute('d') === 'M 248 22 C 272 22, 272 22, 296 22'),
    );
    aEl.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, relatedTarget: container.parentElement }),
    );
    expect(aToB.classList.contains('is-edge-active')).toBe(true);

    aTitle.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: aAdd }));

    expect(aToB.classList.contains('is-edge-active')).toBe(true);
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
    expect(state.zoomTouched).toBe(true);
    expect(canvas?.style.transform).toBe('scale(1.1)');
    expect(container.querySelector('.bases-structure-zoom-label')?.textContent).toBe('110%');

    renderer.update(makeInput({ state }));

    expect(canvas?.style.transform).toBe('scale(1.1)');
    expect(container.querySelector('.bases-structure-zoom-label')?.textContent).toBe('110%');
  });

  it('sizes the canvas wrapper to layout size × zoom, so the scroll area matches the visible graph (M6)', () => {
    // `transform: scale()` never changes an element's own layout box/scroll size — only its
    // visual rendering — so scaling `.bases-structure-canvas` directly (as before this fix) left
    // `.bases-structure-graph` (the actual `overflow: auto` scroll container) still reporting the
    // *unscaled* canvas size as scrollable content, however small the zoomed-out graph actually
    // looked. A separate wrapper sized to `layout size × zoom`, with the scaled canvas positioned
    // inside it at its own full unscaled size, is what makes the scroll area track what's visible.
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState();
    renderer.update(makeInput({ state }));
    const wrap = container.querySelector<HTMLElement>('.bases-structure-canvas-wrap');
    const canvas = container.querySelector<HTMLElement>('.bases-structure-canvas');
    if (wrap === null || canvas === null) throw new Error('missing canvas/wrap elements');
    const baseWidth = parseFloat(wrap.style.width);
    const baseHeight = parseFloat(wrap.style.height);
    expect(baseWidth).toBeGreaterThan(0);
    expect(baseHeight).toBeGreaterThan(0);
    expect(parseFloat(canvas.style.width)).toBeCloseTo(baseWidth);
    expect(parseFloat(canvas.style.height)).toBeCloseTo(baseHeight);

    container
      .querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(parseFloat(wrap.style.width)).toBeCloseTo(baseWidth * 1.1);
    expect(parseFloat(wrap.style.height)).toBeCloseTo(baseHeight * 1.1);
    // The visually-scaled canvas itself keeps its own full, unscaled layout size — only the
    // wrapper (what actually determines the scroll area) shrinks/grows with zoom.
    expect(parseFloat(canvas.style.width)).toBeCloseTo(baseWidth);
    expect(parseFloat(canvas.style.height)).toBeCloseTo(baseHeight);
  });

  it('zoom out steps down and clamps at the minimum', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    // `zoomTouched: true` simulates a zoom the user already set previously — otherwise the first
    // `update()` below would auto-fit over this starting value (see the auto-fit tests further
    // down).
    const state = makeState({ zoom: 0.35, zoomTouched: true });
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

    // Layout is 408x44 (see the geometry test above); a 204x22 viewport fits at 0.5.
    if (graphEl !== null) {
      Object.defineProperty(graphEl, 'clientWidth', { value: 204, configurable: true });
      Object.defineProperty(graphEl, 'clientHeight', { value: 22, configurable: true });
    }
    fitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(canvas?.style.transform).toBe('scale(0.5)');
  });

  it('fits by width alone for direction: right, ignoring a tiny container height (U2)', () => {
    // Layout is 408x44 (see the geometry test above). A 204x5 viewport has a generous width
    // ratio (0.5) but a tiny height ratio (5/44 ≈ 0.11) — the tree grows left to right and its
    // breadth is meant to scroll vertically, so "Fit" must land on the width ratio alone.
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(makeInput());
    const graphEl = container.querySelector<HTMLElement>('.bases-structure-graph');
    const canvas = container.querySelector<HTMLElement>('.bases-structure-canvas');
    const fitBtn = container.querySelector<HTMLButtonElement>('[aria-label="Fit to view"]');
    if (graphEl !== null) {
      Object.defineProperty(graphEl, 'clientWidth', { value: 204, configurable: true });
      Object.defineProperty(graphEl, 'clientHeight', { value: 5, configurable: true });
    }

    fitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(canvas?.style.transform).toBe('scale(0.5)');
  });

  it('fits by width and height for direction: down, same as today (U2)', () => {
    // Since depth grows downward and siblings spread horizontally for direction: down, both
    // dimensions are equally "the tree" (unlike 'right', where only the width should bind) — a
    // viewport with a generous width ratio but a constraining height ratio must still fit by
    // height. The viewport is derived from the layout's own measured size (rather than a
    // hardcoded guess) so this doesn't depend on hand-computing the vertical layout's geometry;
    // it only asserts the *shape* of U2's decision (both axes bind, not just the width).
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(makeInput({ schema: verticalSchema() }));
    const canvas = must(container.querySelector<HTMLElement>('.bases-structure-canvas'));
    const layoutWidth = parseFloat(canvas.style.width);
    const layoutHeight = parseFloat(canvas.style.height);
    const graphEl = container.querySelector<HTMLElement>('.bases-structure-graph');
    const fitBtn = container.querySelector<HTMLButtonElement>('[aria-label="Fit to view"]');
    if (graphEl !== null) {
      Object.defineProperty(graphEl, 'clientWidth', { value: layoutWidth * 2, configurable: true });
      Object.defineProperty(graphEl, 'clientHeight', {
        value: layoutHeight * 0.5,
        configurable: true,
      });
    }

    fitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Width ratio alone would be min(1, 2) = 1; the height ratio (0.5) is what must win.
    expect(canvas.style.transform).toBe('scale(0.5)');
  });

  it('auto-fits on the first render when zoom is untouched, floored at 0.85 so text stays readable', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    fakeGraphViewport(container, 204, 22);
    const state = makeState();

    renderer.update(makeInput({ state }));

    // Layout is 408x44 (see the geometry test above); a 204x22 viewport's natural fit is 0.5 —
    // below AUTO_FIT_MIN_ZOOM (0.85), so auto-fit floors it there instead of shrinking further
    // (a wide graph in a narrow embed must not open with unreadably small text).
    expect(state.zoom).toBeCloseTo(0.85);
    expect(container.querySelector<HTMLElement>('.bases-structure-canvas')?.style.transform).toBe(
      'scale(0.85)',
    );
  });

  it('clamps auto-fit at 0.85 for direction: down too', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    // Vertical layout is 124x152 (see the "direction: down" describe block below); a 40x40
    // viewport's natural fit is min(1, 40/124, 40/152) ≈ 0.263 — the floor must engage on this
    // direction's own (both-axes) fit computation too, not just direction: right's width-only one.
    fakeGraphViewport(container, 40, 40);
    const state = makeState();

    renderer.update(makeInput({ schema: verticalSchema(), state }));

    expect(state.zoom).toBeCloseTo(0.85);
  });

  it('leaves auto-fit unclamped once the natural fit ratio is already above 0.85', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    // 357 / 408 = 0.875 — already above the floor, so auto-fit must land on the real ratio, not
    // snap up to a fixed 0.85 regardless of what the container actually fits.
    fakeGraphViewport(container, 357, 100);
    const state = makeState();

    renderer.update(makeInput({ state }));

    expect(state.zoom).toBeCloseTo(0.875);
  });

  it('lets the manual "Fit to view" button go below the 0.85 auto-fit floor', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    fakeGraphViewport(container, 204, 22);
    const state = makeState();
    renderer.update(makeInput({ state }));
    expect(state.zoom).toBeCloseTo(0.85); // auto-fit floored, as above

    const fitBtn = must(container.querySelector<HTMLButtonElement>('[aria-label="Fit to view"]'));
    fitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // The floor is specific to `applyAutoFit`'s own choice — a user explicitly asking to fit the
    // whole graph still gets the real 0.5 ratio (only ZOOM_MIN, 0.3, bounds the manual button).
    expect(state.zoom).toBeCloseTo(0.5);
    expect(state.zoomTouched).toBe(true);
  });

  it('does not auto-fit when the zoom was already touched', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    fakeGraphViewport(container, 204, 22);
    const state = makeState({ zoomTouched: true });

    renderer.update(makeInput({ state }));

    expect(state.zoom).toBe(1);
  });

  it('only auto-fits once: a later untouched render keeps the first fit zoom', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    fakeGraphViewport(container, 204, 22);
    const state = makeState();
    renderer.update(makeInput({ state }));
    expect(state.zoom).toBeCloseTo(0.85); // floored, as above

    fakeGraphViewport(container, 408, 44);
    renderer.update(makeInput({ state }));

    expect(state.zoom).toBeCloseTo(0.85);
  });

  it('re-fits when direction changes and zoom was never touched (U3)', () => {
    // "Fit" follows a different axis per direction (U2), so the *old* direction's fit zoom is
    // usually the wrong number once the layout's own shape changes — switching direction must get
    // its own fresh auto-fit, same as the very first render did.
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    fakeGraphViewport(container, 204, 22);
    const state = makeState();
    renderer.update(makeInput({ state }));
    expect(state.zoom).toBeCloseTo(0.85); // floored, as above

    // Vertical layout is exactly 124x152 (see the "direction: down" describe block below) — a
    // same-size viewport fits at 1, unclamped. Landing on 1 (not the previous 0.85) proves the
    // switch actually recomputed a fresh fit rather than just reusing the old direction's value.
    fakeGraphViewport(container, 124, 152);
    renderer.update(makeInput({ schema: verticalSchema(), state }));

    expect(state.zoom).toBeCloseTo(1);
    expect(state.zoomTouched).toBe(false);
  });

  it('does not re-fit on a direction change once the zoom was touched', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    fakeGraphViewport(container, 204, 22);
    const state = makeState({ zoom: 0.8, zoomTouched: true });
    renderer.update(makeInput({ state }));
    expect(state.zoom).toBeCloseTo(0.8);

    fakeGraphViewport(container, 100, 5);
    renderer.update(makeInput({ schema: verticalSchema(), state }));

    expect(state.zoom).toBeCloseTo(0.8);
  });

  it('does not latch auto-fit against a zero-size container, and fits once a real size appears', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState();

    // jsdom always reports 0 for clientWidth/clientHeight, so this first render must not spend
    // its one auto-fit attempt on a bogus 0x0 box — it should stay untouched instead, leaving
    // the zoom at its default.
    renderer.update(makeInput({ state }));
    expect(state.zoom).toBe(1);
    expect(state.zoomTouched).toBe(false);

    fakeGraphViewport(container, 204, 22);
    renderer.update(makeInput({ state }));

    expect(state.zoom).toBeCloseTo(0.85); // floored, as above
  });

  it('computes a sane auto-fit zoom even when the container shrink-wraps to the canvas wrapper (real-browser CSS quirk)', () => {
    // In a real browser, `.bases-structure-graph` has no explicit height of its own — it
    // shrink-wraps to its in-flow content (just the toolbar; `.bases-structure-canvas` is
    // absolutely positioned, so it never counts) *plus* `.bases-structure-canvas-wrap`, which
    // only ever gets an explicit size from `applyZoom`. Reading `clientHeight` for auto-fit
    // *before* giving the wrapper its natural (unscaled) size is a chicken-and-egg bug: on the
    // very first render the wrapper has no size yet, so the container reports a tiny height,
    // `computeFitZoom` computes a bogus ratio far below `ZOOM_MIN`, and — since auto-fit only gets
    // one attempt per direction — that wrong zoom sticks forever (only direction: down actually
    // reads height at all, per U2, so this was invisible for the default direction: right).
    // jsdom has no real layout engine, so `clientHeight` is faked everywhere else in this file as
    // a static number; here it's faked as a *function* of the wrapper's own current inline
    // height instead, to model that shrink-wrap relationship and actually exercise the bug.
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const graphEl = must(container.querySelector<HTMLElement>('.bases-structure-graph'));
    const wrapEl = must(container.querySelector<HTMLElement>('.bases-structure-canvas-wrap'));
    const TOOLBAR_FLOW_HEIGHT = 40;
    Object.defineProperty(graphEl, 'clientWidth', { value: 200, configurable: true });
    Object.defineProperty(graphEl, 'clientHeight', {
      configurable: true,
      get: () =>
        TOOLBAR_FLOW_HEIGHT + parseFloat(wrapEl.style.height === '' ? '0' : wrapEl.style.height),
    });
    const state = makeState();

    renderer.update(makeInput({ schema: verticalSchema(), state }));

    // Layout is 124x152 unscaled (see the "direction: down" describe block below): a 200-wide,
    // "container that grows with its own content" box comfortably fits both axes at 100% once
    // the wrapper is measured at its real, unscaled size — not clamped down to ZOOM_MIN (0.3),
    // which is exactly what the unfixed chicken-and-egg read produced.
    expect(state.zoom).toBe(1);
  });

  it('exposes aria-labels for the three toolbar controls with no leftover text labels', () => {
    const container = createDiv();
    expect(new GraphRenderer(container, makeCtx(), { measure: fixedMeasure })).toBeInstanceOf(
      GraphRenderer,
    );

    const zoomOut = must(container.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]'));
    const zoomIn = must(container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]'));
    const fit = must(container.querySelector<HTMLButtonElement>('[aria-label="Fit to view"]'));
    expect(zoomOut.textContent).toBe('');
    expect(zoomIn.textContent).toBe('');
    expect(fit.textContent).toBe('');
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
    // M6: the canvas now sits inside `.bases-structure-canvas-wrap`, which is what's actually
    // hidden (and is what's sized to the zoomed layout — hiding it, not just the canvas nested
    // inside it, keeps an empty structure from leaving a stale, non-empty scroll area behind).
    expect(
      container.querySelector('.bases-structure-canvas-wrap')?.classList.contains('is-hidden'),
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

/** `direction: 'down'` (U3). The chain fixture (`chainStructure`, no siblings) with `fixedMeasure`
 * (every box 100x20) keeps the geometry hand-checkable: with `DEFAULT_VERTICAL_LAYOUT_OPTIONS`
 * (`columnGap: 40`), depth grows straight down, each level 60px below the last (columnGap 40 +
 * node height 20). Every node lands at `x = 12`, not 0 — `a.md` is a depth-1 node with a visible
 * child (`b.md`), so `layoutTree` still computes a padded group frame around it (`groupPadding:
 * 12`, unused for drawing since task 15 — see `layout.ts` — but still part of the vertical extent
 * `placeAllTops` shifts the whole tree by, to keep every coordinate non-negative); the same
 * shift is exactly why the *horizontal* geometry test above puts every one of these nodes at
 * `top: 12px` rather than 0. */
function verticalSchema(): ReturnType<typeof parseSchema>['schema'] {
  return parseSchema((key) => (key === 'direction' ? 'down' : undefined)).schema;
}

describe('GraphRenderer — direction: down', () => {
  it('positions nodes top-to-bottom instead of left-to-right', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    renderer.update(makeInput({ schema: verticalSchema() }));

    const rootEl = must(container.querySelector<HTMLElement>('[data-path="root.md"]'));
    const aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    const bEl = must(container.querySelector<HTMLElement>('[data-path="b.md"]'));
    expect(rootEl.style.left).toBe('12px');
    expect(rootEl.style.top).toBe('0px');
    expect(aEl.style.left).toBe('12px');
    expect(aEl.style.top).toBe('60px');
    expect(bEl.style.left).toBe('12px');
    expect(bEl.style.top).toBe('120px');
  });

  it('draws tree edges bottom-centre to top-centre instead of right-centre to left-centre', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    renderer.update(makeInput({ schema: verticalSchema() }));

    const edges = Array.from(
      container.querySelectorAll<SVGPathElement>('.bases-structure-edge:not(.is-extra)'),
    );
    expect(edges.map((edge) => edge.getAttribute('d'))).toStrictEqual([
      'M 62 20 C 62 44, 62 36, 62 60',
      'M 62 80 C 62 104, 62 96, 62 120',
    ]);
  });

  it('switching direction on an already-rendered view re-lays-out without recreating the renderer', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState({ active: 'a.md' });
    renderer.update(makeInput({ state }));
    const aElBefore = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    expect(aElBefore.style.top).toBe('12px');

    renderer.update(makeInput({ schema: verticalSchema(), state }));

    // Same renderer instance re-laid-out (not recreated) — collapsed/active state (`state` itself)
    // survives untouched, and the node now sits at its vertical position.
    expect(state.active).toBe('a.md');
    const aElAfter = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    expect(aElAfter.style.top).toBe('60px');
  });
});

describe('GraphRenderer — pop-out window (M3)', () => {
  it('checks focus against the container’s own document on a same-active-path re-render, not the global one', () => {
    // See `keyboard.test.ts`'s identical pop-out test for why an `<iframe>` (real focus tracking)
    // and a main-realm `container` merely *adopted* into it (keeps `instanceof HTMLElement`
    // matching, which this module's own node-element click handling depends on elsewhere).
    const iframe = createEl('iframe');
    document.body.appendChild(iframe);
    const otherDoc = iframe.contentDocument;
    if (otherDoc === null) throw new Error('Test setup error: iframe has no contentDocument');
    const container = createDiv();
    otherDoc.body.appendChild(container);
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState({ active: null });
    renderer.update(makeInput({ state })); // First render: nothing active yet (I9).

    state.active = 'a.md';
    renderer.update(makeInput({ state })); // Active newly set: real focus follows.
    const aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    expect(otherDoc.activeElement).toBe(aEl);

    renderer.update(makeInput({ state })); // Same active path: only `hadFocus` can trigger refocus.

    // Before M3, `hadFocus` read the *global* `document.activeElement` — never `aEl` (which was
    // genuinely focused inside the pop-out's own document) — so the rebuilt node never got real
    // focus back, and `otherDoc.activeElement` would have fallen back to `otherDoc.body`.
    const rebuiltAEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    expect(rebuiltAEl).not.toBe(aEl);
    expect(otherDoc.activeElement).toBe(rebuiltAEl);
  });
});

describe('GraphRenderer — background pan (M7)', () => {
  function pointerEvent(
    type: string,
    init: { x?: number; y?: number; target?: EventTarget } = {},
  ): PointerEvent {
    const event = new PointerEvent(type, {
      pointerId: 1,
      clientX: init.x ?? 0,
      clientY: init.y ?? 0,
      button: 0,
      pointerType: 'mouse',
      bubbles: true,
      cancelable: true,
    });
    if (init.target !== undefined) {
      Object.defineProperty(event, 'target', { value: init.target, configurable: true });
    }
    return event;
  }

  it('dragging the empty background scrolls the graph element', () => {
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(makeInput());
    const graphEl = must(container.querySelector<HTMLElement>('.bases-structure-graph'));

    graphEl.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, target: graphEl }));
    document.dispatchEvent(pointerEvent('pointermove', { x: 50, y: 100 }));

    expect(graphEl.classList.contains('is-panning')).toBe(true);
    expect(graphEl.scrollLeft).toBe(50);
  });

  it('does not pan when the pointerdown lands on a node', () => {
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(makeInput());
    const graphEl = must(container.querySelector<HTMLElement>('.bases-structure-graph'));
    const nodeEl = must(container.querySelector<HTMLElement>('[data-path="root.md"]'));

    nodeEl.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, target: nodeEl }));
    document.dispatchEvent(pointerEvent('pointermove', { x: 50, y: 100 }));

    expect(graphEl.classList.contains('is-panning')).toBe(false);
    expect(graphEl.scrollLeft).toBe(0);
  });

  it('stops panning once the renderer is destroyed', () => {
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(makeInput());
    const graphEl = must(container.querySelector<HTMLElement>('.bases-structure-graph'));

    renderer.destroy();
    graphEl.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, target: graphEl }));
    document.dispatchEvent(pointerEvent('pointermove', { x: 50, y: 100 }));

    expect(graphEl.classList.contains('is-panning')).toBe(false);
  });
});
