// Mind-map style keyboard control (task 16): roving focus over the same `Structure` model both
// renderers draw, shared between the graph and the outline through the `KeyboardDeps` contract
// rather than either renderer's own DOM shape. Nothing here hijacks typing — every entry point
// (keydown and click alike) bails out immediately when the event target is an `input`, `textarea`
// or `[contenteditable]`, since the create draft owns its own Enter/Tab/Escape handling (see
// `actions-ui.ts`).

import type { Direction } from '../core/schema.js';
import type { Structure, StructureNode } from '../core/structure.js';
import { applyActiveNode, focusActiveNode } from './node-element.js';
import type { ViewUiState } from './view-state.js';

/** Containers `setActive` is *itself* mid-way through focusing (see its Escape/`path === null`
 * branch). `.focus()` dispatches `focus` synchronously, and the container has its own `focus`
 * listener (`handleContainerFocus`, "entering by keyboard activates the root") — without this
 * guard, focusing the container to give Escape somewhere sane to land would immediately re-fire
 * that listener and re-activate a node, undoing the very thing Escape just did. A `WeakSet` keyed
 * by container (not a single module-level flag) so concurrent `attachKeyboard` instances — more
 * than one structure view open at once — can't interfere with each other. */
const focusingContainerProgrammatically = new WeakSet<HTMLElement>();

export interface KeyboardDeps {
  readonly container: HTMLElement;
  readonly getStructure: () => Structure;
  readonly getState: () => ViewUiState;
  /** Collapse/expand (Space, ArrowLeft/ArrowRight) only ever change `state.collapsed`, which the
   * schema/snapshot/structure the last render already produced can still answer against — so this
   * re-draws from that same, already-computed `RenderInput` (a renderer's own cheap `update()`,
   * not a full re-render: no schema re-parse, no snapshot re-read, no `buildStructure` — see I6,
   * which measured a full `render()` here as one of `buildStructure`'s several multipliers per
   * user interaction). */
  readonly renderCollapse: () => void;
  readonly open: (path: string, newTab: boolean) => void;
  readonly addChild: (path: string, anchorEl: HTMLElement) => void;
  readonly addSibling: (path: string, anchorEl: HTMLElement) => void;
  readonly movePicker: (path: string) => void;
  readonly retype: (path: string, anchorEl: HTMLElement) => void;
  readonly undo: () => void;
  /** Which axis the *graph* currently grows along (U3) — arrow-key roles mirror accordingly (see
   * `keyHandlersFor`). The outline has no growth axis of its own and always behaves as `'right'`;
   * `structure-view.ts`'s wiring is what enforces that (it reports `'right'` whenever the outline
   * is the active renderer, regardless of `Schema.direction`), not this module. */
  readonly getDirection: () => Direction;
}

const NODE_SELECTOR = '.bases-structure-node';
// Matches `node-element.ts`'s own selector — kept as a local copy for the same reason
// `NODE_SELECTOR` above is (see this module's own doc comment): a title click already opens the
// note (`attachNodeInteractions`'s delegated listener on the renderer's own container), and I9
// decided that gesture shouldn't *also* activate the node for keyboard purposes — clicking a title
// to navigate away is not "select this node", and doing so anyway is what let a stale `state.active`
// (which survives a view being torn down and recreated) steal focus/scroll back on this same node
// on a later, unrelated visit.
const TITLE_SELECTOR = '.bases-structure-title';

/** Everything a key handler needs about "the currently active node" — resolved once per keydown
 * (`resolveActiveCtx`) so the individual handlers below stay simple lookups/mutations. */
interface ActiveCtx {
  readonly path: string;
  readonly node: StructureNode;
  readonly structure: Structure;
  readonly state: ViewUiState;
  readonly anchorEl: HTMLElement | null;
}

type KeyHandler = (deps: KeyboardDeps, ctx: ActiveCtx) => void;

