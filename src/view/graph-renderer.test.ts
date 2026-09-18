import { App, Component } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it, vi } from 'vitest';
import { note, snapshot } from '../core/__tests__/notes.js';
import type { Diagnostic } from '../core/diagnostics.js';
import type { Size } from '../core/layout.js';
import { parseSchema } from '../core/schema.js';
import type { Structure, StructureNode } from '../core/structure.js';
import * as superchargedLinksModule from '../obsidian/supercharged-links.js';
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
    onContextMenu: () => undefined,
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
    diagnostics: [],
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

  it('keeps real focus on the active node across a same-active-path re-render when focus was already inside', () => {
    // Node elements are reused across `update()` (perf task), so `aEl` itself never loses real
    // focus here — but `applyActiveState` still has to *ask* to focus it again (via `hadFocus`)
    // on every render regardless, since a re-render that *did* have to replace the active node's
    // element (any node it doesn't yet know how to reuse) must not leave
    // `document.activeElement` fallen back to `document.body`, silently breaking the next real
    // keydown (`keyboard.ts` relies on one delegated listener, not one per node).
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

    const sameAEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    expect(sameAEl).toBe(aEl);
    expect(document.activeElement).toBe(sameAEl);
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

  // I11 regression: unlike "focus elsewhere" above, a create draft's own input can be nested
  // *inside* the active node's own element (a Tab-created child draft, anchored on it) — `hadFocus`
  // is then true even though focus belongs to the draft, not the node. `suppressFocus` is
  // `showOptimistic`'s own signal (see `structure-view.ts`) that this render must not move focus.
  it('does not move focus onto the active node when suppressFocus is set, even with focus nested inside it (I11)', () => {
    const container = createDiv();
    document.body.appendChild(container);
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState({ active: 'a.md' });
    renderer.update(makeInput({ state }));
    const aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    const draftInput = createEl('input');
    aEl.appendChild(draftInput);
    draftInput.focus();
    expect(document.activeElement).toBe(draftInput);

    renderer.update(makeInput({ state, suppressFocus: true }));

    expect(document.activeElement).toBe(draftInput);
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

  it('centres the root horizontally for direction: down when the auto-fit floor still overflows', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    // Vertical layout is 124x152 (root at x=12, width 100 — see the "direction: down" describe
    // block below); a 40x40 viewport floors zoom at 0.85 (see "clamps auto-fit at 0.85 for
    // direction: down too"), leaving the 105px-wide canvas still wider than the 40px viewport.
    fakeGraphViewport(container, 40, 40);
    const state = makeState();

    renderer.update(makeInput({ schema: verticalSchema(), state }));

    // Root centre x = 12 + 100/2 = 62; scrollLeft = 62 * 0.85 - 40/2 = 32.7.
    expect(state.scrollLeft).toBeCloseTo(32.7);
    expect(state.scrollTop).toBe(0);
  });

  it('centres the root vertically for direction: right when the auto-fit floor still overflows', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    // Layout is 408x44 (root at y=12, height 20); a 204x22 viewport floors zoom at 0.85 (see
    // "auto-fits on the first render..."), leaving the 37.4px-tall canvas taller than the 22px
    // viewport.
    fakeGraphViewport(container, 204, 22);
    const state = makeState();

    renderer.update(makeInput({ state }));

    expect(state.scrollLeft).toBe(0);
    // Root centre y = 12 + 20/2 = 22; scrollTop = 22 * 0.85 - 22/2 = 7.7.
    expect(state.scrollTop).toBeCloseTo(7.7);
  });

  it('leaves scroll at 0/0 once the whole graph fits (no overflow to bring the root into)', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    // Exactly the vertical layout's own size (124x152): zoom lands on 1, unclamped, and the whole
    // tree — including the root — is already fully in view.
    fakeGraphViewport(container, 124, 152);
    const state = makeState();

    renderer.update(makeInput({ schema: verticalSchema(), state }));

    expect(state.zoom).toBe(1);
    expect(state.scrollLeft).toBe(0);
    expect(state.scrollTop).toBe(0);
  });

  it('keeps the user’s own scroll on a later render instead of re-centring', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    fakeGraphViewport(container, 204, 22);
    const state = makeState();
    renderer.update(makeInput({ state }));
    expect(state.scrollTop).toBeCloseTo(7.7); // centred once, as above.

    state.scrollLeft = 5;
    state.scrollTop = 5;
    renderer.update(makeInput({ state }));

    expect(state.scrollLeft).toBe(5);
    expect(state.scrollTop).toBe(5);
  });

  it('re-centres once for a new direction after a switch (U3)', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    fakeGraphViewport(container, 204, 22);
    const state = makeState();
    renderer.update(makeInput({ state })); // right: floored at 0.85, vertical overflow.
    expect(state.scrollLeft).toBe(0);
    expect(state.scrollTop).toBeCloseTo(7.7);

    fakeGraphViewport(container, 40, 40);
    renderer.update(makeInput({ schema: verticalSchema(), state })); // down: floored at 0.85 too.

    // Reset for the new axis, and recomputed (not merely left over from the right-direction fit).
    expect(state.scrollTop).toBe(0);
    expect(state.scrollLeft).toBeCloseTo(32.7);
  });

  // Reviewer regression (important): `a.md`'s box means something different in each direction's
  // layout (different axes entirely) — an active node present under both must not let scroll
  // anchoring diff a "before" box captured under the old direction against an "after" box from the
  // new one and add that bogus delta on top of auto-fit's own freshly computed centring.
  it('does not let scroll anchoring fight auto-fit’s own re-centring across a direction switch, with an active node present in both', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    fakeGraphViewport(container, 204, 22);
    const state = makeState({ active: 'a.md' });
    renderer.update(makeInput({ state })); // right: floored at 0.85, vertical overflow.
    expect(state.scrollTop).toBeCloseTo(7.7);

    fakeGraphViewport(container, 40, 40);
    renderer.update(makeInput({ schema: verticalSchema(), state })); // down: floored at 0.85 too.

    // Same numbers as the direction-switch test above (which has no active node) — an active node
    // surviving the switch must not change them.
    expect(state.scrollTop).toBe(0);
    expect(state.scrollLeft).toBeCloseTo(32.7);
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

    // jsdom always reports 0 for offsetWidth/offsetHeight, so the fallback constants (180x32)
    // apply — visible in the next column's `left` (180 + the default 48px columnGap), since a
    // node's own rendered width is no longer pinned to the measurement directly (D1 follow-up,
    // "keep Supercharged Links icons on the title line" — see `positionNodes`'s own doc comment).
    expect(container.querySelector<HTMLElement>('[data-path="a.md"]')?.style.left).toBe('228px');
  });

  it('never sets an inline width on a positioned node (D1 follow-up)', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    renderer.update(makeInput());

    for (const el of Array.from(
      container.querySelectorAll<HTMLElement>('.bases-structure-node.is-positioned'),
    )) {
      expect(el.style.width).toBe('');
    }
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

/** A flat forest with no parent/child relationships — every path is its own top. Enough for the
 * reconciliation tests below, which only care about element identity across updates, not layout. */
function flatStructure(paths: readonly string[]): Structure {
  const nodes = new Map(
    paths.map((path): [string, StructureNode] => [
      path,
      {
        path,
        type: null,
        parent: null,
        edge: null,
        children: [],
        extras: [],
        alsoIn: [],
        twoWay: false,
      },
    ]),
  );
  return { root: paths[0] ?? null, tops: paths, orphans: [], nodes, issues: [] };
}

function flatInput(paths: readonly string[], overrides: Partial<RenderInput> = {}): RenderInput {
  return makeInput({
    structure: flatStructure(paths),
    snapshot: snapshot(paths.map((path) => note(path))),
    ...overrides,
  });
}

/** `topPath` with `childPaths` as its only children — for the toggle-reconciliation test, which
 * needs a single node's child count to change between two updates while the node itself persists. */
function structureWithChildren(topPath: string, childPaths: readonly string[]): Structure {
  const nodes = new Map<string, StructureNode>();
  nodes.set(topPath, {
    path: topPath,
    type: null,
    parent: null,
    edge: null,
    children: childPaths,
    extras: [],
    alsoIn: [],
    twoWay: false,
  });
  for (const child of childPaths) {
    nodes.set(child, {
      path: child,
      type: null,
      parent: topPath,
      edge: null,
      children: [],
      extras: [],
      alsoIn: [],
      twoWay: false,
    });
  }
  return { root: topPath, tops: [topPath], orphans: [], nodes, issues: [] };
}

describe('GraphRenderer — reconciling node elements instead of rebuilding them', () => {
  it('reuses node elements across updates', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(flatInput(['a.md', 'b.md']));
    const first = renderer.getNodeElement('a.md');

    renderer.update(flatInput(['a.md', 'b.md', 'c.md']));

    expect(renderer.getNodeElement('a.md')).toBe(first);
    expect(renderer.getNodeElement('c.md')).not.toBeNull();
  });

  it('drops elements for nodes that are gone', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(flatInput(['a.md', 'b.md']));

    renderer.update(flatInput(['a.md']));

    expect(renderer.getNodeElement('b.md')).toBeNull();
    expect(container.querySelectorAll('.bases-structure-node')).toHaveLength(1);
  });

  it('keeps the same title element across an update, so Supercharged Links state on it survives', () => {
    const app = App.createConfigured__();
    // A non-scalar frontmatter value: `applySuperchargedLinkAttributes` never sets this itself —
    // only Supercharged Links' own async observer would, simulated below by setting it directly.
    app.metadataCache.setCache__('a.md', { frontmatter: { related: ['x', 'y'] } });
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx({ app: app.asOriginalType__() }), {
      measure: fixedMeasure,
    });
    renderer.update(flatInput(['a.md']));
    const title = container.querySelector('[data-path="a.md"] .bases-structure-title');
    title?.setAttribute('data-link-related', 'x y');

    renderer.update(flatInput(['a.md']));

    expect(container.querySelector('[data-path="a.md"] .bases-structure-title')).toBe(title);
    expect(title?.getAttribute('data-link-related')).toBe('x y');
  });

  it('clears is-new on a later render once focusPath no longer names the node (I7)', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(flatInput(['a.md'], { focusPath: 'a.md' }));
    expect(renderer.getNodeElement('a.md')?.classList.contains('is-new')).toBe(true);

    renderer.update(flatInput(['a.md']));

    expect(renderer.getNodeElement('a.md')?.classList.contains('is-new')).toBe(false);
  });

  it('adds a toggle to a reused node once it gains children, and drops it once they are gone', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const snap = snapshot([note('a.md'), note('b.md')]);
    renderer.update(makeInput({ structure: structureWithChildren('a.md', []), snapshot: snap }));
    expect(container.querySelector('[data-path="a.md"] .bases-structure-toggle')).toBeNull();

    renderer.update(
      makeInput({ structure: structureWithChildren('a.md', ['b.md']), snapshot: snap }),
    );
    expect(container.querySelector('[data-path="a.md"] .bases-structure-toggle')).not.toBeNull();

    renderer.update(makeInput({ structure: structureWithChildren('a.md', []), snapshot: snap }));
    expect(container.querySelector('[data-path="a.md"] .bases-structure-toggle')).toBeNull();
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
    // genuinely focused inside the pop-out's own document) — so a node that had to be rebuilt
    // never got real focus back, and `otherDoc.activeElement` would have fallen back to
    // `otherDoc.body`. `aEl` itself is reused now (perf task), so it never actually lost focus —
    // this still guards `hadFocus` reading the right document for whichever node *does* have to
    // be replaced on some other render.
    const sameAEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    expect(sameAEl).toBe(aEl);
    expect(otherDoc.activeElement).toBe(sameAEl);
  });
});

