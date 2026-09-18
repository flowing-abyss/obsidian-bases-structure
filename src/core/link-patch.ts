// The patch algorithm shared by the two places that turn a link/list *patch* (remove these
// targets, add those) into an actual frontmatter value: `simulate.ts` (verifying a plan against a
// pure `Snapshot`) and `src/obsidian/plan-applier.ts` (writing the real vault, and formatting via
// `link-writer.ts`). Both mirror the exact same positional rule so verification sees what the
// applier will really write; only how a raw element resolves to a path, and how a new target is
// formatted, differ between the two (a `Snapshot`-only lookup here vs `getFirstLinkpathDest` /
// `getFirstLinkpathDest`-formatted text there), so those are injected as callbacks. No Obsidian
// imports.

/** Extracts the bracket-stripped linktext from a raw wikilink or Markdown-link frontmatter
 * element (`[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `[text](target)`), or `null`
 * when `raw` isn't shaped like a link at all (plain text) — the alias half of a piped wikilink
 * isn't part of the linktext a resolver ever sees, since it's display-only. */
export function rawLinkText(raw: string): string | null {
  const trimmed = raw.trim();
  const wiki = /^\[\[([^[\]]*)\]\]$/.exec(trimmed);
  if (wiki?.[1] !== undefined) {
    const linktext = wiki[1].split('|')[0] ?? '';
    return linktext.trim();
  }
  const md = /^\[[^[\]]*\]\(([^()]*)\)$/.exec(trimmed);
  if (md?.[1] !== undefined) {
    try {
      return decodeURIComponent(md[1].trim());
    } catch {
      return md[1].trim();
    }
  }
  return null;
}

export interface LinkPatchOptions {
  /** Resolved target paths to drop from the current value. */
  readonly remove: ReadonlySet<string>;
  /** Resolved target paths to add, in order — a target already present (after removal) is a
   * no-op. */
  readonly add: readonly string[];
  /** The shape to use when the key doesn't currently exist at all (a brand-new write). Ignored
   * when `current` is already present — an existing scalar stays scalar, an existing list stays a
   * list, regardless of `list`, unless the result ends up holding more than one element. */
  readonly list: boolean;
  /** Raw frontmatter element (one array entry, or the whole value when it's a scalar) → the
   * resolved path it points at, or `null` when it isn't a link, or is one that doesn't resolve.
   * Unresolved/non-link elements are never touched. */
  readonly resolve: (raw: string) => string | null;
  /** Resolved path → the display string to insert for a newly added target ("formatted as
   * today"). */
  readonly format: (target: string) => string;
}

/** Normalises `current` (frontmatter's raw value for one key: `undefined`/`null`, a scalar, or an
 * array) into a list of raw elements, alongside whether it already existed as an array. */
function rawItemsOf(current: unknown): {
  readonly items: readonly unknown[];
  readonly wasArray: boolean;
} {
  if (current === undefined || current === null) {
    return { items: [], wasArray: false };
  }
  if (Array.isArray(current)) {
    return { items: current, wasArray: true };
  }
  return { items: [current], wasArray: false };
}

interface RemovalResult {
  readonly kept: unknown[];
  readonly insertIndex: number | null;
  readonly presentTargets: ReadonlySet<string>;
}

/** Walks `items` in order, dropping every one whose resolved path is in `remove` and recording the
 * position (within the surviving elements) where the first drop happened — the splice point new
 * elements go in at. Everything else (non-links, unresolved links, kept links) is carried over
 * untouched, and every resolved-and-kept target is recorded so a later `add` of the same target is
 * a no-op. */
function removeMatching(
  items: readonly unknown[],
  remove: ReadonlySet<string>,
  resolve: (raw: string) => string | null,
): RemovalResult {
  const kept: unknown[] = [];
  const presentTargets = new Set<string>();
  let insertIndex: number | null = null;
  for (const item of items) {
    const resolved = typeof item === 'string' ? resolve(item) : null;
    if (resolved !== null && remove.has(resolved)) {
      insertIndex ??= kept.length;
      continue;
    }
    if (resolved !== null) {
      presentTargets.add(resolved);
    }
    kept.push(item);
  }
  return { kept, insertIndex, presentTargets };
}

/** Round 2 minor 1: the key is always kept, never deleted by emptying it out — `[]` once `kept`
 * holds nothing and the value should be array-shaped, `null` once it holds nothing and should be
 * scalar-shaped; otherwise `kept` itself once it holds more than one element or `isArray` says the
 * value should stay an array regardless of count, otherwise its lone element, unwrapped back to a
 * scalar. */
