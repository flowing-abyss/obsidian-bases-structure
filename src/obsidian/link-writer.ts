// Converts plan `WriteValue`s and body/append link targets into the wikilink text Obsidian
// expects, matching how `MetadataCache.fileToLinktext` renders an existing file and falling back
// to a plain basename when the target doesn't exist yet (e.g. a backlink to a note created earlier
// in the same plan, before the vault has re-resolved it). Used by `plan-applier.ts` when writing
// new values; `undo-manager.ts` restores old ones directly (raw before/after frontmatter values),
// not through this module.
//
// A `'links'`/`'listItem'` write is a *patch*, not a literal value — see `../core/link-patch.ts`
// for the shared remove/add algorithm. `applyLinksWrite`/`applyListItemWrite` apply one write's
// patch to `frontmatter[key]` in place, resolving each raw element the real vault already has via
// `getFirstLinkpathDest`/`getLinkpath` (the same pair `snapshot-reader.ts` uses to read links), so
// unresolved links, plain text, aliases/headings, and links outside the base survive untouched.

import type { App } from 'obsidian';
import { getLinkpath } from 'obsidian';
import { patchLinksValue, patchListItem, rawLinkText } from '../core/link-patch.js';
import type { WriteValue } from '../core/plan-types.js';

type LinksWrite = Extract<WriteValue, { kind: 'links' }>;
type ListItemWrite = Extract<WriteValue, { kind: 'listItem' }>;

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

/** One raw frontmatter element (`"[[Target]]"`, `"[[Target|Alias]]"`, plain text, …) → the vault
 * path it currently resolves to, or `null` when it isn't a link or doesn't resolve to anything —
 * both cases `patchLinksValue` leaves untouched. */
function resolveFrontmatterLink(app: App, raw: string, sourcePath: string): string | null {
  const linktext = rawLinkText(raw);
  if (linktext === null) {
    return null;
  }
  return app.metadataCache.getFirstLinkpathDest(getLinkpath(linktext), sourcePath)?.path ?? null;
}

export interface LinksWriteArgs {
  readonly frontmatter: Record<string, unknown>;
  readonly key: string;
  readonly value: LinksWrite;
  readonly sourcePath: string;
}

/** Applies a `'links'`-kind write to `frontmatter[key]` in place: patches the note's *existing*
 * raw value for `key` (preserving unresolved links, plain text, aliases/headings, and links
 * outside the base exactly as written — see `patchLinksValue`), deleting the key entirely once the
 * result would hold nothing. */
export function applyLinksWrite(app: App, args: LinksWriteArgs): void {
  const { frontmatter, key, value, sourcePath } = args;
  const patched = patchLinksValue(frontmatter[key], {
    remove: new Set(value.remove),
    add: value.add,
    list: value.list,
    resolve: (raw) => resolveFrontmatterLink(app, raw, sourcePath),
    format: (target) => `[[${linktextFor(app, target, sourcePath)}]]`,
  });
  if (patched === null) {
    delete frontmatter[key];
  } else {
    frontmatter[key] = patched;
  }
}

/** Applies a `'listItem'`-kind write to `frontmatter[key]` in place: patches a plain (non-link)
 * list-shaped value by element (see `patchListItem`) — retype's recipe-property/tag writes. */
export function applyListItemWrite(
  frontmatter: Record<string, unknown>,
  key: string,
  value: ListItemWrite,
): void {
  const patched = patchListItem(frontmatter[key], {
    ...(value.remove === undefined ? {} : { remove: value.remove }),
    ...(value.add === undefined ? {} : { add: value.add }),
  });
  if (patched === null) {
    delete frontmatter[key];
  } else {
    frontmatter[key] = patched;
  }
}

/** One Markdown list item linking to `target`, as appended to a note's body. */
export function linkLine(app: App, target: string, sourcePath: string): string {
  return `- [[${linktextFor(app, target, sourcePath)}]]`;
}
