// The default renderer: a left-to-right tidy tree, nodes as HTML (positioned absolutely from
// `layoutTree`), edges as SVG (cubic beziers between node borders — no group frames, no arrows on
// a plain tree edge, direction is implied by the left-to-right layout), a zoom/fit toolbar and
// collapse toggles.
// The DOM is built once in the constructor and reused across `update()` calls; only the nodes
// layer and the SVG's dynamic content (everything after `<defs>`) are rebuilt each time.

import type { LayoutResult, Size } from '../core/layout.js';
import { DEFAULT_LAYOUT_OPTIONS, layoutTree } from '../core/layout.js';
import type { ExtraLink, Structure, StructureNode } from '../core/structure.js';
import { edgePath } from './edges.js';
import { setSizedIcon } from './icon.js';
import type { MutableNodeElementContext, NodeElementContext } from './node-element.js';
import {
  applyActiveNode,
  attachNodeInteractions,
  cloneNodeElementContext,
  createNodeElement,
  findNodeElement,
  focusActiveNode,
} from './node-element.js';
import type { RenderInput, StructureRenderer } from './structure-view.js';
import type { ViewUiState } from './view-state.js';

export interface GraphRendererOptions {
  readonly measure?: (el: HTMLElement) => Size;
}

interface VisibleEntry {
  readonly path: string;
  readonly node: StructureNode;
  readonly isRoot: boolean;
  readonly isOrphan: boolean;
}

interface ToolbarElements {
  readonly toolbarEl: HTMLElement;
  readonly zoomOutBtn: HTMLButtonElement;
  readonly zoomLabelEl: HTMLElement;
  readonly zoomInBtn: HTMLButtonElement;
  readonly fitBtn: HTMLButtonElement;
}

interface CanvasElements {
  /** Sized to `layout size × zoom` (see `applyZoom`) — the element `.bases-structure-graph`'s
   * `overflow: auto` actually measures for scrolling. `canvasEl` itself keeps its own full,
   * unscaled layout size and is visually scaled with `transform` inside this wrapper (M6:
   * `transform: scale()` never changes an element's own layout/scroll size, so scaling `canvasEl`
   * directly — with nothing else sized to the zoomed result — left the scroll area always
   * matching the *unscaled* graph, regardless of how small zooming out made it look). */
  readonly wrapEl: HTMLElement;
  readonly canvasEl: HTMLElement;
  readonly svgEl: SVGSVGElement;
  readonly defsEl: SVGDefsElement;
  readonly nodesEl: HTMLElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_SELECTOR = '.bases-structure-node';
const TREE_ARROW_MARKER_ID = 'bases-structure-arrow-tree';
const TREE_ARROW_MARKER_URL = `url(#${TREE_ARROW_MARKER_ID})`;
const EXTRA_ARROW_MARKER_ID = 'bases-structure-arrow-extra';
const EXTRA_ARROW_MARKER_URL = `url(#${EXTRA_ARROW_MARKER_ID})`;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
const WHEEL_ZOOM_FACTOR = 0.002;
const DEFAULT_NODE_WIDTH = 180;
const DEFAULT_NODE_HEIGHT = 32;
const EMPTY_MESSAGE = 'Nothing to show yet';
// `offsetWidth` rounds a fractional layout width (e.g. a CSS `width: fit-content` box sized to
// wrap its title on one line) to the nearest whole pixel. Reapplying that rounded value verbatim
// as the node's final `width` can round *down* just enough to push the title onto an extra line —
// changing its height after `layoutTree` already spaced siblings assuming the shorter, measured
// one. A couple of spare pixels keeps the applied width comfortably above that boundary.
const WIDTH_SAFETY_MARGIN = 2;

function defaultMeasure(el: HTMLElement): Size {
  return {
    width: el.offsetWidth === 0 ? DEFAULT_NODE_WIDTH : el.offsetWidth + WIDTH_SAFETY_MARGIN,
    height: el.offsetHeight === 0 ? DEFAULT_NODE_HEIGHT : el.offsetHeight,
  };
}

function createSvgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

/** One arrow marker definition, `id` and its arrowhead's class parameterized so the tree
 * (two-way-only) and extra-edge markers can be styled with different colours in CSS without
 * duplicating the marker geometry. */
function buildArrowMarker(id: string, arrowClass: string): SVGMarkerElement {
  const marker = createSvgEl('marker');
  marker.setAttribute('id', id);
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '8');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('orient', 'auto-start-reverse');
  const arrow = createSvgEl('path');
  arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  arrow.classList.add(arrowClass);
  marker.appendChild(arrow);
  return marker;
}

