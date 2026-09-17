// Shared node-building and interaction logic for both renderers (graph and outline): a node is
// always the same little internal-link card — a title link plus an optional "also in" chip — so
// there is exactly one place that knows the DOM shape, the click-to-open behaviour and the
// hover-to-preview behaviour. `attachNodeInteractions` is delegated (one listener pair per
// container, not per node) so callers never have to track per-node listeners.

import type { App, Component, FrontMatterCache } from 'obsidian';
import { getAllTags, Keymap } from 'obsidian';
import type { Snapshot } from '../core/snapshot.js';
import { displayName } from '../core/snapshot.js';
import type { StructureNode } from '../core/structure.js';
import { applySuperchargedLinkAttributes } from '../obsidian/supercharged-links.js';
import { setSizedIcon } from './icon.js';
import { reportOpenFailure } from './open-note.js';

export interface NodeElementContext {
  readonly app: App;
  readonly sourcePath: string; // host path, or '' when there is none
  readonly hoverParent: Component; // the view, for hover-link
  readonly snapshot: Snapshot;
  /** Invoked with a node's own path, its `.bases-structure-node` element, and the actual "+"
   * button clicked, when that button is clicked — wired to `StructureActions.startCreate` by
   * `structure-view.ts`. `anchorEl` (the node) is what a draft attaches to; `buttonEl` (U1) is
   * what a resulting type menu positions itself under — the node can be much wider than the
   * button, so anchoring the menu to the node instead used to open it away from where the user
   * actually clicked. */
  readonly onAdd: (path: string, anchorEl: HTMLElement, buttonEl: HTMLElement) => void;
  /** I10: invoked with a node's own path, its element, and the touch-only node-menu button
   * clicked — wired to `StructureActions.openNodeMenuFromButton` by `structure-view.ts`. Opens
   * the identical menu a `contextmenu` right-click does; a touch device has no right-click, so
   * this button (visible only under `(hover: none)` — see `styles.css`) is the only way to reach
   * it there. */
  readonly onMenu: (path: string, nodeEl: HTMLElement, buttonEl: HTMLElement) => void;
}

/** Flags that depend on where a node sits in the forest rather than on the node itself (a
 * `StructureNode` doesn't know whether its path is `structure.root` or an orphan tree's top). */
export interface NodeElementFlags {
  readonly isRoot?: boolean;
  readonly isOrphan?: boolean;
  /** D1 follow-up ("keep Supercharged Links icons on the title line"): the *same path's* title
   * element from the render being replaced, if any — see `carryOverSuperchargedLinkState`'s own
   * doc comment for why. Only whichever of its `data-link-*` attributes are still backed by the
   * note's current state get copied forward — see that function's own doc comment. `previousTitle`
   * itself is otherwise inert (no classes are carried from it). `collectTitleElements` builds the
   * map callers pass this from. */
  readonly previousTitle?: HTMLElement;
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
  onAdd: (path: string, anchorEl: HTMLElement, buttonEl: HTMLElement) => void;
  onMenu: (path: string, nodeEl: HTMLElement, buttonEl: HTMLElement) => void;
}

export function cloneNodeElementContext(ctx: NodeElementContext): MutableNodeElementContext {
  return {
    app: ctx.app,
    sourcePath: ctx.sourcePath,
    hoverParent: ctx.hoverParent,
    snapshot: ctx.snapshot,
    onAdd: ctx.onAdd,
    onMenu: ctx.onMenu,
  };
}

const HOVER_SOURCE = 'bases-structure';
const TITLE_SELECTOR = '.bases-structure-title';
const ADD_SELECTOR = '[data-action="add"]';
const MENU_SELECTOR = '[data-action="menu"]';
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

/** D1 follow-up #2 ("drop Supercharged Links attributes whose source is gone"): whether
 * `data-link-<key>` is still backed by *something* in the note's current state, and so is safe to
 * carry forward from a previous render. Carrying every `data-link-*` attribute unconditionally
 * (this function's own first version) let a *deleted* frontmatter key's attribute — and its
 * `--data-link-<key>` CSS variable — linger forever: `applySuperchargedLinkAttributes` only ever
 * sets a key that's actually present, and this view rebuilds every node on every render, so
 * nothing else would ever clear a stale one.
 *
 * - `<key>` still present in `frontmatter` (any value type — a list, e.g. `tags`, is exactly what
 *   Supercharged Links itself computes asynchronously, the whole reason this carry-over exists) —
 *   eligible.
 * - `<key> === 'tags'` and the note currently has any tag at all, frontmatter or inline
 *   (Supercharged Links' `targetTags` option folds both together, same as `getAllTags`) —
 *   eligible even when frontmatter itself has no `tags` key of its own.
 * - `<key> === 'path'` — Supercharged Links' own path-derived attribute, inherent to *which* note
 *   this link points to, never sourced from frontmatter at all — always eligible.
 * - Anything else — dropped, not carried. */
