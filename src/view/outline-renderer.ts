// The compact indented-tree renderer for the structure view — the second representation of the
// same hierarchy model as the graph, better for deep hierarchies and fast keyboard work. It
// supports everything the graph does except zoom/pan, and reuses the graph's building blocks
// wholesale: node cards and click/hover/"+"/drag behaviour come from `node-element.ts` unchanged,
// and the collapse toggle (button, icon, `state.collapsed`, "toggle + re-`update`") mirrors
// `graph-renderer.ts`, which is the reference implementation for both.
//
// DOM shape (see task 13's binding decisions):
//   div.bases-structure-outline
//     ul.bases-structure-outline-list            (tops, then a trailing orphans section)
//       li.bases-structure-outline-item
//         div.bases-structure-node               (from node-element.ts, unchanged)
//         ul.bases-structure-outline-list        (children, omitted when collapsed or empty)

import { displayName } from '../core/snapshot.js';
import type { StructureNode } from '../core/structure.js';
import {
  hookSuperchargedLinks,
  unhookSuperchargedLinks,
  type SuperchargedWatch,
} from '../obsidian/supercharged-links.js';
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

const EMPTY_MESSAGE = 'Nothing to show yet';
const LIST_CLASS = 'bases-structure-outline-list';
const ITEM_CLASS = 'bases-structure-outline-item';
const TOGGLE_SELECTOR = '.bases-structure-toggle';
const NODE_SELECTOR = '.bases-structure-node';
const TITLE_SELECTOR = '.bases-structure-title';
// D1: mirrors `graph-renderer.ts`'s own counter — see its doc comment for why a fresh id per
// instance matters (two embeds of this view open at once must not share a watch key).
let nextOutlineWatchSeq = 0;

export interface OutlineRendererOptions {
  /** D1: this plugin's own `manifest.id` — see `GraphRendererOptions.ownerId`'s identical doc
   * comment. Omitted in tests that don't care. */
  readonly ownerId?: string;
}

interface RenderCtx {
  readonly input: RenderInput;
  readonly nodeCtx: MutableNodeElementContext;
  readonly seen: Set<string>;
}

/** Same button, same classes/attrs and same icon choice as the graph's own `addToggle` — only
 * the DOM it's prepended into (an outline row instead of a positioned graph node) differs. */
