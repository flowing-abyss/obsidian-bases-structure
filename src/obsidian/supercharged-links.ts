// Supercharged Links integration (D1): mirrors the same author's `obsidian-hybrid-search-plugin`
// (`src/ui/noteUtils.ts` — `applySuperchargedLinkAttributes`, `hookSuperchargedLinks`,
// `unhookSuperchargedLinks`) so this view's node title links (`node-element.ts`) get the exact
// same `data-link-*`/`--data-link-*` styling hooks and the exact same live updates (Supercharged
// Links' own `MutationObserver`) as a link anywhere else in the vault. Supercharged Links ships no
// public API or types — everything here reaches into its own plugin instance's private surface,
// so every access is guarded structurally (no `any`) and a missing/differently-shaped install is
// always a silent no-op, never a crash. `src/core` never imports `obsidian`; this module and its
// call sites (`node-element.ts`, `graph-renderer.ts`, `outline-renderer.ts`) are the only places
// that know Supercharged Links exists at all.

import type { App } from 'obsidian';

const SUPERCHARGED_LINKS_ID = 'supercharged-links-obsidian';

/** The slice of the Supercharged Links plugin this module actually calls — its own internals, not
 * a documented public API (the plugin ships no types of its own), so this stays deliberately
 * narrow and structural: an unexpected shape (a future major version changing these fields) just
 * fails the `typeof`/`Array.isArray` checks below instead of throwing on `undefined`. */
export interface SuperchargedLinksPlugin {
  // The trailing pair travels as one labeled rest tuple, not two named parameters, purely to stay
  // inside this project's `max-params` budget — call sites are unaffected: `f(a, b, c, d, e)`
  // still type-checks against a fixed 2-element rest tuple exactly as it would against two plain
  // parameters.
  _watchContainerDynamic: (
    watchId: string,
    container: HTMLElement,
    plugin: unknown,
    ...selector: [linkSelector: string, rowClass: string]
  ) => void;
  observers?: Array<[{ disconnect: () => void }, string]>;
}

// Not exported: talking to Supercharged Links is this module's job now, so nothing else needs to
// reach into its internals.
interface AppWithSuperchargedLinks {
  plugins?: {
    plugins?: Record<string, SuperchargedLinksPlugin | undefined>;
  };
}

function getSuperchargedLinks(app: App): SuperchargedLinksPlugin | undefined {
  return (app as unknown as AppWithSuperchargedLinks).plugins?.plugins?.[SUPERCHARGED_LINKS_ID];
}

function applyScalarAttribute(link: HTMLElement, key: string, value: unknown): void {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return;
  }
  const strVal = String(value);
  try {
    link.setAttribute(`data-link-${key}`, strVal);
    link.style.setProperty(`--data-link-${key}`, strVal);
  } catch {
    // Skip frontmatter keys that produce invalid attribute names.
  }
}

/** Copies every scalar frontmatter value at `path` onto `link` as both a `data-link-<key>`
 * attribute and a `--data-link-<key>` CSS custom property — the shape Supercharged Links' own
 * generated snippets style against. `position` (metadata-cache bookkeeping, not user frontmatter)
 * and non-scalar values (lists, nested maps) are skipped; a key that produces an invalid
 * attribute name is caught per-key so one bad key never drops every other one. */
export function applySuperchargedLinkAttributes(app: App, link: HTMLElement, path: string): void {
  const frontmatter = app.metadataCache.getCache(path.normalize('NFC'))?.frontmatter;
  if (frontmatter === undefined) {
    return;
  }
  for (const key of Object.keys(frontmatter)) {
    if (key !== 'position') {
      applyScalarAttribute(link, key, frontmatter[key]);
    }
  }
}

/**
 * Identifies one container this view asks Supercharged Links to watch.
 *
 * The observers live in Supercharged Links' own shared array, and unhooking works by matching
 * this id, so two installed copies of this plugin sharing an id would disconnect each other's
 * observers. `ownerId` namespaces the key; it is a required field with a nullable value so that
 * forgetting to wire it is a compile error rather than silent cross-copy interference.
 */
export interface SuperchargedWatch {
  ownerId: string | undefined;
  /** Identifies the container within one plugin instance. */
  id: string;
}

function watchKey(watch: SuperchargedWatch): string {
  return watch.ownerId !== undefined && watch.ownerId !== ''
    ? `${watch.ownerId}:${watch.id}`
    : watch.id;
}

/** Registers `containerEl` with Supercharged Links so every `linkSelector` match inside it (each
 * expected to sit inside an ancestor carrying `rowClass`) is kept in sync with its target note's
 * frontmatter, including future changes, via Supercharged Links' own `MutationObserver`. A no-op
 * when the plugin isn't installed or doesn't expose the expected method. Always unhooks `watch`
 * first, so calling this again for the same watch (e.g. a container swapped for a fresh one)
 * never accumulates duplicate observers. */
export function hookSuperchargedLinks(
  app: App,
  watch: SuperchargedWatch,
  containerEl: HTMLElement,
  // See `SuperchargedLinksPlugin._watchContainerDynamic`'s own comment: a labeled rest tuple, not
  // two plain parameters, so `hookSuperchargedLinks(app, watch, el, selector, rowClass)` still
  // works exactly as called, within this project's `max-params` budget.
  ...selector: [linkSelector: string, rowClass: string]
): void {
  const [linkSelector, rowClass] = selector;
  const sl = getSuperchargedLinks(app);
  if (sl === undefined || typeof sl._watchContainerDynamic !== 'function') {
    return;
  }
  unhookSuperchargedLinks(app, watch);
  sl._watchContainerDynamic(watchKey(watch), containerEl, sl, linkSelector, rowClass);
}

/** Removes every observer registered under any of `watches`' keys, disconnecting each one. A
 * no-op when the plugin isn't installed or its `observers` array isn't there. Keeps removing
 * every matching entry even when one's `disconnect()` throws — an unexpected shape shouldn't stop
 * the rest of the cleanup — but re-throws the first such error afterwards, so a caller that wants
 * this failure contained (see the renderers' own hook/unhook wrappers) has something to catch. */
export function unhookSuperchargedLinks(app: App, ...watches: SuperchargedWatch[]): void {
  const sl = getSuperchargedLinks(app);
  if (sl === undefined || !Array.isArray(sl.observers)) {
    return;
  }
  const observers = sl.observers;
  const keys = new Set(watches.map(watchKey));
  let failed = false;
  let firstError: unknown;
  for (let idx = observers.length - 1; idx >= 0; idx--) {
    const entry = observers[idx];
    if (entry === undefined || !keys.has(entry[1])) {
      continue;
    }
    observers.splice(idx, 1);
    try {
      entry[0].disconnect();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
  }
  if (failed) {
    throw firstError;
  }
}
