// Reverts a `Transaction` recorded by `plan-applier.ts`'s `applyPlan`, one primitive step at a
// time, in reverse order. A step is only reverted when the vault still looks the way the apply
// left it — anything touched again since (by the user or another plan) is left alone and reported
// as skipped, never overwritten and never thrown past this boundary.

import type { App } from 'obsidian';
import { getFrontMatterInfo } from 'obsidian';
import type { Transaction, TransactionStep } from './plan-applier.js';

export interface UndoResult {
  readonly label: string | null;
  readonly skipped: readonly string[];
}

const DEFAULT_LIMIT = 50;

/** Structural comparison good enough for frontmatter values (strings, numbers, booleans, `null`,
 * plain objects and arrays — everything YAML can produce): arrays compare order-sensitively,
 * objects compare by key/value regardless of key order. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length && aKeys.every((key) => key in b && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First-occurrence order, duplicates dropped. */
function uniqueInOrder(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

type RenameStep = Extract<TransactionStep, { kind: 'rename' }>;
type AppendStep = Extract<TransactionStep, { kind: 'append' }>;
type FrontmatterStep = Extract<TransactionStep, { kind: 'frontmatter' }>;
type CreateStep = Extract<TransactionStep, { kind: 'create' }>;
type CreateFolderStep = Extract<TransactionStep, { kind: 'createFolder' }>;

/** `true` when reverted, `false` when skipped — never throws (callers catch around it). */
async function revertRename(app: App, step: RenameStep): Promise<boolean> {
  const file = app.vault.getFileByPath(step.to);
  if (file === null || app.vault.getAbstractFileByPath(step.from) !== null) {
    return false;
  }
  await app.fileManager.renameFile(file, step.from);
  return true;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The bare link line an append step's `text` wraps: `applyAppend` prefixes it with a `"\n"`
 * separator only when the parent didn't already end with one, and always suffixes it with a
 * `"\n"` — stripping both leaves just the line itself (e.g. `"- [[Child]]"`). */
function bareLineOf(text: string): string {
  const withoutLeadingNewline = text.startsWith('\n') ? text.slice(1) : text;
  return withoutLeadingNewline.endsWith('\n')
    ? withoutLeadingNewline.slice(0, -1)
    : withoutLeadingNewline;
}

/** Removes the last whole-line occurrence of `line` from `data` — matched at a real line boundary
 * (start of file, or right after a `"\n"`) — keeping that boundary character itself and only
 * dropping the line's own text and its trailing `"\n"`. `null` when no such line exists. This is
 * the "content was appended after ours" fallback `revertAppend` uses once `data` no longer simply
 * ends with the recorded text: blindly stripping the recorded text (which may start with a
 * separator `"\n"` `applyAppend` added ahead of it) would instead delete the newline terminating
 * the *previous* line, merging it with whatever now follows (I2). */
function removeLastWholeLine(data: string, line: string): string | null {
  const regex = new RegExp(`(^|\\n)${escapeRegExp(line)}\\n`, 'g');
  let lastMatch: RegExpExecArray | null = null;
  for (const match of data.matchAll(regex)) {
    lastMatch = match;
  }
  if (lastMatch === null) {
    return null;
  }
  const boundary = lastMatch[1] ?? '';
  return (
    data.slice(0, lastMatch.index) + boundary + data.slice(lastMatch.index + lastMatch[0].length)
  );
}

async function revertAppend(app: App, step: AppendStep): Promise<boolean> {
  const file = app.vault.getFileByPath(step.path);
  if (file === null) {
    return false;
  }
  let handled = false;
  await app.vault.process(file, (data: string) => {
    if (data.endsWith(step.text)) {
      handled = true;
      return data.slice(0, data.length - step.text.length);
    }
    const replaced = removeLastWholeLine(data, bareLineOf(step.text));
    if (replaced === null) {
      return data;
    }
    handled = true;
    return replaced;
  });
  return handled;
}

async function revertFrontmatter(app: App, step: FrontmatterStep): Promise<boolean> {
  const file = app.vault.getFileByPath(step.path);
  if (file === null) {
    return false;
  }
  let handled = false;
  await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
    const current = step.key in frontmatter ? frontmatter[step.key] : undefined;
    if (!deepEqual(current, step.after)) {
      return;
    }
    handled = true;
    if (step.existed) {
      frontmatter[step.key] = step.before;
    } else {
      delete frontmatter[step.key];
    }
  });
  return handled;
}

