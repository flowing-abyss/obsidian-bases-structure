import type { BasesAllOptions, BasesViewConfig } from 'obsidian';
import { Notice, Plugin } from 'obsidian';
import { UndoManager } from './obsidian/undo-manager.js';
import { formatUndoResult } from './view/actions-ui.js';
import { STRUCTURE_VIEW_ID, StructureView } from './view/structure-view.js';
import { clearUiState } from './view/view-state.js';

export { STRUCTURE_VIEW_ID };

const UNDO_COMMAND_ID = 'undo-last-change';

/** The Bases view's config controls: the frontmatter property that points at a note's parent,
 * and which renderer draws the tree. `config` is unused for now — every option here is static —
 * but the registration hook always passes it, so the parameter stays for signature parity. */
function buildViewOptions(_config: BasesViewConfig): BasesAllOptions[] {
  return [
    {
      type: 'property',
      key: 'parent',
      displayName: 'Parent property',
      filter: (prop) => prop.startsWith('note.'),
      default: '',
    },
    {
      type: 'dropdown',
      key: 'layout',
      displayName: 'Layout',
      options: { graph: 'Graph', outline: 'Outline' },
      default: 'graph',
    },
  ];
}

export default class StructureViewPlugin extends Plugin {
  private undoManager: UndoManager | null = null;

  /** Created lazily on first use (in practice, no earlier than `onload`, since nothing else in
   * this plugin touches it before the view factory and the undo command exist). */
  get undo(): UndoManager {
    this.undoManager ??= new UndoManager(this.app);
    return this.undoManager;
  }

  override onload(): void {
    this.registerBasesView(STRUCTURE_VIEW_ID, {
      name: 'Structure',
      icon: 'git-fork',
      factory: (controller, containerEl) => new StructureView(controller, containerEl, this),
      options: buildViewOptions,
    });

    this.addCommand({
      id: UNDO_COMMAND_ID,
      name: 'Undo last structure change',
      checkCallback: (checking) => {
        if (!this.undo.canUndo) {
          return false;
        }
        if (!checking) {
          this.runUndo().catch((error: unknown) => {
            console.error('[bases-structure]', error);
            this.notify('Structure: undo failed');
          });
        }
        return true;
      },
    });
  }

  override onunload(): void {
    clearUiState();
  }

  private async runUndo(): Promise<void> {
    const result = await this.undo.undo();
    this.notify(`Structure: ${formatUndoResult(result)}`);
  }

  /** Thin wrapper around `new Notice(...)` so tests can observe the message shown without
   * spying on the `Notice` class itself (its module export isn't reconfigurable under Vitest's
   * ESM mocking). */
  private notify(message: string): void {
    new Notice(message);
  }
}
