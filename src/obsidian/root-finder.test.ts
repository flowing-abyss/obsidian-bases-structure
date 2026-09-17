import { App, FileView, MarkdownView } from 'obsidian-test-mocks/obsidian';
import { describe, expect, it } from 'vitest';
import { findContainingFile, findHostFile } from './root-finder.js';

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

/** A minimal concrete `FileView` — standing in for the built-in, non-`MarkdownView` `FileView`
 * subclass a directly-opened `.base` file's own leaf really uses in Obsidian (see
 * `findContainingFile`'s own doc comment: verified empirically against a real vault, not just
 * assumed). `obsidian-test-mocks` only ships a concrete `MarkdownView` (itself a `FileView`
 * subclass, so it can't demonstrate the *non-markdown* case `findHostFile` deliberately excludes). */
class TestFileView extends FileView {
  getViewType(): string {
    return 'test-file-view';
  }
}

function fileViewLeaf(app: App, filePath?: string): { containerEl: HTMLElement } {
  const leaf = app.workspace.getLeaf(true);
  const view = new TestFileView(leaf);
  if (filePath !== undefined) {
    const file = app.vault.getFileByPath(filePath);
    if (file === null) {
      throw new Error(`Test setup error: missing file "${filePath}"`);
    }
    view.file = file;
  }
  leaf.view = view.asOriginalType4__();
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

describe('findContainingFile (I9)', () => {
  it('returns the file of a non-MarkdownView FileView leaf — the shape a directly-opened .base file uses', () => {
    const app = App.createConfigured__({ files: { 'my.base': '' } });
    const { containerEl } = fileViewLeaf(app, 'my.base');
    const element = createDiv();
    containerEl.appendChild(element);

    const file = findContainingFile(app.asOriginalType__(), element);

    expect(file?.path).toBe('my.base');
  });

  it('also returns the file of a MarkdownView leaf — unlike findHostFile, it is not restricted to markdown', () => {
    const app = App.createConfigured__({ files: { 'note.md': '' } });
    const { containerEl } = markdownLeaf(app, 'note.md');
    const element = createDiv();
    containerEl.appendChild(element);

    const file = findContainingFile(app.asOriginalType__(), element);

    expect(file?.path).toBe('note.md');
  });

  it('returns null when no leaf contains the element', () => {
    const app = App.createConfigured__({ files: { 'my.base': '' } });
    fileViewLeaf(app, 'my.base');
    const element = createDiv();

    const file = findContainingFile(app.asOriginalType__(), element);

    expect(file).toBeNull();
  });

  it('returns null when the containing FileView has no file at all', () => {
    const app = App.createConfigured__({});
    const { containerEl } = fileViewLeaf(app);
    const element = createDiv();
    containerEl.appendChild(element);

    const file = findContainingFile(app.asOriginalType__(), element);

    expect(file).toBeNull();
  });

  it('picks the first matching leaf when several leaves exist', () => {
    const app = App.createConfigured__({ files: { 'first.base': '', 'second.base': '' } });
    const { containerEl: firstEl } = fileViewLeaf(app, 'first.base');
    const { containerEl: secondEl } = fileViewLeaf(app, 'second.base');
    const firstElement = createDiv();
    const secondElement = createDiv();
    firstEl.appendChild(firstElement);
    secondEl.appendChild(secondElement);

    expect(findContainingFile(app.asOriginalType__(), firstElement)?.path).toBe('first.base');
    expect(findContainingFile(app.asOriginalType__(), secondElement)?.path).toBe('second.base');
  });
});
