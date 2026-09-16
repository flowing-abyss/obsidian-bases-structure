// Applies a pure `Plan` (see `src/core/plan-types.ts`) to the real vault: creates notes, writes
// frontmatter, appends backlink lines, and moves files, recording every primitive step it actually
// completed so a failure partway through still leaves something `UndoManager` can roll back.
// Never throws — the first failing operation stops the walk and comes back as `ApplyOutcome.error`.

import type { App, TFile } from 'obsidian';
import { Notice } from 'obsidian';
import { deepEqual } from '../core/deep-equal.js';
import type { KeyWrite, Plan } from '../core/plan-types.js';
import { folderOf, type Snapshot } from '../core/snapshot.js';
import { applyLinksWrite, applyListItemWrite, linkLine } from './link-writer.js';
import type { UndoManager } from './undo-manager.js';

export type TransactionStep =
  | {
      readonly kind: 'frontmatter';
      readonly path: string;
      readonly key: string;
      readonly existed: boolean;
      readonly before: unknown;
      readonly after: unknown;
      readonly deleted: boolean;
    }
  | { readonly kind: 'create'; readonly path: string; readonly content: string }
  | { readonly kind: 'createFolder'; readonly path: string }
  | { readonly kind: 'append'; readonly path: string; readonly text: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string };

export interface Transaction {
  readonly label: string;
  readonly steps: readonly TransactionStep[];
}

export interface ApplyOutcome {
  readonly transaction: Transaction;
  readonly error: unknown;
}

/** Creates every path segment of `folderPath` that doesn't already exist, parent-first, recording
 * a `'createFolder'` step for each one actually created — so a folder this step (a create or a
 * move) had to make gets cleaned up on undo, not left behind as an orphan (M2). A no-op for the
 * vault root (`''`). */
async function ensureFolder(app: App, folderPath: string, steps: TransactionStep[]): Promise<void> {
  if (folderPath === '') {
    return;
  }
  let cumulative = '';
  for (const segment of folderPath.split('/')) {
    cumulative = cumulative === '' ? segment : `${cumulative}/${segment}`;
    if (app.vault.getFolderByPath(cumulative) === null) {
      await app.vault.createFolder(cumulative);
      steps.push({ kind: 'createFolder', path: cumulative });
    }
  }
}

/** The note at `path`, or an error matching the decisions' wording — thrown, not returned, so a
 * caller can just `await` this and let `applyPlan`'s outer `try` stop the walk. */
function requireFile(app: App, path: string): TFile {
  const file = app.vault.getFileByPath(path);
  if (file === null) {
    throw new Error(`Note not found: ${path}`);
  }
  return file;
}

interface WriteContext {
  readonly sourcePath: string;
  readonly creating: ReadonlySet<string>;
}

function applyWrite(
  app: App,
  frontmatter: Record<string, unknown>,
  write: KeyWrite,
  ctx: WriteContext,
): void {
  const { key, value } = write;
  if (value === null) {
    delete frontmatter[key];
    return;
  }
  if (value.kind === 'links') {
    applyLinksWrite(app, {
      frontmatter,
      key,
      value,
      sourcePath: ctx.sourcePath,
      creating: ctx.creating,
    });
    return;
  }
  if (value.kind === 'listItem') {
    applyListItemWrite(frontmatter, key, value);
    return;
  }
  frontmatter[key] = value.value;
}

function renderBody(
  app: App,
  bodyLinks: readonly string[],
  sourcePath: string,
  creating: ReadonlySet<string>,
): string {
  if (bodyLinks.length === 0) {
    return '';
  }
  return `${bodyLinks.map((target) => linkLine(app, target, sourcePath, creating)).join('\n')}\n`;
}

/** Creates the note and records its `'create'` step *immediately*, before writing frontmatter —
 * with the note's initial (pre-frontmatter) content. If `processFrontMatter` then fails partway,
 * the step already in `steps` still lets `UndoManager` trash the orphaned note; if it succeeds,
 * the step is updated in place to the final content, matching what undo will actually compare
 * against (M2 — a failing frontmatter write used to leave the created note un-undoable). */
async function applyCreation(
  app: App,
  creation: Plan['creations'][number],
  steps: TransactionStep[],
  creating: ReadonlySet<string>,
): Promise<void> {
  await ensureFolder(app, folderOf(creation.path), steps);
  const body = renderBody(app, creation.bodyLinks, creation.path, creating);
  const file = await app.vault.create(creation.path, body);
  const stepIndex = steps.length;
  steps.push({ kind: 'create', path: creation.path, content: body });
  const ctx: WriteContext = { sourcePath: creation.path, creating };
  await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
    for (const write of creation.writes) {
      applyWrite(app, frontmatter, write, ctx);
    }
  });
  const content = await app.vault.read(file);
  steps.splice(stepIndex, 1, { kind: 'create', path: creation.path, content });
}

interface ChangeWriteState {
  readonly expectedFrontmatter: Readonly<Record<string, unknown>> | undefined;
  readonly checkedKeys: Set<string>;
}

interface ChangeWriteArgs {
  readonly app: App;
  readonly frontmatter: Record<string, unknown>;
  readonly write: KeyWrite;
  readonly path: string;
  readonly creating: ReadonlySet<string>;
  readonly state: ChangeWriteState;
  readonly steps: TransactionStep[];
}

/** Applies one write, first checking (once per *distinct* key) whether the note's current value
 * still matches what the plan expected — `false` (nothing applied, nothing recorded) the moment
 * it doesn't; a later write to the same key already checked (e.g. a retype's paired tag
 * remove+add) is this same plan's own edit, not a concurrent one, so it's never re-checked. */