/** The `.bases-structure-node` ancestor of `target`, or `null` when `target` isn't inside one
 * (including when it isn't an `HTMLElement` at all, e.g. a text node or a `mouseout`'s
 * `relatedTarget` leaving the document entirely). */
function closestNode(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  return target.closest<HTMLElement>(NODE_SELECTOR);
}

function createToolbarButton(
  toolbarEl: HTMLElement,
  label: string,
  icon: string,
): HTMLButtonElement {
  const button = toolbarEl.createEl('button', {
    cls: 'bases-structure-toolbar-btn',
    attr: { type: 'button', 'aria-label': label },
  });
  setSizedIcon(button, icon);
  return button;
}

/** The toolbar is icon-only (see task 15's decisions): three buttons plus a muted zoom
 * percentage, all revealed on hover/focus by CSS alone. */
function buildToolbar(graphEl: HTMLElement): ToolbarElements {
  const toolbarEl = graphEl.createDiv('bases-structure-toolbar');
  const zoomOutBtn = createToolbarButton(toolbarEl, 'Zoom out', 'zoom-out');
  const zoomLabelEl = toolbarEl.createSpan({ cls: 'bases-structure-zoom-label', text: '100%' });
  const zoomInBtn = createToolbarButton(toolbarEl, 'Zoom in', 'zoom-in');
  const fitBtn = createToolbarButton(toolbarEl, 'Fit to view', 'scan');
  return { toolbarEl, zoomOutBtn, zoomLabelEl, zoomInBtn, fitBtn };
}

function buildCanvas(graphEl: HTMLElement): CanvasElements {
  const wrapEl = graphEl.createDiv('bases-structure-canvas-wrap');
  const canvasEl = wrapEl.createDiv('bases-structure-canvas');
  const svgEl = createSvgEl('svg');
  svgEl.classList.add('bases-structure-edges');
  const defsEl = createSvgEl('defs');
  defsEl.appendChild(buildArrowMarker(TREE_ARROW_MARKER_ID, 'bases-structure-arrowhead-tree'));
  defsEl.appendChild(buildArrowMarker(EXTRA_ARROW_MARKER_ID, 'bases-structure-arrowhead-extra'));
  svgEl.appendChild(defsEl);
  canvasEl.appendChild(svgEl);
  const nodesEl = canvasEl.createDiv('bases-structure-nodes');
  return { wrapEl, canvasEl, svgEl, defsEl, nodesEl };
}

/** Every node reachable from `forestTops` (the structure's tops plus its orphans, so both render
 * as top-level trees) without crossing into a collapsed node's children — the same rule
 * `layoutTree` applies internally, kept in lockstep here because DOM elements have to exist
 * *before* layout can measure them. A defensive `seen` guard mirrors the outline renderer's,
 * since nothing here re-verifies `structure`'s acyclic invariant. */
function collectVisibleEntries(
  structure: Structure,
  forestTops: readonly string[],
  collapsed: ReadonlySet<string>,
): VisibleEntry[] {
  const orphanSet = new Set(structure.orphans);
  const seen = new Set<string>();
  const entries: VisibleEntry[] = [];
  const visit = (path: string, isTop: boolean): void => {
    if (seen.has(path)) {
      return;
    }
    seen.add(path);
    const node = structure.nodes.get(path);
    if (node === undefined) {
      return;
    }
    entries.push({
      path,
      node,
      isRoot: path === structure.root,
      isOrphan: isTop && orphanSet.has(path),
    });
    if (collapsed.has(path)) {
      return;
    }
    for (const child of node.children) {
      visit(child, false);
    }
  };
  for (const top of forestTops) {
    visit(top, true);
  }
  return entries;
}

