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
import type { EdgeRule, Schema } from '../core/schema.js';
import { displayName, folderOf, type Snapshot } from '../core/snapshot.js';
import type { Structure } from '../core/structure.js';
import { commitPlan } from '../obsidian/plan-applier.js';
import type { UndoManager, UndoResult } from '../obsidian/undo-manager.js';
import { reportOpenFailure } from './open-note.js';
import type { RenderInput } from './structure-view.js';

/** `schema`/`snapshot`/`structure` re-read from the vault right now — what `commitAndNotify`/
 * `runCommit` plan and commit against, instead of the (possibly stale) last render's `RenderInput`
 * (I5: a click can happen well after the last `onDataUpdated`, e.g. while a create draft deferred
 * rendering, or simply because nothing touched a property Bases requeries on). */
export interface FreshInput {
  readonly schema: Schema;
  readonly snapshot: Snapshot;
  readonly structure: Structure;
}

export interface ActionsDeps {
  readonly app: App;
  readonly undo: UndoManager;
  readonly getInput: () => RenderInput;
  /** Re-reads the snapshot/structure from the vault at call time — see `FreshInput`. Used only at
   * the moment an action actually plans+commits (`startMove`, `commitRetype`, `runCommit`); menu
   * listings (`startCreate`, `startMovePicker`, `startRetype`) still use `getInput()`, since a
   * slightly-stale list of options is harmless and re-reading on every keystroke/menu-open would
   * not be. */
  readonly freshInput: () => FreshInput;
  readonly hostPath: string;
  readonly refresh: () => void;
  /** Called whenever an open draft closes for good — cancel (Escape/blur), a successful or failed
   * commit, or `destroy()` — see `cancelDraft`. Superseding one draft with another (a new "+"
   * while one is already open) does *not* fire this: it's a single continuous draft session from
   * `StructureView`'s point of view, not a close, so the deferred render must stay deferred (see
   * `openDraft`'s own note). `StructureView` uses this to flush a data-driven render it deferred
   * while the draft was open (see the class doc comment). Returns whether this call itself
   * performed that flush (I6) — `runCommit` uses it to skip its own following `refresh()` when
   * this already did the exact same work moments earlier, against the exact same data (nothing
   * else can run in between — see `runCommit`'s own doc comment). */
  readonly onDraftClosed: () => boolean;
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

/** What a chained draft (I7) still needs once the create it followed becomes visible: which
 * parent/type to reopen on, and whether that reopen is an "enter" (same parent, sibling) or "tab"
 * (the newly created node itself, child) chain — see `PendingCreate.chain`. */
interface PendingChain {
  readonly mode: ChainMode;
  readonly parentPath: string;
  readonly type: string;
}

/** A just-committed create's path, kept until a render's `Structure` actually contains it (I7):
 * `refresh()` right after `commitPlan` resolves runs against whatever Bases last handed the view,
 * which usually does *not* include the brand new note yet (Bases updates asynchronously) — so
 * neither the `is-new` highlight nor a Tab/Enter chain can complete on that first render. Instead
 * of firing them against a structure that doesn't have the node, this is kept pending and resolved
 * by `resolveFocus`/`completePending` on whichever later render (from `onDataUpdated`, once Bases
 * catches up) first has `path` in its `Structure`. `chain` is `null` when nothing should reopen —
 * either the draft that created it was already superseded by the time the commit settled, or (see
 * `clearPendingCreate`) a later user action/draft close cancelled it before it could fire. */
interface PendingCreate {
  readonly path: string;
  readonly chain: PendingChain | null;
}

const DRAFT_CLASS = 'bases-structure-draft';
const DRAFT_INPUT_CLASS = 'bases-structure-draft-input';
// Marks the node an open draft belongs to, so `styles.css` can give it a dedicated typing layout
// (siblings hidden, own width) instead of squeezing the input in next to them.
const DRAFTING_CLASS = 'is-drafting';
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
 * across renders (see `structure-view.ts`). While a draft is open, `StructureView` defers its own
 * data-driven renders (`hasOpenDraft`) so a background vault change can't rebuild the DOM out from
 * under the typed input; `teardownDraft` — the single teardown path for a draft — is reported to
 * `ActionsDeps.onDraftClosed` by its own callers (`cancelDraft` for every *external* close; not
 * `openDraft`'s own supersede case, which is a continuation of the same draft session, not a
 * close) so that deferred render can run exactly once. */
export class StructureActions {
  private readonly deps: ActionsDeps;
  private draft: DraftState | null = null;
  /** A just-committed create still waiting for a render to actually contain its path — see
   * `PendingCreate`'s own doc comment (I7). */
  private pendingCreate: PendingCreate | null = null;
  /** The `.bases-structure-body` a draft last opened into — kept even after that draft closes,
   * since the container itself outlives every render (only its children are rebuilt). Belt-and-
   * braces fallback for `openDraft`: if the `anchorEl` it's given is already detached (stale from
   * before a render that happened to run in between), this is what lets it re-resolve a live
   * element for the same path instead of attaching a draft nobody can see. */
  private lastRoot: HTMLElement | null = null;
  /** Set while a move/retype/create commit is actually in flight (between `commitPlan` starting
   * and settling) — a new create/move/retype started while this is true is ignored with a Notice
   * instead of racing the one already applying (I5). Menu listings aren't gated by this: only the
   * three commit-initiating paths (`startMove`, `commitRetype`, `runCommit`) check and set it. */
  private committing = false;

