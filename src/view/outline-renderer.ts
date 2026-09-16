// Minimal outline renderer for the structure view: a nested `<ul>/<li>` tree, depth-first in
// `children` order, with a defensive cycle guard (structure.ts already guarantees an acyclic
// primary-parent tree, but this renderer doesn't trust that blindly) and a trailing "Without a
// parent" section for orphans. Node interaction (click to open, hover to preview) goes through
// one delegated listener per container, matching the design spec's "Представления" section.

import type { App, HoverParent } from 'obsidian';
import { Keymap } from 'obsidian';
import { displayName } from '../core/snapshot.js';
import type { RenderInput, StructureRenderer } from './structure-view.js';

const NODE_SELECTOR = '.bases-structure-node';
const HOVER_SOURCE = 'bases-structure';

interface RenderCtx {
  readonly input: RenderInput;
  readonly seen: Set<string>;
}

function logHandlerError(error: unknown): void {
  console.error('[bases-structure]', error);
}

/** Renders `structure.tops`/orphans into `container` as nested lists. Pure DOM building — no
 * Obsidian-specific behaviour lives here beyond the node attributes the click/hover handlers
 * read back. */
function renderNode(ul: HTMLElement, path: string, ctx: RenderCtx): void {
  if (ctx.seen.has(path)) {
    return;
  }
  ctx.seen.add(path);
  const node = ctx.input.structure.nodes.get(path);
  const li = ul.createEl('li');
  li.createEl('a', {
    cls: 'internal-link bases-structure-node',
    text: displayName(ctx.input.snapshot, path),
    attr: { 'data-path': path, 'data-type': node?.type ?? '' },
  });
  if (node !== undefined && node.children.length > 0) {
    renderList(li, node.children, ctx);
  }
}

function renderList(container: HTMLElement, paths: readonly string[], ctx: RenderCtx): void {
  if (paths.length === 0) {
    return;
  }
  const ul = container.createEl('ul');
  for (const path of paths) {
    renderNode(ul, path, ctx);
  }
}

function renderOrphans(container: HTMLElement, ctx: RenderCtx): void {
  const { orphans } = ctx.input.structure;
  if (orphans.length === 0) {
    return;
  }
  const li = container.createEl('li', {
    cls: 'bases-structure-orphans',
    text: 'Without a parent',
  });
  renderList(li, orphans, ctx);
}

export class OutlineRenderer implements StructureRenderer {
  private readonly app: App;
  private readonly containerEl: HTMLElement;
  private readonly hoverParent: HoverParent = { hoverPopover: null };
  private hostPath: string | null = null;

  constructor(app: App, containerEl: HTMLElement) {
    this.app = app;
    this.containerEl = containerEl;
    this.containerEl.addEventListener('click', this.handleClick);
    this.containerEl.addEventListener('mouseover', this.handleMouseOver);
  }

  update(input: RenderInput): void {
    this.hostPath = input.snapshot.host;
    this.containerEl.empty();
    const ctx: RenderCtx = { input, seen: new Set() };
    renderList(this.containerEl, input.structure.tops, ctx);
    renderOrphans(this.containerEl, ctx);
  }

  destroy(): void {
    this.containerEl.removeEventListener('click', this.handleClick);
    this.containerEl.removeEventListener('mouseover', this.handleMouseOver);
    this.containerEl.empty();
  }

  private findNodeEl(event: MouseEvent): HTMLElement | null {
    if (!(event.target instanceof HTMLElement)) {
      return null;
    }
    return event.target.closest<HTMLElement>(NODE_SELECTOR);
  }

  private readonly handleClick = (event: MouseEvent): void => {
    const nodeEl = this.findNodeEl(event);
    if (nodeEl === null) {
      return;
    }
    const path = nodeEl.getAttribute('data-path');
    if (path === null) {
      return;
    }
    event.preventDefault();
    this.app.workspace
      .openLinkText(path, this.hostPath ?? '', Keymap.isModEvent(event))
      .catch(logHandlerError);
  };

  private readonly handleMouseOver = (event: MouseEvent): void => {
    const nodeEl = this.findNodeEl(event);
    if (nodeEl === null) {
      return;
    }
    const path = nodeEl.getAttribute('data-path');
    if (path === null) {
      return;
    }
    this.app.workspace.trigger('hover-link', {
      event,
      source: HOVER_SOURCE,
      hoverParent: this.hoverParent,
      targetEl: nodeEl,
      linktext: path,
      sourcePath: this.hostPath ?? '',
    });
  };
}