/** The nearest ancestor-or-self with an *explicit* `contenteditable` value wins — an inner
 * `contenteditable="false"` must override an outer `contenteditable="true"`, not the other way
 * round. This is exactly what the native `isContentEditable` getter computes, but jsdom doesn't
 * implement that getter at all, so it's reimplemented here as a plain walk. Matters in practice:
 * Obsidian renders an embedded Bases view inside live-preview notes as a `contenteditable="false"`
 * island *inside* the editor's own `contenteditable="true"` root — a naive `target.closest
 * ('[contenteditable="true"]')` would match that outer root and treat every click/keypress in the
 * view as "typing", permanently disabling keyboard control outside Reading view. */
function isExplicitlyContentEditable(el: HTMLElement): boolean {
  let current: HTMLElement | null = el;
  while (current !== null) {
    const value = current.getAttribute('contenteditable');
    if (value === 'true' || value === '') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    current = current.parentElement;
  }
  return false;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.closest('input, textarea') !== null || isExplicitlyContentEditable(target);
}

function isMod(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

/** Single characters are case-normalized (so Shift+Z's `key` of `'Z'` still matches the plain `z`
 * binding, with `shiftKey` itself driving the `Shift+` prefix below) — multi-character key names
 * (`'ArrowDown'`, `'Enter'`, ...) are already canonical and left untouched. */
function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** A canonical `"Shift+Mod+Alt+key"` string (only the modifiers actually held are included) used
 * as the lookup key into `KEY_HANDLERS` — this is what keeps e.g. `Mod+Shift+Z` from matching the
 * plain `Mod+z` undo binding, and `Mod+m`/`Shift+m` from matching the plain `m` binding, without
 * any handler needing its own modifier checks. */
function bindingKey(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.shiftKey) {
    parts.push('Shift');
  }
  if (isMod(event)) {
    parts.push('Mod');
  }
  if (event.altKey) {
    parts.push('Alt');
  }
  parts.push(normalizeKey(event.key));
  return parts.join('+');
}

/** Every `.bases-structure-node` under `root` whose `data-path` is `path` — the same linear scan
 * `node-element.ts`'s own `findNodeElement` and `actions-ui.ts`'s private copy use (a note path
 * can contain characters a CSS attribute selector would need escaping). Kept as a local copy
 * (rather than importing the shared one) since this is the only other thing in the module that
 * still only needs `KeyboardDeps` — `setActive` below does reach into `node-element.ts` for the
 * two functions that actually own drawing `.is-active`. */
function findNodeElement(root: HTMLElement, path: string): HTMLElement | null {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(NODE_SELECTOR))) {
    if (el.getAttribute('data-path') === path) {
      return el;
    }
  }
  return null;
}

/** The ordered group `node` navigates among with Up/Down/Home/End: its parent's `children` when
 * it has one, or the forest tops (`tops` then `orphans`) when it's top-level — the same "forest
 * tops" grouping `graph-renderer.ts`'s `collectVisibleEntries` uses. Falls back to a
 * single-element list of just `node.path` when the parent pointer doesn't resolve (a broken
 * invariant `structure.ts` doesn't currently produce, but this module doesn't trust it blindly). */
function siblingsOf(structure: Structure, node: StructureNode): readonly string[] {
  if (node.parent === null) {
    return [...structure.tops, ...structure.orphans];
  }
  return structure.nodes.get(node.parent)?.children ?? [node.path];
}

function moveBy(ctx: ActiveCtx, delta: number): string | null {
  const siblings = siblingsOf(ctx.structure, ctx.node);
  const index = siblings.indexOf(ctx.path);
  if (index === -1) {
    return null;
  }
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= siblings.length) {
    return null;
  }
  return siblings[nextIndex] ?? null;
}

function edgeOf(ctx: ActiveCtx, edge: 'first' | 'last'): string | null {
  const siblings = siblingsOf(ctx.structure, ctx.node);
  if (siblings.length === 0) {
    return null;
  }
  return (edge === 'first' ? siblings[0] : siblings[siblings.length - 1]) ?? null;
}