describe('GraphRenderer — edge labels (D2)', () => {
  /** root.md -> [a.md, b.md, c.md], all type "Task" — a single run of 3 visible siblings, so
   * `planEdgeLabels` picks the middle one (`b.md`, index `floor((3-1)/2)` = 1) as the label's
   * anchor. Every box is a fixed 100x20 via `measureByKind` below (nodes) so column positions are
   * hand-checkable the same way `chainStructure`'s own tests are. */
  function siblingsStructure(): Structure {
    const child = (path: string): [string, StructureNode] => [
      path,
      {
        path,
        type: 'Task',
        parent: 'root.md',
        edge: null,
        children: [],
        extras: [],
        alsoIn: [],
        twoWay: false,
      },
    ];
    return {
      root: 'root.md',
      tops: ['root.md'],
      orphans: [],
      nodes: new Map([
        [
          'root.md',
          {
            path: 'root.md',
            type: null,
            parent: null,
            edge: null,
            children: ['a.md', 'b.md', 'c.md'],
            extras: [],
            alsoIn: [],
            twoWay: false,
          },
        ],
        child('a.md'),
        child('b.md'),
        child('c.md'),
      ]),
      issues: [],
    };
  }

  function siblingsSnapshot(): ReturnType<typeof snapshot> {
    return snapshot([note('root.md'), note('a.md'), note('b.md'), note('c.md')]);
  }

  function makeSchema(overrides: Record<string, unknown> = {}) {
    return parseSchema((key: string): unknown => overrides[key]).schema;
  }

  /** 100x20 for a node, 40x14 for a label — distinct enough that gap-widening math
   * (`widest label + 16` for `right`, `tallest label + 8` for `down`) is hand-checkable from the
   * resulting `left`/`top` of a depth-1 node. */
  const measureByKind = (el: HTMLElement): Size =>
    el.classList.contains('bases-structure-edge-label')
      ? { width: 40, height: 14 }
      : { width: 100, height: 20 };

  it('draws no labels and leaves the layout unchanged when edgeLabels is off (default)', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: measureByKind });

    renderer.update(
      makeInput({
        schema: makeSchema(),
        structure: siblingsStructure(),
        snapshot: siblingsSnapshot(),
      }),
    );

    expect(container.querySelectorAll('.bases-structure-edge-label')).toHaveLength(0);
    const aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    expect(aEl.style.left).toBe('148px'); // 100 (root width) + 48 (default columnGap).
  });

  it("draws one label per run of same-type siblings, with the run's type as its text", () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: measureByKind });

    renderer.update(
      makeInput({
        schema: makeSchema({ edgeLabels: true }),
        structure: siblingsStructure(),
        snapshot: siblingsSnapshot(),
      }),
    );

    const labels = container.querySelectorAll('.bases-structure-edge-label');
    expect(labels).toHaveLength(1);
    expect(labels[0]?.textContent).toBe('Task');
  });

  it('never labels an untyped ("") run, even when edgeLabels is on', () => {
    const untyped: Structure = {
      ...siblingsStructure(),
      nodes: new Map(
        Array.from(siblingsStructure().nodes, ([path, node]) => [
          path,
          node.parent === null ? node : { ...node, type: '' },
        ]),
      ),
    };
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: measureByKind });

    renderer.update(
      makeInput({
        schema: makeSchema({ edgeLabels: true }),
        structure: untyped,
        snapshot: siblingsSnapshot(),
      }),
    );

    expect(container.querySelectorAll('.bases-structure-edge-label')).toHaveLength(0);
  });

  it('excludes a two-way child and its own extras from ever hosting a label', () => {
    // chainWithExtrasStructure: root.md -> a.md -> b.md (two-way, plus an extra dashed edge from
    // extra.md). Only root -> a.md is a plain, single-child run of a typed ("X") node; a.md's own
    // child b.md is two-way, so it must never host a label, and extra.md's dashed edge to b.md
    // (an "extra", not a tree child) must never produce one either.
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: measureByKind });

    renderer.update(
      makeInput({
        schema: makeSchema({ edgeLabels: true }),
        structure: chainWithExtrasStructure(),
      }),
    );

    const labels = container.querySelectorAll('.bases-structure-edge-label');
    expect(labels).toHaveLength(1);
    expect(labels[0]?.textContent).toBe('X');
  });

  it('widens the depth gap by the widest label width + 16px for direction: right', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: measureByKind });

    renderer.update(
      makeInput({
        schema: makeSchema({ edgeLabels: true }),
        structure: siblingsStructure(),
        snapshot: siblingsSnapshot(),
      }),
    );

    // 100 (root width) + 48 (default columnGap) + 40 (label width) + 16 (right margin) = 204.
    const aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    expect(aEl.style.left).toBe('204px');
  });

  it('widens the depth gap by the tallest label height + 8px for direction: down', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: measureByKind });

    renderer.update(
      makeInput({
        schema: makeSchema({ edgeLabels: true, direction: 'down' }),
        structure: siblingsStructure(),
        snapshot: siblingsSnapshot(),
      }),
    );

    // 20 (root height) + 40 (default vertical columnGap) + 14 (label height) + 8 (down margin) = 82.
    const aEl = must(container.querySelector<HTMLElement>('[data-path="a.md"]'));
    expect(aEl.style.top).toBe('82px');
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