function addToggle(el: HTMLElement, collapsed: boolean): void {
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

/** I8: only the outline marks a two-way edge on the node itself — the graph already draws it as
 * an arrowed-both-ways SVG edge (see `graph-renderer.ts`'s `TREE_ARROW_MARKER_URL`), which the
 * outline has no equivalent of (no edges at all). A small icon right before the title, not
 * prepended to the node wholesale, so it lands after the toggle (which prepends *after* this
 * runs) but still ahead of the title text itself. */
function addTwoWayMarker(el: HTMLElement, node: StructureNode): void {
  if (!node.twoWay) {
    return;
  }
  const title = el.querySelector(TITLE_SELECTOR);
  const icon = el.createSpan({ cls: 'bases-structure-two-way-icon' });
  setSizedIcon(icon, 'arrow-left-right');
  title?.before(icon);
}

/** I8: the outline's only way to show a node's *extra* parents (candidates the planner found but
 * didn't pick as the primary one — see `structure.ts`'s `ExtraLink`) — the graph already draws
 * each as its own dashed edge; the outline has no edges to draw them as, so this is a muted chip
 * instead, the same icon-led shape as `node-element.ts`'s own `alsoIn` chip. Unlike that chip
 * (icon-only, no text — see its own doc comment), this one's text is prefixed ("also under …")
 * since it shares that exact same icon: without the words, the two chips would be visually
 * identical for two different meanings sitting on the same row. */
function addExtrasChip(
  el: HTMLElement,
  nodeCtx: MutableNodeElementContext,
  node: StructureNode,
): void {
  if (node.extras.length === 0) {
    return;
  }
  const names = node.extras.map((extra) => displayName(nodeCtx.snapshot, extra.parent));
  const label = `also under ${names.join(', ')}`;
  const chip = el.createSpan({
    cls: 'bases-structure-extras',
    attr: { title: label },
  });
  setSizedIcon(chip.createSpan({ cls: 'bases-structure-extras-icon' }), 'arrow-up-right');
  chip.createSpan({ text: label });
}

/** Builds one `<li>` (node + optional nested child list) into `ul` and recurses depth-first in
 * `children` order. `ctx.seen` is a defensive cycle guard — `structure.ts` already guarantees an
 * acyclic primary-parent tree, but this renderer doesn't trust that blindly. */
function renderNode(ul: HTMLElement, path: string, ctx: RenderCtx, isOrphanTop = false): void {
  if (ctx.seen.has(path)) {
    return;
  }
  ctx.seen.add(path);
  const node = ctx.input.structure.nodes.get(path);
  if (node === undefined) {
    return;
  }
  const li = ul.createEl('li', { cls: ITEM_CLASS });
  const nodeEl = createNodeElement(ctx.nodeCtx, node, {
    isRoot: path === ctx.input.structure.root,
    isOrphan: isOrphanTop,
  });
  addTwoWayMarker(nodeEl, node);
  addExtrasChip(nodeEl, ctx.nodeCtx, node);
  const collapsed = ctx.input.state.collapsed.has(path);
  if (node.children.length > 0) {
    addToggle(nodeEl, collapsed);
  }
  if (path === ctx.input.focusPath) {
    nodeEl.classList.add('is-new');
  }
  li.appendChild(nodeEl);
  if (node.children.length > 0 && !collapsed) {
    renderChildren(li, node.children, ctx);
  }
}

/** Only ever called with a non-empty `paths` (its one call site already guards on
 * `children.length > 0`), so there's no empty-list case to short-circuit here. */
function renderChildren(li: HTMLElement, paths: readonly string[], ctx: RenderCtx): void {
  const ul = li.createEl('ul', { cls: LIST_CLASS });
  for (const path of paths) {
    renderNode(ul, path, ctx);
  }
}

/** The orphans section is a final `li.bases-structure-orphans` INSIDE the same top-level `<ul>`
 * as the tops (not a second, sibling list) — appended straight onto `ul`. Only each orphan tree's
 * own top gets `isOrphan` (matching `collectVisibleEntries` in the graph renderer); its
 * descendants render through the ordinary, un-flagged `renderNode`. */
function renderOrphans(ul: HTMLElement, ctx: RenderCtx): void {
  const { orphans } = ctx.input.structure;
  if (orphans.length === 0) {
    return;
  }
  const li = ul.createEl('li', { cls: 'bases-structure-orphans', text: 'Without a parent' });
  const orphanList = li.createEl('ul', { cls: LIST_CLASS });
  for (const path of orphans) {
    renderNode(orphanList, path, ctx, true);
  }
}

export class OutlineRenderer implements StructureRenderer {
  private readonly containerEl: HTMLElement;
  private readonly nodeCtx: MutableNodeElementContext;
  private readonly outlineEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly disposeInteractions: () => void;
  private readonly slWatch: SuperchargedWatch;
  private listEl: HTMLElement | null = null;
  private lastInput: RenderInput | null = null;
  // Tracks the active path applied by the *previous* `update()` — mirrors the graph renderer's
  // own field, see its doc comment for why an unchanged `active` skips focus/scroll, and for why
  // the first `update()` seeds this from that render's own `state.active` (I9) instead of leaving
  // it `null`.
  private lastActivePath: string | null = null;
  private hasRenderedOnce = false;

  constructor(
    containerEl: HTMLElement,
    ctx: NodeElementContext,
    options: OutlineRendererOptions = {},
  ) {
    this.containerEl = containerEl;
    this.nodeCtx = cloneNodeElementContext(ctx);
    this.outlineEl = containerEl.createDiv('bases-structure-outline');
    this.emptyEl = this.outlineEl.createDiv({
      cls: ['bases-structure-empty', 'is-hidden'],
      text: EMPTY_MESSAGE,
    });
    this.disposeInteractions = attachNodeInteractions(this.nodeCtx, this.outlineEl);
    this.outlineEl.addEventListener('click', this.handleToggleClick);
    // M5: `.bases-structure-outline` (this.outlineEl) never scrolls itself — it's a plain
    // `display: flex; flex-direction: column` block with no height constraint of its own, so it
    // just grows with its content. `.bases-structure-body` (`containerEl`, what actually has
    // `overflow: auto` in styles.css) is the element that really scrolls; listening/writing on
    // `outlineEl` meant this never fired and `scrollTop` writes had no visible effect at all.
    this.containerEl.addEventListener('scroll', this.handleScroll);

    nextOutlineWatchSeq += 1;
    this.slWatch = {
      ownerId: options.ownerId,
      id: `bases-structure-outline-${nextOutlineWatchSeq}`,
    };
    this.watchSuperchargedLinks();
  }

  /** D1: mirrors `GraphRenderer`'s identical method — see its own doc comment. Watched once here,
   * against `outlineEl` (stable across every `update()`; only its `listEl` child is rebuilt). */
  private watchSuperchargedLinks(): void {
    try {
      hookSuperchargedLinks(
        this.nodeCtx.app,
        this.slWatch,
        this.outlineEl,
        'a.bases-structure-title',
        'bases-structure-node',
      );
    } catch (error) {
      console.error('[bases-structure]', error);
    }
  }

  private unwatchSuperchargedLinks(): void {
    try {
      unhookSuperchargedLinks(this.nodeCtx.app, this.slWatch);
    } catch (error) {
      console.error('[bases-structure]', error);
    }
  }

  update(input: RenderInput): void {
    // See the graph renderer's identical capture in its own `update()` for why: this has to be
    // read before the rebuild below destroys whatever real DOM focus is currently inside. M3:
    // `this.containerEl.doc` (its own owner document — a pop-out window's, when the view is open
    // in one), not the global `document`, which would never match focus genuinely inside a
    // pop-out and so never re-focus a rebuilt node there.
    const hadFocus = this.outlineEl.contains(this.containerEl.doc.activeElement);
    if (!this.hasRenderedOnce) {
      this.lastActivePath = input.state.active;
      this.hasRenderedOnce = true;
    }
    this.lastInput = input;
    this.nodeCtx.snapshot = input.snapshot;
    this.nodeCtx.sourcePath = input.snapshot.host ?? '';
    this.listEl?.remove();
    this.listEl = null;

    const ctx: RenderCtx = { input, nodeCtx: this.nodeCtx, seen: new Set() };
    const listEl = this.outlineEl.createEl('ul', { cls: LIST_CLASS });
    for (const path of input.structure.tops) {
      renderNode(listEl, path, ctx);
    }
    renderOrphans(listEl, ctx);

    if (listEl.childElementCount === 0) {
      listEl.remove();
      this.emptyEl.removeClass('is-hidden');
    } else {
      this.listEl = listEl;
      this.emptyEl.addClass('is-hidden');
    }
    this.containerEl.scrollTop = input.state.scrollTop;
    this.applyActiveState(input.state.active, hadFocus);
  }

  /** Re-derives `.is-active`/roving tabindex from `state.active` on every render (task 16) — see
   * the graph renderer's identical method for why (node elements are rebuilt wholesale above) and
   * why focus/scroll follow either an actual change *or* `hadFocus` (captured in `update()` before
   * the rebuild) — the latter is what keeps a collapse/expand refresh (same active path, but every
   * node element replaced) from silently dropping real focus to `document.body`. */
  private applyActiveState(active: string | null, hadFocus: boolean): void {
    const activeEl = applyActiveNode(this.outlineEl, active);
    if (activeEl !== null && (hadFocus || active !== this.lastActivePath)) {
      focusActiveNode(activeEl);
    }
    this.lastActivePath = active;
  }

  getNodeElement(path: string): HTMLElement | null {
    return findNodeElement(this.outlineEl, path);
  }

  destroy(): void {
    this.unwatchSuperchargedLinks();
    this.outlineEl.removeEventListener('click', this.handleToggleClick);
    this.containerEl.removeEventListener('scroll', this.handleScroll);
    this.disposeInteractions();
    this.containerEl.empty();
  }

  /** Delegated toggle click, mirroring the graph's `handleNodesClick`: flip `state.collapsed` for
   * the owning node and re-render from the last known input. A plain node/title click also lands
   * here (bubbling from the same container `attachNodeInteractions` listens on) but never matches
   * `TOGGLE_SELECTOR`, so it falls through as a no-op. */
  private readonly handleToggleClick = (event: MouseEvent): void => {
    if (!(event.target instanceof HTMLElement) || this.lastInput === null) {
      return;
    }
    const toggle = event.target.closest<HTMLElement>(TOGGLE_SELECTOR);
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

  /** Mirrors the graph's `handleScroll`: keeps `state.scrollTop` live as the user scrolls, so a
   * later `update()` (e.g. from `handleToggleClick`'s re-render on collapse/expand, or a layout
   * switch back to the graph) restores the position instead of snapping back to whatever was
   * current the last time `update` itself ran. */
  private readonly handleScroll = (): void => {
    if (this.lastInput === null) {
      return;
    }
    this.lastInput.state.scrollTop = this.containerEl.scrollTop;
  };
}