function isSuperchargedLinkAttributeStillTrue(
  key: string,
  frontmatter: FrontMatterCache | undefined,
  hasAnyTag: boolean,
): boolean {
  if (frontmatter !== undefined && Object.prototype.hasOwnProperty.call(frontmatter, key)) {
    return true;
  }
  if (key === 'tags') {
    return hasAnyTag;
  }
  return key === 'path';
}

/** Supercharged Links sets attributes for *non-scalar* frontmatter (e.g. `data-link-tags`, from a
 * list) itself, asynchronously, via its own `MutationObserver` — `applySuperchargedLinkAttributes`
 * never does (it only ever handles scalars). Both renderers rebuild every node element on every
 * render, so without this, a value Supercharged Links had already discovered before the rebuild
 * would vanish the instant this node's path re-renders, only to reappear whenever the observer
 * next happens to fire — and since `.bases-structure-node` sizes itself from its own content
 * (`width: max-content`, since 0b0d1df), an attribute that adds an `::after` icon appearing *after*
 * this node was already measured is exactly what pushed that icon onto a second line (nowhere else
 * for it to go once the node had already been laid out narrower).
 *
 * Copies a `data-link-*` attribute (and its CSS variable) from `previousTitle` onto `titleEl` only
 * when `titleEl` doesn't already carry that name (scalar frontmatter, just applied above by
 * `applySuperchargedLinkAttributes`, always wins over a carried-over value for the same name) *and*
 * `isSuperchargedLinkAttributeStillTrue` says the note's current state still backs it — otherwise a
 * deleted frontmatter key's attribute would carry forward forever instead of disappearing on the
 * next render, same as before this whole mechanism existed. No classes are carried: unlike an
 * attribute, this module can't tell whether an arbitrary class Supercharged Links added still
 * applies, so nothing beyond the fixed `data-link-icon`/`data-link-icon-after`/`data-link-text`
 * classes `createNodeElement` already always adds is carried over. A no-op when there is no
 * previous title (this path is new this render). */
/** The note-derived facts `isSuperchargedLinkAttributeStillTrue` checks each carry-over candidate
 * against — bundled into one object purely to stay inside this project's `max-params` budget. */
interface CurrentLinkState {
  readonly frontmatter: FrontMatterCache | undefined;
  readonly hasAnyTag: boolean;
}

function readCurrentLinkState(app: App, path: string): CurrentLinkState {
  const cache = app.metadataCache.getCache(path.normalize('NFC'));
  return {
    frontmatter: cache?.frontmatter,
    hasAnyTag: cache !== null && (getAllTags(cache)?.length ?? 0) > 0,
  };
}

/** One `data-link-*` attribute of `previousTitle`, copied onto `titleEl` (with its CSS variable)
 * when eligible — see `carryOverSuperchargedLinkState`'s own doc comment for the full contract.
 * Split out from it purely to stay inside this project's `complexity` budget. */
function carryOneSuperchargedLinkAttribute(
  titleEl: HTMLElement,
  previousTitle: HTMLElement,
  attr: Attr,
  current: CurrentLinkState,
): void {
  if (!attr.name.startsWith('data-link-') || titleEl.hasAttribute(attr.name)) {
    return;
  }
  const key = attr.name.slice('data-link-'.length);
  if (!isSuperchargedLinkAttributeStillTrue(key, current.frontmatter, current.hasAnyTag)) {
    return;
  }
  titleEl.setAttribute(attr.name, attr.value);
  const cssVar = `--${attr.name}`;
  const previousCssValue = previousTitle.style.getPropertyValue(cssVar);
  if (previousCssValue !== '') {
    titleEl.style.setProperty(cssVar, previousCssValue);
  }
}