export class GraphRenderer implements StructureRenderer {
  private readonly container: HTMLElement;
  private readonly ctx: MutableNodeElementContext;
  private readonly measure: (el: HTMLElement) => Size;
  private readonly graphEl: HTMLElement;
  private readonly toolbarEl: HTMLElement;
  private readonly zoomOutBtn: HTMLButtonElement;
  private readonly zoomLabelEl: HTMLElement;
  private readonly zoomInBtn: HTMLButtonElement;
  private readonly fitBtn: HTMLButtonElement;
  private readonly emptyEl: HTMLElement;
  private readonly wrapEl: HTMLElement;
  private readonly canvasEl: HTMLElement;
  private readonly svgEl: SVGSVGElement;
  private readonly defsEl: SVGDefsElement;
  private readonly nodesEl: HTMLElement;
  private readonly disposeNodeInteractions: () => void;
  private state: ViewUiState | null = null;
  private lastInput: RenderInput | null = null;
  private lastLayoutSize: Size = { width: 0, height: 0 };
  // Gates the auto-fit computation to the graph's first successful (non-empty) layout — separate
  // from `state.zoomTouched`, which tracks the user's own intent and can outlive this renderer
  // instance (the same `ViewUiState` is reused across remounts via `getUiState`).
  private hasAutoFitted = false;
  private edgesByPath = new Map<string, SVGPathElement[]>();
  // Tracks the active path applied by the *previous* `update()` so a re-render triggered for an
  // unrelated reason (a collapse toggle elsewhere, a refresh from an action) doesn't re-focus or
  // re-scroll to the same node every time — only an actual change does (see `applyActiveState`).
  // `null` until the first `update()`, which seeds it from that render's own `state.active` (I9)
  // instead of leaving it `null` — `state.active` survives a view being torn down and recreated
  // (`getUiState` is keyed independent of any one renderer instance), so a fresh renderer's very
  // first render would otherwise see its own initial `null` as a "change" the moment `state.active`
  // is already non-null (e.g. the user had a node active before switching away and back), stealing
  // focus/scroll nobody asked for on that render.
  private lastActivePath: string | null = null;
  private hasRenderedOnce = false;

  constructor(container: HTMLElement, ctx: NodeElementContext, options: GraphRendererOptions = {}) {
    this.container = container;
    this.ctx = cloneNodeElementContext(ctx);
    this.measure = options.measure ?? defaultMeasure;

    this.graphEl = container.createDiv('bases-structure-graph');
    const toolbar = buildToolbar(this.graphEl);
    this.toolbarEl = toolbar.toolbarEl;
    this.zoomOutBtn = toolbar.zoomOutBtn;
    this.zoomLabelEl = toolbar.zoomLabelEl;
    this.zoomInBtn = toolbar.zoomInBtn;
    this.fitBtn = toolbar.fitBtn;
    this.emptyEl = this.graphEl.createDiv({
      cls: ['bases-structure-empty', 'is-hidden'],
      text: EMPTY_MESSAGE,
    });
    const canvas = buildCanvas(this.graphEl);
    this.wrapEl = canvas.wrapEl;
    this.canvasEl = canvas.canvasEl;
    this.svgEl = canvas.svgEl;
    this.defsEl = canvas.defsEl;
    this.nodesEl = canvas.nodesEl;

    this.disposeNodeInteractions = attachNodeInteractions(this.ctx, this.nodesEl);
    this.attachListeners();
  }

  private attachListeners(): void {
    this.nodesEl.addEventListener('click', this.handleNodesClick);
    this.nodesEl.addEventListener('mouseover', this.handleNodesMouseOver);
    this.nodesEl.addEventListener('mouseout', this.handleNodesMouseOut);
    this.zoomOutBtn.addEventListener('click', this.handleZoomOut);
    this.zoomInBtn.addEventListener('click', this.handleZoomIn);
    this.fitBtn.addEventListener('click', this.handleFit);
    this.graphEl.addEventListener('wheel', this.handleWheel, { passive: false });
    this.graphEl.addEventListener('scroll', this.handleScroll);
  }

