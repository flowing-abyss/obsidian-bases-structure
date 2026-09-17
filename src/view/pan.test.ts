// Unit tests for `attachPan` — the background grab-to-pan gesture for the graph (M7). Mirrors
// `drag.test.ts`'s approach: drives the whole module through dispatched `Pointer` events against
// plain DOM, never through measured geometry.

import { afterEach, describe, expect, it } from 'vitest';
import { attachPan, type PanDeps } from './pan.js';

const IGNORE_SELECTOR = '.bases-structure-node, .bases-structure-toolbar, button';
const POINTER_ID = 1;

function pointerEvent(
  type: string,
  init: {
    x?: number;
    y?: number;
    button?: number;
    target?: EventTarget;
    pointerType?: string;
  } = {},
): PointerEvent {
  const event = new PointerEvent(type, {
    pointerId: POINTER_ID,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    button: init.button ?? 0,
    pointerType: init.pointerType ?? 'mouse',
    bubbles: true,
    cancelable: true,
  });
  if (init.target !== undefined) {
    Object.defineProperty(event, 'target', { value: init.target, configurable: true });
  }
  return event;
}

function makeContainer(): HTMLElement {
  const el = createDiv();
  document.body.appendChild(el);
  return el;
}

function attach(container: HTMLElement): () => void {
  const deps: PanDeps = { container, ignoreSelector: IGNORE_SELECTOR };
  return attachPan(deps);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('attachPan — threshold', () => {
  it('does not scroll or mark is-panning for a move under 4px', () => {
    const container = makeContainer();
    const dispose = attach(container);

    container.dispatchEvent(pointerEvent('pointerdown', { x: 0, y: 0, target: container }));
    document.dispatchEvent(pointerEvent('pointermove', { x: 2, y: 2 }));

    expect(container.classList.contains('is-panning')).toBe(false);
    expect(container.scrollLeft).toBe(0);
    expect(container.scrollTop).toBe(0);
    dispose();
  });
});

describe('attachPan — panning', () => {
  it('scrolls opposite the drag direction once past the threshold, and marks is-panning', () => {
    const container = makeContainer();
    const dispose = attach(container);

    container.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, target: container }));
    document.dispatchEvent(pointerEvent('pointermove', { x: 60, y: 80 }));

    // Dragging left/up by (40, 20) — like grabbing the canvas and pulling it — scrolls right/down
    // by the same amount (scrollLeft/scrollTop increase).
    expect(container.classList.contains('is-panning')).toBe(true);
    expect(container.scrollLeft).toBe(40);
    expect(container.scrollTop).toBe(20);
    dispose();
  });

  it('accumulates from the scroll position at the start of the gesture, not from 0', () => {
    const container = makeContainer();
    container.scrollLeft = 200;
    container.scrollTop = 50;
    const dispose = attach(container);

    container.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, target: container }));
    document.dispatchEvent(pointerEvent('pointermove', { x: 90, y: 100 }));

    expect(container.scrollLeft).toBe(210);
    expect(container.scrollTop).toBe(50);
    dispose();
  });

  it('clears is-panning and stops updating scroll after pointerup', () => {
    const container = makeContainer();
    const dispose = attach(container);
    container.dispatchEvent(pointerEvent('pointerdown', { x: 0, y: 0, target: container }));
    document.dispatchEvent(pointerEvent('pointermove', { x: 20, y: 0 }));
    expect(container.classList.contains('is-panning')).toBe(true);

    document.dispatchEvent(pointerEvent('pointerup', { x: 20, y: 0 }));
    document.dispatchEvent(pointerEvent('pointermove', { x: 100, y: 0 }));

    expect(container.classList.contains('is-panning')).toBe(false);
    expect(container.scrollLeft).toBe(-20);
    dispose();
  });

  it('clears is-panning on pointercancel', () => {
    const container = makeContainer();
    const dispose = attach(container);
    container.dispatchEvent(pointerEvent('pointerdown', { x: 0, y: 0, target: container }));
    document.dispatchEvent(pointerEvent('pointermove', { x: 20, y: 0 }));

    document.dispatchEvent(pointerEvent('pointercancel', { x: 20, y: 0 }));

    expect(container.classList.contains('is-panning')).toBe(false);
    dispose();
  });
});

