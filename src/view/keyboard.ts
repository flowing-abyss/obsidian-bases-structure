// Mind-map style keyboard control (task 16): roving focus over the same `Structure` model both
// renderers draw, shared between the graph and the outline through the `KeyboardDeps` contract
// rather than either renderer's own DOM shape. Nothing here hijacks typing — every entry point
// (keydown and click alike) bails out immediately when the event target is an `input`, `textarea`
// or `[contenteditable]`, since the create draft owns its own Enter/Tab/Escape handling (see
// `actions-ui.ts`).

import type { Structure, StructureNode } from '../core/structure.js';
import type { ViewUiState } from './view-state.js';

export interface KeyboardDeps {
  readonly container: HTMLElement;
  readonly getStructure: () => Structure;
  readonly getState: () => ViewUiState;
  readonly refresh: () => void;
  readonly open: (path: string, newTab: boolean) => void;
  readonly addChild: (path: string, anchorEl: HTMLElement) => void;
  readonly addSibling: (path: string, anchorEl: HTMLElement) => void;
  readonly movePicker: (path: string) => void;
  readonly retype: (path: string, anchorEl: HTMLElement) => void;
  readonly undo: () => void;
}

const NODE_SELECTOR = '.bases-structure-node';

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
 * can contain characters a CSS attribute selector would need escaping), kept local here too so
 * this module only depends on `KeyboardDeps`, not on the renderers' own helpers. */
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
 * nothing is active so it can be tabbed into, -1 once a node owns focus) and re-renders so the
 * renderers can re-derive `.is-active`/per-node tabindex/scroll from the new value — see
 * `node-element.ts`'s `applyActiveNode`/`focusActiveNode`. */
function setActive(deps: KeyboardDeps, path: string | null): void {
  deps.getState().active = path;
  deps.container.tabIndex = path === null ? 0 : -1;
  deps.refresh();
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
    deps.refresh();
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
    deps.refresh();
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
  deps.refresh();
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

/** Map of binding key (see `bindingKey`) to handler — keeping dispatch a single lookup, rather
 * than an if/else chain over every combination, is what keeps this module's cyclomatic/cognitive
 * complexity within budget. */
const KEY_HANDLERS: Record<string, KeyHandler> = {
  ArrowUp: handleArrowUp,
  ArrowDown: handleArrowDown,
  ArrowLeft: handleArrowLeft,
  ArrowRight: handleArrowRight,
  Home: handleHome,
  End: handleEnd,
  ' ': handleSpace,
  Enter: handleEnter,
  'Mod+Enter': handleModEnter,
  Tab: handleTab,
  'Shift+Enter': handleShiftEnter,
  m: handleMove,
  t: handleRetype,
  'Mod+z': handleUndo,
  Escape: handleEscape,
};

function resolveActiveCtx(deps: KeyboardDeps): ActiveCtx | null {
  const state = deps.getState();
  if (state.active === null) {
    return null;
  }
  const structure = deps.getStructure();
  const node = structure.nodes.get(state.active);
  if (node === undefined) {
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
 * itself, never a descendant — `focus` doesn't bubble). */
function handleContainerFocus(deps: KeyboardDeps): void {
  if (deps.getState().active !== null) {
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
    const ctx = resolveActiveCtx(deps);
    if (ctx === null) {
      return;
    }
    const handler = KEY_HANDLERS[bindingKey(event)];
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
