// The Bases view entry point: parses the view's config into a `Schema`, reads a `Snapshot` from
// the current query results, builds the pure `Structure`, and hands it to a renderer. Bases hides
// an empty `.bases-view` inside embeds (`display: none`), which stops the query from ever
// running — so the two child elements are created in the constructor, before any data arrives.
//
// `onDataUpdated` can fire at any time, including while a create draft is open (see
// `actions-ui.ts`'s `StructureActions`) — both renderers rebuild every node on every render, which
// would otherwise wipe the draft's DOM, typed value and focus out from under the user. While
// `StructureActions.hasOpenDraft` is true, a data-driven render is deferred (`pendingRender`)
// instead of run immediately, and flushed exactly once when the draft closes for any reason —
// cancel, commit, or the view unloading — via `ActionsDeps.onDraftClosed`.

import type { QueryController } from 'obsidian';
import { BasesView, Notice } from 'obsidian';
import { moveTargets } from '../core/plan-move.js';
import type { Schema, SchemaIssue } from '../core/schema.js';
import { parseSchema } from '../core/schema.js';
import type { Snapshot } from '../core/snapshot.js';
import { displayName } from '../core/snapshot.js';
import type { Structure, StructureIssue } from '../core/structure.js';
import { buildStructure } from '../core/structure.js';
import type StructureViewPlugin from '../main.js';
import { findContainingFile, findHostFile } from '../obsidian/root-finder.js';
import { readSnapshot } from '../obsidian/snapshot-reader.js';
import type { FreshInput } from './actions-ui.js';
import { StructureActions } from './actions-ui.js';
import { attachDrag } from './drag.js';
import { GraphRenderer } from './graph-renderer.js';
import { attachKeyboard } from './keyboard.js';
import type { NodeElementContext } from './node-element.js';
import { OutlineRenderer } from './outline-renderer.js';
import type { ViewUiState } from './view-state.js';
import { getUiState } from './view-state.js';

const NODE_SELECTOR = '.bases-structure-node';

/** Fallback `Structure`/`ViewUiState` for `attachStructureKeyboard`'s deps closures, for the
 * (never actually reached in practice — `render()` always sets `lastInput` before the keyboard
 * handler is attached, see `resolveRenderer`) case the type system still has to account for.
 * `EMPTY_STRUCTURE` is a shared constant since keyboard.ts only ever reads a `Structure`, never
 * mutates it; the state fallback is built fresh per call since `ViewUiState.collapsed` is a
 * mutable `Set` and a shared singleton could otherwise leak mutations across calls. */
const EMPTY_STRUCTURE: Structure = {
  root: null,
  tops: [],
  orphans: [],
  nodes: new Map(),
  issues: [],
};

function emptyViewState(): ViewUiState {
  return {
    collapsed: new Set(),
    zoom: 1,
    zoomTouched: false,
    scrollLeft: 0,
    scrollTop: 0,
    active: null,
  };
}

export interface RenderInput {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly structure: Structure;
  readonly state: ViewUiState;
  /** The path to flag `is-new` in this render only — set for the one render right after a
   * successful create, then cleared (see `StructureActions.consumeFocus`). */
  readonly focusPath?: string;
}

export interface StructureRenderer {
  update(input: RenderInput): void;
  /** The rendered element for `path` (whichever of the shared `.bases-structure-node` cards
   * currently represents it), or `null` when it isn't currently in the DOM (collapsed away, or
   * not part of the structure). Consumed by the keyboard task to anchor menus/drafts. */
  getNodeElement(path: string): HTMLElement | null;
  destroy(): void;
}

export const STRUCTURE_VIEW_ID = 'structure';

const MAX_ISSUES_SHOWN = 5;

/** Exported for direct unit testing of the `path === null` branch: `buildStructure` doesn't
 * currently produce a structure issue without a path, but the formatting stays generic per the
 * design spec ("Ошибки конфига") in case a future issue kind needs it. */
