// Thin wrapper around Obsidian's `setIcon` — the one call site every icon in the view goes
// through, in case a future shared behavior needs it. Sizing/alignment itself needs no class from
// here: `styles.css` (see U4) targets Obsidian's own `.svg-icon` class directly, through selectors
// specific enough (three plugin-scoped ancestor classes deep) to beat Obsidian's global sizing rule
// without a plugin-specific marker class or `!important` — a `.bases-structure-icon` class used to
// be added here for exactly that purpose, but lost that specificity fight outright, so it was
// dropped rather than left around unused.

import type { IconName } from 'obsidian';
import { setIcon } from 'obsidian';

export function setSizedIcon(el: HTMLElement, icon: IconName): void {
  setIcon(el, icon);
}