describe('GraphRenderer — Supercharged Links (D1)', () => {
  it('hooks the nodes container once at construction, and unhooks it once on destroy', () => {
    const hookSpy = vi.spyOn(superchargedLinksModule, 'hookSuperchargedLinks');
    const unhookSpy = vi.spyOn(superchargedLinksModule, 'unhookSuperchargedLinks');
    const container = createDiv();
    const ctx = makeCtx();

    const renderer = new GraphRenderer(container, ctx, {
      measure: fixedMeasure,
      ownerId: 'bases-structure',
    });

    const nodesEl = must(container.querySelector<HTMLElement>('.bases-structure-nodes'));
    expect(hookSpy).toHaveBeenCalledExactlyOnceWith(
      ctx.app,
      expect.objectContaining({ ownerId: 'bases-structure' }),
      nodesEl,
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
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    hookSpy.mockClear();

    renderer.update(makeInput());
    renderer.update(makeInput());

    expect(hookSpy).not.toHaveBeenCalled();
  });

  it('logs and continues when hooking throws instead of breaking construction', () => {
    vi.spyOn(superchargedLinksModule, 'hookSuperchargedLinks').mockImplementation(() => {
      throw new Error('unexpected shape');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const container = createDiv();
    let renderer: GraphRenderer | undefined;

    expect(() => {
      renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
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
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    expect(() => {
      renderer.destroy();
    }).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith('[bases-structure]', expect.any(Error));
    expect(container.childElementCount).toBe(0);
  });
});

describe('GraphRenderer — Supercharged Links attribute carry-over (D1 follow-up)', () => {
  it('carries a Supercharged-Links-added attribute over (present at measure time) while its frontmatter key is still there', () => {
    const app = App.createConfigured__();
    app.metadataCache.setCache__('root.md', { frontmatter: { related: ['x', 'y'] } });
    const seenAtMeasureTime = new Map<string, string | null>();
    const measure = (el: HTMLElement): Size => {
      const path = el.getAttribute('data-path');
      const title = el.querySelector('.bases-structure-title');
      if (path !== null && title !== null) {
        seenAtMeasureTime.set(path, title.getAttribute('data-link-related'));
      }
      return { width: 100, height: 20 };
    };
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx({ app: app.asOriginalType__() }), {
      measure,
    });
    renderer.update(makeInput());
    // Simulate Supercharged Links' own observer adding a non-scalar attribute asynchronously,
    // some time after the first render already measured/positioned this node —
    // `applySuperchargedLinkAttributes` never sets one itself (scalars only), by design.
    const title = must(
      container.querySelector<HTMLElement>('[data-path="root.md"] .bases-structure-title'),
    );
    title.setAttribute('data-link-related', 'x y');

    renderer.update(makeInput());

    expect(seenAtMeasureTime.get('root.md')).toBe('x y');
  });

  it('drops a data-link-* attribute and its CSS variable once its frontmatter key is removed', () => {
    const app = App.createConfigured__();
    app.metadataCache.setCache__('root.md', { frontmatter: { type: 'A' } });
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx({ app: app.asOriginalType__() }), {
      measure: fixedMeasure,
    });
    renderer.update(makeInput());
    const firstTitle = must(
      container.querySelector<HTMLElement>('[data-path="root.md"] .bases-structure-title'),
    );
    expect(firstTitle.getAttribute('data-link-type')).toBe('A');
    expect(firstTitle.style.getPropertyValue('--data-link-type')).toBe('A');

    app.metadataCache.setCache__('root.md', { frontmatter: {} });
    renderer.update(makeInput());

    const title = container.querySelector<HTMLElement>(
      '[data-path="root.md"] .bases-structure-title',
    );
    expect(title?.hasAttribute('data-link-type')).toBe(false);
    expect(title?.style.getPropertyValue('--data-link-type')).toBe('');
  });

  it('drops data-link-tags once the note has no tags left at all (frontmatter or inline)', () => {
    const app = App.createConfigured__();
    app.metadataCache.setCache__('root.md', { frontmatter: { tags: ['x'] } });
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx({ app: app.asOriginalType__() }), {
      measure: fixedMeasure,
    });
    renderer.update(makeInput());
    const firstTitle = must(
      container.querySelector<HTMLElement>('[data-path="root.md"] .bases-structure-title'),
    );
    // Simulate Supercharged Links' own observer — `data-link-tags` is never set by
    // `applySuperchargedLinkAttributes` itself.
    firstTitle.setAttribute('data-link-tags', '#x');

    app.metadataCache.setCache__('root.md', { frontmatter: {} });
    renderer.update(makeInput());

    const title = container.querySelector('[data-path="root.md"] .bases-structure-title');
    expect(title?.hasAttribute('data-link-tags')).toBe(false);
  });

  it('always carries data-link-path over — a path-derived attribute, never frontmatter-sourced', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(makeInput());
    const firstTitle = must(
      container.querySelector<HTMLElement>('[data-path="root.md"] .bases-structure-title'),
    );
    firstTitle.setAttribute('data-link-path', 'root.md');

    renderer.update(makeInput());

    const title = container.querySelector('[data-path="root.md"] .bases-structure-title');
    expect(title?.getAttribute('data-link-path')).toBe('root.md');
  });

  it('lets current scalar frontmatter win over a carried-over stale value for the same attribute', () => {
    const app = App.createConfigured__();
    app.metadataCache.setCache__('root.md', { frontmatter: { type: 'A' } });
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx({ app: app.asOriginalType__() }), {
      measure: fixedMeasure,
    });
    renderer.update(makeInput());

    app.metadataCache.setCache__('root.md', { frontmatter: { type: 'B' } });
    renderer.update(makeInput());

    const title = container.querySelector('[data-path="root.md"] .bases-structure-title');
    expect(title?.getAttribute('data-link-type')).toBe('B');
  });

  it('does not hook again while carrying attributes over across renders (no duplicate observers)', () => {
    const hookSpy = vi.spyOn(superchargedLinksModule, 'hookSuperchargedLinks');
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(makeInput());
    const title = must(
      container.querySelector<HTMLElement>('[data-path="root.md"] .bases-structure-title'),
    );
    title.setAttribute('data-link-tags', '#a');
    hookSpy.mockClear();

    renderer.update(makeInput());

    expect(hookSpy).not.toHaveBeenCalled();
  });
});