function carryOverSuperchargedLinkState(
  titleEl: HTMLElement,
  previousTitle: HTMLElement | undefined,
  app: App,
  path: string,
): void {
  if (previousTitle === undefined) {
    return;
  }
  const current = readCurrentLinkState(app, path);
  for (const attr of Array.from(previousTitle.attributes)) {
    carryOneSuperchargedLinkAttribute(titleEl, previousTitle, attr, current);
  }
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
  const titleEl = el.createEl('a', {
    cls: 'internal-link bases-structure-title',
    text: displayName(ctx.snapshot, node.path),
    // No real `href`: navigation is fully handled by `attachNodeInteractions` (via `data-href`).
    // `tabindex="-1"` (M10) keeps the title out of the regular Tab order — the node itself is
    // already the one Tab stop (`applyActiveNode`'s roving tabindex), and a separate stop for the
    // title inside it doubled every node's Tab count for no benefit (the title still opens on a
    // real click, and keyboard `Enter` on the active node already opens it — see `keyboard.ts`).
    attr: { 'data-href': node.path, tabindex: '-1' },
  });
  // D1: the same classes/attributes Supercharged Links styles a normal internal link with, so a
  // node's title reads exactly like a wikilink to the same note elsewhere in the vault — see
  // `src/obsidian/supercharged-links.ts`'s own doc comment for why this is a no-op without that
  // plugin installed.
  titleEl.classList.add('data-link-icon', 'data-link-icon-after', 'data-link-text');
  applySuperchargedLinkAttributes(ctx.app, titleEl, node.path);
  carryOverSuperchargedLinkState(titleEl, flags.previousTitle, ctx.app, node.path);
  appendAddButton(el);
  appendNodeMenuButton(el);
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

/** D1 follow-up: every currently-rendered title element under `root`, keyed by its node's own
 * `data-path` — a snapshot both renderers take right before they tear down the *previous* render's
 * elements, so `createNodeElement`'s `previousTitle` flag has something to carry Supercharged
 * Links' own state from (see `carryOverSuperchargedLinkState`). Must be called before the
 * container is emptied for the next render, or there is nothing left to collect. */
export function collectTitleElements(root: HTMLElement): Map<string, HTMLElement> {
  const titlesByPath = new Map<string, HTMLElement>();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(NODE_SELECTOR))) {
    const path = el.getAttribute('data-path');
    const title = el.querySelector<HTMLElement>(TITLE_SELECTOR);
    if (path !== null && title !== null) {
      titlesByPath.set(path, title);
    }
  }
  return titlesByPath;
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

/** I10: touch-only stand-in for the `contextmenu` right-click — always in the DOM (mirrors the
 * "+"/toggle) but only ever visible under `(hover: none)` in `styles.css`, so a mouse/pen user
 * (who already has the right-click menu) never sees it take up space. */
function appendNodeMenuButton(el: HTMLElement): void {
  const button = el.createEl('button', {
    cls: 'bases-structure-node-menu',
    attr: { type: 'button', 'aria-label': 'Node menu', 'data-action': 'menu' },
  });
  setSizedIcon(button, 'more-horizontal');
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

interface ButtonHit {
  readonly nodeEl: HTMLElement;
  readonly buttonEl: HTMLElement;
  readonly path: string;
}

/** The node whose button (matching `selector`) was clicked, its own path, and the button itself
 * (U1: a menu that follows positions from the button's own rect, not the whole node's) — `null`
 * when the click didn't land on a button matching `selector` at all. Shared by `readAddHit` (the
 * "+") and `readMenuHit` (I10's touch-only node-menu button) — both resolve identically, only the
 * selector differs. */
function readButtonHit(event: MouseEvent, selector: string): ButtonHit | null {
  if (!(event.target instanceof HTMLElement)) {
    return null;
  }
  const buttonEl = event.target.closest<HTMLElement>(selector);
  if (buttonEl === null) {
    return null;
  }
  const nodeEl = buttonEl.closest<HTMLElement>(NODE_SELECTOR);
  if (nodeEl === null) {
    return null;
  }
  const path = nodeEl.getAttribute('data-path');
  if (path === null) {
    return null;
  }
  return { nodeEl, buttonEl, path };
}

function readAddHit(event: MouseEvent): ButtonHit | null {
  return readButtonHit(event, ADD_SELECTOR);
}

function readMenuHit(event: MouseEvent): ButtonHit | null {
  return readButtonHit(event, MENU_SELECTOR);
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
      ctx.onAdd(addHit.path, addHit.nodeEl, addHit.buttonEl);
      return;
    }
    const menuHit = readMenuHit(event);
    if (menuHit !== null) {
      event.stopPropagation();
      ctx.onMenu(menuHit.path, menuHit.nodeEl, menuHit.buttonEl);
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