/** The content after the frontmatter block (including any leading blank line) — everything the
 * user actually typed, as opposed to the frontmatter block another plugin commonly fills in on a
 * newly created note (a metadata/template plugin, e.g.) before the user gets to it. */
function bodyOf(content: string): string {
  return content.slice(getFrontMatterInfo(content).contentStart);
}

/** Trashes the created note when its *body* is unchanged, regardless of frontmatter — another
 * plugin filling in frontmatter fields on a newly created note is common and shouldn't block
 * undo, which only cares whether the user's own text is still there (I11). Skips (reports a
 * conflict) only when the body itself was edited. */
async function revertCreate(app: App, step: CreateStep): Promise<boolean> {
  const file = app.vault.getFileByPath(step.path);
  if (file === null) {
    return true;
  }
  const content = await app.vault.read(file);
  if (bodyOf(content) !== bodyOf(step.content)) {
    return false;
  }
  await app.fileManager.trashFile(file);
  return true;
}

/** Removes a folder this same transaction had to create, but only when it's still empty — a
 * folder that picked up other content since (including a step from the same transaction that got
 * skipped, e.g. its own note not reverting cleanly) is left alone rather than deleted out from
 * under whatever's now in it (M2). Deliberately reports no conflict either way (unlike every other
 * step kind): an already-gone folder, one left alone because it's non-empty, and one actually
 * removed are all unremarkable outcomes for a folder specifically, which is why this isn't part of
 * the shared `revertStep`/`skipped` protocol — see `revertOne`. */
async function revertCreateFolder(app: App, step: CreateFolderStep): Promise<void> {
  const folder = app.vault.getFolderByPath(step.path);
  if (folder === null || folder.children.length > 0) {
    return;
  }
  await app.fileManager.trashFile(folder);
}

function revertStep(
  app: App,
  step: Exclude<TransactionStep, { kind: 'createFolder' }>,
): Promise<boolean> {
  switch (step.kind) {
    case 'rename':
      return revertRename(app, step);
    case 'append':
      return revertAppend(app, step);
    case 'frontmatter':
      return revertFrontmatter(app, step);
    case 'create':
      return revertCreate(app, step);
  }
}

/** The path a skipped step is reported under — the rename's destination (its current, still-live
 * path), the others' own `path`. */
function pathOf(step: TransactionStep): string {
  return step.kind === 'rename' ? step.to : step.path;
}

/** Reverts one `Transaction` at a time, most recent first (LIFO), reporting per-note conflicts
 * instead of failing outright. */
export class UndoManager {
  private readonly app: App;
  private readonly limit: number;
  private readonly stack: Transaction[] = [];

  constructor(app: App, limit: number = DEFAULT_LIMIT) {
    this.app = app;
    this.limit = limit;
  }

  push(transaction: Transaction): void {
    this.stack.push(transaction);
    while (this.stack.length > this.limit) {
      this.stack.shift();
    }
  }

  get canUndo(): boolean {
    return this.stack.length > 0;
  }

  async undo(): Promise<UndoResult> {
    const transaction = this.stack.pop();
    if (transaction === undefined) {
      return { label: null, skipped: [] };
    }
    const skipped: string[] = [];
    for (const step of [...transaction.steps].reverse()) {
      await this.revertOne(step, skipped);
    }
    return { label: transaction.label, skipped: uniqueInOrder(skipped) };
  }

  private async revertOne(step: TransactionStep, skipped: string[]): Promise<void> {
    if (step.kind === 'createFolder') {
      try {
        await revertCreateFolder(this.app, step);
      } catch (error) {
        console.error('[bases-structure]', error);
      }
      return;
    }
    try {
      const handled = await revertStep(this.app, step);
      if (!handled) {
        skipped.push(pathOf(step));
      }
    } catch (error) {
      console.error('[bases-structure]', error);
      skipped.push(pathOf(step));
    }
  }
}
