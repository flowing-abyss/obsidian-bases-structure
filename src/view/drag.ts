// Delegated pointer-drag for the structure view: a pointerdown+move on a `.bases-structure-node`
// becomes either a "move this node under that parent" or, while Shift is held, a "convert this
// node's type as it moves" gesture. Drop-target/blocked highlighting comes entirely from
// `deps.targetsFor` (wired to the planner's `operationTargets` by `structure-view.ts`) — this
// module knows nothing about the structure/schema itself, only which of the two modes is active.
// The modifier is live: `keydown`/`keyup` on the owner document flip the session's own mode and
// recompute its target set/highlight for as long as the drag is in progress, not just at
// pointerdown. No Obsidian imports: plain DOM, so it runs the same way inside jsdom (see
// `DragDeps.elementAt` — jsdom has neither `document.elementFromPoint` nor real pointer capture)
// and in a real browser.

export type DragMode = 'move' | 'convert';

export interface DragDeps {
  readonly container: HTMLElement;
  readonly targetsFor: (path: string, mode: DragMode) => ReadonlySet<string>;
  readonly onDrop: (node: string, parent: string, mode: DragMode, event: PointerEvent) => void;
  readonly elementAt?: (x: number, y: number) => Element | null;
}

const NODE_SELECTOR = '.bases-structure-node';
const IGNORE_SELECTOR =
  '[data-action], .bases-structure-toggle, .bases-structure-draft, input, button';
const TITLE_SELECTOR = '.bases-structure-title';
const DRAG_THRESHOLD_PX = 4;
const GHOST_CLASS = 'bases-structure-drag-ghost';
const DRAGGING_CLASS = 'is-dragging';
const DROP_TARGET_CLASS = 'is-drop-target';
const DROP_HOVER_CLASS = 'is-drop-hover';
const DRAG_BLOCKED_CLASS = 'is-drag-blocked';
const CONVERT_CLASS = 'is-convert';

interface DragSession {
  readonly pointerId: number;
  readonly sourceEl: HTMLElement;
  readonly sourcePath: string;
  mode: DragMode;
  targets: ReadonlySet<string>;
  readonly ghostEl: HTMLElement;
  readonly startX: number;
  readonly startY: number;
  started: boolean;
  hoveredEl: HTMLElement | null;
  /** Removes the session's own `keydown`/`keyup` Shift tracking — attached in `handlePointerDown`,
   * called from `endSession` so a cancelled/completed gesture never leaves a listener behind
   * (each new drag would otherwise stack another pair on top of the last). */
  readonly stopModifierTracking: () => void;
}

function nodeAncestor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  return target.closest<HTMLElement>(NODE_SELECTOR);
}

function isIgnoredTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(IGNORE_SELECTOR) !== null;
}

/** I10: a touch drag would fight the container's native scrolling (the same one-finger gesture
 * means both "scroll the tree" and "start a drag" on touch) — mouse/pen only. Moving a node on a
 * touch device goes through the node menu's "Move to…" instead. */
function shouldStartDrag(event: PointerEvent): boolean {
  return event.button === 0 && event.pointerType !== 'touch' && !isIgnoredTarget(event.target);
}

function allNodeElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(NODE_SELECTOR));
}

/** Never lets a host's `setPointerCapture`/`releasePointerCapture` abort the gesture: jsdom
 * doesn't implement either at all, and a real browser can still reject the call (e.g. for an
 * element that's already been detached). Real pointer capture is a nice-to-have here, not a
 * requirement — every subsequent pointer event is tracked via `document` listeners regardless. */
function safePointerCapture(el: HTMLElement, pointerId: number, release: boolean): void {
  try {
    if (release) {
      el.releasePointerCapture(pointerId);
    } else {
      el.setPointerCapture(pointerId);
    }
  } catch {
    // Intentionally ignored — see the doc comment above.
  }
}

function buildGhost(sourceEl: HTMLElement, path: string): HTMLElement {
  const ghost = createDiv();
  ghost.className = GHOST_CLASS;
  ghost.textContent = sourceEl.querySelector(TITLE_SELECTOR)?.textContent ?? path;
  return ghost;
}

function positionGhost(ghostEl: HTMLElement, x: number, y: number): void {
  ghostEl.style.left = `${x}px`;
  ghostEl.style.top = `${y}px`;
}

/** (Re-)classifies every other node against `session.targets` — the one-shot pass `beginDrag`
 * runs once the drag actually starts, and the same pass `setSessionMode` re-runs whenever the
 * modifier flips the target set out from under an already-started drag. Re-derives
 * `DROP_HOVER_CLASS` for whatever's currently hovered too, since a node that was a valid target a
 * moment ago can stop being one (or the reverse) without the pointer itself moving. */
