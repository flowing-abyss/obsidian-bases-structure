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
import { setSizedIcon } from './icon.js';
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

/** Muted, icon-led chip: an `arrow-up-right` SVG followed by the extra parents' display names —
 * see task 15's decisions (no more text-glyph prefix). */
function appendAlsoIn(el: HTMLElement, ctx: NodeElementContext, node: StructureNode): void {
  if (node.alsoIn.length === 0) {
    return;
  }
  const names = node.alsoIn.map((path) => displayName(ctx.snapshot, path));
  const chip = el.createSpan({
    cls: 'bases-structure-alsoin',
    attr: { title: names.join(', ') },
  });
  setSizedIcon(chip.createSpan({ cls: 'bases-structure-alsoin-icon' }), 'arrow-up-right');
  chip.createSpan({ text: names.join(', ') });
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

/** Roving-tabindex + `.is-active` (task 16): the node matching `activePath` gets `tabindex="0"`
 * and the class; every other `.bases-structure-node` under `root` gets `tabindex="-1"`. Returns
 * the active element (or `null` when `activePath` is `null` or isn't currently rendered — e.g.
 * hidden behind a collapsed ancestor), so a renderer can decide whether to move real focus/scroll
 * it into view. Called on every `update()` (both renderers rebuild their node elements wholesale
 * each time) so the highlight survives a re-render instead of being lost with the old elements. */
export function applyActiveNode(root: HTMLElement, activePath: string | null): HTMLElement | null {
  let activeEl: HTMLElement | null = null;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(NODE_SELECTOR))) {
    const isActive = activePath !== null && el.getAttribute('data-path') === activePath;
    el.classList.toggle('is-active', isActive);
    el.tabIndex = isActive ? 0 : -1;
    if (isActive) {
      activeEl = el;
    }
  }
  return activeEl;
}

/** Moves real keyboard focus to `el` and scrolls it into view — called once per render when the
 * active node changed (task 16's roving tabindex needs real DOM focus to follow the logical
 * active node, or a later keydown dispatched from wherever focus fell back to would never bubble
 * through the container's delegated listener). `scrollIntoView` isn't implemented at all by jsdom
 * (`focus` is) — wrapped in a `try`/`catch` rather than a `typeof` guard, since the standard DOM
 * types declare it as always present and a guard would trip `no-unnecessary-condition`; mirrors
 * `drag.ts`'s `safePointerCapture` for the same class of jsdom gap. */
export function focusActiveNode(el: HTMLElement): void {
  el.focus({ preventScroll: true });
  try {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } catch {
    // Intentionally ignored — see the doc comment above.
  }
}

/** The "+" affordance: always in the DOM (shown on hover/focus via CSS), so it's the delegated
 * click listener below — not conditional rendering — that decides whether it's reachable. */
function appendAddButton(el: HTMLElement): void {
  const button = el.createEl('button', {
    cls: 'bases-structure-add',
    attr: { type: 'button', 'aria-label': 'Add child', 'data-action': 'add' },
  });
  setSizedIcon(button, 'plus');
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
