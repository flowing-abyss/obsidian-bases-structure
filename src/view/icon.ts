// Thin wrapper around Obsidian's `setIcon`: every icon in the view is sized/aligned by a single
// CSS rule scoped to a class (`.bases-structure-icon`, see `styles.css`), never a bare `svg`
// selector — the project's CSS conventions forbid tag selectors so the plugin's rules can't leak
// onto an unrelated `<svg>` elsewhere on the page. `setIcon` itself only inserts the markup, so
// this is where that class gets attached.

import type { IconName } from 'obsidian';
import { setIcon } from 'obsidian';

const ICON_CLASS = 'bases-structure-icon';

export function setSizedIcon(el: HTMLElement, icon: IconName): void {
  setIcon(el, icon);
  el.querySelector('svg')?.classList.add(ICON_CLASS);
}