describe('GraphRenderer — re-measure after Supercharged Links changes a node (task 2)', () => {
  /** jsdom has no `requestAnimationFrame` of its own to drive explicitly, so this replaces it with
   * a queue the test controls. `flushFrames` first awaits a microtask tick — long enough for the
   * (real, native) `MutationObserver` callback to run and call the stubbed `requestAnimationFrame`
   * itself — then invokes whatever got queued, exactly once. */
  function stubAnimationFrame(): { flushFrames: () => Promise<void> } {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      const handle = nextHandle++;
      callbacks.set(handle, cb);
      return handle;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
      callbacks.delete(handle);
    });
    return {
      flushFrames: async () => {
        await Promise.resolve();
        const pending = Array.from(callbacks.values());
        callbacks.clear();
        for (const cb of pending) {
          cb(0);
        }
      },
    };
  }

  /** `a.md` and `b.md` as two independent forest tops (`flatInput`) — direction: right stacks
   * separate tops in their own rows, so growing `a.md`'s own row height pushes `b.md`'s row down,
   * a change hand-checkable without needing to know either box's exact coordinates. */
  function measureByWidth(wide: Set<string>): (el: HTMLElement) => Size {
    return (el) =>
      wide.has(el.getAttribute('data-path') ?? '')
        ? { width: 100, height: 60 }
        : { width: 100, height: 20 };
  }

  it('re-lays out when Supercharged Links adds an attribute later', async () => {
    const { flushFrames } = stubAnimationFrame();
    const wide = new Set<string>();
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: measureByWidth(wide) });
    renderer.update(flatInput(['a.md', 'b.md']));
    const before = renderer.getNodeElement('b.md')?.style.top;

    wide.add('a.md'); // the stubbed measure now reports a taller node for a.md
    must(renderer.getNodeElement('a.md')?.querySelector<HTMLElement>('a')).setAttribute(
      'data-link-tags',
      'x',
    );
    await flushFrames();

    expect(renderer.getNodeElement('b.md')?.style.top).not.toBe(before);
  });

  it('ignores an attribute change that is not data-link-*', async () => {
    const { flushFrames } = stubAnimationFrame();
    const wide = new Set<string>();
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: measureByWidth(wide) });
    renderer.update(flatInput(['a.md', 'b.md']));
    const before = renderer.getNodeElement('b.md')?.style.top;

    wide.add('a.md');
    must(renderer.getNodeElement('a.md')?.querySelector<HTMLElement>('a')).setAttribute(
      'data-foo',
      'x',
    );
    await flushFrames();

    expect(renderer.getNodeElement('b.md')?.style.top).toBe(before);
  });

  it('coalesces several attribute changes into a single re-layout per frame', async () => {
    const { flushFrames } = stubAnimationFrame();
    const wide = new Set<string>();
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: measureByWidth(wide) });
    renderer.update(flatInput(['a.md', 'b.md']));
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    const title = must(renderer.getNodeElement('a.md')?.querySelector<HTMLElement>('a'));

    wide.add('a.md');
    title.setAttribute('data-link-tags', 'x');
    title.setAttribute('data-link-type', 'y');
    await flushFrames();

    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending re-layout frame on destroy, and stops observing', async () => {
    stubAnimationFrame();
    const wide = new Set<string>();
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: measureByWidth(wide) });
    renderer.update(flatInput(['a.md', 'b.md']));
    const cafSpy = vi.spyOn(window, 'cancelAnimationFrame');
    const title = must(renderer.getNodeElement('a.md')?.querySelector<HTMLElement>('a'));
    wide.add('a.md');
    title.setAttribute('data-link-tags', 'x');
    await Promise.resolve(); // let the MutationObserver's own microtask schedule the frame

    renderer.destroy();

    expect(cafSpy).toHaveBeenCalledTimes(1);
  });

  it('does not crash on a mutation observed before the first update (defensive)', async () => {
    const { flushFrames } = stubAnimationFrame();
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    // `nodesEl` exists as soon as the renderer is constructed, before any `update()` call — so
    // `relayout()`'s scheduled frame runs against a renderer with no `lastInput` yet.
    const nodesEl = must(container.querySelector<HTMLElement>('.bases-structure-nodes'));
    const stray = nodesEl.createDiv();
    stray.setAttribute('data-link-tags', 'x');

    await expect(flushFrames()).resolves.toBeUndefined();

    expect(renderer.getNodeElement('a.md')).toBeNull();
  });

  it('does not crash on a mutation observed while the structure has no visible nodes (defensive)', async () => {
    const { flushFrames } = stubAnimationFrame();
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(flatInput(['a.md']));
    const title = must(renderer.getNodeElement('a.md')?.querySelector<HTMLElement>('a'));
    title.setAttribute('data-link-tags', 'x'); // schedules a re-layout for the frame below
    const emptyStructure: Structure = {
      root: null,
      tops: [],
      orphans: [],
      nodes: new Map(),
      issues: [],
    };
    renderer.update(makeInput({ structure: emptyStructure, snapshot: snapshot([]) }));

    await expect(flushFrames()).resolves.toBeUndefined();

    expect(container.querySelectorAll('.bases-structure-node')).toHaveLength(0);
  });
});

