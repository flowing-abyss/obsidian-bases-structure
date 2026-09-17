// Delegated pointer-drag for the structure view: a pointerdown+move on a `.bases-structure-node`
// becomes a "move this node under that parent" gesture. Drop-target/blocked highlighting comes
// entirely from `deps.targetsFor` (wired to the planner's `moveTargets` by `structure-view.ts`) —
// this module knows nothing about the structure/schema itself. No Obsidian imports: plain DOM, so
// it runs the same way inside jsdom (see `DragDeps.elementAt` — jsdom has neither
// `document.elementFromPoint` nor real pointer capture) and in a real browser.

export interface DragDeps {
  readonly container: HTMLElement;
  readonly targetsFor: (path: string) => ReadonlySet<string>;
  readonly onDrop: (node: string, parent: string) => void;
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

interface DragSession {
  readonly pointerId: number;
  readonly sourceEl: HTMLElement;
  readonly sourcePath: string;
  readonly targets: ReadonlySet<string>;
  readonly ghostEl: HTMLElement;
  readonly startX: number;
  readonly startY: number;
  started: boolean;
  hoveredEl: HTMLElement | null;
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

function applyStartClasses(container: HTMLElement, session: DragSession): void {
  session.sourceEl.classList.add(DRAGGING_CLASS);
  for (const el of allNodeElements(container)) {
    if (el === session.sourceEl) {
      continue;
    }
    const path = el.getAttribute('data-path');
    const isTarget = path !== null && session.targets.has(path);
    el.classList.add(isTarget ? DROP_TARGET_CLASS : DRAG_BLOCKED_CLASS);
  }
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
  clearAllClasses(container);
  current.ghostEl.remove();
  safePointerCapture(current.sourceEl, current.pointerId, true);
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

  const handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || box.current !== null || isIgnoredTarget(event.target)) {
      return;
    }
    const sourceEl = nodeAncestor(event.target);
    const sourcePath = sourceEl?.getAttribute('data-path') ?? null;
    if (sourceEl === null || sourcePath === null) {
      return;
    }
    box.current = {
      pointerId: event.pointerId,
      sourceEl,
      sourcePath,
      targets: deps.targetsFor(sourcePath),
      ghostEl: buildGhost(sourceEl, sourcePath),
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      hoveredEl: null,
    };
  };

  const handlePointerMove = (event: PointerEvent): void => {
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

  const handlePointerUp = (event: PointerEvent): void => {
    const current = box.current;
    if (current?.pointerId !== event.pointerId) {
      return;
    }
    const { started, hoveredEl, sourcePath, targets } = current;
    endSession(box, deps.container);
    const targetPath = hoveredEl?.getAttribute('data-path') ?? null;
    if (!started || targetPath === null || !targets.has(targetPath)) {
      return;
    }
    deps.onDrop(sourcePath, targetPath);
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