  update(input: RenderInput): void {
    // Captured before anything below rebuilds `nodesEl`'s children (destroying whatever real DOM
    // focus was on): a full rebuild always replaces the active node's own element, even when its
    // `data-path` is unchanged (e.g. a collapse/expand `refresh()`) — without this, focus would
    // silently fall back to `document.body`, and the next real keydown would never reach the
    // container's delegated listener again (see `applyActiveState`).
    const hadFocus = this.nodesEl.contains(document.activeElement);
    if (!this.hasRenderedOnce) {
      this.lastActivePath = input.state.active;
      this.hasRenderedOnce = true;
    }
    this.lastInput = input;
    this.state = input.state;
    this.ctx.snapshot = input.snapshot;
    this.ctx.sourcePath = input.snapshot.host ?? '';

    const forestTops = [...input.structure.tops, ...input.structure.orphans];
    const entries = collectVisibleEntries(input.structure, forestTops, input.state.collapsed);
    if (entries.length === 0) {
      this.showEmpty();
      this.lastLayoutSize = { width: 0, height: 0 };
      return;
    }
    this.showContent();

    const elementsByPath = this.buildNodeElements(entries, input.state.collapsed, input.focusPath);
    const sizesByPath = this.measureAll(entries, elementsByPath);
    const layoutResult = layoutTree(
      {
        tops: forestTops,
        childrenOf: (path) => input.structure.nodes.get(path)?.children ?? [],
        sizeOf: (path) =>
          sizesByPath.get(path) ?? { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT },
        collapsed: input.state.collapsed,
      },
      DEFAULT_LAYOUT_OPTIONS,
    );

    this.positionNodes(entries, elementsByPath, layoutResult);
    this.applyCanvasSize(layoutResult);
    this.drawSvg(entries, layoutResult);
    this.lastLayoutSize = { width: layoutResult.width, height: layoutResult.height };
    this.applyAutoFit(input.state);
    this.applyZoom(input.state.zoom);
    this.graphEl.scrollLeft = input.state.scrollLeft;
    this.graphEl.scrollTop = input.state.scrollTop;
    this.applyActiveState(input.state.active, hadFocus);
  }

  /** Re-derives `.is-active`/roving tabindex from `state.active` on every render (task 16) — the
   * node elements themselves are rebuilt wholesale above, so nothing here can just persist a
   * class from before. Moves real focus/scroll when `active` actually changed since the last
   * render (tracked via `lastActivePath`) *or* when focus was already inside the graph before
   * this render (`hadFocus`, captured in `update()` before the rebuild) — the latter is what keeps
   * a collapse/expand refresh (same active path, but every node element replaced) from silently
   * dropping real focus to `document.body`. Without `hadFocus`, an unrelated re-render (e.g. a
   * create commit while the user's focus is on some other element entirely, like a draft input)
   * still won't steal focus back, since `hadFocus` is only true when focus genuinely was here. */
  private applyActiveState(active: string | null, hadFocus: boolean): void {
    const activeEl = applyActiveNode(this.nodesEl, active);
    if (activeEl !== null && (hadFocus || active !== this.lastActivePath)) {
      focusActiveNode(activeEl);
    }
    this.lastActivePath = active;
  }

  getNodeElement(path: string): HTMLElement | null {
    return findNodeElement(this.nodesEl, path);
  }

  destroy(): void {
    this.disposeNodeInteractions();
    this.nodesEl.removeEventListener('click', this.handleNodesClick);
    this.nodesEl.removeEventListener('mouseover', this.handleNodesMouseOver);
    this.nodesEl.removeEventListener('mouseout', this.handleNodesMouseOut);
    this.zoomOutBtn.removeEventListener('click', this.handleZoomOut);
    this.zoomInBtn.removeEventListener('click', this.handleZoomIn);
    this.fitBtn.removeEventListener('click', this.handleFit);
    this.graphEl.removeEventListener('wheel', this.handleWheel);
    this.graphEl.removeEventListener('scroll', this.handleScroll);
    this.container.empty();
  }

