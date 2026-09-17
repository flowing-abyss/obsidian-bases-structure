// The default renderer: a left-to-right tidy tree, nodes as HTML (positioned absolutely from
// `layoutTree`), edges as SVG (cubic beziers between node borders — no group frames, no arrows on
// a plain tree edge, direction is implied by the left-to-right layout), a zoom/fit toolbar and
// collapse toggles.
// The DOM is built once in the constructor and reused across `update()` calls; only the nodes
// layer and the SVG's dynamic content (everything after `<defs>`) are rebuilt each time.

import type { Box, LayoutOptions, LayoutResult, Size } from '../core/layout.js';
import {
  DEFAULT_LAYOUT_OPTIONS,
  DEFAULT_VERTICAL_LAYOUT_OPTIONS,
  layoutTree,
  layoutTreeVertical,
} from '../core/layout.js';
import type { Direction, Schema } from '../core/schema.js';
import type { ExtraLink, Structure, StructureNode } from '../core/structure.js';
import {
  hookSuperchargedLinks,
  unhookSuperchargedLinks,
  type SuperchargedWatch,
} from '../obsidian/supercharged-links.js';
import type { EdgeLabelChild } from './edges.js';
import { edgeAnchors, edgePath, planEdgeLabels } from './edges.js';
import { setSizedIcon } from './icon.js';
import type { MutableNodeElementContext, NodeElementContext } from './node-element.js';
import {
  applyActiveNode,
  attachNodeInteractions,
  cloneNodeElementContext,
  collectTitleElements,
  createNodeElement,
  findNodeElement,
  focusActiveNode,
} from './node-element.js';
import { attachPan } from './pan.js';
import type { RenderInput, StructureRenderer } from './structure-view.js';
import type { ViewUiState } from './view-state.js';

export interface GraphRendererOptions {
  readonly measure?: (el: HTMLElement) => Size;
  /** D1: this plugin's own `manifest.id`, namespacing the Supercharged Links watch key so two
   * installed copies of this plugin never disconnect each other's observers — see
   * `SuperchargedWatch`'s own doc comment. Omitted in tests that don't care. */
  readonly ownerId?: string;
}

interface VisibleEntry {
  readonly path: string;
  readonly node: StructureNode;
  readonly isRoot: boolean;
  readonly isOrphan: boolean;
}

/** D2: one edge label about to be drawn — `parent`/`childPath` anchor it to the tree edge between
 * those two boxes once `layoutResult` is known; `text` is the run's type name. */