/** The one place that changes `state.active`: updates the roving container tabindex (0 when
 * nothing is active so it can be tabbed into, -1 once a node owns focus) and applies
 * `.is-active`/per-node tabindex/focus/scroll straight to the *current* DOM via
 * `node-element.ts`'s `applyActiveNode`/`focusActiveNode` — deliberately not a `deps.renderCollapse()`.
 * A render (even the cheap `renderCollapse()` path) rebuilds every node element wholesale, which is
 * both unnecessary for a pure "move focus among already-rendered nodes" change and actively wrong
 * when the click that triggered it also landed on a collapse toggle or the "+" button: those
 * already re-render themselves before this handler runs (their listener is on a nearer ancestor,
 * so it fires first during bubbling) — a second one on top would be redundant work and once made
 * `GraphRenderer.update`/`OutlineRenderer.update` run twice for a single toggle click. Handlers
 * that actually change *which nodes are rendered* (collapse/expand) still call
 * `deps.renderCollapse()` themselves, separately from `setActive`.
 *
 * `path === null` (Escape) is the one case `applyActiveNode` never returns an element for — left
 * alone, real DOM focus would stay on the *previous* active node, which now has `tabindex="-1"`:
 * `document.activeElement` would be stuck there, so a later Tab wouldn't reliably land back on the
 * container (roving tabindex only governs which element a Tab *lands on*, not where the next Tab
 * *starts from* — the browser still starts from wherever real focus currently is). Moving focus to
 * the container itself (now `tabindex="0"`) when focus was inside it is what "Escape — clear the
 * active node (blur)" (see the decisions) means in practice: nothing is visually active, but the
 * view stays a single, re-enterable Tab stop instead of a dead end. */
function setActive(deps: KeyboardDeps, path: string | null): void {
  const state = deps.getState();
  state.active = path;
  deps.container.tabIndex = path === null ? 0 : -1;
  const activeEl = applyActiveNode(deps.container, path);
  if (activeEl !== null) {
    focusActiveNode(activeEl);
    return;
  }
  // M3: `deps.container.doc` (its own owner document — a pop-out window's, when the view is open
  // in one), not the global `document` — otherwise this always read the *main* window's
  // `activeElement`, which is never the container even when focus genuinely is inside it, just in
  // a different window.
  if (deps.container.contains(deps.container.doc.activeElement)) {
    focusingContainerProgrammatically.add(deps.container);
    deps.container.focus({ preventScroll: true });
    focusingContainerProgrammatically.delete(deps.container);
  }
}

function moveActive(deps: KeyboardDeps, target: string | null): void {
  if (target !== null) {
    setActive(deps, target);
  }
}

function handleArrowUp(deps: KeyboardDeps, ctx: ActiveCtx): void {
  moveActive(deps, moveBy(ctx, -1));
}

function handleArrowDown(deps: KeyboardDeps, ctx: ActiveCtx): void {
  moveActive(deps, moveBy(ctx, 1));
}

function handleArrowLeft(deps: KeyboardDeps, ctx: ActiveCtx): void {
  if (ctx.node.children.length > 0 && !ctx.state.collapsed.has(ctx.path)) {
    ctx.state.collapsed.add(ctx.path);
    deps.renderCollapse();
    return;
  }
  if (ctx.node.parent !== null) {
    setActive(deps, ctx.node.parent);
  }
}

function handleArrowRight(deps: KeyboardDeps, ctx: ActiveCtx): void {
  if (ctx.node.children.length === 0) {
    return;
  }
  if (ctx.state.collapsed.has(ctx.path)) {
    ctx.state.collapsed.delete(ctx.path);
    deps.renderCollapse();
    return;
  }
  moveActive(deps, ctx.node.children[0] ?? null);
}

function handleHome(deps: KeyboardDeps, ctx: ActiveCtx): void {
  moveActive(deps, edgeOf(ctx, 'first'));
}

function handleEnd(deps: KeyboardDeps, ctx: ActiveCtx): void {
  moveActive(deps, edgeOf(ctx, 'last'));
}

