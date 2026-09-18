// In-memory UI state (collapsed branches, zoom, scroll position) for a structure view — never
// written to the `.base` file. Keyed by "host path + view name" so it survives Bases re-rendering
// the view and re-running its query, but resets when the plugin unloads. No Obsidian imports.

export interface ViewUiState {
  collapsed: Set<string>;
  zoom: number;
  // Set once the user zooms/pans by hand (buttons, wheel or a future gesture); while `false`, the
  // graph renderer keeps auto-fitting new layouts to the viewport instead of respecting `zoom`.
  zoomTouched: boolean;
  scrollLeft: number;
  scrollTop: number;
  // The path of the node the keyboard's roving focus currently sits on (task 16), or `null` when
  // nothing is active. Lives here rather than as its own module-level map for the same reason
  // `collapsed`/`zoom` do: it survives a re-render of the same view but resets on plugin unload.
  active: string | null;
}

const states = new Map<string, ViewUiState>();

function createDefaultState(): ViewUiState {
  return {
    collapsed: new Set(),
    zoom: 1,
    zoomTouched: false,
    scrollLeft: 0,
    scrollTop: 0,
    active: null,
  };
}

/** The `ViewUiState` for `key`, creating and storing a fresh default the first time it's asked
 * for. The same object is returned on every later call with the same key, so callers can mutate
 * it in place and have that stick across re-renders. */
export function getUiState(key: string): ViewUiState {
  const existing = states.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = createDefaultState();
  states.set(key, created);
  return created;
}

/** Drops every stored state — called from the plugin's `onunload` and reused as a test helper. */
export function clearUiState(): void {
  states.clear();
}