describe('GraphRenderer — scroll anchoring on the active node (task 3)', () => {
  it('folds the active node’s layout shift into scroll, keeping it visually still', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState({ active: 'b.md' });
    renderer.update(flatInput(['a.md', 'b.md'], { state }));
    const before = must(renderer.getNodeElement('b.md')).style.top;

    // A new top inserted before b.md pushes its row down — a layout shift with nothing to do with
    // the user's own scroll position.
    renderer.update(flatInput(['a.md', 'a2.md', 'b.md'], { state }));

    const after = must(renderer.getNodeElement('b.md')).style.top;
    const delta = parseFloat(after) - parseFloat(before);
    expect(delta).not.toBe(0); // sanity: the raw layout position actually moved
    expect(state.scrollTop).toBeCloseTo(delta);
    const graphEl = must(container.querySelector<HTMLElement>('.bases-structure-graph'));
    expect(graphEl.scrollTop).toBeCloseTo(delta);
  });

  it('does not touch scroll when nothing is active', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState();
    renderer.update(flatInput(['a.md', 'b.md'], { state }));

    renderer.update(flatInput(['a.md', 'a2.md', 'b.md'], { state }));

    expect(state.scrollLeft).toBe(0);
    expect(state.scrollTop).toBe(0);
  });

  it('does not anchor an active node that only just appeared (not rendered before)', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const state = makeState({ active: 'a.md' });
    renderer.update(flatInput(['a.md'], { state }));

    // b.md becomes active on the very render it first appears — nothing to anchor it against yet.
    state.active = 'b.md';
    renderer.update(flatInput(['a.md', 'b.md'], { state }));

    expect(state.scrollLeft).toBe(0);
    expect(state.scrollTop).toBe(0);
  });
});

