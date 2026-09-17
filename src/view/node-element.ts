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
  /** The one render right after this node was created (I7) — a transient highlight, so
   * `updateNodeElement` must actively clear it on every later render, not just add it once. */
  readonly isNew?: boolean;
  /** The same path's title element from the render being replaced, if any — its `data-link-*`
   * attributes are carried forward where still backed by current state (see
   * `carryOverSuperchargedLinkState`); no classes are carried. `collectTitleElements` builds the
   * map callers pass this from. Only consulted for an element being created fresh: a reused
   * element's own title is never replaced, so it has nothing to carry from. */
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
const ALSOIN_SELECTOR = '.bases-structure-alsoin';
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

/** Whether Supercharged Links' `data-link-<key>` is still backed by the note's current state, and
 * so safe to carry forward from a previous render: some frontmatter key normalises to `key`
 * (Supercharged Links lowercases the attribute name and replaces spaces with hyphens, so
 * `Due Date` backs `due-date`) — any value type, since a list is exactly what
 * `applySuperchargedLinkAttributes` never sets itself; `tags` also counts via any current tag,
 * frontmatter or inline; `path`/`data-href` are file-derived, never frontmatter, so always
 * eligible. Everything else is dropped. */
function isSuperchargedLinkAttributeStillTrue(
  key: string,
  frontmatter: FrontMatterCache | undefined,
  hasAnyTag: boolean,
): boolean {
  if (frontmatter !== undefined) {
    for (const frontmatterKey of Object.keys(frontmatter)) {
      if (frontmatterKey.replace(/ /g, '-').toLowerCase() === key) {
        return true;
      }
    }
  }
  if (key === 'tags') {
    return hasAnyTag;
  }
  return key === 'path' || key === 'data-href';
}

/** The current-state facts `isSuperchargedLinkAttributeStillTrue` checks against, bundled to stay
 * under this project's `max-params` budget. */
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

/** One `data-link-*` attribute of `previousTitle`, copied onto `titleEl` when eligible — split out
 * from `carryOverSuperchargedLinkState` to stay under this project's `complexity` budget. */
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

/** Supercharged Links sets `data-link-<key>` for non-scalar frontmatter (e.g. tags) itself,
 * asynchronously, via its own `MutationObserver` — `applySuperchargedLinkAttributes` only ever
 * handles scalars. A genuinely new element still needs this: without it, a value Supercharged
 * Links had already found on the node it replaces would vanish, and the `::after` icon some
 * `data-link-*` attributes add would appear after this node was already measured, wrapping onto a
 * second line for lack of room. A node that merely stays keeps its title outright (see
 * `updateNodeElement`), so this never runs for one.
 *
 * Copies a `data-link-*` attribute (and its CSS variable) from `previousTitle` onto `titleEl` when
 * `titleEl` doesn't already carry that name (fresh frontmatter always wins) and
 * `isSuperchargedLinkAttributeStillTrue` confirms it's still backed. No classes are carried — only
 * the fixed `data-link-icon`/`data-link-icon-after`/`data-link-text` classes survive. A no-op with
 * no previous title. */
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

/** `data-path`/`data-type` — the two attributes that identify a node and never change identity
 * across an update, only value (a `type` edit stays the same element). Shared by `createNodeElement`
 * and `updateNodeElement`. */
function applyNodeAttributes(el: HTMLElement, node: StructureNode): void {
  el.setAttribute('data-path', node.path);
  el.setAttribute('data-type', node.type ?? '');
}

/** `is-root`/`is-orphan`/`is-new` — every class that depends on `flags` rather than being fixed
 * at creation (`bases-structure-node` itself). `toggle`, not `add`, so a reused element's classes
 * actually track the current render instead of only ever accumulating (`is-new` in particular
 * must be removable — see `NodeElementFlags.isNew`'s own doc comment). */
function applyNodeClasses(el: HTMLElement, flags: NodeElementFlags): void {
  el.classList.toggle('is-root', flags.isRoot === true);
  el.classList.toggle('is-orphan', flags.isOrphan === true);
  el.classList.toggle('is-new', flags.isNew === true);
}

/** The title's node-derived content — text and the path `attachNodeInteractions` reads clicks
 * against. Never touches classes, `tabindex` or `data-link-*`: those are either fixed at creation
 * or Supercharged Links' own state (see `refreshSuperchargedLinkAttributes`). */
function updateTitleContent(
  titleEl: HTMLElement,
  ctx: NodeElementContext,
  node: StructureNode,
): void {
  titleEl.textContent = displayName(ctx.snapshot, node.path);
  titleEl.setAttribute('data-href', node.path);
}

/** Rebuilds the "also lives here" chip from scratch — cheap and holds no external state (unlike
 * the title), so a stale chip is simply dropped and a current one appended in its place. A no-op
 * append when `node.alsoIn` is empty (see `appendAlsoIn`). */