function tryApplyChangeWrite(args: ChangeWriteArgs): boolean {
  const { app, frontmatter, write, path, creating, state, steps } = args;
  const { expectedFrontmatter, checkedKeys } = state;
  if (expectedFrontmatter !== undefined && !checkedKeys.has(write.key)) {
    checkedKeys.add(write.key);
    if (!deepEqual(frontmatter[write.key], expectedFrontmatter[write.key])) {
      return false;
    }
  }
  const existed = write.key in frontmatter;
  const before = structuredClone(frontmatter[write.key]);
  const deleted = write.value === null;
  applyWrite(app, frontmatter, write, { sourcePath: path, creating });
  const after = deleted ? undefined : structuredClone(frontmatter[write.key]);
  steps.push({ kind: 'frontmatter', path, key: write.key, existed, before, after, deleted });
  return true;
}

/** Applies every write for one changed note inside a single `processFrontMatter` call, checking
 * each touched key against `ctx.expected` (the raw frontmatter value the fresh snapshot the plan
 * was built from saw for that key) via `tryApplyChangeWrite`. On a mismatch, stops applying *this
 * and every later* write and throws — `applyPlan`'s outer `try` already stops the whole walk there
 * and keeps whatever completed earlier as undoable, exactly what "nothing else was written"
 * requires (I5). */
async function applyChange(
  app: App,
  change: Plan['changes'][number],
  steps: TransactionStep[],
  ctx: ApplyContext,
): Promise<void> {
  const file = requireFile(app, change.path);
  const state: ChangeWriteState = {
    expectedFrontmatter: ctx.expected.notes.get(change.path)?.frontmatter,
    checkedKeys: new Set(),
  };
  const outcome = { conflict: false };
  await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
    for (const write of change.writes) {
      if (outcome.conflict) {
        break;
      }
      const applied = tryApplyChangeWrite({
        app,
        frontmatter,
        write,
        path: change.path,
        creating: ctx.creating,
        state,
        steps,
      });
      if (!applied) {
        outcome.conflict = true;
      }
    }
  });
  if (outcome.conflict) {
    throw new Error(`"${file.basename}" changed while applying; nothing else was written`);
  }
}

async function applyAppend(
  app: App,
  append: Plan['appends'][number],
  steps: TransactionStep[],
  creating: ReadonlySet<string>,
): Promise<void> {
  const file = requireFile(app, append.path);
  let text = '';
  await app.vault.process(file, (data: string) => {
    const prefix = data === '' || data.endsWith('\n') ? '' : '\n';
    text = `${prefix}${linkLine(app, append.target, append.path, creating)}\n`;
    return data + text;
  });
  steps.push({ kind: 'append', path: append.path, text });
}

async function applyMove(
  app: App,
  move: Plan['moves'][number],
  steps: TransactionStep[],
): Promise<void> {
  const file = requireFile(app, move.from);
  await ensureFolder(app, folderOf(move.to), steps);
  await app.fileManager.renameFile(file, move.to);
  steps.push({ kind: 'rename', from: move.from, to: move.to });
}

interface ApplyContext {
  readonly expected: Snapshot;
  readonly creating: ReadonlySet<string>;
}

/** Applies every part of `plan` in order (creations, changes, appends, moves), recording one
 * `TransactionStep` per primitive write. Stops at the first failing operation and returns the
 * steps completed so far with `error` set — `null` when everything succeeded. `expected` is the
 * snapshot the plan was built from (the view's `freshInput()`, read immediately before planning):
 * each change write is checked against it before being applied, so a concurrent edit to the same
 * key aborts the rest of the plan instead of overwriting it (I5). */
export async function applyPlan(
  app: App,
  plan: Plan,
  label: string,
  expected: Snapshot,
): Promise<ApplyOutcome> {
  const steps: TransactionStep[] = [];
  const ctx: ApplyContext = {
    expected,
    creating: new Set(plan.creations.map((creation) => creation.path)),
  };
  try {
    for (const creation of plan.creations) {
      await applyCreation(app, creation, steps, ctx.creating);
    }
    for (const change of plan.changes) {
      await applyChange(app, change, steps, ctx);
    }
    for (const append of plan.appends) {
      await applyAppend(app, append, steps, ctx.creating);
    }
    for (const move of plan.moves) {
      await applyMove(app, move, steps);
    }
    return { transaction: { label, steps }, error: null };
  } catch (error) {
    return { transaction: { label, steps }, error };
  }
}

/** A user-facing description of `error`: an `Error`'s own `message`, else its `String()` form —
 * deliberately permissive since this is the last-resort fallback for whatever a thrown value
 * turned out to be (`String()` never itself throws, unlike reading a property off it). */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export interface CommitRequest {
  readonly plan: Plan;
  readonly label: string;
  /** The snapshot the plan was built from — see `applyPlan`'s own doc comment. */
  readonly expected: Snapshot;
}

/** `applyPlan`, then the outer boundary a user-triggered structure edit needs: the transaction is
 * pushed onto `undo` whenever it has at least one step — even a failed apply may have partially
 * succeeded, and that partial work still needs to be reversible. On failure, logs the error and
 * shows the user a short `Notice`; returns whether the whole plan applied cleanly. */
export async function commitPlan(
  app: App,
  undo: UndoManager,
  request: CommitRequest,
): Promise<boolean> {
  const { plan, label, expected } = request;
  const outcome = await applyPlan(app, plan, label, expected);
  if (outcome.transaction.steps.length > 0) {
    undo.push(outcome.transaction);
  }
  if (outcome.error === null) {
    return true;
  }
  console.error('[bases-structure]', outcome.error);
  new Notice(`Structure: could not apply all changes. ${errorMessage(outcome.error)}`);
  return false;
}
