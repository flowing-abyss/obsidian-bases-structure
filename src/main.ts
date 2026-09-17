import type { BasesAllOptions, BasesViewConfig } from 'obsidian';
import { Notice, Plugin } from 'obsidian';
import { UndoManager } from './obsidian/undo-manager.js';
import { formatUndoResult } from './view/actions-ui.js';
import { STRUCTURE_VIEW_ID, StructureView } from './view/structure-view.js';
import { clearUiState } from './view/view-state.js';

export { STRUCTURE_VIEW_ID };

const UNDO_COMMAND_ID = 'undo-last-change';

/** The Bases view's config controls: which renderer draws the tree, and (graph only) which axis
 * it grows along. The parent property itself is edited directly in the `.base` file (see
 * `parseSchema`, which still reads `parent` from config) — these options only ever hold things
 * that change the picture. `shouldHide` closes over `config` (there is no other way to read the
 * *current* config value from inside it — `BasesOption.shouldHide` takes no arguments, see
 * `obsidian.d.ts`), so the direction option disappears the moment the layout option is switched
 * to outline (U3): the outline has no growth axis of its own, so offering the control there would
 * just be dead chrome. */
function buildViewOptions(config: BasesViewConfig): BasesAllOptions[] {
  return [
    {
      type: 'dropdown',
      key: 'layout',
      displayName: 'Layout',
      options: { graph: 'Graph', outline: 'Outline' },
      default: 'graph',
    },
    {
      type: 'dropdown',
      key: 'direction',
      displayName: 'Direction',
      options: { right: 'Left to right', down: 'Top to bottom' },
      default: 'right',
      shouldHide: () => config.get('layout') === 'outline',
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

    // M4: without this, hovering a node's title never shows Obsidian's "Page preview" popover —
    // `attachNodeInteractions` (`node-element.ts`) already fires the `hover-link` workspace event
    // with `source: 'bases-structure'` on every mouseover, but nothing had told Obsidian that
    // source exists, so every hover was silently ignored by the preview plugin.
    this.registerHoverLinkSource('bases-structure', {
      display: 'Bases Structure',
      defaultMod: true,
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