function applyTargetClasses(container: HTMLElement, session: DragSession): void {
  for (const el of allNodeElements(container)) {
    if (el === session.sourceEl) {
      continue;
    }
    el.classList.remove(DROP_TARGET_CLASS, DRAG_BLOCKED_CLASS, DROP_HOVER_CLASS);
    const path = el.getAttribute('data-path');
    const isTarget = path !== null && session.targets.has(path);
    el.classList.add(isTarget ? DROP_TARGET_CLASS : DRAG_BLOCKED_CLASS);
  }
  if (session.hoveredEl?.classList.contains(DROP_TARGET_CLASS) === true) {
    session.hoveredEl.classList.add(DROP_HOVER_CLASS);
  }
}

function applyStartClasses(container: HTMLElement, session: DragSession): void {
  session.sourceEl.classList.add(DRAGGING_CLASS);
  applyTargetClasses(container, session);
}

function clearAllClasses(container: HTMLElement): void {
  for (const el of allNodeElements(container)) {
    el.classList.remove(DRAGGING_CLASS, DROP_TARGET_CLASS, DROP_HOVER_CLASS, DRAG_BLOCKED_CLASS);
  }
}

function pastThreshold(session: DragSession, x: number, y: number): boolean {
  return Math.hypot(x - session.startX, y - session.startY) >= DRAG_THRESHOLD_PX;
}

/** The one mutable cell every helper below reads/writes — plain object instead of a closured
 * `let` so the helpers can live at module scope (and each stay well under the function-size
 * budget) instead of being redeclared inside `attachDrag` on every call. */
interface SessionBox {
  current: DragSession | null;
}

function endSession(box: SessionBox, container: HTMLElement): void {
  const current = box.current;
  if (current === null) {
    return;
  }
  box.current = null;
  current.stopModifierTracking();
  clearAllClasses(container);
  current.ghostEl.remove();
  safePointerCapture(current.sourceEl, current.pointerId, true);
}

/** Flips `session.mode`, re-derives its target set from `deps.targetsFor` and the ghost's own
 * `CONVERT_CLASS`, and — only once the drag has actually started (see `beginDrag`) — the
 * highlight itself. A no-op when the modifier's new state matches the mode already in effect
 * (e.g. OS key-repeat re-firing `keydown` while Shift stays held). */
function setSessionMode(deps: DragDeps, session: DragSession, mode: DragMode): void {
  if (session.mode === mode) {
    return;
  }
  session.mode = mode;
  session.targets = deps.targetsFor(session.sourcePath, mode);
  session.ghostEl.classList.toggle(CONVERT_CLASS, mode === 'convert');
  if (session.started) {
    applyTargetClasses(deps.container, session);
  }
}

/** Session-scoped Shift tracking (task 10's own decisions: "the modifier is live" — pressing or
 * releasing Shift mid-drag must recompute the target set, not just read it at pointerdown): attached by
 * `handlePointerDown` once a session exists, removed by `endSession` so a cancelled/completed
 * gesture leaves nothing listening — unlike the module-level Escape handler below, which spans
 * `attachDrag`'s whole lifetime (it's a no-op with no session to cancel anyway). Reads
 * `box.current` at call time, not the `session` given at attach time: by the time either handler
 * fires, that's still the same session (a new one can't start until this one ends), but reading
 * through the box keeps the two lookups textually identical to every other per-event handler here. */
function attachModifierTracking(doc: Document, box: SessionBox, deps: DragDeps): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Shift' && box.current !== null) {
      setSessionMode(deps, box.current, 'convert');
    }
  };
  const handleKeyUp = (event: KeyboardEvent): void => {
    if (event.key === 'Shift' && box.current !== null) {
      setSessionMode(deps, box.current, 'move');
    }
  };
  doc.addEventListener('keydown', handleKeyDown);
  doc.addEventListener('keyup', handleKeyUp);
  return () => {
    doc.removeEventListener('keydown', handleKeyDown);
    doc.removeEventListener('keyup', handleKeyUp);
  };
}

/** `handlePointerDown` as a standalone factory (not a closure inline in `attachDrag`) purely to
 * keep `attachDrag` itself under the project's per-function line budget — behaviorally this is
 * exactly the listener `attachDrag` used to build inline. Starts a new session (in `move` or
 * `convert` mode, from the pointer event's own `shiftKey`) and its Shift tracking; ignored while
 * one is already in progress or the pointerdown doesn't land on a draggable node (see
 * `shouldStartDrag`/`nodeAncestor`). */
