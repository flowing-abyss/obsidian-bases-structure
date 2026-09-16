// Shared node-building and interaction logic for both renderers (graph and outline): a node is
// always the same little internal-link card — a title link plus an optional "also in" chip — so
// there is exactly one place that knows the DOM shape, the click-to-open behaviour and the
// hover-to-preview behaviour. `attachNodeInteractions` is delegated (one listener pair per
// container, not per node) so callers never have to track per-node listeners.

import type { App, Component } from 'obsidian';
import { Keymap } from 'obsidian';
import type { Snapshot } from '../core/snapshot.js';
import { displayName } from '../core/snapshot.js';
import type { StructureNode } from '../core/structure.js';

export interface NodeElementContext {
  readonly app: App;
  readonly sourcePath: string; // host path, or '' when there is none
  readonly hoverParent: Component; // the view, for hover-link
  readonly snapshot: Snapshot;
}

/** Flags that depend on where a node sits in the forest rather than on the node itself (a
 * `StructureNode` doesn't know whether its path is `structure.root` or an orphan tree's top). */
export interface NodeElementFlags {
  readonly isRoot?: boolean;
  readonly isOrphan?: boolean;
}

/** A renderer's own working copy of a `NodeElementContext`: both renderers own one of these and
 * refresh `snapshot`/`sourcePath` from every `RenderInput` they receive, so `createNodeElement`/
 * `attachNodeInteractions` always see the current render's data without either renderer having to
 * reach back into `StructureView` for it. */
export interface MutableNodeElementContext {
  app: App;
  sourcePath: string;
  hoverParent: Component;
  snapshot: Snapshot;
}

export function cloneNodeElementContext(ctx: NodeElementContext): MutableNodeElementContext {
  return {
    app: ctx.app,
    sourcePath: ctx.sourcePath,
    hoverParent: ctx.hoverParent,
    snapshot: ctx.snapshot,
  };
}

const HOVER_SOURCE = 'bases-structure';
const TITLE_SELECTOR = '.bases-structure-title';
const ALSO_IN_PREFIX = '↗ ';

function logHandlerError(error: unknown): void {
  console.error('[bases-structure]', error);
}

function appendAlsoIn(el: HTMLElement, ctx: NodeElementContext, node: StructureNode): void {
  if (node.alsoIn.length === 0) {
    return;
  }
  const names = node.alsoIn.map((path) => displayName(ctx.snapshot, path));
  el.createSpan({
    cls: 'bases-structure-alsoin',
    text: `${ALSO_IN_PREFIX}${names.join(', ')}`,
    attr: { title: names.join(', ') },
  });
}

/** The node card: `div.bases-structure-node` (`data-path`, `data-type`, `is-root`/`is-orphan`)
 * containing the title link and, when present, the "also in" chip. */
export function createNodeElement(
  ctx: NodeElementContext,
  node: StructureNode,
  flags: NodeElementFlags = {},
): HTMLElement {
  const classes = ['bases-structure-node'];
  if (flags.isRoot === true) {
    classes.push('is-root');
  }
  if (flags.isOrphan === true) {
    classes.push('is-orphan');
  }
  const el = createDiv({
    cls: classes,
    attr: { 'data-path': node.path, 'data-type': node.type ?? '' },
  });
  el.createEl('a', {
    cls: 'internal-link bases-structure-title',
    text: displayName(ctx.snapshot, node.path),
    // No real `href`: navigation is fully handled by `attachNodeInteractions` (via `data-href`),
    // and a literal `href` would make jsdom log spurious "navigation to another Document"
    // warnings in tests. `tabindex` keeps the link keyboard-focusable without one.
    attr: { 'data-href': node.path, tabindex: '0' },
  });
  appendAlsoIn(el, ctx, node);
  return el;
}

function readTitlePath(event: MouseEvent): { title: HTMLElement; path: string } | null {
  if (!(event.target instanceof HTMLElement)) {
    return null;
  }
  const title = event.target.closest<HTMLElement>(TITLE_SELECTOR);
  if (title === null) {
    return null;
  }
  const path = title.getAttribute('data-href');
  if (path === null) {
    return null;
  }
  return { title, path };
}

/** One delegated `click` and one delegated `mouseover` listener on `container`, matching the
 * design spec's "Представления" node behaviour: click opens the link (Mod+click into a new
 * pane), mouseover previews it. Returns a disposer that removes both listeners. */
export function attachNodeInteractions(
  ctx: NodeElementContext,
  container: HTMLElement,
): () => void {
  const handleClick = (event: MouseEvent): void => {
    const hit = readTitlePath(event);
    if (hit === null) {
      return;
    }
    event.preventDefault();
    ctx.app.workspace
      .openLinkText(hit.path, ctx.sourcePath, Keymap.isModEvent(event))
      .catch(logHandlerError);
  };
  const handleMouseOver = (event: MouseEvent): void => {
    const hit = readTitlePath(event);
    if (hit === null) {
      return;
    }
    ctx.app.workspace.trigger('hover-link', {
      event,
      source: HOVER_SOURCE,
      hoverParent: ctx.hoverParent,
      targetEl: hit.title,
      linktext: hit.path,
      sourcePath: ctx.sourcePath,
    });
  };
  container.addEventListener('click', handleClick);
  container.addEventListener('mouseover', handleMouseOver);
  return () => {
    container.removeEventListener('click', handleClick);
    container.removeEventListener('mouseover', handleMouseOver);
  };
}