  private buildNodeElements(
    entries: readonly VisibleEntry[],
    collapsed: ReadonlySet<string>,
    focusPath: string | undefined,
  ): Map<string, HTMLElement> {
    this.nodesEl.empty();
    const elements = new Map<string, HTMLElement>();
    for (const entry of entries) {
      const el = createNodeElement(this.ctx, entry.node, {
        isRoot: entry.isRoot,
        isOrphan: entry.isOrphan,
      });
      if (entry.node.children.length > 0) {
        this.addToggle(el, collapsed.has(entry.path));
      }
      if (entry.path === focusPath) {
        el.classList.add('is-new');
      }
      this.nodesEl.appendChild(el);
      elements.set(entry.path, el);
    }
    return elements;
  }

  private addToggle(el: HTMLElement, collapsed: boolean): void {
    const toggle = createEl('button', {
      cls: 'bases-structure-toggle',
      attr: {
        type: 'button',
        'aria-expanded': String(!collapsed),
        'aria-label': 'Toggle children',
      },
    });
    setSizedIcon(toggle, collapsed ? 'chevron-right' : 'chevron-down');
    el.prepend(toggle);
  }

  private measureAll(
    entries: readonly VisibleEntry[],
    elementsByPath: ReadonlyMap<string, HTMLElement>,
  ): Map<string, Size> {
    const sizes = new Map<string, Size>();
    for (const entry of entries) {
      const el = elementsByPath.get(entry.path);
      if (el === undefined) {
        continue;
      }
      sizes.set(entry.path, this.measure(el));
    }
    return sizes;
  }

  private positionNodes(
    entries: readonly VisibleEntry[],
    elementsByPath: ReadonlyMap<string, HTMLElement>,
    layoutResult: LayoutResult,
  ): void {
    for (const entry of entries) {
      const box = layoutResult.boxes.get(entry.path);
      const el = elementsByPath.get(entry.path);
      if (box === undefined || el === undefined) {
        continue;
      }
      // Added once the box is known, not before: an unsized node that is already positioned at
      // *measurement* time collapses to a shrink-to-fit width (see `styles.css`), so this class
      // (which is what actually applies `position: absolute`) is only added here, after
      // `measureAll` has already run.
      el.classList.add('is-positioned');
      el.style.left = `${box.x}px`;
      el.style.top = `${box.y}px`;
      el.style.width = `${box.width}px`;
    }
  }

  private applyCanvasSize(layoutResult: LayoutResult): void {
    this.canvasEl.style.width = `${layoutResult.width}px`;
    this.canvasEl.style.height = `${layoutResult.height}px`;
    this.svgEl.setAttribute('width', String(layoutResult.width));
    this.svgEl.setAttribute('height', String(layoutResult.height));
  }

  /** Group frames are a layout-only concept now (`layoutTree` still computes them so spacing
   * doesn't change) — nothing here draws `layoutResult.groups`. */
  private drawSvg(entries: readonly VisibleEntry[], layoutResult: LayoutResult): void {
    for (const child of Array.from(this.svgEl.children)) {
      if (child !== this.defsEl) {
        child.remove();
      }
    }
    this.edgesByPath = new Map();
    this.drawTreeEdges(entries, layoutResult);
    this.drawExtraEdges(entries, layoutResult);
  }

  private drawTreeEdges(entries: readonly VisibleEntry[], layoutResult: LayoutResult): void {
    for (const entry of entries) {
      if (entry.node.parent === null) {
        continue;
      }
      const fromBox = layoutResult.boxes.get(entry.node.parent);
      const toBox = layoutResult.boxes.get(entry.path);
      if (fromBox === undefined || toBox === undefined) {
        continue;
      }
      const path = createSvgEl('path');
      path.classList.add('bases-structure-edge');
      path.setAttribute('d', edgePath(fromBox, toBox));
      if (entry.node.twoWay) {
        path.classList.add('is-two-way');
        path.setAttribute('marker-start', TREE_ARROW_MARKER_URL);
        path.setAttribute('marker-end', TREE_ARROW_MARKER_URL);
      }
      this.svgEl.appendChild(path);
      this.registerEdge(path, entry.node.parent, entry.path);
    }
  }

