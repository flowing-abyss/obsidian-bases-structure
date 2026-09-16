// The "+" create flow: turns a click on a node's add button into a typed, inline-named child
// note. Mirrors the design spec's "Действия: одно ядро" — a create is just another action planned
// against the current snapshot, verified, and applied through the same `commitPlan`/`UndoManager`
// pipeline every other action uses; this module only owns the transient "draft" input (one at a
// time, appended inside the parent node's own element) and the menu/chaining UX around it.

import type { App } from 'obsidian';
import { Menu, Notice } from 'obsidian';
import type { Action, PlanEnv } from '../core/plan-types.js';
import { childOptions, planAction } from '../core/planner.js';
import type { EdgeRule } from '../core/schema.js';
import { displayName } from '../core/snapshot.js';
import { commitPlan } from '../obsidian/plan-applier.js';
import type { UndoManager } from '../obsidian/undo-manager.js';
import type { RenderInput } from './structure-view.js';

export interface ActionsDeps {
  readonly app: App;
  readonly undo: UndoManager;
  readonly getInput: () => RenderInput;
  readonly hostPath: string;
  readonly refresh: () => void;
}

type ChainMode = 'enter' | 'tab';

interface DraftState {
  readonly anchorEl: HTMLElement;
  readonly parentPath: string;
  readonly type: string;
  readonly wrapperEl: HTMLElement;
  readonly inputEl: HTMLInputElement;
  committing: boolean;
}

const DRAFT_CLASS = 'bases-structure-draft';
const DRAFT_INPUT_CLASS = 'bases-structure-draft-input';
const UNDO_CLASS = 'bases-structure-undo';
const NODE_SELECTOR = '.bases-structure-node';
const ROOT_SELECTOR = '.bases-structure-body';
const UNDO_NOTICE_DURATION = 8000;

function logError(error: unknown): void {
  console.error('[bases-structure]', error);
}

