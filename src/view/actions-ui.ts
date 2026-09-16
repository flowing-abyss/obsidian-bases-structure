// The "+" create flow: turns a click on a node's add button into a typed, inline-named child
// note. Mirrors the design spec's "Действия: одно ядро" — a create is just another action planned
// against the current snapshot, verified, and applied through the same `commitPlan`/`UndoManager`
// pipeline every other action uses; this module only owns the transient "draft" input (one at a
// time, appended inside the parent node's own element) and the menu/chaining UX around it.

import type { App, FuzzyMatch, PaneType } from 'obsidian';
import { FuzzySuggestModal, Keymap, Menu, Notice } from 'obsidian';
import { moveTargets } from '../core/plan-move.js';
import { retypeOptions } from '../core/plan-retype.js';
import type { Action, Plan, PlanEnv } from '../core/plan-types.js';
import { childOptions, planAction } from '../core/planner.js';
import type { EdgeRule } from '../core/schema.js';
import { displayName, folderOf, type Snapshot } from '../core/snapshot.js';
import { commitPlan } from '../obsidian/plan-applier.js';
import type { UndoManager, UndoResult } from '../obsidian/undo-manager.js';
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
const SUGGEST_FOLDER_CLASS = 'bases-structure-suggest-folder';

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

/** Menu items pass either a real click or a keyboard "activate" through the same callback — only
 * the former is a sensible anchor for a follow-up `showAtMouseEvent`, so `startCreate`/
 * `startRetype`'s own optional `event` param is left `undefined` for the keyboard case (falling
 * back to `anchorEl`'s position, same as every other caller without a mouse event). */
function asMouseEvent(evt: MouseEvent | KeyboardEvent): MouseEvent | undefined {
  return evt instanceof MouseEvent ? evt : undefined;
}

/** `Structure: nothing to undo` / `Structure: undone "<label>" (skipped <n> note(s))` — the exact
 * wording both `StructureActions.undoLast` and the plugin's global undo command show, kept in one
 * place so the two call sites can't drift apart. */
export function formatUndoResult(result: UndoResult): string {
  if (result.label === null) {
    return 'nothing to undo';
  }
  const suffix = result.skipped.length > 0 ? ` (skipped ${result.skipped.length} note(s))` : '';
  return `undone "${result.label}"${suffix}`;
}

/** The "Move to…" picker: a fuzzy list of `moveTargets`, each row showing the note's display name
 * plus its folder as a muted suffix. Choosing one hands the path back to `onChoose` (wired to
 * `StructureActions.startMove` by the caller) — this class owns only the listing/rendering. */
class MoveSuggestModal extends FuzzySuggestModal<string> {
  private readonly snapshot: Snapshot;
  private readonly targets: readonly string[];
  private readonly onChoose: (path: string) => void;

  constructor(
    app: App,
    snapshot: Snapshot,
    targets: readonly string[],
    onChoose: (path: string) => void,
  ) {
    super(app);
    this.snapshot = snapshot;
    this.targets = targets;
    this.onChoose = onChoose;
  }

  getItems(): string[] {
    return [...this.targets];
  }

  getItemText(path: string): string {
    return displayName(this.snapshot, path);
  }

  override renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void {
    el.createDiv({ text: displayName(this.snapshot, match.item) });
    const folder = folderOf(match.item);
    if (folder !== '') {
      el.createDiv({ cls: SUGGEST_FOLDER_CLASS, text: folder });
    }
  }

  onChooseItem(path: string): void {
    this.onChoose(path);
  }
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

  /** `moveTargets(node)` → picker; `size === 0` → a Notice instead, same shape as `startCreate`'s
   * "nothing can be added" guard. Choosing a target commits through `startMove`. */
  startMovePicker(node: string): void {
    const { schema, snapshot, structure } = this.deps.getInput();
    const targets = moveTargets(schema, structure, node);
    if (targets.size === 0) {
      notifyError(`nowhere to move "${displayName(snapshot, node)}"`);
      return;
    }
    const modal = new MoveSuggestModal(this.deps.app, snapshot, [...targets], (target) => {
      this.startMove(node, target);
    });
    modal.open();
  }

  /** Plans and commits a `'move'` action: `node` reparented under `parent`, with the planner's own
   * cascade to descendants. Rejections show the planner's reason and write nothing. */
  startMove(node: string, parent: string): void {
    const { schema, snapshot } = this.deps.getInput();
    const result = planAction(schema, snapshot, { kind: 'move', node, parent }, this.planEnv());
    if (!result.ok) {
      notifyError(result.reason);
      return;
    }
    const name = displayName(snapshot, node);
    const label = `Move "${name}"`;
    const message = `Moved "${name}" to "${displayName(snapshot, parent)}"`;
    this.commitAndNotify(result.plan, label, message);
  }

  /** `retypeOptions(node)` → a menu of type names; empty → a Notice. Choosing a type commits a
   * `'retype'` action. */
  startRetype(node: string, anchorEl: HTMLElement, event?: MouseEvent): void {
    const { schema, snapshot, structure } = this.deps.getInput();
    const options = retypeOptions(schema, structure, node);
    const name = displayName(snapshot, node);
    if (options.length === 0) {
      notifyError(`"${name}" cannot change type here`);
      return;
    }
    const menu = new Menu();
    for (const type of options) {
      menu.addItem((item) => {
        item.setTitle(type).onClick(() => {
          this.commitRetype(node, type, name);
        });
      });
    }
    this.showMenuAt(menu, anchorEl, event);
  }