  private drawExtraEdges(entries: readonly VisibleEntry[], layoutResult: LayoutResult): void {
    for (const entry of entries) {
      for (const extra of entry.node.extras) {
        this.drawExtraEdge(extra, entry.path, layoutResult);
      }
    }
  }

  private drawExtraEdge(extra: ExtraLink, childPath: string, layoutResult: LayoutResult): void {
    const fromBox = layoutResult.boxes.get(extra.parent);
    const toBox = layoutResult.boxes.get(childPath);
    if (fromBox === undefined || toBox === undefined) {
      return;
    }
    const path = createSvgEl('path');
    path.classList.add('bases-structure-edge', 'is-extra');
    path.setAttribute('d', edgePath(fromBox, toBox));
    path.setAttribute('marker-end', EXTRA_ARROW_MARKER_URL);
    this.svgEl.appendChild(path);
    this.registerEdge(path, extra.parent, childPath);
  }

  /** Indexes `edgeEl` under both endpoints it connects, so a hover on either one can raise its
   * opacity (see `handleNodesMouseOver`/`handleNodesMouseOut`). */
  private registerEdge(edgeEl: SVGPathElement, pathA: string, pathB: string): void {
    this.addEdgeRef(pathA, edgeEl);
    this.addEdgeRef(pathB, edgeEl);
  }

  private addEdgeRef(path: string, edgeEl: SVGPathElement): void {
    const existing = this.edgesByPath.get(path);
    if (existing === undefined) {
      this.edgesByPath.set(path, [edgeEl]);
    } else {
      existing.push(edgeEl);
    }
  }

  private setEdgesActive(path: string, active: boolean): void {
    const edges = this.edgesByPath.get(path);
    if (edges === undefined) {
      return;
    }
    for (const edge of edges) {
      edge.classList.toggle('is-edge-active', active);
    }
  }

  private showEmpty(): void {
    this.emptyEl.removeClass('is-hidden');
    this.toolbarEl.addClass('is-hidden');
    // Hides `wrapEl` (M6), not `canvasEl` directly — `canvasEl` now sits inside `wrapEl`, so
    // hiding the wrapper hides it too, and — since `wrapEl` is what's sized to the last zoomed
    // layout (see `applyZoom`) — also avoids leaving a stale, non-empty scroll area behind for
    // the graph's own `overflow: auto` to still report while nothing is actually shown.
    this.wrapEl.addClass('is-hidden');
    this.nodesEl.empty();
  }

  private showContent(): void {
    this.emptyEl.addClass('is-hidden');
    this.toolbarEl.removeClass('is-hidden');
    this.wrapEl.removeClass('is-hidden');
  }

  private currentZoom(): number {
    return this.state?.zoom ?? 1;
  }

  private setZoom(value: number): void {
    if (this.state === null) {
      return;
    }
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
    this.state.zoom = clamped;
    this.state.zoomTouched = true;
    this.applyZoom(clamped);
  }

  /** `canvasEl` itself is only ever visually scaled (`transform` doesn't change an element's own
   * layout/scroll size) — `wrapEl`, sized here to `lastLayoutSize × zoom`, is what actually
   * determines how much the graph's `overflow: auto` container can scroll (M6). Called both from
   * `update()` (after `lastLayoutSize` is freshly set for this render) and from every zoom
   * handler (`setZoom`, wheel, fit), which only change `zoom` itself — `lastLayoutSize` is already
   * current in that case too, so re-reading it here (rather than taking it as a parameter) keeps
   * every caller's job to just "apply this zoom level," without each having to know or re-pass the
   * layout size along too. */
  private applyZoom(zoom: number): void {
    this.canvasEl.style.transform = `scale(${zoom})`;
    this.zoomLabelEl.textContent = `${Math.round(zoom * 100)}%`;
    this.wrapEl.style.width = `${this.lastLayoutSize.width * zoom}px`;
    this.wrapEl.style.height = `${this.lastLayoutSize.height * zoom}px`;
  }