export function formatStructureIssue(issue: StructureIssue, snapshot: Snapshot): string {
  if (issue.path === null) {
    return issue.message;
  }
  return `${displayName(snapshot, issue.path)}: ${issue.message}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A schema issue with no key (e.g. the top-level "set parent or types" issue) renders as just
 * the message — a leading ": " with nothing before it would read as a formatting bug, not as
 * "this issue has no specific key". */
function formatSchemaIssue(issue: SchemaIssue): string {
  return issue.key === '' ? issue.message : `${issue.key}: ${issue.message}`;
}

function collectIssueLines(
  schemaIssues: readonly SchemaIssue[],
  structureIssues: readonly StructureIssue[],
  snapshot: Snapshot,
): string[] {
  return [
    ...schemaIssues.map((issue) => formatSchemaIssue(issue)),
    ...structureIssues.map((issue) => formatStructureIssue(issue, snapshot)),
  ];
}

export class StructureView extends BasesView {
  override readonly type = STRUCTURE_VIEW_ID;

  private readonly plugin: StructureViewPlugin;
  private readonly containerEl: HTMLElement;
  private readonly issuesEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private renderer: StructureRenderer | null = null;
  private rendererLayout: Schema['layout'] | null = null;
  private actions: StructureActions | null = null;
  private lastInput: RenderInput | null = null;
  private dragDispose: (() => void) | null = null;
  private keyboardDispose: (() => void) | null = null;
  /** Set by `onDataUpdated` when a data-driven render arrives while a create draft is open (see
   * the class doc comment's carried-over fix); flushed by `flushPendingRender` once the draft
   * closes, however it closes — cancel, commit, or the view unloading. */
  private pendingRender = false;

  constructor(controller: QueryController, parentEl: HTMLElement, plugin: StructureViewPlugin) {
    super(controller);
    this.plugin = plugin;
    this.containerEl = parentEl.createDiv('bases-structure');
    this.issuesEl = this.containerEl.createDiv('bases-structure-issues');
    this.bodyEl = this.containerEl.createDiv('bases-structure-body');
    this.registerDomEvent(this.containerEl, 'contextmenu', (event) => {
      this.handleContextMenu(event);
    });
    this.register(() => {
      this.dragDispose?.();
      this.keyboardDispose?.();
      this.actions?.destroy();
      this.renderer?.destroy();
      this.containerEl.empty();
      this.containerEl.remove();
    });
  }

  /** Bases can call this at any time, including while the user has a create draft open and is
   * mid-keystroke (e.g. a metadata plugin filling in fields on the note the draft is about to
   * chain from) — both renderers rebuild every node on `update()`, which would otherwise destroy
   * the draft's DOM, typed value and focus. While `hasOpenDraft` is true, defer: remember that a
   * render is owed and let `flushPendingRender` run it once the draft actually closes. */
  override onDataUpdated(): void {
    if (this.actions?.hasOpenDraft === true) {
      this.pendingRender = true;
      return;
    }
    this.safeRender();
  }

  private safeRender(): void {
    try {
      this.render();
    } catch (error) {
      console.error('[bases-structure]', error);
      this.bodyEl.empty();
      this.bodyEl.setText(`Structure view failed: ${errorMessage(error)}`);
    }
  }

  /** Wired as `ActionsDeps.onDraftClosed`: runs the render `onDataUpdated` deferred, exactly once,
   * the moment a draft closes for any reason — including the view's own `onunload` (`actions`'s
   * `destroy()` also funnels through `cancelDraft`), so a pending render is never silently lost. */
  private flushPendingRender(): void {
    if (!this.pendingRender) {
      return;
    }
    this.pendingRender = false;
    this.safeRender();
  }

  /** Parses the schema and re-reads the snapshot/structure straight from the vault's current
   * state — the one computation both `render()` (which also needs `issues`/`host` for the rest of
   * its own work) and `readFreshInput()` (I5: an action plans against this, not the last render's
   * possibly-stale `RenderInput`) share, so they can never disagree about what "current" means. */
  private computeCurrentData(): {
    readonly schema: Schema;
    readonly issues: readonly SchemaIssue[];
    readonly host: ReturnType<typeof findHostFile>;
    readonly snapshot: Snapshot;
    readonly structure: Structure;
  } {
    const { schema, issues } = parseSchema((key) => this.config.get(key));
    const host = findHostFile(this.app, this.containerEl);
    const snapshot = readSnapshot(
      this.app,
      this.data.data.map((entry) => entry.file),
      host,
    );
    const structure = buildStructure(schema, snapshot);
    return { schema, issues, host, snapshot, structure };
  }

  /** The `getUiState` key (I9): must include the `.base` file itself, or two different `.base`
   * files opened directly (no host note at all, so `host` is `null` for both) with a view of the
   * same name would collide on the exact same key and silently share collapsed/zoom/scroll/active
   * state. Embedded in a host note, `host.path` already disambiguates (a note only has one Bases
   * embed of a given view name at a time in practice), so the key stays exactly what it was before
   * this fix. Opened directly, `host` is `null` — `BasesView`/`BasesViewConfig`/`QueryController`'s
   * public surface has nothing file-related to fall back to (see `findContainingFile`'s own doc
   * comment for what was actually checked), so this uses the `.base` file's own path via that
   * broader, `FileView`-based lookup; if even that somehow finds nothing, the key degrades to the
   * pre-I9 host+view-name shape (`''::name`) — a known, documented limitation, not a crash. */
  private resolveStateKey(host: ReturnType<typeof findHostFile>): string {
    const basePath =
      host !== null ? host.path : (findContainingFile(this.app, this.containerEl)?.path ?? '');
    return `${basePath}::${this.config.name}`;
  }

  private render(): void {
    const { schema, issues, host, snapshot, structure } = this.computeCurrentData();
    this.renderIssues(issues, structure.issues, snapshot);
    const state = getUiState(this.resolveStateKey(host));
    const input: RenderInput = { schema, snapshot, structure, state };
    this.lastInput = input;
    const actions = this.resolveActions(host?.path ?? '', () => this.lastInput ?? input);
    const ctx: NodeElementContext = {
      app: this.app,
      sourcePath: host?.path ?? '',
      hoverParent: this,
      snapshot,
      onAdd: (path, anchorEl) => {
        actions.startCreate(path, anchorEl);
      },
    };
    const renderer = this.resolveRenderer(schema.layout, ctx);
    const focusPath = actions.resolveFocus(structure);
    renderer.update(focusPath === null ? input : { ...input, focusPath });
    // Must run on *every* render (I7), not just the one right after a commit: the render right
    // after `commitPlan` resolves almost never has Bases' own data caught up with the note it just
    // wrote (see `StructureActions.runCommit`), so the pending create's path usually isn't in
    // `structure` yet on that first pass — this only actually completes it once a later render
    // (from `onDataUpdated`) does contain it.
    actions.completePending(structure, this.bodyEl);
  }

  /** `ActionsDeps.freshInput()` — re-reads the vault right now, independent of when the last
   * `render()` happened to run (I5). Never touches the DOM/UI state, so it's safe to call at any
   * time, including while a create draft is open. */
  private readFreshInput(): FreshInput {
    const { schema, snapshot, structure } = this.computeCurrentData();
    return { schema, snapshot, structure };
  }

  /** Created once, on the first render, and reused for the view's whole lifetime — unlike the
   * renderer, a layout switch doesn't need a fresh instance. `getInput` always resolves to the
   * latest render's data (see `render()`); only `hostPath` is fixed at creation, since a Bases
   * embed's host note doesn't move without the view itself being torn down and recreated. */
  private resolveActions(hostPath: string, getInput: () => RenderInput): StructureActions {
    this.actions ??= new StructureActions({
      app: this.app,
      undo: this.plugin.undo,
      getInput,
      freshInput: () => this.readFreshInput(),
      hostPath,
      refresh: () => {
        this.render();
      },
      onDraftClosed: () => {
        this.flushPendingRender();
      },
    });
    return this.actions;
  }

  /** Recreates the renderer whenever the resolved layout changes (including the very first
   * render). `ctx` only has to be correct at the moment of construction — each renderer keeps its
   * own working copy and refreshes it from every `RenderInput` it's given afterwards. */
  private resolveRenderer(layout: Schema['layout'], ctx: NodeElementContext): StructureRenderer {
    if (this.renderer === null || this.rendererLayout !== layout) {
      this.dragDispose?.();
      this.keyboardDispose?.();
      this.renderer?.destroy();
      this.renderer =
        layout === 'outline'
          ? new OutlineRenderer(this.bodyEl, ctx)
          : new GraphRenderer(this.bodyEl, ctx);
      this.rendererLayout = layout;
      this.dragDispose = this.attachNodeDrag();
      this.keyboardDispose = this.attachStructureKeyboard(this.renderer);
    }
    return this.renderer;
  }

  /** `targetsFor`/`onDrop` always resolve against `this.lastInput`/`this.actions` at drag time
   * (not whatever was current when `attachDrag` was called) — the same "read the latest render"
   * approach `resolveActions`'s `getInput` uses, since a single `attachDrag` call is reused across
   * every render until the renderer itself is next recreated (see `resolveRenderer`). */
  private attachNodeDrag(): () => void {
    return attachDrag({
      container: this.bodyEl,
      targetsFor: (path) => {
        if (this.lastInput === null) {
          return new Set();
        }
        return moveTargets(this.lastInput.schema, this.lastInput.structure, path);
      },
      onDrop: (node, parent) => {
        this.actions?.startMove(node, parent);
      },
    });
  }

  /** Wires `keyboard.ts`'s roving-focus control (task 16) to the same `bodyEl` container the drag
   * gesture uses, attached/disposed alongside it in `resolveRenderer`. Every dep here either reads
   * the latest render (`this.lastInput`, same fallback pattern as `attachNodeDrag`'s `targetsFor`)
   * or forwards straight to `this.actions` — `addSibling` is the one exception, resolved below.
   * `renderer` is `resolveRenderer`'s own freshly-assigned `this.renderer`, passed in (rather than
   * read back off `this.renderer` inside the closure) purely so `renderCollapse` only has to guard
   * one nullable (`this.lastInput`), not two that are always either both set or both unset. */
  private attachStructureKeyboard(renderer: StructureRenderer): () => void {
    return attachKeyboard({
      container: this.bodyEl,
      getStructure: () => this.lastInput?.structure ?? EMPTY_STRUCTURE,
      getState: () => this.lastInput?.state ?? emptyViewState(),
      // I6: collapse/expand only ever change `state.collapsed`, already reflected by mutating the
      // same `ViewUiState` object the last render's `RenderInput` still holds — re-drawing from it
      // is a renderer's own cheap `update()`, with no schema re-parse/snapshot re-read/
      // `buildStructure` (a full `render()`, as this used to call, was one of I6's several
      // multipliers: every keyboard collapse/expand rebuilt the whole structure from scratch).
      renderCollapse: () => {
        if (this.lastInput !== null) {
          renderer.update(this.lastInput);
        }
      },
      open: (path, newTab) => {
        this.actions?.openNode(path, newTab);
      },
      addChild: (path, anchorEl) => {
        this.actions?.startCreate(path, anchorEl);
      },
      addSibling: (path, anchorEl) => {
        this.handleAddSibling(path, anchorEl);
      },
      movePicker: (path) => {
        this.actions?.startMovePicker(path);
      },
      retype: (path, anchorEl) => {
        this.actions?.startRetype(path, anchorEl);
      },
      undo: () => {
        this.actions?.undoLast();
      },
    });
  }

  /** Adding a sibling means creating under `path`'s own *parent* — a root/top node has none, so
   * that case shows a Notice instead (see task 16's decisions) rather than silently doing nothing
   * or falling back to some other parent. The draft opens anchored to the parent's own rendered
   * element (via the renderer's `getNodeElement`), not `anchorEl` (the active node's own element
   * `keyboard.ts` passes) — a new sibling visually belongs under the parent, the same place a
   * "+" click there would open one; `anchorEl` is only a fallback for the practically-unreachable
   * case the parent isn't currently rendered. */
  private handleAddSibling(path: string, anchorEl: HTMLElement): void {
    const input = this.lastInput;
    if (input === null) {
      return;
    }
    const parent = input.structure.nodes.get(path)?.parent ?? null;
    if (parent === null) {
      const name = displayName(input.snapshot, path);
      new Notice(`Structure: "${name}" has no parent to add a sibling to`);
      return;
    }
    const parentAnchor = this.renderer?.getNodeElement(parent) ?? anchorEl;
    this.actions?.startCreate(parent, parentAnchor);
  }

  private handleContextMenu(event: MouseEvent): void {
    if (!(event.target instanceof HTMLElement)) {
      return;
    }
    const nodeEl = event.target.closest<HTMLElement>(NODE_SELECTOR);
    const path = nodeEl?.getAttribute('data-path') ?? null;
    if (path === null || this.actions === null) {
      return;
    }
    event.preventDefault();
    this.actions.openNodeMenu(path, event);
  }

  private renderIssues(
    schemaIssues: readonly SchemaIssue[],
    structureIssues: readonly StructureIssue[],
    snapshot: Snapshot,
  ): void {
    this.issuesEl.empty();
    const lines = collectIssueLines(schemaIssues, structureIssues, snapshot);
    if (lines.length === 0) {
      this.issuesEl.addClass('is-hidden');
      return;
    }
    this.issuesEl.removeClass('is-hidden');
    for (const line of lines.slice(0, MAX_ISSUES_SHOWN)) {
      this.issuesEl.createDiv({ text: line });
    }
    const remaining = lines.length - MAX_ISSUES_SHOWN;
    if (remaining > 0) {
      this.issuesEl.createDiv({ text: `+${remaining} more` });
    }
  }
}
