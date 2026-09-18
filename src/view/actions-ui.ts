// The "+" create flow: turns a click on a node's add button into a typed, inline-named child
// note. Mirrors the design spec's "Действия: одно ядро" — a create is just another action planned
// against the current snapshot, verified, and applied through the same `commitPlan`/`UndoManager`
// pipeline every other action uses; this module only owns the transient "draft" input (one at a
// time, appended inside the parent node's own element) and the menu/chaining UX around it.

import type { App, FuzzyMatch, PaneType } from 'obsidian';
import { FuzzySuggestModal, Menu, Notice } from 'obsidian';
import type { Diagnostic } from '../core/diagnostics.js';
import { convertOptions, type ConvertContext } from '../core/plan-convert.js';
import { moveTargets } from '../core/plan-move.js';
import { retypeOptions } from '../core/plan-retype.js';
import type { Action, Plan, PlanEnv } from '../core/plan-types.js';
import { childOptions, planAction } from '../core/planner.js';
import type { EdgeRule, Schema } from '../core/schema.js';
import { applyPlan } from '../core/simulate.js';
import { displayName, folderOf, lastSegmentBasename, type Snapshot } from '../core/snapshot.js';
import type { Structure } from '../core/structure.js';
import type { CommitOutcome, Transaction } from '../obsidian/plan-applier.js';
import { commitPlan } from '../obsidian/plan-applier.js';
import type { UndoBlockedResult, UndoManager, UndoResult } from '../obsidian/undo-manager.js';
import type { DragMode } from './drag.js';
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
  /** I11: shows `snapshot` — the exact result of simulating the plan `commitWithOptimism` just
   * verified (`applyPlan`, never a second, independent guess) — immediately, before the real write
   * lands. Called again with the pre-plan snapshot if the commit itself throws, or if it resolves
   * with `transaction: null` (per `CommitOutcome`'s own doc, that means literally nothing was
   * written, whatever `applied` says — e.g. an I5 concurrency conflict on the very first write),
   * undoing the prediction either way. A plan that fails gracefully *after* writing something
   * (`applied: false` with a non-null `transaction`, already shown its own Notice) is left alone,
   * since that partial write can leave the vault somewhere `applyPlan` never predicted at all.
   * `StructureView` renders from the shown snapshot until the next real `onDataUpdated` clears it
   * — real data always wins once Bases reports it. */
  readonly showOptimistic: (snapshot: Snapshot) => void;
  /** I11: clears `StructureView.optimistic` without itself forcing a render — call right before
   * `refresh()` once an undo has actually reverted something (`undoLast`/`runUndoFromNotice`),
   * so the render `refresh()` triggers reads real data instead of a stale, already-reverted
   * prediction from an earlier, unrelated create/move/retype. Undo never goes through
   * `showOptimistic` itself (it's a real vault mutation, not a planned+simulated one), so this is
   * the only way that prior prediction ever gets cleared outside of a real `onDataUpdated`. */
  readonly clearOptimistic: () => void;
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

/** Where a follow-up menu (U1's type menu) should position itself: `buttonEl` (the actual button
 * clicked, when there is one) wins over the node it belongs to; `event` (a real click, e.g. on a
 * context-menu item) wins over both — see `showMenuAt`. */
interface MenuAnchor {
  readonly buttonEl: HTMLElement | undefined;
  readonly event: MouseEvent | undefined;
}

interface DraftState {
  readonly anchorEl: HTMLElement;
  readonly parentPath: string;
  readonly type: string;
  readonly wrapperEl: HTMLElement;
  readonly inputEl: HTMLInputElement;
  committing: boolean;
}

