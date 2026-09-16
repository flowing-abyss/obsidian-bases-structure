// Minimal outline renderer for the structure view: a nested `<ul>/<li>` tree, depth-first in
// `children` order, with a defensive cycle guard (structure.ts already guarantees an acyclic
// primary-parent tree, but this renderer doesn't trust that blindly) and a trailing "Without a
// parent" section for orphans. Node building and interaction (click to open, hover to preview)
// are delegated to `node-element.ts`, shared with the graph renderer.

import type { MutableNodeElementContext, NodeElementContext } from './node-element.js';
import {
  attachNodeInteractions,
  cloneNodeElementContext,
  createNodeElement,
} from './node-element.js';
import type { RenderInput, StructureRenderer } from './structure-view.js';

interface RenderCtx {
  readonly input: RenderInput;
  readonly nodeCtx: MutableNodeElementContext;
  readonly seen: Set<string>;
}

/** Renders `structure.tops`/orphans into `container` as nested lists. Pure DOM building — no
 * Obsidian-specific behaviour lives here beyond what `createNodeElement` already attaches. */
function renderNode(ul: HTMLElement, path: string, ctx: RenderCtx): void {
  if (ctx.seen.has(path)) {
    return;
  }
  ctx.seen.add(path);
  const node = ctx.input.structure.nodes.get(path);
  if (node === undefined) {
    return;
  }
  const li = ul.createEl('li');
  const nodeEl = createNodeElement(ctx.nodeCtx, node, {
    isRoot: path === ctx.input.structure.root,
  });
  if (path === ctx.input.focusPath) {
    nodeEl.classList.add('is-new');
  }
  li.appendChild(nodeEl);
  if (node.children.length > 0) {
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

/** Carried-over fix from the task 9 review: the orphan `<li>` must live inside a `<ul>` — it gets
 * its own wrapper here rather than being appended straight to `container`. */
function renderOrphans(container: HTMLElement, ctx: RenderCtx): void {
  const { orphans } = ctx.input.structure;
  if (orphans.length === 0) {
    return;
  }
  const ul = container.createEl('ul');
  const li = ul.createEl('li', { cls: 'bases-structure-orphans', text: 'Without a parent' });
  renderList(li, orphans, ctx);
}

export class OutlineRenderer implements StructureRenderer {
  private readonly containerEl: HTMLElement;
  private readonly nodeCtx: MutableNodeElementContext;
  private readonly disposeInteractions: () => void;

  constructor(containerEl: HTMLElement, ctx: NodeElementContext) {
    this.containerEl = containerEl;
    this.nodeCtx = cloneNodeElementContext(ctx);
    this.disposeInteractions = attachNodeInteractions(this.nodeCtx, containerEl);
  }

  update(input: RenderInput): void {
    this.nodeCtx.snapshot = input.snapshot;
    this.nodeCtx.sourcePath = input.snapshot.host ?? '';
    this.containerEl.empty();
    const ctx: RenderCtx = { input, nodeCtx: this.nodeCtx, seen: new Set() };
    renderList(this.containerEl, input.structure.tops, ctx);
    renderOrphans(this.containerEl, ctx);
  }

  destroy(): void {
    this.disposeInteractions();
    this.containerEl.empty();
  }
}
