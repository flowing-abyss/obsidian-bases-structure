// Finds the note a structure view's Bases block is embedded in — the "host" note whose frontmatter
// edge properties get updated when the view creates/moves/retypes notes. Bases embeds its block
// view inside the leaf that's currently rendering the host markdown note, so the host is whichever
// open `MarkdownView` contains the view's root element.

import type { App, TFile } from 'obsidian';
import { FileView, MarkdownView } from 'obsidian';

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

/** The file of the nearest leaf — of *any* `FileView` kind, not just `MarkdownView` — containing
 * `element` (I9's UI-state-key fix). `findHostFile` above stays markdown-only (it's what note
 * frontmatter edits write to); this is a separate, broader lookup used only to give a directly-
 * opened `.base` file's own view a stable, per-file UI-state key, since `BasesView`/
 * `BasesViewConfig`/`QueryController`'s public surface exposes nothing file-related at all (no
 * `file`, no path, nothing `.get`/`.getAsPropertyId` can reach) to identify *which* `.base` file a
 * directly-opened view (no host markdown note at all, so `findHostFile` returns `null`) belongs
 * to. Verified against a real vault: opening a `.base` file directly gives its own leaf's view a
 * `.file` equal to that `.base` file — `FileView` (the exported base class every built-in file-
 * backed view, including Bases' own, extends) is the only public vocabulary for that, so this
 * duck-types on it rather than on any Bases-specific class (none is exported). `null` when even
 * that fails (embedded with no host at all, or some future view shape this doesn't anticipate) —
 * callers fall back to the pre-I9 host+view-name key in that case; see `structure-view.ts`. */
export function findContainingFile(app: App, element: HTMLElement): TFile | null {
  let match: TFile | null | undefined;
  app.workspace.iterateAllLeaves((leaf) => {
    if (match !== undefined) {
      return;
    }
    if (!(leaf.view instanceof FileView) || !leaf.view.containerEl.contains(element)) {
      return;
    }
    match = leaf.view.file;
  });
  return match ?? null;
}