interface PlacedLabel {
  readonly parent: string;
  readonly childPath: string;
  readonly text: string;
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
  readonly labelsEl: HTMLElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_SELECTOR = '.bases-structure-node';
// M7: what a background pan (`pan.ts`) must never start on — every node (which has its own
// click/drag), the toolbar's zoom/fit controls, and the same interactive elements `drag.ts`
// itself already excludes a node-drag from starting on.
const PAN_IGNORE_SELECTOR =
  '.bases-structure-node, .bases-structure-toolbar, [data-action], .bases-structure-toggle, .bases-structure-draft, input, button';
const TREE_ARROW_MARKER_ID = 'bases-structure-arrow-tree';
const TREE_ARROW_MARKER_URL = `url(#${TREE_ARROW_MARKER_ID})`;
const EXTRA_ARROW_MARKER_ID = 'bases-structure-arrow-extra';
const EXTRA_ARROW_MARKER_URL = `url(#${EXTRA_ARROW_MARKER_ID})`;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2;
// A floor for *auto*-fit only (`applyAutoFit`) — below this, node text renders too small to read
// (a wide graph in a narrow embed was measured auto-fitting to 66%, ~8.6px text). The manual "Fit
// to view" button (`handleFit`) intentionally keeps going down to `ZOOM_MIN`: a user who clicks it
// is choosing to see the whole tree even if that means squinting, but a graph nobody asked to zoom
// should never open unreadable. When even 0.85 doesn't fit the container, the graph simply
// overflows into the scroll area instead of shrinking further.
const AUTO_FIT_MIN_ZOOM = 0.85;
const ZOOM_STEP = 0.1;
const WHEEL_ZOOM_FACTOR = 0.002;
const DEFAULT_NODE_WIDTH = 180;
const DEFAULT_NODE_HEIGHT = 32;
const EMPTY_MESSAGE = 'Nothing to show yet';
// `offsetWidth` rounds a fractional intrinsic width (a CSS `width: max-content` box) to the
// nearest whole pixel. `positionNodes` no longer pins a node to this measurement (D1 follow-up —
// see its own doc comment), but `layoutTree`/`layoutTreeVertical` still size columns and space
// siblings/edges from it; a couple of spare pixels keeps a column comfortably wider than the exact
// rounded measurement, so the node's own (unpinned) rendered width has a little slack before it
// would visually crowd the next column.
const WIDTH_SAFETY_MARGIN = 2;
// D2: how much wider the depth gap gets when edge labels are on, beyond the widest/tallest
// measured label — a little clearance so a label's own background never touches the next
// column's node border. Only added when there is at least one label to draw; with labels off (or
// an untyped schema producing zero labels), the layout is byte-for-byte what it was before D2.
const LABEL_GAP_RIGHT_MARGIN = 16;
const LABEL_GAP_DOWN_MARGIN = 8;
// D1: every `GraphRenderer` instance gets its own Supercharged Links watch id — two embeds of
// this view open at once (same plugin, same `ownerId`) would otherwise share a bare id and
// disconnect each other's observer the moment the second one mounts (`hookSuperchargedLinks`
// always unhooks its own key first). Module-scoped, not per-instance: it only has to keep handing
// out fresh values for as long as the plugin is loaded.
let nextGraphWatchSeq = 0;

function defaultMeasure(el: HTMLElement): Size {
  return {
    width: el.offsetWidth === 0 ? DEFAULT_NODE_WIDTH : el.offsetWidth + WIDTH_SAFETY_MARGIN,
    height: el.offsetHeight === 0 ? DEFAULT_NODE_HEIGHT : el.offsetHeight,
  };
}

/** `center` (a layout-space coordinate) scaled to viewport pixels, then offset so it lands in the
 * middle of a `viewportSize`-wide/tall scroll area — clamped to 0 (the browser clamps the max). */
function centeredScroll(center: number, zoom: number, viewportSize: number): number {
  return Math.max(0, center * zoom - viewportSize / 2);
}

// M3: takes `doc` explicitly (the container's own owner document — a pop-out window's, when the
// view is open in one) rather than reaching for the global `document.createElementNS` — an
// `appendChild` further up the tree would eventually *adopt* a wrong-document node into the right
// one anyway, but building it in the right document from the start needs no such rescue.
function createSvgEl<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
): SVGElementTagNameMap[K] {
  return doc.createElementNS(SVG_NS, tag);
}

/** One arrow marker definition, `id` and its arrowhead's class parameterized so the tree
 * (two-way-only) and extra-edge markers can be styled with different colours in CSS without
 * duplicating the marker geometry. */
function buildArrowMarker(doc: Document, id: string, arrowClass: string): SVGMarkerElement {
  const marker = createSvgEl(doc, 'marker');
  marker.setAttribute('id', id);
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '8');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('orient', 'auto-start-reverse');
  const arrow = createSvgEl(doc, 'path');
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
  const doc = graphEl.doc;
  const wrapEl = graphEl.createDiv('bases-structure-canvas-wrap');
  const canvasEl = wrapEl.createDiv('bases-structure-canvas');
  const svgEl = createSvgEl(doc, 'svg');
  svgEl.classList.add('bases-structure-edges');
  const defsEl = createSvgEl(doc, 'defs');
  defsEl.appendChild(buildArrowMarker(doc, TREE_ARROW_MARKER_ID, 'bases-structure-arrowhead-tree'));
  defsEl.appendChild(
    buildArrowMarker(doc, EXTRA_ARROW_MARKER_ID, 'bases-structure-arrowhead-extra'),
  );
  svgEl.appendChild(defsEl);
  canvasEl.appendChild(svgEl);
  const nodesEl = canvasEl.createDiv('bases-structure-nodes');
  // D2: on top of the nodes so a label's own opaque background reads as a caption sitting on the
  // line beneath it, not the other way around — labels never overlap node boxes (the layout gap
  // widening keeps them apart), so paint order between the two never actually matters visually.
  const labelsEl = canvasEl.createDiv('bases-structure-edge-labels');
  return { wrapEl, canvasEl, svgEl, defsEl, nodesEl, labelsEl };
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