/** `parentPath` with a single real tree child `childPath` — for the inherit-mismatch test, which
 * needs an existing parent/child edge for the diagnostic to mark (unlike `illegal-parent`/
 * `broken-link`, whose own `target` is never the node's real structural parent). */
function parentChildStructure(parentPath: string, childPath: string): Structure {
  const nodes = new Map<string, StructureNode>([
    [
      parentPath,
      {
        path: parentPath,
        type: null,
        parent: null,
        edge: null,
        children: [childPath],
        extras: [],
        alsoIn: [],
        twoWay: false,
      },
    ],
    [
      childPath,
      {
        path: childPath,
        type: null,
        parent: parentPath,
        edge: null,
        children: [],
        extras: [],
        alsoIn: [],
        twoWay: false,
      },
    ],
  ]);
  return { root: parentPath, tops: [parentPath], orphans: [], nodes, issues: [] };
}

describe('GraphRenderer — diagnostics (task 5)', () => {
  const illegalParent: Diagnostic = {
    kind: 'illegal-parent',
    node: 'h.md',
    target: 'p.md',
    property: 'category',
    message: '"Problem" cannot be the category of "Hierarchy"',
  };

  const brokenLink: Diagnostic = {
    kind: 'broken-link',
    node: 'h.md',
    target: 'missing.md',
    property: 'category',
    message: '"h" links to "missing.md" as category, but no such note exists.',
  };

  const inheritMismatch: Diagnostic = {
    kind: 'inherit-mismatch',
    node: 'c.md',
    keys: ['category'],
    message: '"c" does not match its parent for category.',
  };

  it('draws an error edge and a problem marker for an illegal-parent diagnostic between two rendered nodes', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    renderer.update(flatInput(['h.md', 'p.md'], { diagnostics: [illegalParent] }));

    expect(container.querySelector('.bases-structure-edge.is-error')).not.toBeNull();
    expect(container.querySelector('.bases-structure-edge-problem')).not.toBeNull();
  });

  it('marks a broken-link diagnostic with a stub error edge when its target is not a rendered node', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    renderer.update(flatInput(['h.md'], { diagnostics: [brokenLink] }));

    expect(container.querySelectorAll('.bases-structure-edge.is-error')).toHaveLength(1);
    expect(container.querySelector('.bases-structure-edge-problem')).not.toBeNull();
  });

  it('marks an inheritance mismatch on the node and its own parent tree edge', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const structure = parentChildStructure('p.md', 'c.md');

    renderer.update(
      makeInput({
        structure,
        snapshot: snapshot([note('p.md'), note('c.md')]),
        diagnostics: [inheritMismatch],
      }),
    );

    expect(
      renderer.getNodeElement('c.md')?.querySelector('.bases-structure-problem'),
    ).not.toBeNull();
    expect(container.querySelector('.bases-structure-edge.is-warning')).not.toBeNull();
  });

  it("sets the mid-edge marker's title to the diagnostic message", () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });

    renderer.update(flatInput(['h.md', 'p.md'], { diagnostics: [illegalParent] }));

    const marker = must(
      container.querySelector<SVGTitleElement>('.bases-structure-edge-problem title'),
    );
    expect(marker.textContent).toBe(illegalParent.message);
  });

  it('joins several diagnostics naming the same node into one marker title', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const second: Diagnostic = {
      kind: 'broken-link',
      node: 'h.md',
      target: 'missing2.md',
      property: 'meta',
      message: 'second message',
    };

    renderer.update(flatInput(['h.md'], { diagnostics: [brokenLink, second] }));

    const marker = must(renderer.getNodeElement('h.md')?.querySelector('.bases-structure-problem'));
    expect(marker.getAttribute('title')).toBe(`${brokenLink.message}\n${second.message}`);
  });

  it('drops the error edge, marker and node problem-marker once the diagnostic is resolved (no leaked marker)', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    renderer.update(flatInput(['h.md', 'p.md'], { diagnostics: [illegalParent] }));
    expect(container.querySelector('.bases-structure-edge.is-error')).not.toBeNull();

    renderer.update(flatInput(['h.md', 'p.md'], { diagnostics: [] }));

    expect(container.querySelector('.bases-structure-edge.is-error')).toBeNull();
    expect(container.querySelector('.bases-structure-edge-problem')).toBeNull();
    expect(renderer.getNodeElement('h.md')?.querySelector('.bases-structure-problem')).toBeNull();
  });

  it('drops is-warning from the tree edge once the inherit-mismatch diagnostic is resolved', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const structure = parentChildStructure('p.md', 'c.md');
    const snap = snapshot([note('p.md'), note('c.md')]);
    renderer.update(makeInput({ structure, snapshot: snap, diagnostics: [inheritMismatch] }));
    expect(container.querySelector('.bases-structure-edge.is-warning')).not.toBeNull();

    renderer.update(makeInput({ structure, snapshot: snap, diagnostics: [] }));

    expect(container.querySelector('.bases-structure-edge.is-warning')).toBeNull();
  });

  it('ignores a diagnostic naming a node that is not currently rendered (defensive)', () => {
    const container = createDiv();
    const renderer = new GraphRenderer(container, makeCtx(), { measure: fixedMeasure });
    const ghost: Diagnostic = { ...illegalParent, node: 'ghost.md' };

    expect(() => {
      renderer.update(flatInput(['h.md'], { diagnostics: [ghost] }));
    }).not.toThrow();
    expect(container.querySelector('.bases-structure-edge-problem')).toBeNull();
  });
});