describe('attachPan — ignored targets/pointers', () => {
  it('never starts for a touch pointer', () => {
    const container = makeContainer();
    const dispose = attach(container);

    container.dispatchEvent(
      pointerEvent('pointerdown', { x: 0, y: 0, target: container, pointerType: 'touch' }),
    );
    document.dispatchEvent(pointerEvent('pointermove', { x: 50, y: 50, pointerType: 'touch' }));

    expect(container.classList.contains('is-panning')).toBe(false);
    expect(container.scrollLeft).toBe(0);
    dispose();
  });

  it('never starts when the pointerdown lands on an ignored element (a node)', () => {
    const container = makeContainer();
    const node = container.createDiv('bases-structure-node');
    const dispose = attach(container);

    node.dispatchEvent(pointerEvent('pointerdown', { x: 0, y: 0, target: node }));
    document.dispatchEvent(pointerEvent('pointermove', { x: 50, y: 50 }));

    expect(container.classList.contains('is-panning')).toBe(false);
    expect(container.scrollLeft).toBe(0);
    dispose();
  });

  it('ignores a second pointerdown while a pan is already in progress', () => {
    const container = makeContainer();
    const dispose = attach(container);
    container.dispatchEvent(pointerEvent('pointerdown', { x: 0, y: 0, target: container }));
    document.dispatchEvent(pointerEvent('pointermove', { x: 20, y: 0 }));
    expect(container.scrollLeft).toBe(-20);

    // A second pointer going down mid-pan must not reset the session's start position.
    container.dispatchEvent(
      pointerEvent('pointerdown', { x: 999, y: 999, target: container, button: 0 }),
    );
    document.dispatchEvent(pointerEvent('pointermove', { x: 30, y: 0 }));

    expect(container.scrollLeft).toBe(-30);
    dispose();
  });

  it('ignores a non-primary-button pointerdown', () => {
    const container = makeContainer();
    const dispose = attach(container);

    container.dispatchEvent(
      pointerEvent('pointerdown', { x: 0, y: 0, target: container, button: 2 }),
    );
    document.dispatchEvent(pointerEvent('pointermove', { x: 50, y: 50 }));

    expect(container.classList.contains('is-panning')).toBe(false);
    dispose();
  });
});

describe('attachPan — disposer', () => {
  it('removes every listener and clears an in-progress pan', () => {
    const container = makeContainer();
    const dispose = attach(container);
    container.dispatchEvent(pointerEvent('pointerdown', { x: 0, y: 0, target: container }));
    document.dispatchEvent(pointerEvent('pointermove', { x: 20, y: 0 }));
    expect(container.classList.contains('is-panning')).toBe(true);

    dispose();

    expect(container.classList.contains('is-panning')).toBe(false);
    document.dispatchEvent(pointerEvent('pointermove', { x: 100, y: 0 }));
    expect(container.scrollLeft).toBe(-20);
  });
});

describe('attachPan — pop-out window (M3)', () => {
  it('drives pointermove/pointerup through the container’s own document, not the global one', () => {
    const otherDoc = document.implementation.createHTMLDocument('pop-out');
    const container = createDiv();
    otherDoc.body.appendChild(container);
    const dispose = attach(container);

    container.dispatchEvent(pointerEvent('pointerdown', { x: 0, y: 0, target: container }));
    otherDoc.dispatchEvent(pointerEvent('pointermove', { x: 30, y: 0 }));

    expect(container.classList.contains('is-panning')).toBe(true);
    expect(container.scrollLeft).toBe(-30);
    dispose();
  });
});
