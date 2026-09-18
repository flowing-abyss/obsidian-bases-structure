// Unit tests for `attachDrag` — the delegated pointer-drag gesture nodes use to move under a new
// parent. jsdom has no real pointer capture, no layout and no `elementFromPoint`, so every test
// drives the gesture purely through dispatched `Pointer`/`Keyboard` events plus the injected
// `elementAt` — never through measured geometry.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachDrag, type DragDeps, type DragMode } from './drag.js';

const NODE_CLASS = 'bases-structure-node';
const POINTER_ID = 1;

interface CaptureMethods {
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
}

function makeNode(path: string, options: { title?: string } = {}): HTMLElement {
  const el = createDiv(NODE_CLASS, (node) => {
    node.setAttribute('data-path', path);
  });
  el.createDiv('bases-structure-title', (title) => {
    title.textContent = options.title ?? path;
  });
  return el;
}

function pointerEvent(
  type: string,
  init: {
    x?: number;
    y?: number;
    button?: number;
    target?: EventTarget;
    pointerType?: string;
    shiftKey?: boolean;
  } = {},
): PointerEvent {
  const event = new PointerEvent(type, {
    pointerId: POINTER_ID,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    button: init.button ?? 0,
    pointerType: init.pointerType ?? 'mouse',
    shiftKey: init.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  if (init.target !== undefined) {
    Object.defineProperty(event, 'target', { value: init.target, configurable: true });
  }
  return event;
}

function shiftKeyEvent(type: 'keydown' | 'keyup'): KeyboardEvent {
  return new KeyboardEvent(type, { key: 'Shift', bubbles: true });
}

interface Harness {
  readonly container: HTMLElement;
  readonly onDrop: ReturnType<typeof vi.fn>;
  readonly elementAt: ReturnType<typeof vi.fn>;
  readonly targetsFor: ReturnType<typeof vi.fn>;
  readonly dispose: () => void;
  moveTo(x: number, y: number, hovered: Element | null): void;
  down(
    el: HTMLElement,
    init?: { x?: number; y?: number; button?: number; pointerType?: string; shiftKey?: boolean },
  ): void;
  pressShift(): void;
  releaseShift(): void;
}

interface HarnessOptions {
  /** Overrides the default "same set regardless of mode" `targetsFor` — tests that need the
   * highlighted set to actually differ between `'move'` and `'convert'` (the mid-drag Shift
   * switch) provide their own. Still wrapped in `vi.fn` so every test can assert on calls. */
  readonly targetsFor?: (path: string, mode: DragMode) => ReadonlySet<string>;
}

function makeHarness(
  targets: ReadonlySet<string> = new Set(['parent.md']),
  options: HarnessOptions = {},
): Harness {
  const container = createDiv();
  document.body.appendChild(container);
  const onDrop = vi.fn();
  const elementAt = vi.fn<(x: number, y: number) => Element | null>(() => null);
  const targetsFor = vi.fn(options.targetsFor ?? ((): ReadonlySet<string> => targets));
  const deps: DragDeps = {
    container,
    targetsFor,
    onDrop,
    elementAt,
  };
  const dispose = attachDrag(deps);
  return {
    container,
    onDrop,
    elementAt,
    targetsFor,
    dispose,
    moveTo(x: number, y: number, hovered: Element | null): void {
      elementAt.mockReturnValue(hovered);
      container.dispatchEvent(pointerEvent('pointermove', { x, y }));
    },
    down(el: HTMLElement, init = {}): void {
      el.dispatchEvent(pointerEvent('pointerdown', { ...init, target: el }));
    },
    pressShift(): void {
      document.dispatchEvent(shiftKeyEvent('keydown'));
    },
    releaseShift(): void {
      document.dispatchEvent(shiftKeyEvent('keyup'));
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('attachDrag — touch pointers ignored (I10)', () => {
  it('never starts a drag for a touch pointer, even well past the threshold', () => {
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.append(source, parent);

    h.down(source, { pointerType: 'touch' });
    h.moveTo(50, 50, parent);
    h.container.doc.dispatchEvent(
      pointerEvent('pointerup', { x: 50, y: 50, pointerType: 'touch' }),
    );

    // A touch drag would fight the container's native scroll (one-finger gesture serving both) —
    // moving a node on touch goes through the node menu's "Move to…" instead (I10).
    expect(document.querySelector('.bases-structure-drag-ghost')).toBeNull();
    expect(source.classList.contains('is-dragging')).toBe(false);
    expect(h.onDrop).not.toHaveBeenCalled();
  });

  it('still starts a drag for a mouse pointer past the threshold (control)', () => {
    const source = makeNode('source.md');
    const h = makeHarness();
    h.container.appendChild(source);

    h.down(source, { pointerType: 'mouse' });
    h.moveTo(50, 50, null);

    expect(source.classList.contains('is-dragging')).toBe(true);
  });
});

describe('attachDrag — threshold', () => {
  it('does not start a drag (no ghost, no classes) for a move under 4px', () => {
    const source = makeNode('source.md');
    const h = makeHarness();
    h.container.appendChild(source);

    h.down(source);
    h.moveTo(2, 2, null);

    expect(document.querySelector('.bases-structure-drag-ghost')).toBeNull();
    expect(source.classList.contains('is-dragging')).toBe(false);
  });

  it('does not call onDrop on pointerup when the drag never started (plain click)', () => {
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const h = makeHarness();
    h.container.append(source, parent);

    h.down(source);
    h.moveTo(1, 1, parent);
    document.dispatchEvent(pointerEvent('pointerup', { x: 1, y: 1 }));

    expect(h.onDrop).not.toHaveBeenCalled();
  });
});

describe('attachDrag — valid drop', () => {
  it('calls onDrop with source and target paths when released over a valid target', () => {
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.append(source, parent);

    h.down(source);
    h.moveTo(10, 10, parent);
    document.dispatchEvent(pointerEvent('pointerup', { x: 10, y: 10 }));

    expect(h.onDrop).toHaveBeenCalledExactlyOnceWith(
      'source.md',
      'parent.md',
      'move',
      expect.any(PointerEvent),
    );
  });

  it('adds is-drop-target to every valid target and is-drag-blocked to everything else once the drag starts', () => {
    const source = makeNode('source.md');
    const target = makeNode('target.md');
    const blocked = makeNode('blocked.md');
    const h = makeHarness(new Set(['target.md']));
    h.container.append(source, target, blocked);

    h.down(source);
    h.moveTo(10, 10, null);

    expect(source.classList.contains('is-dragging')).toBe(true);
    expect(target.classList.contains('is-drop-target')).toBe(true);
    expect(target.classList.contains('is-drag-blocked')).toBe(false);
    expect(blocked.classList.contains('is-drag-blocked')).toBe(true);
    expect(blocked.classList.contains('is-drop-target')).toBe(false);
  });

  it('adds is-drop-hover only while hovering a valid target, and removes it when hovering elsewhere', () => {
    const source = makeNode('source.md');
    const target = makeNode('target.md');
    const blocked = makeNode('blocked.md');
    const h = makeHarness(new Set(['target.md']));
    h.container.append(source, target, blocked);
    h.down(source);
    h.moveTo(5, 5, null);

    h.moveTo(10, 10, target);
    expect(target.classList.contains('is-drop-hover')).toBe(true);

    h.moveTo(20, 20, blocked);
    expect(target.classList.contains('is-drop-hover')).toBe(false);
    expect(blocked.classList.contains('is-drop-hover')).toBe(false);
  });

  it('creates a fixed-position ghost showing the source node title that follows the pointer', () => {
    const source = makeNode('source.md', { title: 'My Source' });
    const h = makeHarness();
    h.container.appendChild(source);

    h.down(source);
    h.moveTo(15, 25, null);

    const ghost = document.querySelector<HTMLElement>('.bases-structure-drag-ghost');
    expect(ghost).not.toBeNull();
    expect(ghost?.textContent).toBe('My Source');
    expect(ghost?.style.left).toBe('15px');
    expect(ghost?.style.top).toBe('25px');
  });
});

describe('attachDrag — invalid drop', () => {
  it('does not call onDrop when released over a node that is not a valid target', () => {
    const source = makeNode('source.md');
    const other = makeNode('other.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.append(source, other);

    h.down(source);
    h.moveTo(10, 10, other);
    document.dispatchEvent(pointerEvent('pointerup', { x: 10, y: 10 }));

    expect(h.onDrop).not.toHaveBeenCalled();
  });

  it('does not call onDrop when released over empty space', () => {
    const source = makeNode('source.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.appendChild(source);

    h.down(source);
    h.moveTo(10, 10, null);
    document.dispatchEvent(pointerEvent('pointerup', { x: 10, y: 10 }));

    expect(h.onDrop).not.toHaveBeenCalled();
  });

  it('cleans up every class and the ghost after a drop', () => {
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.append(source, parent);

    h.down(source);
    h.moveTo(10, 10, parent);
    document.dispatchEvent(pointerEvent('pointerup', { x: 10, y: 10 }));

    expect(source.classList.contains('is-dragging')).toBe(false);
    expect(parent.classList.contains('is-drop-target')).toBe(false);
    expect(parent.classList.contains('is-drop-hover')).toBe(false);
    expect(document.querySelector('.bases-structure-drag-ghost')).toBeNull();
  });
});

describe('attachDrag — abort', () => {
  it('Escape aborts the drag: no onDrop, classes and ghost cleaned up', () => {
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.append(source, parent);
    h.down(source);
    h.moveTo(10, 10, parent);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(pointerEvent('pointerup', { x: 10, y: 10 }));

    expect(h.onDrop).not.toHaveBeenCalled();
    expect(source.classList.contains('is-dragging')).toBe(false);
    expect(parent.classList.contains('is-drop-target')).toBe(false);
    expect(document.querySelector('.bases-structure-drag-ghost')).toBeNull();
  });

  it('a keydown that is not Escape does not abort an in-progress drag', () => {
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.append(source, parent);
    h.down(source);
    h.moveTo(10, 10, parent);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    document.dispatchEvent(pointerEvent('pointerup', { x: 10, y: 10 }));

    expect(h.onDrop).toHaveBeenCalledExactlyOnceWith(
      'source.md',
      'parent.md',
      'move',
      expect.any(PointerEvent),
    );
  });

  it('a keydown before any drag has started is a no-op', () => {
    makeHarness();
    expect(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }).not.toThrow();
  });

  it('pointercancel aborts the drag: no onDrop, classes and ghost cleaned up', () => {
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.append(source, parent);
    h.down(source);
    h.moveTo(10, 10, parent);

    document.dispatchEvent(pointerEvent('pointercancel', { x: 10, y: 10 }));
    document.dispatchEvent(pointerEvent('pointerup', { x: 10, y: 10 }));

    expect(h.onDrop).not.toHaveBeenCalled();
    expect(source.classList.contains('is-dragging')).toBe(false);
    expect(document.querySelector('.bases-structure-drag-ghost')).toBeNull();
  });

  it('a pointercancel for a different pointer id is ignored', () => {
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.append(source, parent);
    h.down(source);
    h.moveTo(10, 10, parent);

    const otherPointerCancel = new PointerEvent('pointercancel', { pointerId: 999, bubbles: true });
    document.dispatchEvent(otherPointerCancel);
    document.dispatchEvent(pointerEvent('pointerup', { x: 10, y: 10 }));

    expect(h.onDrop).toHaveBeenCalledExactlyOnceWith(
      'source.md',
      'parent.md',
      'move',
      expect.any(PointerEvent),
    );
  });
});

describe('attachDrag — ignored starts', () => {
  it('ignores a pointerdown on the toggle button, so its own click still works', () => {
    const source = makeNode('source.md');
    const toggle = source.createEl('button', { cls: 'bases-structure-toggle' });
    const h = makeHarness();
    h.container.appendChild(source);

    h.down(toggle);
    h.moveTo(10, 10, null);

    expect(source.classList.contains('is-dragging')).toBe(false);
  });

  it('ignores a pointerdown on the "+" add button ([data-action])', () => {
    const source = makeNode('source.md');
    const addBtn = source.createEl('button', { attr: { 'data-action': 'add' } });
    const h = makeHarness();
    h.container.appendChild(source);

    h.down(addBtn);
    h.moveTo(10, 10, null);

    expect(source.classList.contains('is-dragging')).toBe(false);
  });

  it('ignores a pointerdown on an open draft (.bases-structure-draft)', () => {
    const source = makeNode('source.md');
    const draft = source.createDiv('bases-structure-draft');
    const input = draft.createEl('input');
    const h = makeHarness();
    h.container.appendChild(source);

    h.down(input);
    h.moveTo(10, 10, null);

    expect(source.classList.contains('is-dragging')).toBe(false);
  });

  it('ignores a non-primary button pointerdown', () => {
    const source = makeNode('source.md');
    const h = makeHarness();
    h.container.appendChild(source);

    h.down(source, { button: 2 });
    h.moveTo(10, 10, null);

    expect(source.classList.contains('is-dragging')).toBe(false);
  });

  it('ignores a pointerdown that does not land on any node', () => {
    const h = makeHarness();
    const outside = createDiv();
    h.container.appendChild(outside);

    h.down(outside);
    h.moveTo(10, 10, null);

    expect(document.querySelector('.bases-structure-drag-ghost')).toBeNull();
  });
});

describe('attachDrag — disposer', () => {
  it('removes every listener: pointerdown after dispose no longer starts a drag', () => {
    const source = makeNode('source.md');
    const h = makeHarness();
    h.container.appendChild(source);

    h.dispose();
    h.down(source);
    h.moveTo(10, 10, null);

    expect(source.classList.contains('is-dragging')).toBe(false);
  });

  it('removes a leftover ghost and drag classes for a drag in progress at dispose time', () => {
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.append(source, parent);
    h.down(source);
    h.moveTo(10, 10, parent);
    expect(document.querySelector('.bases-structure-drag-ghost')).not.toBeNull();

    h.dispose();

    expect(document.querySelector('.bases-structure-drag-ghost')).toBeNull();
    expect(source.classList.contains('is-dragging')).toBe(false);
    expect(parent.classList.contains('is-drop-target')).toBe(false);
  });

  it('guards setPointerCapture/releasePointerCapture so a throwing implementation never aborts the drag', () => {
    // jsdom doesn't implement these methods at all (calling them throws "not a function"), which
    // already exercises the guard in every other test in this file. This test simulates the other
    // failure shape a real host can produce — a defined method that itself rejects the call (e.g.
    // for a detached element) — to prove the guard isn't accidentally narrower than that.
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const throwing = (): void => {
      throw new Error('not implemented');
    };
    const proto = HTMLElement.prototype as unknown as CaptureMethods;
    proto.setPointerCapture = throwing;
    proto.releasePointerCapture = throwing;

    try {
      const h = makeHarness(new Set(['parent.md']));
      h.container.append(source, parent);

      h.down(source);
      h.moveTo(10, 10, parent);
      document.dispatchEvent(pointerEvent('pointerup', { x: 10, y: 10 }));

      expect(h.onDrop).toHaveBeenCalledExactlyOnceWith(
        'source.md',
        'parent.md',
        'move',
        expect.any(PointerEvent),
      );
    } finally {
      delete proto.setPointerCapture;
      delete proto.releasePointerCapture;
    }
  });
});

describe('attachDrag — Shift/convert mode', () => {
  it('starts in move mode by default, calling targetsFor with the source path and "move"', () => {
    const source = makeNode('source.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.appendChild(source);

    h.down(source);

    expect(h.targetsFor).toHaveBeenCalledExactlyOnceWith('source.md', 'move');
  });

  it('starts in convert mode when Shift is already held at pointerdown', () => {
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.append(source, parent);

    h.down(source, { shiftKey: true });
    h.moveTo(10, 10, null);

    expect(h.targetsFor).toHaveBeenCalledExactlyOnceWith('source.md', 'convert');
    expect(parent.classList.contains('is-drop-target')).toBe(true);
  });

  it('switches target sets and re-highlights when Shift is pressed mid-drag, and switches back on release', () => {
    const source = makeNode('source.md');
    const moveTarget = makeNode('move-target.md');
    const convertTarget = makeNode('convert-target.md');
    const h = makeHarness(new Set(), {
      targetsFor: (_path, mode) =>
        mode === 'convert' ? new Set(['convert-target.md']) : new Set(['move-target.md']),
    });
    h.container.append(source, moveTarget, convertTarget);
    h.down(source);
    h.moveTo(10, 10, null);
    expect(moveTarget.classList.contains('is-drop-target')).toBe(true);
    expect(convertTarget.classList.contains('is-drop-target')).toBe(false);

    h.pressShift();

    expect(h.targetsFor).toHaveBeenLastCalledWith('source.md', 'convert');
    expect(convertTarget.classList.contains('is-drop-target')).toBe(true);
    expect(moveTarget.classList.contains('is-drop-target')).toBe(false);

    h.releaseShift();

    expect(h.targetsFor).toHaveBeenLastCalledWith('source.md', 'move');
    expect(moveTarget.classList.contains('is-drop-target')).toBe(true);
    expect(convertTarget.classList.contains('is-drop-target')).toBe(false);
  });

  it('re-derives is-drop-hover for the currently hovered node once the mode flip makes it a valid target', () => {
    const source = makeNode('source.md');
    const swing = makeNode('swing.md');
    const h = makeHarness(new Set(), {
      targetsFor: (_path, mode) => (mode === 'convert' ? new Set(['swing.md']) : new Set()),
    });
    h.container.append(source, swing);
    h.down(source);
    h.moveTo(10, 10, swing);
    expect(swing.classList.contains('is-drop-hover')).toBe(false);

    h.pressShift();

    expect(swing.classList.contains('is-drop-target')).toBe(true);
    expect(swing.classList.contains('is-drop-hover')).toBe(true);
  });

  it('does not recompute targets for a repeated Shift keydown while already held (key repeat)', () => {
    const source = makeNode('source.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.appendChild(source);
    h.down(source, { shiftKey: true });
    h.moveTo(10, 10, null);
    h.targetsFor.mockClear();

    h.pressShift();

    expect(h.targetsFor).not.toHaveBeenCalled();
  });

  it('adds is-convert to the ghost while Shift is held and removes it on release — nothing new appears on the nodes themselves', () => {
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.append(source, parent);

    h.down(source, { shiftKey: true });
    h.moveTo(10, 10, null);

    const ghost = document.querySelector<HTMLElement>('.bases-structure-drag-ghost');
    expect(ghost?.classList.contains('is-convert')).toBe(true);
    expect(parent.classList.contains('is-convert')).toBe(false);
    expect(source.classList.contains('is-convert')).toBe(false);

    h.releaseShift();

    expect(ghost?.classList.contains('is-convert')).toBe(false);
  });

  it('reports the mode current at drop time to onDrop', () => {
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.append(source, parent);

    h.down(source, { shiftKey: true });
    h.moveTo(10, 10, parent);
    document.dispatchEvent(pointerEvent('pointerup', { x: 10, y: 10, shiftKey: true }));

    expect(h.onDrop).toHaveBeenCalledExactlyOnceWith(
      'source.md',
      'parent.md',
      'convert',
      expect.any(PointerEvent),
    );
  });

  it('a Shift keydown/keyup before any drag has started is a no-op', () => {
    makeHarness();
    expect(() => {
      document.dispatchEvent(shiftKeyEvent('keydown'));
      document.dispatchEvent(shiftKeyEvent('keyup'));
    }).not.toThrow();
  });

  it('stops listening for Shift once the drag ends, so a later press does not recompute targets', () => {
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.append(source, parent);
    h.down(source);
    h.moveTo(10, 10, parent);
    document.dispatchEvent(pointerEvent('pointerup', { x: 10, y: 10 }));
    h.targetsFor.mockClear();

    h.pressShift();

    expect(h.targetsFor).not.toHaveBeenCalled();
  });

  it('stops listening for Shift once disposed mid-drag', () => {
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    const h = makeHarness(new Set(['parent.md']));
    h.container.append(source, parent);
    h.down(source);
    h.moveTo(10, 10, parent);
    h.targetsFor.mockClear();

    h.dispose();

    expect(() => {
      document.dispatchEvent(shiftKeyEvent('keydown'));
    }).not.toThrow();
    expect(h.targetsFor).not.toHaveBeenCalled();
  });
});

describe('attachDrag — pop-out window (M3)', () => {
  it('drives pointermove/pointerup/Escape through the container’s own document, not the global one', () => {
    // A second, detached `Document` (never attached to the real `document`'s tree) standing in
    // for an Obsidian pop-out window's own document. `source`/`parent`/`container` are built with
    // the ordinary global `createDiv` (main-realm elements — every event dispatched below still
    // reaches ordinary `instanceof HTMLElement` checks) and only *adopted* into `otherDoc` by the
    // final `appendChild` — enough to move their owner document (and hence `.doc`) without it. If
    // `attachDrag` still listened on the global `document` (as it did before M3), none of these
    // dispatched events would ever reach it.
    const otherDoc = document.implementation.createHTMLDocument('pop-out');
    const container = createDiv();
    const source = makeNode('source.md');
    const parent = makeNode('parent.md');
    container.append(source, parent);
    otherDoc.body.appendChild(container);
    const onDrop = vi.fn();
    const elementAt = vi.fn<(x: number, y: number) => Element | null>(() => parent);
    const dispose = attachDrag({
      container,
      targetsFor: () => new Set(['parent.md']),
      onDrop,
      elementAt,
    });

    source.dispatchEvent(pointerEvent('pointerdown', { target: source }));
    container.dispatchEvent(pointerEvent('pointermove', { x: 10, y: 10 }));
    expect(source.classList.contains('is-dragging')).toBe(true);
    otherDoc.dispatchEvent(pointerEvent('pointerup', { x: 10, y: 10 }));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith(
      'source.md',
      'parent.md',
      'move',
      expect.any(PointerEvent),
    );
    dispose();
  });

  it('appends the drag ghost into the container’s own document body, not the global document’s', () => {
    const otherDoc = document.implementation.createHTMLDocument('pop-out');
    const container = createDiv();
    const source = makeNode('source.md');
    container.appendChild(source);
    otherDoc.body.appendChild(container);
    const dispose = attachDrag({ container, targetsFor: () => new Set(), onDrop: vi.fn() });

    source.dispatchEvent(pointerEvent('pointerdown', { target: source }));
    container.dispatchEvent(pointerEvent('pointermove', { x: 10, y: 10 }));

    expect(otherDoc.querySelector('.bases-structure-drag-ghost')).not.toBeNull();
    expect(document.querySelector('.bases-structure-drag-ghost')).toBeNull();
    dispose();
  });
});
