import { describe, expect, it } from 'vitest';
import { removeBodyLink } from './body-link.js';

describe('removeBodyLink', () => {
  it('removes a bullet line', () => {
    expect(removeBodyLink('# H\n\n- [[Child]]\n- [[Other]]\n', ['Child'])?.text).toBe(
      '# H\n\n- [[Other]]\n',
    );
  });

  it('removes a bare mention but keeps the sentence', () => {
    expect(removeBodyLink('See [[Child]] for details.\n', ['Child'])?.text).toBe(
      'See for details.\n',
    );
  });

  it('matches an aliased and a headed link', () => {
    expect(removeBodyLink('- [[Child|kid]]\n', ['Child'])?.text).toBe('');
    expect(removeBodyLink('- [[Child#Part]]\n', ['Child'])?.text).toBe('');
  });

  it('ignores embeds', () => {
    expect(removeBodyLink('![[Child]]\n', ['Child'])).toBeNull();
  });

  it('returns null when there is no mention', () => {
    expect(removeBodyLink('- [[Other]]\n', ['Child'])).toBeNull();
  });

  it('matches case-insensitively', () => {
    expect(removeBodyLink('- [[child]]\n', ['Child'])?.text).toBe('');
  });

  it('matches a numbered list marker line', () => {
    expect(removeBodyLink('1. [[Child]]\n', ['Child'])?.text).toBe('');
  });

  it('matches a "*" list marker line', () => {
    expect(removeBodyLink('* [[Child]]\n', ['Child'])?.text).toBe('');
  });

  it('removes only the first matching mention, leaving a later one untouched', () => {
    const result = removeBodyLink('- [[Child]]\n- [[Child]]\n', ['Child']);
    expect(result?.text).toBe('- [[Child]]\n');
  });

  it('matches against any entry in linktexts, not just the first', () => {
    expect(removeBodyLink('- [[Child]]\n', ['Alias', 'Child'])?.text).toBe('');
  });

  it('matches a linktext entry by its basename when the mention is the bare name', () => {
    expect(removeBodyLink('- [[Child]]\n', ['folder/Child'])?.text).toBe('');
  });

  it('removes the last line even without a trailing newline', () => {
    expect(removeBodyLink('Body\n- [[Child]]', ['Child'])?.text).toBe('Body\n');
  });

  it('keeps a heading above an emptied list untouched', () => {
    expect(removeBodyLink('## Children\n- [[Child]]\n', ['Child'])?.text).toBe('## Children\n');
  });

  it('reports exactly what was cut and where, so it can be spliced back in verbatim (undo invariant)', () => {
    const original = '# H\n\n- [[Child]]\n- [[Other]]\n';
    const result = removeBodyLink(original, ['Child']);
    expect(result).not.toBeNull();
    if (result === null) {
      return;
    }
    expect(
      result.text.slice(0, result.index) + result.removed + result.text.slice(result.index),
    ).toBe(original);
  });

  it('reports the same undo invariant for a bare mid-sentence mention', () => {
    const original = 'See [[Child]] for details.\n';
    const result = removeBodyLink(original, ['Child']);
    expect(result).not.toBeNull();
    if (result === null) {
      return;
    }
    expect(
      result.text.slice(0, result.index) + result.removed + result.text.slice(result.index),
    ).toBe(original);
  });

  it('does not collapse a space when only one side of the token has one', () => {
    expect(removeBodyLink('[[Child]] leads.\n', ['Child'])?.text).toBe(' leads.\n');
  });
});