function finalizeValue(kept: readonly unknown[], isArray: boolean): unknown {
  if (kept.length === 0) {
    return isArray ? [] : null;
  }
  return kept.length > 1 || isArray ? kept : kept[0];
}

/** Patches `current` per `options`: drops every raw element whose resolved path is in `remove`,
 * then inserts a `format`-ed string for every `add` target not already present (after removal) —
 * at the position of the first removed element, or appended when nothing was removed. Elements
 * that aren't links, or are links that don't resolve, are never touched (kept exactly as written).
 * Round 2 minor 1: the key itself is always kept, even when the result holds no elements at all —
 * `[]` when the value should stay array-shaped, `null` for a scalar. Never deletes the key. */
export function patchLinksValue(current: unknown, options: LinkPatchOptions): unknown {
  const { remove, add, list, resolve, format } = options;
  const { items, wasArray } = rawItemsOf(current);
  const { kept, insertIndex, presentTargets } = removeMatching(items, remove, resolve);

  const toInsert = add
    .filter((target) => !presentTargets.has(target))
    .map((target) => format(target));
  kept.splice(insertIndex ?? kept.length, 0, ...toInsert);

  return finalizeValue(kept, items.length === 0 ? list : wasArray);
}

/** Case/whitespace-insensitive string equality — matches how retype's recipe-property cleanup has
 * always compared a note's current value against the schema's recipe value. */
export function looseEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Round 2 minor 2: real Obsidian's `parseFrontMatterTags` does not strip a leading `#` off a raw
 * frontmatter tag element, so a note's actual `tags` array can hold `"#project"` rather than
 * `"project"`. Schema tag names never carry a `#`, so matching a raw element against one needs its
 * own `#` stripped first — matching what we do when *reading* tags (see `snapshot-reader.ts`). */
function stripHash(value: string): string {
  return value.startsWith('#') ? value.slice(1) : value;
}

/** `looseEqual`, tolerant of a raw item's optional leading `#` (tags only carry one; recipe
 * property values never do, so this is a safe superset of the plain comparison). */
function looseEqualIgnoringHash(item: string, expected: string): boolean {
  return looseEqual(stripHash(item), expected);
}

export interface ListItemPatch {
  readonly remove?: string;
  readonly add?: string;
}

interface ListRemovalResult {
  readonly kept: unknown[];
  readonly insertIndex: number | null;
}

/** Walks `items` in order, dropping the first one `looseEqual` (ignoring a leading `#`) to
 * `remove` (when given) and recording the position it was dropped from. */
function removeListMatch(items: readonly unknown[], remove: string | undefined): ListRemovalResult {
  const kept: unknown[] = [];
  let insertIndex: number | null = null;
  let removed = false;
  for (const item of items) {
    if (
      !removed &&
      remove !== undefined &&
      typeof item === 'string' &&
      looseEqualIgnoringHash(item, remove)
    ) {
      removed = true;
      insertIndex = kept.length;
      continue;
    }
    kept.push(item);
  }
  return { kept, insertIndex };
}

/** Inserts `add` into `kept` (mutating it) at `insertIndex`, or appended when nothing was removed
 * — a no-op when `add` is absent, or already present (ignoring a leading `#`). */
function insertListAdd(kept: unknown[], insertIndex: number | null, add: string | undefined): void {
  if (add === undefined) {
    return;
  }
  const alreadyPresent = kept.some(
    (item) => typeof item === 'string' && looseEqualIgnoringHash(item, add),
  );
  if (alreadyPresent) {
    return;
  }
  kept.splice(insertIndex ?? kept.length, 0, add);
}

/** Patches a *plain* (non-link) list-shaped frontmatter value by element, for retype's recipe
 * properties and frontmatter tags: removes the first element `looseEqual` to `patch.remove` (when
 * given), then inserts `patch.add` (when given and not already present) at the removed element's
 * position, or appended when nothing was removed. Mirrors `patchLinksValue`'s positional rule
 * without needing a resolver, since these values are never links. A scalar `current` stays a
 * scalar unless the result ends up holding more than one element. Round 2 minor 1: the key is
 * always kept — `[]` when the result is empty and `current` was already an array, `null` when
 * it's empty and `current` was scalar/absent. */
export function patchListItem(current: unknown, patch: ListItemPatch): unknown {
  const { items, wasArray } = rawItemsOf(current);
  const { kept, insertIndex } = removeListMatch(items, patch.remove);
  insertListAdd(kept, insertIndex, patch.add);
  return finalizeValue(kept, wasArray);
}
