import { App, MarkdownView } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it } from 'vitest';
import { findHostFile } from './root-finder.js';

function markdownLeaf(app: App, filePath?: string): { containerEl: HTMLElement } {
  const leaf = app.workspace.getLeaf(true);
  const view = MarkdownView.create2__(leaf);
  if (filePath !== undefined) {
    const file = app.vault.getFileByPath(filePath);
    if (file === null) {
      throw new Error(`Test setup error: missing file "${filePath}"`);
    }
    view.file = file;
  }
  leaf.view = view.asOriginalType7__();
  return { containerEl: view.containerEl };
}

describe('findHostFile', () => {
  it('returns the markdown file of the leaf whose view contains the element', () => {
    const app = App.createConfigured__({ files: { 'note.md': '' } });
    const { containerEl } = markdownLeaf(app, 'note.md');
    const element = createDiv();
    containerEl.appendChild(element);

    const file = findHostFile(app.asOriginalType__(), element);

    expect(file?.path).toBe('note.md');
  });

  it('returns null when no leaf contains the element', () => {
    const app = App.createConfigured__({ files: { 'note.md': '' } });
    markdownLeaf(app, 'note.md');
    const element = createDiv();
    // Never attached to any leaf's containerEl.

    const file = findHostFile(app.asOriginalType__(), element);

    expect(file).toBeNull();
  });

  it('returns null when the containing leaf has no MarkdownView open yet', () => {
    const app = App.createConfigured__({});
    // A freshly created leaf has `view === null` — fails the `instanceof MarkdownView` check
    // before any `containerEl` access is attempted.
    app.workspace.getLeaf(true);
    const element = createDiv();

    const file = findHostFile(app.asOriginalType__(), element);

    expect(file).toBeNull();
  });

  it('returns null when the MarkdownView is showing a non-markdown file', () => {
    const app = App.createConfigured__({ files: { 'image.png': '' } });
    const { containerEl } = markdownLeaf(app, 'image.png');
    const element = createDiv();
    containerEl.appendChild(element);

    const file = findHostFile(app.asOriginalType__(), element);

    expect(file).toBeNull();
  });

  it('returns null when the MarkdownView has no file at all', () => {
    const app = App.createConfigured__({});
    const { containerEl } = markdownLeaf(app);
    const element = createDiv();
    containerEl.appendChild(element);

    const file = findHostFile(app.asOriginalType__(), element);

    expect(file).toBeNull();
  });

  it('picks the first matching leaf when several leaves exist', () => {
    const app = App.createConfigured__({ files: { 'first.md': '', 'second.md': '' } });
    const { containerEl: firstEl } = markdownLeaf(app, 'first.md');
    const { containerEl: secondEl } = markdownLeaf(app, 'second.md');
    const firstElement = createDiv();
    const secondElement = createDiv();
    firstEl.appendChild(firstElement);
    secondEl.appendChild(secondElement);

    expect(findHostFile(app.asOriginalType__(), firstElement)?.path).toBe('first.md');
    expect(findHostFile(app.asOriginalType__(), secondElement)?.path).toBe('second.md');
  });
});
