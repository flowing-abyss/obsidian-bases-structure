// The Bases view entry point: parses the view's config into a `Schema`, reads a `Snapshot` from
// the current query results, builds the pure `Structure`, and hands it to a renderer. Bases hides
// an empty `.bases-view` inside embeds (`display: none`), which stops the query from ever
// running — so the two child elements are created in the constructor, before any data arrives.

import type { QueryController } from 'obsidian';
import { BasesView } from 'obsidian';
import type { Schema, SchemaIssue } from '../core/schema.js';
import { parseSchema } from '../core/schema.js';
import type { Snapshot } from '../core/snapshot.js';
import { displayName } from '../core/snapshot.js';
import type { Structure, StructureIssue } from '../core/structure.js';
import { buildStructure } from '../core/structure.js';
import type StructureViewPlugin from '../main.js';
import { findHostFile } from '../obsidian/root-finder.js';
import { readSnapshot } from '../obsidian/snapshot-reader.js';
import { StructureActions } from './actions-ui.js';
import { GraphRenderer } from './graph-renderer.js';
import type { NodeElementContext } from './node-element.js';
import { OutlineRenderer } from './outline-renderer.js';
import type { ViewUiState } from './view-state.js';
import { getUiState } from './view-state.js';

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

  constructor(controller: QueryController, parentEl: HTMLElement, plugin: StructureViewPlugin) {
    super(controller);
    this.plugin = plugin;
    this.containerEl = parentEl.createDiv('bases-structure');
    this.issuesEl = this.containerEl.createDiv('bases-structure-issues');
    this.bodyEl = this.containerEl.createDiv('bases-structure-body');
    this.register(() => {
      this.actions?.destroy();
      this.renderer?.destroy();
      this.containerEl.empty();
      this.containerEl.remove();
    });
  }

  override onDataUpdated(): void {
    try {
      this.render();
    } catch (error) {
      console.error('[bases-structure]', error);
      this.bodyEl.empty();
      this.bodyEl.setText(`Structure view failed: ${errorMessage(error)}`);
    }
  }

  private render(): void {
    const { schema, issues } = parseSchema((key) => this.config.get(key));
    const host = findHostFile(this.app, this.containerEl);
    const snapshot = readSnapshot(
      this.app,
      this.data.data.map((entry) => entry.file),
      host,
    );
    const structure = buildStructure(schema, snapshot);
    this.renderIssues(issues, structure.issues, snapshot);
    const state = getUiState(`${host?.path ?? ''}::${this.config.name}`);
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
    const focusPath = actions.consumeFocus();
    renderer.update(focusPath === null ? input : { ...input, focusPath });
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
      hostPath,
      refresh: () => {
        this.render();
      },
    });
    return this.actions;
  }

  /** Recreates the renderer whenever the resolved layout changes (including the very first
   * render). `ctx` only has to be correct at the moment of construction — each renderer keeps its
   * own working copy and refreshes it from every `RenderInput` it's given afterwards. */
  private resolveRenderer(layout: Schema['layout'], ctx: NodeElementContext): StructureRenderer {
    if (this.renderer === null || this.rendererLayout !== layout) {
      this.renderer?.destroy();
      this.renderer =
        layout === 'outline'
          ? new OutlineRenderer(this.bodyEl, ctx)
          : new GraphRenderer(this.bodyEl, ctx);
      this.rendererLayout = layout;
    }
    return this.renderer;
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