function handleSpace(deps: KeyboardDeps, ctx: ActiveCtx): void {
  if (ctx.node.children.length === 0) {
    return;
  }
  if (ctx.state.collapsed.has(ctx.path)) {
    ctx.state.collapsed.delete(ctx.path);
  } else {
    ctx.state.collapsed.add(ctx.path);
  }
  deps.renderCollapse();
}

function handleEnter(deps: KeyboardDeps, ctx: ActiveCtx): void {
  deps.open(ctx.path, false);
}

function handleModEnter(deps: KeyboardDeps, ctx: ActiveCtx): void {
  deps.open(ctx.path, true);
}

function handleTab(deps: KeyboardDeps, ctx: ActiveCtx): void {
  if (ctx.anchorEl !== null) {
    deps.addChild(ctx.path, ctx.anchorEl);
  }
}

function handleShiftEnter(deps: KeyboardDeps, ctx: ActiveCtx): void {
  if (ctx.anchorEl !== null) {
    deps.addSibling(ctx.path, ctx.anchorEl);
  }
}

function handleMove(deps: KeyboardDeps, ctx: ActiveCtx): void {
  deps.movePicker(ctx.path);
}

function handleRetype(deps: KeyboardDeps, ctx: ActiveCtx): void {
  if (ctx.anchorEl !== null) {
    deps.retype(ctx.path, ctx.anchorEl);
  }
}

function handleUndo(deps: KeyboardDeps): void {
  deps.undo();
}

function handleEscape(deps: KeyboardDeps): void {
  setActive(deps, null);
}

/** Every binding that doesn't depend on direction — shared by both `KEY_HANDLERS_RIGHT` and
 * `KEY_HANDLERS_DOWN` below. Keeping dispatch a single lookup, rather than an if/else chain over
 * every combination, is what keeps this module's cyclomatic/cognitive complexity within budget. */
const COMMON_KEY_HANDLERS: Record<string, KeyHandler> = {
  Home: handleHome,
  End: handleEnd,
  ' ': handleSpace,
  Enter: handleEnter,
  'Mod+Enter': handleModEnter,
  Tab: handleTab,
  'Shift+Enter': handleShiftEnter,
  m: handleMove,
  t: handleRetype,
  Escape: handleEscape,
};

/** `direction: 'right'` (the default): Up/Down move among siblings, Left/Right collapse-or-go-to-
 * parent / expand-or-go-to-first-child — matching the tree's own left-to-right growth axis. */
const KEY_HANDLERS_RIGHT: Record<string, KeyHandler> = {
  ...COMMON_KEY_HANDLERS,
  ArrowUp: handleArrowUp,
  ArrowDown: handleArrowDown,
  ArrowLeft: handleArrowLeft,
  ArrowRight: handleArrowRight,
};

/** `direction: 'down'` (U3): the same four handlers as `KEY_HANDLERS_RIGHT`, mirrored onto the
 * physical keys that now match the tree's top-to-bottom growth axis — Left/Right move among
 * siblings (who now spread horizontally), Up/Down collapse-or-parent / expand-or-first-child (who
 * now sit above/below). */
const KEY_HANDLERS_DOWN: Record<string, KeyHandler> = {
  ...COMMON_KEY_HANDLERS,
  ArrowLeft: handleArrowUp,
  ArrowRight: handleArrowDown,
  ArrowUp: handleArrowLeft,
  ArrowDown: handleArrowRight,
};

function keyHandlersFor(direction: Direction): Record<string, KeyHandler> {
  return direction === 'down' ? KEY_HANDLERS_DOWN : KEY_HANDLERS_RIGHT;
}

/** M7: `Mod+z` is deliberately outside `KEY_HANDLERS`/`resolveActiveCtx` — every other binding
 * needs an active node (`ActiveCtx`) to act on, but undo doesn't; gating it on one anyway (as an
 * ordinary entry in the map used to) meant Mod+Z silently did nothing whenever focus was in the
 * view but nothing happened to be active (e.g. right after Escape, or a fresh view nothing has
 * clicked into yet). Checked before `resolveActiveCtx` in `onKeyDown` for exactly that reason. */
const UNDO_BINDING = 'Mod+z';

