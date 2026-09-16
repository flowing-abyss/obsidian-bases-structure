// Converts plan `WriteValue`s and body/append link targets into the wikilink text Obsidian
// expects, matching how `MetadataCache.fileToLinktext` renders an existing file and falling back
// to a plain basename when the target doesn't exist yet (e.g. a backlink to a note created earlier
// in the same plan, before the vault has re-resolved it). Shared by `plan-applier.ts` (writing new
// values) and `undo-manager.ts` (restoring old ones) so both render links the same way.

import type { App } from 'obsidian';
import type { WriteValue } from '../core/plan-types.js';

/** `'a/b/c.md'` → `'c'`; a path without a `.md` suffix is returned as-is. */
function basenameWithoutExtension(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const name = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

/** The link text Obsidian would render for `target` from `sourcePath`: the file's own rendering
 * when it currently exists in the vault, else its bare basename. */
function linktextFor(app: App, target: string, sourcePath: string): string {
  const file = app.vault.getFileByPath(target);
  if (file !== null) {
    return app.metadataCache.fileToLinktext(file, sourcePath, true);
  }
  return basenameWithoutExtension(target);
}

/** A plan `WriteValue` rendered into the shape `processFrontMatter` should assign: a literal
 * passes through untouched; a link list becomes an array of `"[[linktext]]"` strings (possibly
 * empty); a link scalar becomes the first link string, or `null` when there are no targets. */
export function toFrontmatterValue(app: App, value: WriteValue, sourcePath: string): unknown {
  if (value.kind === 'literal') {
    return value.value;
  }
  const links = value.targets.map((target) => `[[${linktextFor(app, target, sourcePath)}]]`);
  return value.list ? links : (links[0] ?? null);
}

/** One Markdown list item linking to `target`, as appended to a note's body. */
export function linkLine(app: App, target: string, sourcePath: string): string {
  return `- [[${linktextFor(app, target, sourcePath)}]]`;
}