/** D2: a parent's children, narrowed to `EdgeLabelChild`s for `planEdgeLabels` — a two-way child
 * (its own edge back to this parent, not the run's type) never hosts a label, so it's dropped
 * from the list entirely rather than merely skipped as a possible "middle": consecutive same-type
 * siblings on either side of it still count as one run. A child with no resolved `StructureNode`
 * (not expected in practice — every path in `node.children` has one) is dropped the same way. */
function visibleChildTypes(children: readonly string[], structure: Structure): EdgeLabelChild[] {
  const result: EdgeLabelChild[] = [];
  for (const path of children) {
    const node = structure.nodes.get(path);
    if (node === undefined || node.twoWay) {
      continue;
    }
    result.push({ path, type: node.type });
  }
  return result;
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
  private readonly labelsEl: HTMLElement;
  private readonly disposeNodeInteractions: () => void;
  private readonly disposePan: () => void;
  private readonly slWatch: SuperchargedWatch;
  private state: ViewUiState | null = null;
  private lastInput: RenderInput | null = null;
  private lastLayoutSize: Size = { width: 0, height: 0 };
  // The direction of the layout just drawn (U3) — read by `computeFitZoom` (fit follows the
  // growth axis) and `applyAutoFit` (a direction switch gets its own re-fit chance, see
  // `lastAutoFitDirection`) from button/wheel handlers that don't receive `RenderInput` directly.
  private lastDirection: Direction = 'right';
  // Gates the auto-fit computation to the graph's first successful (non-empty) layout *for the
  // current direction* — separate from `state.zoomTouched`, which tracks the user's own intent
  // and can outlive this renderer instance (the same `ViewUiState` is reused across remounts via
  // `getUiState`). `null` (never fitted yet) can't equal either real `Direction`, so this alone —
  // without a separate boolean — also covers the first render.
  private lastAutoFitDirection: Direction | null = null;
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
    this.labelsEl = canvas.labelsEl;

    this.disposeNodeInteractions = attachNodeInteractions(this.ctx, this.nodesEl);
    // M7: pan by dragging the background — the graph itself (`this.graphEl`) is what actually
    // scrolls (`overflow: auto`), so that's what owns `scrollLeft`/`scrollTop` for `attachPan` to
    // read/write, same element `handleScroll` below already reads them from.
    this.disposePan = attachPan({ container: this.graphEl, ignoreSelector: PAN_IGNORE_SELECTOR });
    this.attachListeners();

    nextGraphWatchSeq += 1;
    this.slWatch = { ownerId: options.ownerId, id: `bases-structure-graph-${nextGraphWatchSeq}` };
    this.watchSuperchargedLinks();
  }

  /** D1: watched exactly once, here at construction, against `nodesEl` — a container that stays
   * the same DOM node across every `update()` (only its children are torn down/rebuilt), so
   * Supercharged Links' own `MutationObserver` keeps seeing every later re-render without this
   * ever having to re-hook. An unexpected shape of the other plugin (see
   * `supercharged-links.ts`'s own doc comment) is caught and logged here, never left to break
   * renderer construction. */
  private watchSuperchargedLinks(): void {
    try {
      hookSuperchargedLinks(
        this.ctx.app,
        this.slWatch,
        this.nodesEl,
        'a.bases-structure-title',
        'bases-structure-node',
      );
    } catch (error) {
      console.error('[bases-structure]', error);
    }
  }

  /** The `destroy()` half of `watchSuperchargedLinks` — same failure containment, so an
   * unexpected shape never stops the rest of `destroy()`'s own cleanup (listeners, `container`
   * teardown) from running. */
  private unwatchSuperchargedLinks(): void {
    try {
      unhookSuperchargedLinks(this.ctx.app, this.slWatch);
    } catch (error) {
      console.error('[bases-structure]', error);
    }
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
    // M3: `this.container.doc` (its own owner document — a pop-out window's, when the view is
    // open in one), not the global `document`, which would never match focus genuinely inside a
    // pop-out and so never re-focus a rebuilt node there.
    const hadFocus = this.nodesEl.contains(this.container.doc.activeElement);
    if (!this.hasRenderedOnce) {
      this.lastActivePath = input.state.active;
      this.hasRenderedOnce = true;
    }
    this.lastInput = input;
    this.state = input.state;
    this.lastDirection = input.schema.direction;
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

    const direction = this.lastDirection;
    const { elementsByPath, labels, labelElementsByChild, layoutResult } = this.computeLayout(
      entries,
      input,
      forestTops,
      direction,
    );

    this.positionNodes(entries, elementsByPath, layoutResult);
    this.applyCanvasSize(layoutResult);
    this.drawSvg(entries, layoutResult, direction);
    this.positionLabels(labels, labelElementsByChild, layoutResult, direction);
    this.lastLayoutSize = { width: layoutResult.width, height: layoutResult.height };
    this.applyAutoFit(input.state, layoutResult.boxes.get(forestTops[0] ?? ''));
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
    this.unwatchSuperchargedLinks();
    this.disposeNodeInteractions();
    this.disposePan();
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
    // D1 follow-up: snapshotted *before* `empty()` below destroys them — see
    // `carryOverSuperchargedLinkState`'s own doc comment for why a rebuilt node needs its
    // predecessor's title element at all.
    const previousTitles = collectTitleElements(this.nodesEl);
    this.nodesEl.empty();
    const elements = new Map<string, HTMLElement>();
    for (const entry of entries) {
      const previousTitle = previousTitles.get(entry.path);
      const el = createNodeElement(this.ctx, entry.node, {
        isRoot: entry.isRoot,
        isOrphan: entry.isOrphan,
        ...(previousTitle !== undefined ? { previousTitle } : {}),
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

  /** The whole "build DOM, measure it, lay it out" pipeline for one `update()` — node elements,
   * their sizes, D2's edge-label placements/elements/gap-widened options, and the resulting
   * `layoutTree`/`layoutTreeVertical` call, all in one place so `update()` itself only has to
   * sequence the *drawing* steps that come after (`positionNodes`, `drawSvg`, `positionLabels`, …)
   * — kept a separate method purely to stay inside this project's `max-statements` budget. */
  private computeLayout(
    entries: readonly VisibleEntry[],
    input: RenderInput,
    forestTops: readonly string[],
    direction: Direction,
  ): {
    elementsByPath: Map<string, HTMLElement>;
    labels: PlacedLabel[];
    labelElementsByChild: Map<string, HTMLElement>;
    layoutResult: LayoutResult;
  } {
    const elementsByPath = this.buildNodeElements(entries, input.state.collapsed, input.focusPath);
    const sizesByPath = this.measureAll(entries, elementsByPath);
    const labels = this.planLabels(entries, input.structure, input.state.collapsed, input.schema);
    const labelElementsByChild = this.buildLabelElements(labels);
    const layoutOptions = this.resolveLayoutOptions(direction, labelElementsByChild);
    const layoutInput = {
      tops: forestTops,
      childrenOf: (path: string) => input.structure.nodes.get(path)?.children ?? [],
      sizeOf: (path: string) =>
        sizesByPath.get(path) ?? { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT },
      collapsed: input.state.collapsed,
    };
    const layoutResult =
      direction === 'down'
        ? layoutTreeVertical(layoutInput, layoutOptions)
        : layoutTree(layoutInput, layoutOptions);
    return { elementsByPath, labels, labelElementsByChild, layoutResult };
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
      // No inline `width` (D1 follow-up, "keep Supercharged Links icons on the title line"):
      // since 0b0d1df, `.bases-structure-node` is `width: max-content` capped by `max-width` —
      // sized from its own content, not from `left`/`top`'s containing block — so pinning it to
      // *this* measurement bought nothing except forcing a re-wrap the moment the node's real
      // content grew after that measurement (Supercharged Links adds attributes for non-scalar
      // frontmatter, e.g. `data-link-tags`, asynchronously via its own observer, *after*
      // `measureAll` already ran; the `::after` icon that attribute's CSS adds then had nowhere to
      // go but a second line, inside a box already pinned narrower). `box.width` still positions
      // every column/edge/label exactly as before; only the node's own rendered width is no
      // longer force-pinned to whatever it happened to measure as.
    }
  }

  /** D2: one `PlacedLabel` per run of consecutive same-type visible children under each visible,
   * non-collapsed parent — `null` when `schema.edgeLabels` is off, matching the outline's own
   * "ignores it entirely" (the outline never calls this at all). A collapsed parent's children
   * aren't in `entries` at all (see `collectVisibleEntries`), so its own `node.children` are
   * skipped here too, the same way `layoutTree` already skips laying them out. */
  private planLabels(
    entries: readonly VisibleEntry[],
    structure: Structure,
    collapsed: ReadonlySet<string>,
    schema: Schema,
  ): PlacedLabel[] {
    if (!schema.edgeLabels) {
      return [];
    }
    const labels: PlacedLabel[] = [];
    for (const entry of entries) {
      if (collapsed.has(entry.path) || entry.node.children.length === 0) {
        continue;
      }
      const childTypes = visibleChildTypes(entry.node.children, structure);
      for (const label of planEdgeLabels(childTypes)) {
        labels.push({ parent: entry.path, childPath: label.childPath, text: label.text });
      }
    }
    return labels;
  }

  /** Creates one `span.bases-structure-edge-label` per placement (text only — position is set
   * later, once `layoutResult` is known, by `positionLabels`) and measures each like a node, so
   * `resolveLayoutOptions` can size the widened gap from real rendered dimensions. Rebuilt every
   * `update()`, same as the node layer. */
  private buildLabelElements(placements: readonly PlacedLabel[]): Map<string, HTMLElement> {
    this.labelsEl.empty();
    const elements = new Map<string, HTMLElement>();
    for (const placement of placements) {
      const el = this.labelsEl.createSpan({
        cls: 'bases-structure-edge-label',
        text: placement.text,
      });
      elements.set(placement.childPath, el);
    }
    return elements;
  }

  /** D2: the widest measured label's width (`+16px`) widens the depth gap for `direction: right`
   * (labels sit inline in the horizontal gap between columns); the tallest one's height (`+8px`)
   * widens it for `direction: down` (labels sit in the vertical gap between rows). No labels at
   * all (`edgeLabels` off, or on but every run untyped) means no widening — the returned options
   * are then referentially the same defaults `update()` used before D2, so existing layout
   * snapshots stay unchanged byte-for-byte. */
  private resolveLayoutOptions(
    direction: Direction,
    labelElements: ReadonlyMap<string, HTMLElement>,
  ): LayoutOptions {
    const base = direction === 'down' ? DEFAULT_VERTICAL_LAYOUT_OPTIONS : DEFAULT_LAYOUT_OPTIONS;
    if (labelElements.size === 0) {
      return base;
    }
    const extent = this.measureLabelExtent(labelElements);
    const extra =
      direction === 'down'
        ? extent.height + LABEL_GAP_DOWN_MARGIN
        : extent.width + LABEL_GAP_RIGHT_MARGIN;
    return { ...base, columnGap: base.columnGap + extra };
  }

  private measureLabelExtent(labelElements: ReadonlyMap<string, HTMLElement>): Size {
    let maxWidth = 0;
    let maxHeight = 0;
    for (const el of labelElements.values()) {
      const size = this.measure(el);
      maxWidth = Math.max(maxWidth, size.width);
      maxHeight = Math.max(maxHeight, size.height);
    }
    return { width: maxWidth, height: maxHeight };
  }

  /** Centres each label span (via `styles.css`'s `transform: translate(-50%, -50%)`) on the
   * midpoint of its own tree edge's anchors — the same `edgeAnchors` the SVG edge itself is drawn
   * from, so a label always sits exactly on the line it labels regardless of direction. Silently
   * skips a placement whose parent/child box or element is missing (e.g. a child that lost its
   * spot in `layoutResult` some other way) rather than throwing. */
  private positionLabels(
    placements: readonly PlacedLabel[],
    labelElements: ReadonlyMap<string, HTMLElement>,
    layoutResult: LayoutResult,
    direction: Direction,
  ): void {
    for (const placement of placements) {
      const el = labelElements.get(placement.childPath);
      const parentBox = layoutResult.boxes.get(placement.parent);
      const childBox = layoutResult.boxes.get(placement.childPath);
      if (el === undefined || parentBox === undefined || childBox === undefined) {
        continue;
      }
      const { start, end } = edgeAnchors(parentBox, childBox, direction);
      el.style.left = `${(start.x + end.x) / 2}px`;
      el.style.top = `${(start.y + end.y) / 2}px`;
    }
  }

  /** Also gives `wrapEl` its natural, *unscaled* size (zoom 1), not just `canvasEl`/the SVG —
   * `wrapEl` otherwise only ever gets a size from `applyZoom`, called after `applyAutoFit`
   * (`update()`'s own ordering). `.bases-structure-graph` has no explicit height of its own in
   * CSS; it shrink-wraps to its in-flow content, and `.bases-structure-canvas` is absolutely
   * positioned (so it never counts) — meaning `wrapEl` is the *only* thing that gives the
   * container a real, content-driven height at all. Without this, `applyAutoFit`'s `clientHeight`
   * read is a chicken-and-egg bug: on the very first render `wrapEl` has no size yet, so the
   * container reports a tiny (near-toolbar-only) height, the computed fit ratio comes out far
   * below `ZOOM_MIN`, and — since auto-fit only gets one attempt per direction — that wrong zoom
   * sticks forever. Harmless to set here even though `applyZoom` immediately overwrites it a few
   * lines later in `update()`: nothing paints between the two synchronous calls. */
  private applyCanvasSize(layoutResult: LayoutResult): void {
    this.canvasEl.style.width = `${layoutResult.width}px`;
    this.canvasEl.style.height = `${layoutResult.height}px`;
    this.wrapEl.style.width = `${layoutResult.width}px`;
    this.wrapEl.style.height = `${layoutResult.height}px`;
    this.svgEl.setAttribute('width', String(layoutResult.width));
    this.svgEl.setAttribute('height', String(layoutResult.height));
  }

  /** Group frames are a layout-only concept now (`layoutTree` still computes them so spacing
   * doesn't change) — nothing here draws `layoutResult.groups`. */
  private drawSvg(
    entries: readonly VisibleEntry[],
    layoutResult: LayoutResult,
    direction: Direction,
  ): void {
    for (const child of Array.from(this.svgEl.children)) {
      if (child !== this.defsEl) {
        child.remove();
      }
    }
    this.edgesByPath = new Map();
    this.drawTreeEdges(entries, layoutResult, direction);
    this.drawExtraEdges(entries, layoutResult, direction);
  }

  private drawTreeEdges(
    entries: readonly VisibleEntry[],
    layoutResult: LayoutResult,
    direction: Direction,
  ): void {
    for (const entry of entries) {
      if (entry.node.parent === null) {
        continue;
      }
      const fromBox = layoutResult.boxes.get(entry.node.parent);
      const toBox = layoutResult.boxes.get(entry.path);
      if (fromBox === undefined || toBox === undefined) {
        continue;
      }
      const path = createSvgEl(this.container.doc, 'path');
      path.classList.add('bases-structure-edge');
      path.setAttribute('d', edgePath(fromBox, toBox, direction));
      if (entry.node.twoWay) {
        path.classList.add('is-two-way');
        path.setAttribute('marker-start', TREE_ARROW_MARKER_URL);
        path.setAttribute('marker-end', TREE_ARROW_MARKER_URL);
      }
      this.svgEl.appendChild(path);
      this.registerEdge(path, entry.node.parent, entry.path);
    }
  }

  private drawExtraEdges(
    entries: readonly VisibleEntry[],
    layoutResult: LayoutResult,
    direction: Direction,
  ): void {
    for (const entry of entries) {
      for (const extra of entry.node.extras) {
        this.drawExtraEdge(extra, entry.path, layoutResult, direction);
      }
    }
  }

  private drawExtraEdge(
    extra: ExtraLink,
    childPath: string,
    layoutResult: LayoutResult,
    direction: Direction,
  ): void {
    const fromBox = layoutResult.boxes.get(extra.parent);
    const toBox = layoutResult.boxes.get(childPath);
    if (fromBox === undefined || toBox === undefined) {
      return;
    }
    const path = createSvgEl(this.container.doc, 'path');
    path.classList.add('bases-structure-edge', 'is-extra');
    path.setAttribute('d', edgePath(fromBox, toBox, direction));
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
    this.labelsEl.empty();
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

  /** Fits the whole graph into the viewport the first time a layout with content succeeds for the
   * *current* direction while the user hasn't zoomed by hand — an embed opens showing the full
   * tree instead of a corner of it. Mutates `state.zoom` directly (not through `setZoom`) so this
   * never marks the zoom as user-touched. Re-fitting is keyed on direction, not a plain one-shot
   * flag: switching `direction` on an open view (U3) must get its own fresh fit — the axis "fit"
   * follows is different for each direction (see `computeFitZoom`), so the *old* direction's fit
   * zoom is usually the wrong number for the new layout's shape. Only latches
   * `lastAutoFitDirection` once the container actually has a measured size — an embed whose first
   * render lands before the surrounding layout settles (`clientWidth`/`clientHeight` still 0)
   * would otherwise fit against a bogus 0×0 box, lock in that no-op "fit", and never get another
   * chance once the container is really laid out. Never lands below `AUTO_FIT_MIN_ZOOM`: a graph
   * nobody explicitly asked to shrink should never open with unreadable text, even a very wide one
   * in a narrow embed — it just overflows into the scroll area past that floor instead. */
  private applyAutoFit(state: ViewUiState, rootBox: Box | undefined): void {
    if (state.zoomTouched || this.lastAutoFitDirection === this.lastDirection) {
      return;
    }
    if (this.graphEl.clientWidth === 0 || this.graphEl.clientHeight === 0) {
      return;
    }
    this.lastAutoFitDirection = this.lastDirection;
    state.zoom = Math.min(ZOOM_MAX, Math.max(AUTO_FIT_MIN_ZOOM, this.computeFitZoom()));
    this.centerRootInView(state, rootBox);
  }

  /** The auto-fit floor (`AUTO_FIT_MIN_ZOOM`) can still leave a graph overflowing the viewport —
   * scroll defaults to 0/0, which isn't necessarily where the root landed (`down` centres the
   * root horizontally in its column; `right` centres it vertically). Brings the first forest top
   * into view along that axis; the other axis stays 0. A no-op once the graph already fits (the
   * clamp lands at 0 on its own). */
  private centerRootInView(state: ViewUiState, rootBox: Box | undefined): void {
    if (rootBox === undefined) {
      return;
    }
    if (this.lastDirection === 'down') {
      state.scrollLeft = centeredScroll(
        rootBox.x + rootBox.width / 2,
        state.zoom,
        this.graphEl.clientWidth,
      );
      state.scrollTop = 0;
    } else {
      state.scrollLeft = 0;
      state.scrollTop = centeredScroll(
        rootBox.y + rootBox.height / 2,
        state.zoom,
        this.graphEl.clientHeight,
      );
    }
  }

  /** U2: "Fit" follows the axis the tree actually grows along. `direction: 'right'` trees grow
   * arbitrarily deep sideways but their *breadth* (siblings) is meant to scroll vertically, so
   * fitting to height too would shrink the graph far more than necessary — only the width has to
   * fit the viewport. `direction: 'down'` keeps today's both-axes fit (its own breadth spreads
   * horizontally and its depth grows vertically, so both dimensions are equally "the tree", not
   * one scrollable direction and one fitted one). */
  private computeFitZoom(): number {
    const containerWidth = this.graphEl.clientWidth;
    const { width, height } = this.lastLayoutSize;
    if (containerWidth === 0 || width === 0) {
      return 1;
    }
    if (this.lastDirection !== 'down') {
      return Math.min(1, containerWidth / width);
    }
    const containerHeight = this.graphEl.clientHeight;
    if (containerHeight === 0 || height === 0) {
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