/** `undefined` means `state.active` names a path the structure no longer has (the node was moved,
 * retyped away, or deleted out from under an active keyboard session) — rather than leaving that
 * stale path in place forever (which would also leave `container.tabindex="-1"`, so Tab could
 * never re-enter the view at all), this clears `active` and restores the roving-tabindex default
 * so a keyboard user can just Tab back in. */
function resolveActiveCtx(deps: KeyboardDeps): ActiveCtx | null {
  const state = deps.getState();
  if (state.active === null) {
    return null;
  }
  const structure = deps.getStructure();
  const node = structure.nodes.get(state.active);
  if (node === undefined) {
    state.active = null;
    deps.container.tabIndex = 0;
    return null;
  }
  return {
    path: state.active,
    node,
    structure,
    state,
    anchorEl: findNodeElement(deps.container, state.active),
  };
}

/** Entering the container from outside (Tab landing on it, since it holds `tabindex="0"` while
 * nothing is active) activates the root, or the first top when there's no root, or the first
 * orphan when there isn't even that — mirrors the graph/outline renderers' own "forest tops"
 * fallback order. A no-op once something is already active (this only fires for the container
 * itself, never a descendant — `focus` doesn't bubble), and also a no-op while `setActive` is
 * itself the one that just focused the container (see `focusingContainerProgrammatically`) — a
 * genuine "user tabbed in" focus and "we redirected focus here after Escape" are otherwise
 * indistinguishable, since both just look like "the container received focus". */
function handleContainerFocus(deps: KeyboardDeps): void {
  if (focusingContainerProgrammatically.has(deps.container) || deps.getState().active !== null) {
    return;
  }
  const structure = deps.getStructure();
  const target = structure.root ?? structure.tops[0] ?? structure.orphans[0] ?? null;
  if (target !== null) {
    setActive(deps, target);
  }
}

function handleContainerClick(deps: KeyboardDeps, event: MouseEvent): void {
  if (!(event.target instanceof HTMLElement) || isTypingTarget(event.target)) {
    return;
  }
  // A title click opens the note (see this constant's own doc comment) rather than selecting the
  // node — leave `state.active` alone so navigating away doesn't also change keyboard focus.
  if (event.target.closest(TITLE_SELECTOR) !== null) {
    return;
  }
  const path = event.target.closest<HTMLElement>(NODE_SELECTOR)?.getAttribute('data-path');
  if (path !== null && path !== undefined) {
    setActive(deps, path);
  }
}

/** Wires roving-focus keyboard control to `deps.container` (both renderers' shared mount point):
 * one delegated `keydown` for every shortcut in `KEY_HANDLERS`, one `focus` to activate a node
 * when the container itself is tabbed into, and one `click` so clicking a node also makes it
 * active (without stealing the title's own link/hover behaviour — see `node-element.ts`'s
 * `attachNodeInteractions`, which owns that separately). Returns a disposer removing all three. */
export function attachKeyboard(deps: KeyboardDeps): () => void {
  deps.container.tabIndex = deps.getState().active === null ? 0 : -1;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) {
      return;
    }
    const key = bindingKey(event);
    if (key === UNDO_BINDING) {
      event.preventDefault();
      handleUndo(deps);
      return;
    }
    const ctx = resolveActiveCtx(deps);
    if (ctx === null) {
      return;
    }
    const handler = keyHandlersFor(deps.getDirection())[key];
    if (handler === undefined) {
      return;
    }
    event.preventDefault();
    handler(deps, ctx);
  };

  const onFocus = (): void => {
    handleContainerFocus(deps);
  };

  const onClick = (event: MouseEvent): void => {
    handleContainerClick(deps, event);
  };

  deps.container.addEventListener('keydown', onKeyDown);
  deps.container.addEventListener('focus', onFocus);
  deps.container.addEventListener('click', onClick);

  return () => {
    deps.container.removeEventListener('keydown', onKeyDown);
    deps.container.removeEventListener('focus', onFocus);
    deps.container.removeEventListener('click', onClick);
  };
}
