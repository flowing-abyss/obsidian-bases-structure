// Finds the note a structure view's Bases block is embedded in — the "host" note whose frontmatter
// edge properties get updated when the view creates/moves/retypes notes. Bases embeds its block
// view inside the leaf that's currently rendering the host markdown note, so the host is whichever
// open `MarkdownView` contains the view's root element.

import type { App, TFile } from 'obsidian';
import { MarkdownView } from 'obsidian';

/** The markdown file of the first workspace leaf whose `MarkdownView` contains `element` — `null`
 * when no leaf matches, or the matching leaf's file is missing or isn't a markdown file. */
export function findHostFile(app: App, element: HTMLElement): TFile | null {
  let match: TFile | null | undefined;
  app.workspace.iterateAllLeaves((leaf) => {
    if (match !== undefined) {
      return;
    }
    if (!(leaf.view instanceof MarkdownView) || !leaf.view.containerEl.contains(element)) {
      return;
    }
    const file = leaf.view.file;
    match = file !== null && file.extension === 'md' ? file : null;
  });
  return match ?? null;
}