  constructor(deps: ActionsDeps) {
    this.deps = deps;
  }

  /** `true` (and shows the "still applying" Notice) when another commit is already in flight —
   * callers that find this true must not start their own. */
  private guardBusy(): boolean {
    if (this.committing) {
      notifyError('still applying the previous change');
      return true;
    }
    return false;
  }

  /** Whether a create draft is currently open. `StructureView.onDataUpdated` checks this to defer
   * a data-driven render instead of letting it wipe the draft's DOM and typed value. */
  get hasOpenDraft(): boolean {
    return this.draft !== null;
  }

  /** The path to highlight `is-new` in a render whose `Structure` actually contains it (I7) — read-
   * only (does *not* consume `pendingCreate`; see `completePending` for that), so `structure-view.ts`
   * can compute this render's `focusPath` before the DOM is rebuilt, then finish the pending create
   * afterward once the DOM reflects it. Returns `null` on every render before the created path
   * actually shows up (Bases usually hasn't caught up yet on the render right after commit — the
   * whole point of I7 — so this correctly returns `null` there, not the path). */
  resolveFocus(structure: Structure): string | null {
    if (this.pendingCreate !== null && structure.nodes.has(this.pendingCreate.path)) {
      return this.pendingCreate.path;
    }
    return null;
  }

  /** Finishes a pending create once its path is actually in `structure` (I7) — drops it either way
   * (a chain only ever gets one attempt) and, when it carries a chain, reopens the draft against
   * the now-current DOM under `root`. Called by `structure-view.ts`'s `render()` right after the
   * renderer has drawn `structure` (so `root` already contains an element for the created path when
   * this fires), and must be called on *every* render — including the one immediately after commit,
   * which usually won't contain the path yet and so is correctly a no-op here. */
  completePending(structure: Structure, root: HTMLElement): void {
    const pending = this.pendingCreate;
    if (pending === null || !structure.nodes.has(pending.path)) {
      return;
    }
    this.pendingCreate = null;
    if (pending.chain !== null) {
      this.continueChain({
        root,
        parentPath: pending.chain.parentPath,
        type: pending.chain.type,
        mode: pending.chain.mode,
        focusPath: pending.path,
      });
    }
  }

  /** Drops any create still waiting for its render (I7) — called at the start of every other
   * action (a new create/move/retype/undo) and from `teardownDraft(true)` (an *external* draft
   * close: `cancelDraft` — Escape, blur, `destroy()` — or `openDraft` superseding it), per the
   * decision's "the next user action or draft close cancels it" rule. `runCommit`'s own close of
   * the draft it just finished goes through `teardownDraft(false)` instead (via
   * `closeCommittedDraft`) specifically to skip this: by the time that runs, either a fresh
   * `pendingCreate` for *this* commit is already sitting in `this.pendingCreate` (set immediately
   * before, so a render this close flushes can see it — see `runCommit`), or nothing was created
   * and there is nothing to clear anyway (any older `pendingCreate` was already dropped back when
   * *this* draft was first opened, via `startCreate`/`openDraft`'s own `teardownDraft(true)`). */
  private clearPendingCreate(): void {
    this.pendingCreate = null;
  }