  /** The node context menu: `Open`/`Open in new tab`, then the same actions available elsewhere
   * (add child, move, retype), then `Undo last change` when there's something to undo. `anchorEl`
   * is resolved from the triggering event's own target (the real DOM node the user right-clicked),
   * not passed separately — matches the decisions' two-argument signature. */
  openNodeMenu(node: string, event: MouseEvent): void {
    const anchorEl =
      event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(NODE_SELECTOR) : null;
    const menu = new Menu();
    this.buildOpenItems(menu, node);
    menu.addSeparator();
    this.buildEditItems(menu, node, anchorEl);
    if (this.deps.undo.canUndo) {
      menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle('Undo last change').onClick(() => {
          this.undoLast();
        });
      });
    }
    menu.showAtMouseEvent(event);
  }

  /** Awaits the shared undo stack, refreshes the view, then shows exactly the notice the plugin's
   * global undo command shows (see `formatUndoResult`) — the command itself has no view to
   * refresh, so only the wording is shared, not this method wholesale. */
  undoLast(): void {
    this.deps.undo
      .undo()
      .then((result) => {
        this.deps.refresh();
        notifyError(formatUndoResult(result));
      })
      .catch((error: unknown) => {
        logError(error);
        notifyError('undo failed');
      });
  }

  destroy(): void {
    this.cancelDraft();
  }

  private buildOpenItems(menu: Menu, node: string): void {
    menu.addItem((item) => {
      item.setTitle('Open').onClick(() => {
        this.openNode(node, false);
      });
    });
    menu.addItem((item) => {
      item.setTitle('Open in new tab').onClick((evt) => {
        const mod = Keymap.isModEvent(evt);
        this.openNode(node, mod === false ? 'tab' : mod);
      });
    });
  }

  private buildEditItems(menu: Menu, node: string, anchorEl: HTMLElement | null): void {
    menu.addItem((item) => {
      item.setTitle('Add child').onClick((evt) => {
        if (anchorEl !== null) {
          this.startCreate(node, anchorEl, asMouseEvent(evt));
        }
      });
    });
    menu.addItem((item) => {
      item.setTitle('Move to…').onClick(() => {
        this.startMovePicker(node);
      });
    });
    menu.addItem((item) => {
      item.setTitle('Change type').onClick((evt) => {
        if (anchorEl !== null) {
          this.startRetype(node, anchorEl, asMouseEvent(evt));
        }
      });
    });
  }

  private openNode(node: string, newLeaf: boolean | PaneType): void {
    this.deps.app.workspace.openLinkText(node, this.deps.hostPath, newLeaf).catch(logError);
  }

  private commitRetype(node: string, type: string, name: string): void {
    const { schema, snapshot } = this.deps.getInput();
    const result = planAction(schema, snapshot, { kind: 'retype', node, type }, this.planEnv());
    if (!result.ok) {
      notifyError(result.reason);
      return;
    }
    this.commitAndNotify(result.plan, `Change type of "${name}"`, `Changed "${name}" to "${type}"`);
  }

  /** Shared commit tail for `startMove`/`commitRetype`: apply, refresh regardless of outcome, and
   * only show the success notice when the plan actually applied cleanly (a failed apply already
   * shows its own Notice — see `commitPlan`). */
  private commitAndNotify(plan: Plan, label: string, message: string): void {
    commitPlan(this.deps.app, this.deps.undo, plan, label)
      .then((applied) => {
        this.deps.refresh();
        if (applied) {
          this.showUndoNotice(message);
        }
      })
      .catch((error: unknown) => {
        logError(error);
        notifyError(`could not apply the change. ${errorMessage(error)}`);
      });
  }

  private showMenuAt(menu: Menu, anchorEl: HTMLElement, event?: MouseEvent): void {
    if (event !== undefined) {
      menu.showAtMouseEvent(event);
      return;
    }
    const rect = anchorEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
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
    this.showMenuAt(menu, anchorEl, event);
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

  /** Shared by every planned action (create/move/retype) — `move` itself ignores `env`
   * (`planMove` takes no `env` parameter), but `planAction`'s signature is uniform across kinds. */
  private planEnv(): PlanEnv {
    return {
      defaultFolder: this.resolveDefaultFolder(),
      exists: (path) => this.deps.app.vault.getAbstractFileByPath(path) !== null,
    };
  }

  private async runCommit(draft: DraftState, name: string, mode: ChainMode): Promise<void> {
    const root = draft.anchorEl.closest<HTMLElement>(ROOT_SELECTOR);
    const { schema, snapshot } = this.deps.getInput();
    const env: PlanEnv = this.planEnv();
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
    // no longer matches, and chaining has nothing sensible to re-anchor to. `cancelDraft` operates
    // on whatever `this.draft` currently is, so it must only run when that's still this commit's
    // own draft — otherwise it would tear down a newer draft the user has since opened.
    const wasCurrent = this.isCurrentDraft(draft);
    this.pendingFocus = result.focus;
    if (wasCurrent) {
      this.cancelDraft();
    }
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