/** A just-committed create's path, kept until a render's `Structure` actually contains it (I7):
 * originally waited for Bases' own re-query, since `refresh()` right after `commitPlan` resolves
 * ran against whatever Bases last handed the view, which usually didn't include the brand new note
 * yet. I11's optimistic rendering changed that in practice for a create specifically — `refresh()`
 * now typically renders while `StructureView.optimistic` is still showing the plan's own simulated
 * result, which already contains the new note — but the mechanism itself is unchanged:
 * `resolveFocus`/`completePending` still just resolve on whichever render's `Structure` first has
 * `path`, whatever produced that render (the optimistic one, or a later real `onDataUpdated`).
 *
 * `chain` (U5): only ever `true` for a Tab chain — it reopens a create-child draft *on* the new
 * node itself, which by definition doesn't exist until this same render does, so it has to wait
 * here like the highlight does. An Enter chain reopens a create-*sibling* draft on the node's own
 * *parent*, which already exists right now — `runCommit` fires it immediately instead of routing
 * it through here at all. `false` when nothing should reopen once the node appears: the draft that
 * created it was already superseded by the time the commit settled, or (see `clearPendingCreate`)
 * a later user action/draft close cancelled it before it could fire. */
interface PendingCreate {
  readonly path: string;
  readonly chain: boolean;
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

/** `"<node>" has no type that fits under "<parent>"` — `startConvert`'s own empty-options notice,
 * shared with `StructureActions.explainInvalidDrop` (a Shift-drag dropped on a node that offers no
 * fitting type is exactly that same situation, reached by a different path) so the two can never
 * drift apart. */
function noTypeFitsMessage(snapshot: Snapshot, node: string, parent: string): string {
  return `"${displayName(snapshot, node)}" has no type that fits under "${displayName(snapshot, parent)}"`;
}

/** `"<node>" cannot go under "<parent>"` — the generic fallback `explainInvalidDrop` shows when
 * there's no single obvious action to blame (planning the attempted move surprisingly succeeded,
 * a stale-data race per I5) — never expected in normal use, but never silent either. */
function cannotGoUnderMessage(snapshot: Snapshot, node: string, parent: string): string {
  return `"${displayName(snapshot, node)}" cannot go under "${displayName(snapshot, parent)}"`;
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

/** Just below `el`'s own rect, with a small 4px gap so a menu doesn't touch the element it opened
 * from — shared by every menu positioned from a clicked element rather than a mouse event
 * (`showMenuAt`'s no-event branch, `openNodeMenuFromButton`'s touch-only button). */
function positionBelow(el: HTMLElement): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}

const MAX_SKIPPED_NAMES_SHOWN = 3;

/** `(skipped a, b, c, +2 more)` — up to `MAX_SKIPPED_NAMES_SHOWN` display names, then a `+N more`
 * tail; empty string when nothing was skipped. `nameOf` resolves a path to the name shown (I1). */
function formatSkipped(skipped: readonly string[], nameOf: (path: string) => string): string {
  if (skipped.length === 0) {
    return '';
  }
  const names = skipped.map(nameOf);
  const shown = names.slice(0, MAX_SKIPPED_NAMES_SHOWN);
  const remaining = names.length - shown.length;
  const list = remaining > 0 ? `${shown.join(', ')}, +${remaining} more` : shown.join(', ');
  return ` (skipped ${list})`;
}

/** I11: whether an `UndoManager.undo()` result actually reverted something — `false` for both
 * "nothing to undo" (`label === null`) and a blocked result, the two cases `formatUndoResult`
 * itself already distinguishes from a real revert. `undoLast`/`runUndoFromNotice` use this to
 * decide whether `clearOptimistic` has anything to actually clear. */
function didUndoSomething(result: UndoResult | UndoBlockedResult): boolean {
  return !('blocked' in result) && result.label !== null;
}

/** Whether `node` has its own `inherit-mismatch` diagnostic — gates "Fix inheritance" in the node
 * menu, so the item only ever appears for a node the diagnostic actually flagged. */
function hasInheritMismatch(diagnostics: readonly Diagnostic[], node: string): boolean {
  return diagnostics.some((d) => d.kind === 'inherit-mismatch' && d.node === node);
}

/** `Structure: nothing to undo` / `Structure: undone "<label>" (skipped a, b, +N more)` /
 * `Structure: a newer change must be undone first` (I1) — the exact wording every undo surface
 * (`StructureActions.undoLast`, the notice button's own transaction-scoped undo, and the plugin's
 * global undo command) shows, kept in one place so they can't drift apart. `nameOf` resolves a
 * skipped path to the display name shown — callers with a `Snapshot` pass `displayName` bound to
 * it (real display names, aliases included); the default (`lastSegmentBasename`) is what the
 * global undo command falls back to, since it has no view/snapshot to resolve against at all. */
export function formatUndoResult(
  result: UndoResult | UndoBlockedResult,
  nameOf: (path: string) => string = lastSegmentBasename,
): string {
  if ('blocked' in result) {
    return 'a newer change must be undone first';
  }
  if (result.label === null) {
    return 'nothing to undo';
  }
  return `undone "${result.label}"${formatSkipped(result.skipped, nameOf)}`;
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
   * actually shows up — for a create, that's typically the very first render now (I11's optimistic
   * prediction already contains it), not a later one; still correctly `null` for whatever render
   * genuinely doesn't have it yet (e.g. this same check running against real data once
   * `onDataUpdated` clears the prediction, before Bases itself has caught up). */
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
   * which for a create typically *does* already contain the path now (I11's optimistic prediction)
   * and so completes right there; a render whose `structure` genuinely doesn't have it yet
   * (unaffected by optimism — a move/retype, or a create once `onDataUpdated` has cleared the
   * prediction) is correctly a no-op here instead. */
  completePending(structure: Structure, root: HTMLElement): void {
    const pending = this.pendingCreate;
    if (pending === null || !structure.nodes.has(pending.path)) {
      return;
    }
    this.pendingCreate = null;
    if (pending.chain) {
      this.continueTabChain(root, pending.path);
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

  /** `buttonEl` (U1) is the actual "+" button clicked, when there is one — the type menu
   * positions itself from *that* element's rect, not `anchorEl` (the whole node), so it opens
   * directly under the button instead of wherever the node's own top-left happens to be.
   * `undefined` for every caller that has no distinct button (keyboard Tab, a chained reopen, the
   * context menu's "Add child" item — those fall back to `anchorEl` itself, or to `event` when
   * one is given). */
  startCreate(
    parentPath: string,
    anchorEl: HTMLElement,
    buttonEl?: HTMLElement,
    event?: MouseEvent,
  ): void {
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
    this.showTypeMenu(parentPath, anchorEl, options, { buttonEl, event });
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

  /** The drop-side half of the Shift-drag gesture (`drag.ts`'s `'convert'` mode): `convertOptions`
   * lists which types `node` could become while landing under `parent`, listed against the
   * current render's `getInput()` (same "good enough for a listing" freshness as
   * `startMovePicker`/`startRetype`). A type change never happens without the user picking it
   * from a menu — even a single fitting type still opens a one-item menu at `position` (the drop
   * point), spelling out the result (`Make "<name>" a <Type> here`) instead of naming a bare type,
   * so nothing is rewritten before the user has actually seen and chosen it. An empty option list
   * shows a Notice instead. `doc` is the pop-out convention every other `showAtPosition` call in
   * this file follows (see `showNodeMenu`/`showMenuAt`): the caller's own anchor element's owning
   * document, since a drag can start inside a pop-out window and the menu must open there too, not
   * on the default document. Every commit itself re-plans against `freshInput()` via
   * `commitConvert`, same as every other commit path (I5). */
  startConvert(
    node: string,
    parent: string,
    position: { x: number; y: number },
    doc?: Document,
  ): void {
    const { schema, snapshot, structure } = this.deps.getInput();
    const context: ConvertContext = { schema, snapshot, structure, env: this.planEnv() };
    const options = convertOptions(context, node, parent);
    const name = displayName(snapshot, node);
    if (options.length === 0) {
      notifyError(noTypeFitsMessage(snapshot, node, parent));
      return;
    }
    const menu = new Menu();
    for (const type of options) {
      menu.addItem((item) => {
        item.setTitle(`Make "${name}" a ${type} here`).onClick(() => {
          this.commitConvert(node, parent, type, name);
        });
      });
    }
    menu.showAtPosition(position, doc);
  }

  /** Plans and commits a `'convert'` action: `node` becomes `type` under `parent`, in the same
   * transaction — mirrors `startMove`'s shape (fresh plan, notice on rejection, optimistic
   * render, commit, undo). Plans against `freshInput()`, and is ignored while another commit is
   * in flight. */
  private commitConvert(node: string, parent: string, type: string, name: string): void {
    if (this.guardBusy()) {
      return;
    }
    this.clearPendingCreate();
    const { schema, snapshot } = this.deps.freshInput();
    const action: Action = { kind: 'convert', node, parent, type };
    const result = planAction(schema, snapshot, action, this.planEnv());
    if (!result.ok) {
      notifyError(result.reason);
      return;
    }
    const label = `Convert "${name}"`;
    const message = `Converted "${name}" to "${type}" under "${displayName(snapshot, parent)}"`;
    this.committing = true;
    this.commitAndNotify(snapshot, result.plan, label, message);
  }

  /** `DragDeps.onInvalidDrop`'s own handler (task: a drop that lands on a node outside the
   * highlighted target set must never be silent — that's exactly the reported bug). Asks the core
   * once, on drop, rather than precomputing a reason for every node up front: a plain move always
   * has one well-defined action to plan, so its rejection reason is shown directly; a Shift-drag
   * has no single type to plan for (that's what the menu is for), so it reuses `startConvert`'s own
   * "no type fits" wording instead of inventing new copy. Read-only — never plans/writes anything
   * beyond the listing itself. */
  explainInvalidDrop(node: string, parent: string, mode: DragMode): void {
    if (mode === 'convert') {
      this.explainInvalidConvert(node, parent);
      return;
    }
    this.explainInvalidMove(node, parent);
  }

  private explainInvalidMove(node: string, parent: string): void {
    const { schema, snapshot } = this.deps.getInput();
    const result = planAction(schema, snapshot, { kind: 'move', node, parent }, this.planEnv());
    notifyError(result.ok ? cannotGoUnderMessage(snapshot, node, parent) : result.reason);
  }

  private explainInvalidConvert(node: string, parent: string): void {
    const { schema, snapshot, structure } = this.deps.getInput();
    const context: ConvertContext = { schema, snapshot, structure, env: this.planEnv() };
    if (convertOptions(context, node, parent).length > 0) {
      notifyError(cannotGoUnderMessage(snapshot, node, parent));
      return;
    }
    notifyError(noTypeFitsMessage(snapshot, node, parent));
  }

  /** Plans and commits a `'fix-inherit'` action: rewrites `node`'s own inherit-key values and
   * cascades the fix to its subtree. Rejections show the planner's reason and write nothing.
   * Mirrors `startMove`'s shape (plan, notice on rejection, optimistic render, commit, undo
   * transaction) but — per its own `Promise<void>` signature — lets an unexpected commit failure
   * propagate to the caller instead of catching it itself, the same division `runCommit` and its
   * own caller (`commitDraft`) use; `buildEditItems`'s `onClick` is what actually catches it.
   * Plans against `freshInput()`, and is ignored while another commit is in flight. */
  async fixInherit(node: string): Promise<void> {
    if (this.guardBusy()) {
      return;
    }
    this.clearPendingCreate();
    const { schema, snapshot } = this.deps.freshInput();
    const result = planAction(schema, snapshot, { kind: 'fix-inherit', node }, this.planEnv());
    if (!result.ok) {
      notifyError(result.reason);
      return;
    }
    const name = displayName(snapshot, node);
    this.committing = true;
    const outcome = await this.commitWithOptimism(
      snapshot,
      result.plan,
      `Fix inheritance of "${name}"`,
    );
    this.committing = false;
    this.deps.refresh();
    if (outcome.applied) {
      this.showUndoNotice(`Fixed inherited properties on "${name}"`, outcome.transaction);
    }
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

  /** The one node menu every entry point (a title right-click, the touch-only node-menu button)
   * shows: the native link menu first — Obsidian core's own items plus every other plugin's (e.g.
   * Supercharged Links'), via the same `'file-menu'`/`'link-context-menu'` event a note's own
   * in-text link menu fires — then this plugin's own actions (add/move/retype[/fix inheritance]),
   * then `Undo last change` when there's something to undo. `event` positions the menu: a real
   * `MouseEvent` (the right click) opens at the cursor; `{x, y}` (`openNodeMenuFromButton`, U1)
   * opens at a fixed point instead, since a touch device has no click to anchor one to. */
  showNodeMenu(
    path: string,
    event: MouseEvent | { x: number; y: number },
    anchorEl: HTMLElement,
  ): void {
    const menu = new Menu();
    const file = this.deps.app.vault.getAbstractFileByPath(path);
    if (file !== null) {
      this.deps.app.workspace.trigger('file-menu', menu, file, 'link-context-menu');
    }
    menu.addSeparator();
    this.buildEditItems(menu, path, anchorEl);
    this.addUndoItem(menu);
    if (event instanceof MouseEvent) {
      menu.showAtMouseEvent(event);
      return;
    }
    // Pop-out convention (M3): `anchorEl.doc` — its own owner document — not the bare global.
    menu.showAtPosition(event, anchorEl.doc);
  }

  /** I10: the touch-only node-menu button's click — the identical menu `showNodeMenu` (a right
   * click) builds, positioned from the button itself (U1), not a mouse event (a touch device has
   * no right-click to anchor one to). */
  openNodeMenuFromButton(node: string, nodeEl: HTMLElement, buttonEl: HTMLElement): void {
    this.showNodeMenu(node, positionBelow(buttonEl), nodeEl);
  }

  private addUndoItem(menu: Menu): void {
    if (!this.deps.undo.canUndo) {
      return;
    }
    menu.addSeparator();
    menu.addItem((item) => {
      item.setTitle('Undo last change').onClick(() => {
        this.undoLast();
      });
    });
  }

  /** Awaits the shared undo stack, refreshes the view, then shows exactly the notice the plugin's
   * global undo command shows (see `formatUndoResult`) — the command itself has no view to
   * refresh, so only the wording is shared, not this method wholesale. I11: clears any showing
   * optimistic prediction first when this actually reverted something (see `clearOptimistic`'s own
   * doc comment) — a "nothing to undo"/blocked result changes nothing, so there's nothing to
   * clear. */
  undoLast(): void {
    this.clearPendingCreate();
    const { snapshot } = this.deps.getInput();
    this.deps.undo
      .undo()
      .then((result) => {
        if (didUndoSomething(result)) {
          this.deps.clearOptimistic();
        }
        this.deps.refresh();
        notifyError(formatUndoResult(result, (path) => displayName(snapshot, path)));
      })
      .catch((error: unknown) => {
        logError(error);
        notifyError('undo failed');
      });
  }

  destroy(): void {
    this.cancelDraft();
  }

  /** Native items first, this plugin's own after (see `showNodeMenu`) — so `anchorEl` is always a
   * real node element by the time this runs, never the `| null` a keyboard-triggered/unresolved
   * target used to need a guard for. */
  private buildEditItems(menu: Menu, node: string, anchorEl: HTMLElement): void {
    menu.addItem((item) => {
      item.setTitle('Add child').onClick((evt) => {
        this.startCreate(node, anchorEl, undefined, asMouseEvent(evt));
      });
    });
    menu.addItem((item) => {
      item.setTitle('Move to…').onClick(() => {
        this.startMovePicker(node);
      });
    });
    menu.addItem((item) => {
      item.setTitle('Change type').onClick((evt) => {
        this.startRetype(node, anchorEl, asMouseEvent(evt));
      });
    });
    if (hasInheritMismatch(this.deps.getInput().diagnostics, node)) {
      menu.addItem((item) => {
        item.setTitle('Fix inheritance').onClick(() => {
          this.fixInherit(node).catch((error: unknown) => {
            this.committing = false;
            logError(error);
            notifyError(`could not apply the change. ${errorMessage(error)}`);
          });
        });
      });
    }
  }

  /** Public (task 16): the keyboard's `Enter`/`Mod+Enter` open the active node the same way a
   * title click (or the node menu's native "Open"/"Open in new tab", now supplied by
   * `'file-menu'` — see `showNodeMenu`) does — see `keyboard.ts`'s `open` dep, wired in
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

  /** I11: shows the plan's simulated result (`applyPlan(snapshot, plan)`, the exact snapshot
   * `planAction` just verified against) via `showOptimistic`, then commits — reverting to
   * `snapshot` itself if `commitPlan` throws, or if it resolves with `transaction: null` (nothing
   * was actually written, whatever `applied` says — see `CommitOutcome`), so a prediction nothing
   * ever wrote never lingers. Left showing only when a graceful failure still wrote *something*
   * (`applied: false` with a non-null `transaction`), since that partial write can land somewhere
   * `applyPlan` never predicted. Shared by every planned action (`commitAndNotify` for move/retype,
   * `runCommit` for create) so they can't drift on when the prediction shows or unwinds. */
  private async commitWithOptimism(
    snapshot: Snapshot,
    plan: Plan,
    label: string,
  ): Promise<CommitOutcome> {
    this.deps.showOptimistic(applyPlan(snapshot, plan));
    try {
      const outcome = await commitPlan(this.deps.app, this.deps.undo, {
        plan,
        label,
        expected: snapshot,
      });
      if (outcome.transaction === null) {
        this.deps.showOptimistic(snapshot);
      }
      return outcome;
    } catch (error) {
      this.deps.showOptimistic(snapshot);
      throw error;
    }
  }

  /** Shared commit tail for `startMove`/`commitRetype`: apply, refresh regardless of outcome, and
   * only show the success notice when the plan actually applied cleanly (a failed apply already
   * shows its own Notice — see `commitPlan`). `expected` is the same fresh snapshot the caller just
   * planned against, passed straight through to `commitPlan`'s optimistic-concurrency check (I5).
   * Always clears `committing`, however the commit resolves. */
  private commitAndNotify(expected: Snapshot, plan: Plan, label: string, message: string): void {
    this.commitWithOptimism(expected, plan, label)
      .then((outcome) => {
        this.committing = false;
        this.deps.refresh();
        if (outcome.applied) {
          this.showUndoNotice(message, outcome.transaction);
        }
      })
      .catch((error: unknown) => {
        this.committing = false;
        logError(error);
        notifyError(`could not apply the change. ${errorMessage(error)}`);
      });
  }

  /** `event` (a real click, e.g. on a context-menu item) always wins — `showAtMouseEvent` is what
   * `contextmenu`-triggered menus use throughout. Otherwise (U1) `positionEl`'s own
   * `getBoundingClientRect()` decides where the menu opens — never a stale mouse event — with a
   * small 4px gap so it doesn't touch the button, via `positionEl.doc` (its own owner document, a
   * pop-out window's when the view is open in one — see `showAtPosition`'s signature). */
  private showMenuAt(menu: Menu, positionEl: HTMLElement, event?: MouseEvent): void {
    if (event !== undefined) {
      menu.showAtMouseEvent(event);
      return;
    }
    menu.showAtPosition(positionBelow(positionEl), positionEl.doc);
  }

  private showTypeMenu(
    parentPath: string,
    anchorEl: HTMLElement,
    options: ReadonlyArray<{ readonly type: string; readonly rule: EdgeRule }>,
    menuAnchor: MenuAnchor,
  ): void {
    const menu = new Menu();
    for (const option of options) {
      menu.addItem((item) => {
        item.setTitle(option.type).onClick(() => {
          this.openDraft(parentPath, anchorEl, option.type);
        });
      });
    }
    // U1: the button actually clicked (when there is one) positions the menu — never the whole
    // node, which can be much wider than the button and so opens the menu away from the click.
    this.showMenuAt(menu, menuAnchor.buttonEl ?? anchorEl, menuAnchor.event);
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
    this.startDraft(parentPath, anchorEl, type);
  }

  /** The actual draft-building steps `openDraft` wraps with `teardownDraft(true)` — split out so
   * `runCommit`'s U5 immediate Enter-chain reopen (see its own doc comment) can build the next
   * draft directly, without `teardownDraft`'s `clearPendingCreate()` wiping out the `pendingCreate`
   * it set moments earlier for the `is-new` highlight (there is nothing to tear down there anyway:
   * the committed draft this reopens on top of was already closed by `closeCommittedDraft`). */
  private startDraft(parentPath: string, anchorEl: HTMLElement, type: string): void {
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

  /** Defence in depth against a render that rebuilt the DOM without going through `teardownDraft`
   * first (see `structure-view.ts`'s `deferrableRender` for why that must never happen, and this
   * guard for when it somehow still does): a real browser fires `blur` synchronously on an input
   * the instant it's disconnected from the document, and this listener is only ever detached by
   * `teardownDraft` itself — so a DOM removal that skips `teardownDraft` leaves it firing into a
   * `wrapperEl` that's already mid-removal. Bailing out whenever the wrapper is no longer connected
   * stops that blur from re-entering `cancelDraft` → `teardownDraft` → `wrapperEl.remove()` on a
   * node the browser is already in the middle of removing (`removeChild`: "the node to be removed
   * is no longer a child of this node ... moved in a 'blur' event handler"). */
  private readonly handleDraftBlur = (): void => {
    if (this.draft !== null && !this.draft.committing && this.draft.wrapperEl.isConnected) {
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
    const outcome = await this.commitWithOptimism(snapshot, result.plan, `Create "${name}"`);
    this.committing = false;
    // Captured before this method's own cleanup below touches `this.draft`: if the user cancelled
    // this draft (Escape/blur) or opened a different one while the commit was in flight, `draft`
    // no longer matches, and chaining has nothing sensible to reopen against.
    const wasCurrent = this.isCurrentDraft(draft);
    // Set *before* closing the draft below (I6/I7): closing can itself trigger a render (a data
    // update deferred while the draft was open, now flushed by `closeCommittedDraft`) — this has
    // to already be in place for that render's own `resolveFocus`/`completePending` to have any
    // chance of completing the highlight right there, instead of leaving it stranded until some
    // later, possibly-never-arriving `onDataUpdated`. `chain` (U5) is only ever set for Tab — an
    // Enter chain fires immediately below instead, once this draft's own render has run, since it
    // only needs its *parent* (already present) and not the new node itself. Chaining only when
    // this draft was still the one on screen when the commit settled (`wasCurrent`) — a superseded
    // draft already moved the user's attention elsewhere, so nothing should reopen on their behalf;
    // the `is-new` highlight itself still applies either way. Nothing to set when the commit
    // failed — no note exists to highlight or chain from.
    if (outcome.applied) {
      this.pendingCreate = { path: result.focus, chain: wasCurrent && mode === 'tab' };
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
    if (!outcome.applied) {
      return;
    }
    this.showUndoNotice(`Created "${name}"`, outcome.transaction);
    // U5: an Enter chain (create-*sibling*, same parent) doesn't need to wait for the new note to
    // become visible in `Structure` the way `completePending`'s Tab chain does (see
    // `PendingCreate`'s own doc comment) — `draft.parentPath` already exists right now, in the DOM
    // the render just above (`closeCommittedDraft`'s flush or `refresh()`) already produced.
    if (wasCurrent && mode === 'enter') {
      this.reopenEnterChain(draft.parentPath, draft.type);
    }
  }

  /** U5: re-locates the parent by its *current* `data-path` under the last known live root —
   * mirrors `continueTabChain`'s own `findNodeElement` lookup (not `draft.anchorEl` directly, and
   * not `openDraft`), so: a parent that genuinely lost its DOM identity across the render this
   * triggered correctly gets no reopen, same guarantee Tab's own chain already has; and reusing
   * `startDraft` (not `openDraft`) means this doesn't clear the `pendingCreate` `runCommit` just
   * set above — the `is-new` highlight still has to survive for whichever later render actually
   * contains the new note. No-op when there's no known root, or the path isn't found there. */
  private reopenEnterChain(parentPath: string, type: string): void {
    if (this.lastRoot === null) {
      return;
    }
    const anchorEl = findNodeElement(this.lastRoot, parentPath);
    if (anchorEl !== null) {
      this.startDraft(parentPath, anchorEl, type);
    }
  }

  /** U5: only ever reached for a Tab chain now (see `PendingCreate.chain`'s own doc comment) —
   * reopens a create-*child* draft on the node that just became visible. */
  private continueTabChain(root: HTMLElement, focusPath: string): void {
    const anchorEl = findNodeElement(root, focusPath);
    if (anchorEl !== null) {
      this.startCreate(focusPath, anchorEl);
    }
  }

  /** `transaction` (I1) is the exact one this commit just pushed — `null` only for the
   * (practically unreachable through this path, since a notice only shows when `commitPlan`
   * itself reports `applied: true`) case of an apply that somehow produced zero steps. The
   * button's own click handler passes it straight to `runUndoFromNotice`, so clicking an *older*
   * notice after a newer change can't silently undo the wrong one. */
  private showUndoNotice(message: string, transaction: Transaction | null): void {
    const button = createEl('button', { cls: UNDO_CLASS, text: 'Undo' });
    const fragment = createFragment((el) => {
      el.createSpan({ text: message });
      el.appendChild(button);
    });
    const notice = new Notice(fragment, UNDO_NOTICE_DURATION);
    button.addEventListener('click', () => {
      if (button.disabled) {
        return;
      }
      this.runUndoFromNotice(notice, button, transaction);
    });
  }

  /** I1: disables the button immediately (before the `await`) so a second click — real or
   * doubled — can't fire a second undo while the first is still in flight. Reports the result via
   * `formatUndoResult` either way: a normal undo, "a newer change must be undone first" when
   * `transaction` is no longer on top (`UndoManager.undo`'s own identity check), or (the `null`
   * fallback) whatever is currently on top, same as `undoLast`. */
  private runUndoFromNotice(
    notice: Notice,
    button: HTMLButtonElement,
    transaction: Transaction | null,
  ): void {
    button.disabled = true;
    const { snapshot } = this.deps.getInput();
    const result = transaction !== null ? this.deps.undo.undo(transaction) : this.deps.undo.undo();
    result
      .then((outcome) => {
        if (didUndoSomething(outcome)) {
          this.deps.clearOptimistic();
        }
        this.deps.refresh();
        notice.hide();
        notifyError(formatUndoResult(outcome, (path) => displayName(snapshot, path)));
      })
      .catch((error: unknown) => {
        logError(error);
        notifyError('undo failed');
      });
  }
}
