// The default renderer: a left-to-right tidy tree, nodes as HTML (positioned absolutely from
// `layoutTree`), edges as SVG (cubic beziers with arrowheads, dashed for extras), lightweight
// frames around depth-1 branches that have children, a zoom/fit toolbar and collapse toggles.
// The DOM is built once in the constructor and reused across `update()` calls; only the nodes
// layer and the SVG's dynamic content (everything after `<defs>`) are rebuilt each time.

import { setIcon } from 'obsidian';
import type { LayoutGroup, LayoutResult, Size } from '../core/layout.js';
import { DEFAULT_LAYOUT_OPTIONS, layoutTree } from '../core/layout.js';
import type { ExtraLink, Structure, StructureNode } from '../core/structure.js';
import { edgePath } from './edges.js';
import type { MutableNodeElementContext, NodeElementContext } from './node-element.js';
import {
  attachNodeInteractions,
  cloneNodeElementContext,
  createNodeElement,
  findNodeElement,
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

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARROW_MARKER_ID = 'bases-structure-arrow';
const ARROW_MARKER_URL = `url(#${ARROW_MARKER_ID})`;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
const WHEEL_ZOOM_FACTOR = 0.002;
const DEFAULT_NODE_WIDTH = 180;
const DEFAULT_NODE_HEIGHT = 32;
const EMPTY_MESSAGE = 'Nothing to show yet';
const ZOOM_OUT_LABEL = '−';
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

function buildArrowMarker(): SVGMarkerElement {
  const marker = createSvgEl('marker');
  marker.setAttribute('id', ARROW_MARKER_ID);
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '8');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('orient', 'auto-start-reverse');
  const arrow = createSvgEl('path');
  arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  arrow.classList.add('bases-structure-arrowhead');
  marker.appendChild(arrow);
  return marker;
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
  private readonly canvasEl: HTMLElement;
  private readonly svgEl: SVGSVGElement;
  private readonly defsEl: SVGDefsElement;
  private readonly nodesEl: HTMLElement;
  private readonly disposeNodeInteractions: () => void;
  private state: ViewUiState | null = null;
  private lastInput: RenderInput | null = null;
  private lastLayoutSize: Size = { width: 0, height: 0 };

  constructor(container: HTMLElement, ctx: NodeElementContext, options: GraphRendererOptions = {}) {
    this.container = container;
    this.ctx = cloneNodeElementContext(ctx);
    this.measure = options.measure ?? defaultMeasure;

    this.graphEl = container.createDiv('bases-structure-graph');
    this.toolbarEl = this.graphEl.createDiv('bases-structure-toolbar');
    this.zoomOutBtn = this.toolbarEl.createEl('button', {
      cls: 'bases-structure-toolbar-btn',
      text: ZOOM_OUT_LABEL,
      attr: { type: 'button', 'aria-label': 'Zoom out' },
    });
    this.zoomLabelEl = this.toolbarEl.createSpan({
      cls: 'bases-structure-zoom-label',
      text: '100%',
    });
    this.zoomInBtn = this.toolbarEl.createEl('button', {
      cls: 'bases-structure-toolbar-btn',
      text: '+',
      attr: { type: 'button', 'aria-label': 'Zoom in' },
    });
    this.fitBtn = this.toolbarEl.createEl('button', {
      cls: 'bases-structure-toolbar-btn',
      text: 'Fit',
      attr: { type: 'button', 'aria-label': 'Fit to view' },
    });
    this.emptyEl = this.graphEl.createDiv({
      cls: ['bases-structure-empty', 'is-hidden'],
      text: EMPTY_MESSAGE,
    });
    this.canvasEl = this.graphEl.createDiv('bases-structure-canvas');
    this.svgEl = createSvgEl('svg');
    this.svgEl.classList.add('bases-structure-edges');
    this.defsEl = createSvgEl('defs');
    this.defsEl.appendChild(buildArrowMarker());
    this.svgEl.appendChild(this.defsEl);
    this.canvasEl.appendChild(this.svgEl);
    this.nodesEl = this.canvasEl.createDiv('bases-structure-nodes');

    this.disposeNodeInteractions = attachNodeInteractions(this.ctx, this.nodesEl);
    this.nodesEl.addEventListener('click', this.handleNodesClick);
    this.zoomOutBtn.addEventListener('click', this.handleZoomOut);
    this.zoomInBtn.addEventListener('click', this.handleZoomIn);
    this.fitBtn.addEventListener('click', this.handleFit);
    this.graphEl.addEventListener('wheel', this.handleWheel, { passive: false });
    this.graphEl.addEventListener('scroll', this.handleScroll);
  }

  update(input: RenderInput): void {
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
    this.applyZoom(input.state.zoom);
    this.graphEl.scrollLeft = input.state.scrollLeft;
    this.graphEl.scrollTop = input.state.scrollTop;
  }

  getNodeElement(path: string): HTMLElement | null {
    return findNodeElement(this.nodesEl, path);
  }

  destroy(): void {
    this.disposeNodeInteractions();
    this.nodesEl.removeEventListener('click', this.handleNodesClick);
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
    setIcon(toggle, collapsed ? 'chevron-right' : 'chevron-down');
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

  private drawSvg(entries: readonly VisibleEntry[], layoutResult: LayoutResult): void {
    for (const child of Array.from(this.svgEl.children)) {
      if (child !== this.defsEl) {
        child.remove();
      }
    }
    this.drawGroups(layoutResult.groups);
    this.drawTreeEdges(entries, layoutResult);
    this.drawExtraEdges(entries, layoutResult);
  }

  private drawGroups(groups: readonly LayoutGroup[]): void {
    for (const group of groups) {
      const rect = createSvgEl('rect');
      rect.classList.add('bases-structure-group');
      rect.setAttribute('x', String(group.box.x));
      rect.setAttribute('y', String(group.box.y));
      rect.setAttribute('width', String(group.box.width));
      rect.setAttribute('height', String(group.box.height));
      this.svgEl.appendChild(rect);
    }
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
      path.setAttribute('marker-end', ARROW_MARKER_URL);
      if (entry.node.twoWay) {
        path.setAttribute('marker-start', ARROW_MARKER_URL);
      }
      this.svgEl.appendChild(path);
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
    path.setAttribute('marker-end', ARROW_MARKER_URL);
    this.svgEl.appendChild(path);
  }

  private showEmpty(): void {
    this.emptyEl.removeClass('is-hidden');
    this.toolbarEl.addClass('is-hidden');
    this.canvasEl.addClass('is-hidden');
    this.nodesEl.empty();
  }

  private showContent(): void {
    this.emptyEl.addClass('is-hidden');
    this.toolbarEl.removeClass('is-hidden');
    this.canvasEl.removeClass('is-hidden');
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
    this.applyZoom(clamped);
  }

  private applyZoom(zoom: number): void {
    this.canvasEl.style.transform = `scale(${zoom})`;
    this.zoomLabelEl.textContent = `${Math.round(zoom * 100)}%`;
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
    const nodeEl = toggle.closest<HTMLElement>('.bases-structure-node');
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
