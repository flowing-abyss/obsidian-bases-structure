// Delegated pointer-drag panning for the graph's background (M7 — one of the spec's original
// `view.js`-parity items the first pass dropped without recording why; see the design spec's own
// "Отложено сознательно" note for what else in that list stayed dropped on purpose). Grabbing and
// dragging empty canvas space scrolls the graph the same way dragging a canvas in any diagramming
// tool does — mouse/pen only, matching `drag.ts`'s own node-drag: a touch drag is the container's
// native one-finger scroll already (I10), so panning never has anything to do there.

export interface PanDeps {
  /** The scrollable element itself — `scrollLeft`/`scrollTop` are read and written here directly
   * (`.bases-structure-graph` in production, which already owns them for wheel-zoom/scroll — see
   * `graph-renderer.ts`'s `handleScroll`). */
  readonly container: HTMLElement;
  /** A `pointerdown` whose target matches (or is inside) this selector never starts a pan — every
   * node, the toolbar, and anything else interactive that already owns its own drag/click. */
  readonly ignoreSelector: string;
}

const PAN_THRESHOLD_PX = 4;
const PANNING_CLASS = 'is-panning';

interface PanSession {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startScrollLeft: number;
  readonly startScrollTop: number;
  started: boolean;
}

function isIgnoredTarget(target: EventTarget | null, selector: string): boolean {
  return target instanceof Element && target.closest(selector) !== null;
}

/** Attaches the whole gesture to `deps.container` and returns a disposer that removes every
 * listener it registered (on both the container and its own document) and clears any pan still in
 * progress. */
export function attachPan(deps: PanDeps): () => void {
  // M3: the container's own document (a pop-out window's, when the view is open in one) — see
  // `drag.ts`'s identical reasoning for why this can't be the bare global `document`.
  const doc = deps.container.doc;
  let session: PanSession | null = null;

  const endSession = (): void => {
    deps.container.classList.remove(PANNING_CLASS);
    session = null;
  };

  const handlePointerDown = (event: PointerEvent): void => {
    if (
      event.button !== 0 ||
      event.pointerType === 'touch' ||
      session !== null ||
      isIgnoredTarget(event.target, deps.ignoreSelector)
    ) {
      return;
    }
    session = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: deps.container.scrollLeft,
      startScrollTop: deps.container.scrollTop,
      started: false,
    };
  };

  const handlePointerMove = (event: PointerEvent): void => {
    const current = session;
    if (current?.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.started) {
      if (Math.hypot(dx, dy) < PAN_THRESHOLD_PX) {
        return;
      }
      current.started = true;
      deps.container.classList.add(PANNING_CLASS);
    }
    deps.container.scrollLeft = current.startScrollLeft - dx;
    deps.container.scrollTop = current.startScrollTop - dy;
  };

  const handlePointerUp = (event: PointerEvent): void => {
    if (session?.pointerId === event.pointerId) {
      endSession();
    }
  };

  deps.container.addEventListener('pointerdown', handlePointerDown);
  doc.addEventListener('pointermove', handlePointerMove);
  doc.addEventListener('pointerup', handlePointerUp);
  doc.addEventListener('pointercancel', handlePointerUp);

  return () => {
    deps.container.removeEventListener('pointerdown', handlePointerDown);
    doc.removeEventListener('pointermove', handlePointerMove);
    doc.removeEventListener('pointerup', handlePointerUp);
    doc.removeEventListener('pointercancel', handlePointerUp);
    endSession();
  };
}
