// Shared node-building and interaction logic for both renderers (graph and outline): a node is
// always the same little internal-link card — a title link plus an optional "also in" chip — so
// there is exactly one place that knows the DOM shape, the click-to-open behaviour and the
// hover-to-preview behaviour. `attachNodeInteractions` is delegated (one listener pair per
// container, not per node) so callers never have to track per-node listeners.

import type { App, Component } from 'obsidian';
import { Keymap, setIcon } from 'obsidian';
import type { Snapshot } from '../core/snapshot.js';
import { displayName } from '../core/snapshot.js';
import type { StructureNode } from '../core/structure.js';
import { reportOpenFailure } from './open-note.js';

export interface NodeElementContext {
  readonly app: App;
  readonly sourcePath: string; // host path, or '' when there is none
  readonly hoverParent: Component; // the view, for hover-link
  readonly snapshot: Snapshot;
  /** Invoked with a node's own path and its `.bases-structure-node` element when the "+" button
   * on that node is clicked — wired to `StructureActions.startCreate` by `structure-view.ts`. */
  readonly onAdd: (path: string, anchorEl: HTMLElement) => void;
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
  onAdd: (path: string, anchorEl: HTMLElement) => void;
}

export function cloneNodeElementContext(ctx: NodeElementContext): MutableNodeElementContext {
  return {
    app: ctx.app,
    sourcePath: ctx.sourcePath,
    hoverParent: ctx.hoverParent,
    snapshot: ctx.snapshot,
    onAdd: ctx.onAdd,
  };
}

const HOVER_SOURCE = 'bases-structure';
const TITLE_SELECTOR = '.bases-structure-title';
const ADD_SELECTOR = '[data-action="add"]';
const NODE_SELECTOR = '.bases-structure-node';
const ALSO_IN_PREFIX = '↗ ';

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
  appendAddButton(el);
  appendAlsoIn(el, ctx, node);
  return el;
}

/** Every `.bases-structure-node` under `root` whose `data-path` is `path` — a linear scan instead
 * of an attribute-selector query, since a note path can contain characters (quotes, brackets)
 * that would need escaping in a CSS selector. Backs both renderers' `getNodeElement`, which the
 * keyboard task anchors menus/drafts to. */
export function findNodeElement(root: HTMLElement, path: string): HTMLElement | null {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(NODE_SELECTOR))) {
    if (el.getAttribute('data-path') === path) {
      return el;
    }
  }
  return null;
}

/** The "+" affordance: always in the DOM (shown on hover/focus via CSS), so it's the delegated
 * click listener below — not conditional rendering — that decides whether it's reachable. */
function appendAddButton(el: HTMLElement): void {
  const button = el.createEl('button', {
    cls: 'bases-structure-add',
    attr: { type: 'button', 'aria-label': 'Add child', 'data-action': 'add' },
  });
  setIcon(button, 'plus');
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

/** The node whose "+" button was clicked, and its own path — `null` when the click didn't land on
 * an add button at all. */
function readAddHit(event: MouseEvent): { nodeEl: HTMLElement; path: string } | null {
  if (!(event.target instanceof HTMLElement)) {
    return null;
  }
  const button = event.target.closest<HTMLElement>(ADD_SELECTOR);
  if (button === null) {
    return null;
  }
  const nodeEl = button.closest<HTMLElement>(NODE_SELECTOR);
  if (nodeEl === null) {
    return null;
  }
  const path = nodeEl.getAttribute('data-path');
  if (path === null) {
    return null;
  }
  return { nodeEl, path };
}

/** One delegated `click` and one delegated `mouseover` listener on `container`, matching the
 * design spec's "Представления" node behaviour: click opens the link (Mod+click into a new
 * pane), mouseover previews it. Returns a disposer that removes both listeners. */
export function attachNodeInteractions(
  ctx: NodeElementContext,
  container: HTMLElement,
): () => void {
  const handleClick = (event: MouseEvent): void => {
    const addHit = readAddHit(event);
    if (addHit !== null) {
      event.stopPropagation();
      ctx.onAdd(addHit.path, addHit.nodeEl);
      return;
    }
    const hit = readTitlePath(event);
    if (hit === null) {
      return;
    }
    event.preventDefault();
    ctx.app.workspace
      .openLinkText(hit.path, ctx.sourcePath, Keymap.isModEvent(event))
      .catch((error: unknown) => {
        reportOpenFailure(ctx.snapshot, hit.path, error);
      });
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
