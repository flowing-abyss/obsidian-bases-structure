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

import { setSizedIcon } from './icon.js';
import type { MutableNodeElementContext, NodeElementContext } from './node-element.js';
import {
  attachNodeInteractions,
  cloneNodeElementContext,
  createNodeElement,
  findNodeElement,
} from './node-element.js';
import type { RenderInput, StructureRenderer } from './structure-view.js';

const EMPTY_MESSAGE = 'Nothing to show yet';
const LIST_CLASS = 'bases-structure-outline-list';
const ITEM_CLASS = 'bases-structure-outline-item';
const TOGGLE_SELECTOR = '.bases-structure-toggle';
const NODE_SELECTOR = '.bases-structure-node';

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
  private listEl: HTMLElement | null = null;
  private lastInput: RenderInput | null = null;

  constructor(containerEl: HTMLElement, ctx: NodeElementContext) {
    this.containerEl = containerEl;
    this.nodeCtx = cloneNodeElementContext(ctx);
    this.outlineEl = containerEl.createDiv('bases-structure-outline');
    this.emptyEl = this.outlineEl.createDiv({
      cls: ['bases-structure-empty', 'is-hidden'],
      text: EMPTY_MESSAGE,
    });
    this.disposeInteractions = attachNodeInteractions(this.nodeCtx, this.outlineEl);
    this.outlineEl.addEventListener('click', this.handleToggleClick);
    this.outlineEl.addEventListener('scroll', this.handleScroll);
  }

  update(input: RenderInput): void {
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
    this.outlineEl.scrollTop = input.state.scrollTop;
  }

  getNodeElement(path: string): HTMLElement | null {
    return findNodeElement(this.outlineEl, path);
  }

  destroy(): void {
    this.outlineEl.removeEventListener('click', this.handleToggleClick);
    this.outlineEl.removeEventListener('scroll', this.handleScroll);
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
    this.lastInput.state.scrollTop = this.outlineEl.scrollTop;
  };
}