  /** Fits the whole graph into the viewport exactly once, the first time a layout with content
   * succeeds while the user hasn't zoomed by hand — an embed opens showing the full tree instead
   * of a corner of it. Mutates `state.zoom` directly (not through `setZoom`) so this never marks
   * the zoom as user-touched. Only latches `hasAutoFitted` once the container actually has a
   * measured size — an embed whose first render lands before the surrounding layout settles
   * (`clientWidth`/`clientHeight` still 0) would otherwise fit against a bogus 0×0 box, lock in
   * that no-op "fit", and never get another chance once the container is really laid out. */
  private applyAutoFit(state: ViewUiState): void {
    if (state.zoomTouched || this.hasAutoFitted) {
      return;
    }
    if (this.graphEl.clientWidth === 0 || this.graphEl.clientHeight === 0) {
      return;
    }
    this.hasAutoFitted = true;
    state.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.computeFitZoom()));
  }

  private computeFitZoom(): number {
    const containerWidth = this.graphEl.clientWidth;
    const containerHeight = this.graphEl.clientHeight;
    const { width, height } = this.lastLayoutSize;
    if (containerWidth === 0 || containerHeight === 0 || width === 0 || height === 0) {
      return 1;
    }
    return Math.min(1, containerWidth / width, containerHeight / height);
  }

  private readonly handleNodesClick = (event: MouseEvent): void => {
    if (!(event.target instanceof HTMLElement) || this.lastInput === null) {
      return;
    }
    const toggle = event.target.closest<HTMLElement>('.bases-structure-toggle');
    if (toggle === null) {
      return;
    }
    const nodeEl = toggle.closest<HTMLElement>(NODE_SELECTOR);
    const path = nodeEl?.getAttribute('data-path');
    if (path === null || path === undefined) {
      return;
    }
    const { collapsed } = this.lastInput.state;
    if (collapsed.has(path)) {
      collapsed.delete(path);
    } else {
      collapsed.add(path);
    }
    this.update(this.lastInput);
  };

  /** Delegated hover pair that raises/lowers `.is-edge-active` on a node's own edges — paired
   * `mouseover`/`mouseout` (not a single toggle) because leaving one child element of a node for
   * another still fires both, so `closestNode` on `relatedTarget` is what actually filters out
   * moves that stay inside the same node. */
  private readonly handleNodesMouseOver = (event: MouseEvent): void => {
    this.handleNodeHoverChange(event, true);
  };

  private readonly handleNodesMouseOut = (event: MouseEvent): void => {
    this.handleNodeHoverChange(event, false);
  };

  private handleNodeHoverChange(event: MouseEvent, active: boolean): void {
    const nodeEl = closestNode(event.target);
    if (nodeEl === null || closestNode(event.relatedTarget) === nodeEl) {
      return;
    }
    const path = nodeEl.getAttribute('data-path');
    if (path === null) {
      return;
    }
    this.setEdgesActive(path, active);
  }

  private readonly handleZoomOut = (): void => {
    this.setZoom(this.currentZoom() - ZOOM_STEP);
  };

  private readonly handleZoomIn = (): void => {
    this.setZoom(this.currentZoom() + ZOOM_STEP);
  };

  private readonly handleFit = (): void => {
    this.setZoom(this.computeFitZoom());
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }
    event.preventDefault();
    this.setZoom(this.currentZoom() - event.deltaY * WHEEL_ZOOM_FACTOR);
  };

  private readonly handleScroll = (): void => {
    if (this.state === null) {
      return;
    }
    this.state.scrollLeft = this.graphEl.scrollLeft;
    this.state.scrollTop = this.graphEl.scrollTop;
  };
}