function updateAlsoIn(el: HTMLElement, ctx: NodeElementContext, node: StructureNode): void {
  el.querySelector(ALSOIN_SELECTOR)?.remove();
  appendAlsoIn(el, ctx, node);
}

/** The node card: `div.bases-structure-node` (`data-path`, `data-type`, `is-root`/`is-orphan`)
 * containing the title link and, when present, the "also in" chip. */
export function createNodeElement(
  ctx: NodeElementContext,
  node: StructureNode,
  flags: NodeElementFlags = {},
): HTMLElement {
  const el = createDiv({ cls: 'bases-structure-node' });
  applyNodeAttributes(el, node);
  applyNodeClasses(el, flags);
  const titleEl = el.createEl('a', {
    cls: 'internal-link bases-structure-title',
    // No real `href`: navigation is fully handled by `attachNodeInteractions` (via `data-href`).
    // `tabindex="-1"` (M10) keeps the title out of the regular Tab order — the node itself is
    // already the one Tab stop (`applyActiveNode`'s roving tabindex), and a separate stop for the
    // title inside it doubled every node's Tab count for no benefit (the title still opens on a
    // real click, and keyboard `Enter` on the active node already opens it — see `keyboard.ts`).
    attr: { tabindex: '-1' },
  });
  updateTitleContent(titleEl, ctx, node);
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

/** Refreshes an existing node element in place — the title element instance survives (so
 * Supercharged Links' own state on it survives too), only its text/`data-href` are updated.
 * Re-applies `data-path`/`data-type`, `is-root`/`is-orphan`/`is-new`, and the alsoIn chip. Never
 * touches `data-link-*`: a reused title's Supercharged Links state is refreshed separately, by
 * `refreshSuperchargedLinkAttributes` — kept apart so a caller that only wants the plain node data
 * refreshed (e.g. this file's own tests) never has to reason about frontmatter/tag state too. */
export function updateNodeElement(
  el: HTMLElement,
  ctx: NodeElementContext,
  node: StructureNode,
  flags: NodeElementFlags = {},
): void {
  applyNodeAttributes(el, node);
  applyNodeClasses(el, flags);
  const titleEl = el.querySelector<HTMLElement>(TITLE_SELECTOR);
  if (titleEl !== null) {
    updateTitleContent(titleEl, ctx, node);
  }
  updateAlsoIn(el, ctx, node);
}

/** Keeps a *reused* title's `data-link-*` state in sync with current frontmatter/tags — the
 * refresh a persisting node's title now needs instead of the rebuild it used to get for free.
 * Removes any `data-link-*` attribute (and its `--data-link-*` CSS variable)
 * `isSuperchargedLinkAttributeStillTrue` no longer backs, then reapplies every current scalar
 * frontmatter value via `applySuperchargedLinkAttributes` — together, the same two checks
 * `carryOverSuperchargedLinkState` makes when building a fresh title, just read straight off the
 * existing element instead of copied from a predecessor. Never touches classes or an attribute
 * still backed by current state (e.g. a non-scalar value Supercharged Links' own observer set) —
 * a no-op when `el` has no title at all. */
export function refreshSuperchargedLinkAttributes(el: HTMLElement, app: App, path: string): void {
  const titleEl = el.querySelector<HTMLElement>(TITLE_SELECTOR);
  if (titleEl === null) {
    return;
  }
  const current = readCurrentLinkState(app, path);
  for (const attr of Array.from(titleEl.attributes)) {
    if (!attr.name.startsWith('data-link-')) {
      continue;
    }
    const key = attr.name.slice('data-link-'.length);
    if (!isSuperchargedLinkAttributeStillTrue(key, current.frontmatter, current.hasAnyTag)) {
      titleEl.removeAttribute(attr.name);
      titleEl.style.removeProperty(`--${attr.name}`);
    }
  }
  applySuperchargedLinkAttributes(app, titleEl, path);
}

/** Every currently-rendered title element under `root`, keyed by its node's own `data-path` — a
 * snapshot taken right before the previous render's elements are torn down, so
 * `createNodeElement`'s `previousTitle` flag has something to carry Supercharged Links' own state
 * from (see `carryOverSuperchargedLinkState`). Must be called before the container is emptied. */
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

/** I11: re-focuses `el` (without scrolling) if it's still a connected `HTMLElement` — for a
 * renderer whose own DOM strategy can blur something nested inside a reused node as a side effect
 * of an unrelated rebuild (`outline-renderer.ts`'s full skeleton teardown/rebuild momentarily
 * detaches every node, including whatever's nested inside one — e.g. an open create draft's own
 * input). Used when `RenderInput.suppressFocus` says this render must not disturb where real
 * focus currently is; a no-op when `el` is `null`, isn't an `HTMLElement`, or didn't survive
 * whatever the rebuild did. */
export function restoreSuppressedFocus(el: Element | null): void {
  if (el instanceof HTMLElement && el.isConnected) {
    el.focus({ preventScroll: true });
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
