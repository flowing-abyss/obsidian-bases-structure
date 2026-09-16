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
import { OutlineRenderer } from './outline-renderer.js';
import type { ViewUiState } from './view-state.js';
import { getUiState } from './view-state.js';

export interface RenderInput {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly structure: Structure;
  readonly state: ViewUiState;
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

function collectIssueLines(
  schemaIssues: readonly SchemaIssue[],
  structureIssues: readonly StructureIssue[],
  snapshot: Snapshot,
): string[] {
  return [
    ...schemaIssues.map((issue) => `${issue.key}: ${issue.message}`),
    ...structureIssues.map((issue) => formatStructureIssue(issue, snapshot)),
  ];
}

export class StructureView extends BasesView {
  override readonly type = STRUCTURE_VIEW_ID;

  private readonly containerEl: HTMLElement;
  private readonly issuesEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private renderer: StructureRenderer | null = null;
  private rendererLayout: Schema['layout'] | null = null;

  // `_plugin` isn't read yet — plugin-level interactions (e.g. an undo action from a node's
  // context menu) land in a later task, but the factory in `main.ts` always passes it, so the
  // constructor accepts it now to keep that call site stable.
  constructor(controller: QueryController, parentEl: HTMLElement, _plugin: StructureViewPlugin) {
    super(controller);
    this.containerEl = parentEl.createDiv('bases-structure');
    this.issuesEl = this.containerEl.createDiv('bases-structure-issues');
    this.bodyEl = this.containerEl.createDiv('bases-structure-body');
    this.register(() => {
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
    const renderer = this.resolveRenderer(schema.layout);
    renderer.update({ schema, snapshot, structure, state });
  }

  private resolveRenderer(layout: Schema['layout']): StructureRenderer {
    if (this.renderer === null || this.rendererLayout !== layout) {
      this.renderer?.destroy();
      this.renderer = new OutlineRenderer(this.app, this.bodyEl);
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
