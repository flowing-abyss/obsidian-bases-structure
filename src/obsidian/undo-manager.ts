// Reverts a `Transaction` recorded by `plan-applier.ts`'s `applyPlan`, one primitive step at a
// time, in reverse order. A step is only reverted when the vault still looks the way the apply
// left it — anything touched again since (by the user or another plan) is left alone and reported
// as skipped, never overwritten and never thrown past this boundary.

import type { App } from 'obsidian';
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

/** `true` when reverted, `false` when skipped — never throws (callers catch around it). */
async function revertRename(app: App, step: RenameStep): Promise<boolean> {
  const file = app.vault.getFileByPath(step.to);
  if (file === null || app.vault.getAbstractFileByPath(step.from) !== null) {
    return false;
  }
  await app.fileManager.renameFile(file, step.from);
  return true;
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
    const lastIndex = data.lastIndexOf(step.text);
    if (lastIndex === -1) {
      return data;
    }
    handled = true;
    return data.slice(0, lastIndex) + data.slice(lastIndex + step.text.length);
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

async function revertCreate(app: App, step: CreateStep): Promise<boolean> {
  const file = app.vault.getFileByPath(step.path);
  if (file === null) {
    return true;
  }
  const content = await app.vault.read(file);
  if (content !== step.content) {
    return false;
  }
  await app.fileManager.trashFile(file);
  return true;
}

function revertStep(app: App, step: TransactionStep): Promise<boolean> {
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