  startCreate(parentPath: string, anchorEl: HTMLElement, event?: MouseEvent): void {
    this.clearPendingCreate();
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

  /** The externally-visible close path for a draft — Escape, blur, and `destroy()` funnel through
   * this (a successful/failed commit closes its own draft through `closeCommittedDraft` instead —
   * see its own doc comment for why). Unlike `teardownDraft` (which this wraps), it reports the
   * close via `onDraftClosed` — the no-op early return when nothing is open matters here too: it
   * keeps `onDraftClosed` from firing (and `StructureView` from rendering) when there was nothing
   * to close. `openDraft` deliberately does *not* call this when it supersedes an already-open
   * draft — see its own note. */
  cancelDraft(): void {
    if (this.teardownDraft(true)) {
      this.deps.onDraftClosed();
    }
  }

  /** `runCommit`'s own close of the draft it just finished (I6) — unlike `cancelDraft` (every
   * *external* close), this must not clear `pendingCreate` via `teardownDraft`: the caller has
   * already set a fresh one for *this* commit, immediately before calling this, precisely so a
   * render this triggers (a data update deferred while the draft was open, now flushed) can
   * complete the highlight/chain right there — clearing it here would wipe that out before any
   * render gets a chance to see it. Still reports the close via `onDraftClosed`, and returns
   * whether that itself rendered, so `runCommit` can skip a redundant `refresh()` right after. */
  private closeCommittedDraft(): boolean {
    if (this.teardownDraft(false)) {
      return this.deps.onDraftClosed();
    }
    return false;
  }

  /** Removes an open draft's DOM/listeners and clears `this.draft`, without reporting the close —
   * the shared teardown `cancelDraft` and `openDraft` both build on (`closeCommittedDraft` is the
   * one exception that needs the two steps split — see its own doc comment). Returns whether a
   * draft was actually open (so callers that need to notify can tell a real close from a no-op).
   * `clearPending` is `false` only from `closeCommittedDraft`; every other caller passes `true`. */
  private teardownDraft(clearPending: boolean): boolean {
    if (clearPending) {
      this.clearPendingCreate();
    }
    const draft = this.draft;
    if (draft === null) {
      return false;
    }
    draft.inputEl.removeEventListener('keydown', this.handleDraftKeydown);
    draft.inputEl.removeEventListener('blur', this.handleDraftBlur);
    draft.anchorEl.classList.remove(DRAFTING_CLASS);
    draft.wrapperEl.remove();
    this.draft = null;
    return true;
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
   * cascade to descendants. Rejections show the planner's reason and write nothing. Plans against
   * `freshInput()` (not the last render), and is ignored while another commit is in flight. */
  startMove(node: string, parent: string): void {
    if (this.guardBusy()) {
      return;
    }
    this.clearPendingCreate();
    const { schema, snapshot } = this.deps.freshInput();
    const result = planAction(schema, snapshot, { kind: 'move', node, parent }, this.planEnv());
    if (!result.ok) {
      notifyError(result.reason);
      return;
    }
    const name = displayName(snapshot, node);
    const label = `Move "${name}"`;
    const message = `Moved "${name}" to "${displayName(snapshot, parent)}"`;
    this.committing = true;
    this.commitAndNotify(snapshot, result.plan, label, message);
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
    this.clearPendingCreate();
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

  /** Public (task 16): the keyboard's `Enter`/`Mod+Enter` open the active node the same way the
   * context menu's "Open"/"Open in new tab" items do — see `keyboard.ts`'s `open` dep, wired in
   * `structure-view.ts`. */
  openNode(node: string, newLeaf: boolean | PaneType): void {
    this.deps.app.workspace
      .openLinkText(node, this.deps.hostPath, newLeaf)
      .catch((error: unknown) => {
        reportOpenFailure(this.deps.getInput().snapshot, node, error);
      });
  }

  private commitRetype(node: string, type: string, name: string): void {
    if (this.guardBusy()) {
      return;
    }
    this.clearPendingCreate();
    const { schema, snapshot } = this.deps.freshInput();
    const result = planAction(schema, snapshot, { kind: 'retype', node, type }, this.planEnv());
    if (!result.ok) {
      notifyError(result.reason);
      return;
    }
    this.committing = true;
    this.commitAndNotify(
      snapshot,
      result.plan,
      `Change type of "${name}"`,
      `Changed "${name}" to "${type}"`,
    );
  }

  /** Shared commit tail for `startMove`/`commitRetype`: apply, refresh regardless of outcome, and
   * only show the success notice when the plan actually applied cleanly (a failed apply already
   * shows its own Notice — see `commitPlan`). `expected` is the same fresh snapshot the caller just
   * planned against, passed straight through to `commitPlan`'s optimistic check (I5). Always clears
   * `committing`, however the commit resolves. */
  private commitAndNotify(expected: Snapshot, plan: Plan, label: string, message: string): void {
    commitPlan(this.deps.app, this.deps.undo, { plan, label, expected })
      .then((applied) => {
        this.committing = false;
        this.deps.refresh();
        if (applied) {
          this.showUndoNotice(message);
        }
      })
      .catch((error: unknown) => {
        this.committing = false;
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

  /** `anchorEl` gets `DRAFTING_CLASS` for the draft's whole lifetime (removed by `teardownDraft`):
   * CSS keys off that class to give the node its own typing-sized layout instead of squeezing the
   * input in alongside the title, "+", toggle and alsoIn chip that are still otherwise present.
   *
   * Replacing an already-open draft goes through `teardownDraft`, *not* `cancelDraft` — superseding
   * one draft with another (a new "+" while one is open) is a single continuous draft session, not
   * a close: `StructureView` may have a data-driven render deferred (see the class doc comment),
   * and firing `onDraftClosed` here would flush it mid-supersede, rebuilding every node and
   * detaching `anchorEl` before this method gets to use it (the deferred render only makes sense
   * once the *whole* session actually ends, via `cancelDraft`/`destroy`). */
  private openDraft(parentPath: string, anchorEl: HTMLElement, type: string): void {
    this.teardownDraft(true);
    const target = this.resolveAnchor(anchorEl, parentPath);
    this.lastRoot = target.closest<HTMLElement>(ROOT_SELECTOR) ?? this.lastRoot;
    target.classList.add(DRAFTING_CLASS);
    const wrapperEl = target.createDiv(DRAFT_CLASS);
    const inputEl = wrapperEl.createEl('input', {
      cls: DRAFT_INPUT_CLASS,
      attr: { placeholder: type, spellcheck: 'false' },
    });
    inputEl.addEventListener('keydown', this.handleDraftKeydown);
    inputEl.addEventListener('blur', this.handleDraftBlur);
    this.draft = { anchorEl: target, parentPath, type, wrapperEl, inputEl, committing: false };
    inputEl.focus();
  }

  /** `anchorEl` as given, unless it's already detached (stale from a render that ran in between —
   * see `openDraft`'s note), in which case it's re-resolved by `parentPath` under the last known
   * live root. Falls back to the original (possibly detached) element when there's no root to
   * search, or the path isn't found there either — no worse than before this fallback existed. */
  private resolveAnchor(anchorEl: HTMLElement, parentPath: string): HTMLElement {
    if (anchorEl.isConnected) {
      return anchorEl;
    }
    if (this.lastRoot === null) {
      return anchorEl;
    }
    return findNodeElement(this.lastRoot, parentPath) ?? anchorEl;
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
    if (this.guardBusy()) {
      return;
    }
    const name = draft.inputEl.value.trim();
    if (name === '') {
      return;
    }
    draft.committing = true;
    this.committing = true;
    this.runCommit(draft, name, mode).catch((error: unknown) => {
      this.committing = false;
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
    const { schema, snapshot } = this.deps.freshInput();
    const env: PlanEnv = this.planEnv();
    const action: Action = { kind: 'create', parent: draft.parentPath, type: draft.type, name };
    const result = planAction(schema, snapshot, action, env);
    if (!result.ok) {
      notifyError(result.reason);
      this.committing = false;
      draft.committing = false;
      draft.inputEl.select();
      return;
    }
    const applied = await commitPlan(this.deps.app, this.deps.undo, {
      plan: result.plan,
      label: `Create "${name}"`,
      expected: snapshot,
    });
    this.committing = false;
    // Captured before this method's own cleanup below touches `this.draft`: if the user cancelled
    // this draft (Escape/blur) or opened a different one while the commit was in flight, `draft`
    // no longer matches, and chaining has nothing sensible to reopen against.
    const wasCurrent = this.isCurrentDraft(draft);
    // Set *before* closing the draft below (I6/I7): closing can itself trigger a render (a data
    // update deferred while the draft was open, now flushed by `closeCommittedDraft`) — this has
    // to already be in place for that render's own `resolveFocus`/`completePending` to have any
    // chance of completing the highlight/chain right there, instead of leaving it stranded until
    // some later, possibly-never-arriving `onDataUpdated`. Chaining only when this draft was still
    // the one on screen when the commit settled (`wasCurrent`) — a superseded draft already moved
    // the user's attention elsewhere, so nothing should reopen on their behalf; the `is-new`
    // highlight itself still applies either way. Nothing to set when the commit failed — no note
    // exists to highlight or chain from.
    if (applied) {
      this.pendingCreate = {
        path: result.focus,
        chain: wasCurrent ? { mode, parentPath: draft.parentPath, type: draft.type } : null,
      };
    }
    // I6: skip the explicit `refresh()` below when closing the draft already rendered — that
    // render (`closeCommittedDraft`'s flush, if one was owed) used the exact same
    // schema/snapshot/structure this `refresh()` would produce a moment later (nothing else runs
    // in between: no `await` separates them), so running it again would just redo the same
    // `buildStructure` for a result that can't have changed.
    const alreadyRendered = wasCurrent && this.closeCommittedDraft();
    if (!alreadyRendered) {
      this.deps.refresh();
    }
    if (!applied) {
      return;
    }
    this.showUndoNotice(`Created "${name}"`);
  }

  private continueChain(ctx: {
    readonly root: HTMLElement;
    readonly parentPath: string;
    readonly type: string;
    readonly mode: ChainMode;
    readonly focusPath: string;
  }): void {
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