function notifyError(message: string): void {
  new Notice(`Structure: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every `.bases-structure-node` under `root` whose `data-path` is `path` — a linear scan instead
 * of an attribute-selector query, since a note path can contain characters (quotes, brackets)
 * that would need escaping in a CSS selector. */
function findNodeElement(root: HTMLElement, path: string): HTMLElement | null {
  for (const node of Array.from(root.querySelectorAll<HTMLElement>(NODE_SELECTOR))) {
    if (node.getAttribute('data-path') === path) {
      return node;
    }
  }
  return null;
}

/** Owns the single "+" draft input a `StructureView` can have open at once, and the plan → apply
 * → undo pipeline a committed draft runs through. One instance per view, created once and reused
 * across renders (see `structure-view.ts`). */
export class StructureActions {
  private readonly deps: ActionsDeps;
  private draft: DraftState | null = null;
  private pendingFocus: string | null = null;

  constructor(deps: ActionsDeps) {
    this.deps = deps;
  }

  /** The path to highlight in the render that follows a successful create — consumed (cleared) so
   * a later, unrelated refresh doesn't reapply the highlight. */
  consumeFocus(): string | null {
    const focus = this.pendingFocus;
    this.pendingFocus = null;
    return focus;
  }

  startCreate(parentPath: string, anchorEl: HTMLElement, event?: MouseEvent): void {
    const { schema, snapshot, structure } = this.deps.getInput();
    const options = childOptions(schema, structure, parentPath);
    if (options.length === 0) {
      notifyError(`nothing can be added under "${displayName(snapshot, parentPath)}"`);
      return;
    }
    const [only] = options;
    if (only !== undefined && options.length === 1) {
      this.openDraft(parentPath, anchorEl, only.type);
      return;
    }
    this.showTypeMenu(parentPath, anchorEl, options, event);
  }

  cancelDraft(): void {
    const draft = this.draft;
    if (draft === null) {
      return;
    }
    draft.inputEl.removeEventListener('keydown', this.handleDraftKeydown);
    draft.inputEl.removeEventListener('blur', this.handleDraftBlur);
    draft.wrapperEl.remove();
    this.draft = null;
  }

  destroy(): void {
    this.cancelDraft();
  }

  private showTypeMenu(
    parentPath: string,
    anchorEl: HTMLElement,
    options: ReadonlyArray<{ readonly type: string; readonly rule: EdgeRule }>,
    event?: MouseEvent,
  ): void {
    const menu = new Menu();
    for (const option of options) {
      menu.addItem((item) => {
        item.setTitle(option.type).onClick(() => {
          this.openDraft(parentPath, anchorEl, option.type);
        });
      });
    }
    if (event !== undefined) {
      menu.showAtMouseEvent(event);
      return;
    }
    const rect = anchorEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }

  private openDraft(parentPath: string, anchorEl: HTMLElement, type: string): void {
    this.cancelDraft();
    const wrapperEl = anchorEl.createDiv(DRAFT_CLASS);
    const inputEl = wrapperEl.createEl('input', {
      cls: DRAFT_INPUT_CLASS,
      attr: { placeholder: type, spellcheck: 'false' },
    });
    inputEl.addEventListener('keydown', this.handleDraftKeydown);
    inputEl.addEventListener('blur', this.handleDraftBlur);
    this.draft = { anchorEl, parentPath, type, wrapperEl, inputEl, committing: false };
    inputEl.focus();
  }

  private readonly handleDraftKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.cancelDraft();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitDraft('enter');
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      this.commitDraft('tab');
    }
  };

  private readonly handleDraftBlur = (): void => {
    if (this.draft !== null && !this.draft.committing) {
      this.cancelDraft();
    }
  };

  /** Whether `draft` is still the session the user is looking at — `false` once it's been
   * replaced or cancelled (Escape/blur/a new "+" elsewhere), which can happen while an earlier
   * draft's commit is still in flight. Reference equality against `this.draft` doubles as a
   * session token: every draft is a fresh object, so an old reference stops matching the moment
   * it's superseded, without needing a separate id. */
  private isCurrentDraft(draft: DraftState): boolean {
    return this.draft === draft;
  }

  private commitDraft(mode: ChainMode): void {
    const draft = this.draft;
    if (draft === null || draft.committing) {
      return;
    }
    const name = draft.inputEl.value.trim();
    if (name === '') {
      return;
    }
    draft.committing = true;
    this.runCommit(draft, name, mode).catch((error: unknown) => {
      logError(error);
      notifyError(`could not create the note. ${errorMessage(error)}`);
      // Undo the `committing` lock so the draft (if it's still the one on screen) is usable
      // again: blur can cancel it, and the user can edit the name and retry with Enter/Tab.
      if (!this.isCurrentDraft(draft)) {
        return;
      }
      draft.committing = false;
      draft.inputEl.select();
    });
  }

  private resolveDefaultFolder(): string {
    const folder = this.deps.app.fileManager.getNewFileParent(this.deps.hostPath).path;
    return folder === '/' ? '' : folder;
  }

  private async runCommit(draft: DraftState, name: string, mode: ChainMode): Promise<void> {
    const root = draft.anchorEl.closest<HTMLElement>(ROOT_SELECTOR);
    const { schema, snapshot } = this.deps.getInput();
    const env: PlanEnv = {
      defaultFolder: this.resolveDefaultFolder(),
      exists: (path) => this.deps.app.vault.getAbstractFileByPath(path) !== null,
    };
    const action: Action = { kind: 'create', parent: draft.parentPath, type: draft.type, name };
    const result = planAction(schema, snapshot, action, env);
    if (!result.ok) {
      notifyError(result.reason);
      draft.committing = false;
      draft.inputEl.select();
      return;
    }
    const applied = await commitPlan(
      this.deps.app,
      this.deps.undo,
      result.plan,
      `Create "${name}"`,
    );
    // Captured before this method's own cleanup below touches `this.draft`: if the user cancelled
    // this draft (Escape/blur) or opened a different one while the commit was in flight, `draft`
    // no longer matches, and chaining has nothing sensible to re-anchor to.
    const wasCurrent = this.isCurrentDraft(draft);
    this.pendingFocus = result.focus;
    this.cancelDraft();
    this.deps.refresh();
    if (!applied) {
      return;
    }
    this.showUndoNotice(`Created "${name}"`);
    if (!wasCurrent) {
      return;
    }
    this.continueChain({
      root,
      parentPath: draft.parentPath,
      type: draft.type,
      mode,
      focusPath: result.focus,
    });
  }

  private continueChain(ctx: {
    readonly root: HTMLElement | null;
    readonly parentPath: string;
    readonly type: string;
    readonly mode: ChainMode;
    readonly focusPath: string;
  }): void {
    if (ctx.root === null) {
      return;
    }
    if (ctx.mode === 'enter') {
      const anchorEl = findNodeElement(ctx.root, ctx.parentPath);
      if (anchorEl !== null) {
        this.openDraft(ctx.parentPath, anchorEl, ctx.type);
      }
      return;
    }
    const anchorEl = findNodeElement(ctx.root, ctx.focusPath);
    if (anchorEl !== null) {
      this.startCreate(ctx.focusPath, anchorEl);
    }
  }

  private showUndoNotice(message: string): void {
    const button = createEl('button', { cls: UNDO_CLASS, text: 'Undo' });
    const fragment = createFragment((el) => {
      el.createSpan({ text: message });
      el.appendChild(button);
    });
    const notice = new Notice(fragment, UNDO_NOTICE_DURATION);
    button.addEventListener('click', () => {
      this.runUndoFromNotice(notice);
    });
  }

  private runUndoFromNotice(notice: Notice): void {
    this.deps.undo
      .undo()
      .then(() => {
        this.deps.refresh();
        notice.hide();
      })
      .catch((error: unknown) => {
        logError(error);
        notifyError('undo failed');
      });
  }
}