function makePointerDownHandler(
  deps: DragDeps,
  box: SessionBox,
  doc: Document,
): (event: PointerEvent) => void {
  return (event) => {
    if (!shouldStartDrag(event) || box.current !== null) {
      return;
    }
    const sourceEl = nodeAncestor(event.target);
    const sourcePath = sourceEl?.getAttribute('data-path') ?? null;
    if (sourceEl === null || sourcePath === null) {
      return;
    }
    const mode: DragMode = event.shiftKey ? 'convert' : 'move';
    const ghostEl = buildGhost(sourceEl, sourcePath);
    ghostEl.classList.toggle(CONVERT_CLASS, mode === 'convert');
    box.current = {
      pointerId: event.pointerId,
      sourceEl,
      sourcePath,
      mode,
      targets: deps.targetsFor(sourcePath, mode),
      ghostEl,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      hoveredEl: null,
      stopModifierTracking: attachModifierTracking(doc, box, deps),
    };
  };
}

/** `handlePointerMove`'s own factory — see `makePointerDownHandler`'s doc comment for why this is
 * split out. Crosses the drag threshold at most once per session (`beginDrag`), then keeps the
 * ghost and hover highlight following the pointer for the rest of it. */
function makePointerMoveHandler(
  deps: DragDeps,
  box: SessionBox,
  elementAt: (x: number, y: number) => Element | null,
): (event: PointerEvent) => void {
  return (event) => {
    const current = box.current;
    if (current?.pointerId !== event.pointerId) {
      return;
    }
    if (!current.started) {
      if (!pastThreshold(current, event.clientX, event.clientY)) {
        return;
      }
      beginDrag(deps.container, current, event.clientX, event.clientY);
    }
    positionGhost(current.ghostEl, event.clientX, event.clientY);
    updateHover(elementAt, current, event.clientX, event.clientY);
  };
}

function beginDrag(container: HTMLElement, current: DragSession, x: number, y: number): void {
  current.started = true;
  safePointerCapture(current.sourceEl, current.pointerId, false);
  applyStartClasses(container, current);
  // M3: `container.doc` (the element's own owner document, or the global one when there isn't a
  // more specific one — see `obsidian.d.ts`'s `Node.doc`), not the bare global `document` — a drag
  // started inside an Obsidian pop-out window must show its ghost in that window, not silently
  // append it to the main window's `<body>` where nothing in the pop-out could ever see it.
  container.doc.body.appendChild(current.ghostEl);
  positionGhost(current.ghostEl, x, y);
}

function updateHover(
  elementAt: (x: number, y: number) => Element | null,
  current: DragSession,
  x: number,
  y: number,
): void {
  const hit = nodeAncestor(elementAt(x, y));
  if (hit === current.hoveredEl) {
    return;
  }
  current.hoveredEl?.classList.remove(DROP_HOVER_CLASS);
  current.hoveredEl = hit;
  if (hit?.classList.contains(DROP_TARGET_CLASS) === true) {
    hit.classList.add(DROP_HOVER_CLASS);
  }
}

/** Attaches the whole gesture to `deps.container` and returns a disposer that removes every
 * listener it registered (on both the container and `document`) and tears down any drag still in
 * progress. */
export function attachDrag(deps: DragDeps): () => void {
  // M3: the container's own document (a pop-out window's, when the view is open in one), not the
  // global `document` — `document.elementFromPoint`/pointer listeners on the wrong window's
  // document would silently never see events the pop-out's own window actually dispatches.
  const doc = deps.container.doc;
  const elementAt = deps.elementAt ?? ((x, y) => doc.elementFromPoint(x, y));
  const box: SessionBox = { current: null };

  const handlePointerDown = makePointerDownHandler(deps, box, doc);
  const handlePointerMove = makePointerMoveHandler(deps, box, elementAt);

  const handlePointerUp = (event: PointerEvent): void => {
    const current = box.current;
    if (current?.pointerId !== event.pointerId) {
      return;
    }
    const { started, hoveredEl, sourcePath, targets, mode } = current;
    endSession(box, deps.container);
    const targetPath = hoveredEl?.getAttribute('data-path') ?? null;
    if (!started || targetPath === null || !targets.has(targetPath)) {
      return;
    }
    deps.onDrop(sourcePath, targetPath, mode, event);
  };

  const handlePointerCancel = (event: PointerEvent): void => {
    if (box.current?.pointerId === event.pointerId) {
      endSession(box, deps.container);
    }
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (box.current !== null && event.key === 'Escape') {
      endSession(box, deps.container);
    }
  };

  deps.container.addEventListener('pointerdown', handlePointerDown);
  doc.addEventListener('pointermove', handlePointerMove);
  doc.addEventListener('pointerup', handlePointerUp);
  doc.addEventListener('pointercancel', handlePointerCancel);
  doc.addEventListener('keydown', handleKeyDown);

  return () => {
    deps.container.removeEventListener('pointerdown', handlePointerDown);
    doc.removeEventListener('pointermove', handlePointerMove);
    doc.removeEventListener('pointerup', handlePointerUp);
    doc.removeEventListener('pointercancel', handlePointerCancel);
    doc.removeEventListener('keydown', handleKeyDown);
    endSession(box, deps.container);
  };
}
