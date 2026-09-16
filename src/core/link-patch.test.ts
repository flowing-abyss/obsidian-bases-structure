import { describe, expect, it } from 'vitest';
import { looseEqual, patchLinksValue, patchListItem, rawLinkText } from './link-patch.js';

describe('rawLinkText', () => {
  it('extracts the target from a plain wikilink', () => {
    expect(rawLinkText('[[Target]]')).toBe('Target');
  });

  it('strips an alias, keeping only the link half', () => {
    expect(rawLinkText('[[Target|Alias]]')).toBe('Target');
  });

  it('keeps a heading suffix (the resolver/getLinkpath strips that)', () => {
    expect(rawLinkText('[[Target#Heading]]')).toBe('Target#Heading');
  });

  it('extracts the target from a Markdown link', () => {
    expect(rawLinkText('[Text](Target.md)')).toBe('Target.md');
  });

  it('returns null for plain text', () => {
    expect(rawLinkText('some text')).toBeNull();
  });

  it('returns null for an unresolved-looking wikilink (still link-shaped, but that is the resolver’s call)', () => {
    expect(rawLinkText('[[Not yet written]]')).toBe('Not yet written');
  });
});

describe('looseEqual', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(looseEqual(' Todo ', 'todo')).toBe(true);
    expect(looseEqual('a', 'b')).toBe(false);
  });
});

describe('patchLinksValue', () => {
  const resolveByBasename =
    (map: Record<string, string>) =>
    (raw: string): string | null => {
      const text = rawLinkText(raw);
      const bare = text?.split('#')[0] ?? null;
      return bare === null ? null : (map[bare] ?? null);
    };
  const format = (target: string): string => `[[${target.replace(/\.md$/, '')}]]`;

  it('replaces the old parent in place, preserving unresolved links, plain text, and external links exactly as written (the reviewer’s H.md example)', () => {
    const resolve = resolveByBasename({ A: 'A.md', Ext: 'Ext.md' });
    const current = ['[[A]]', '[[Not yet written]]', 'some text', '[[Ext]]'];

    const result = patchLinksValue(current, {
      remove: new Set(['A.md']),
      add: ['M2.md'],
      list: true,
      resolve,
      format,
    });

    expect(result).toStrictEqual(['[[M2]]', '[[Not yet written]]', 'some text', '[[Ext]]']);
  });

  it('drops an aliased/headed link when its resolved path is removed, leaving other elements untouched', () => {
    const resolve = resolveByBasename({ A: 'A.md' });
    const current = ['[[A|x]]', '[[A#h]]', 'kept'];

    const result = patchLinksValue(current, {
      remove: new Set(['A.md']),
      add: [],
      list: true,
      resolve,
      format,
    });

    expect(result).toStrictEqual(['kept']);
  });

  it('is a no-op to add a target already present', () => {
    const resolve = resolveByBasename({ A: 'A.md' });
    const current = ['[[A]]'];

    const result = patchLinksValue(current, {
      remove: new Set(),
      add: ['A.md'],
      list: true,
      resolve,
      format,
    });

    expect(result).toStrictEqual(['[[A]]']);
  });

  it('is a no-op to remove a target that is not present', () => {
    const resolve = resolveByBasename({ A: 'A.md' });
    const current = ['[[A]]'];

    const result = patchLinksValue(current, {
      remove: new Set(['Ghost.md']),
      add: [],
      list: true,
      resolve,
      format,
    });

    expect(result).toStrictEqual(['[[A]]']);
  });

  it('appends when nothing was removed', () => {
    const resolve = resolveByBasename({});
    const current = ['plain'];

    const result = patchLinksValue(current, {
      remove: new Set(),
      add: ['New.md'],
      list: true,
      resolve,
      format,
    });

    expect(result).toStrictEqual(['plain', '[[New]]']);
  });

  it('keeps an existing single-element array as an array (does not collapse to scalar)', () => {
    const resolve = resolveByBasename({ A: 'A.md' });
    const current = ['[[A]]'];

    const result = patchLinksValue(current, {
      remove: new Set(),
      add: [],
      list: false,
      resolve,
      format,
    });

    expect(result).toStrictEqual(['[[A]]']);
  });

  it('turns an existing scalar into a list only once the result holds more than one element (M1)', () => {
    const resolve = resolveByBasename({ A: 'A.md' });
    const current = '[[A]]';

    const result = patchLinksValue(current, {
      remove: new Set(),
      add: ['B.md'],
      list: false,
      resolve,
      format,
    });

    expect(result).toStrictEqual(['[[A]]', '[[B]]']);
  });

  it('keeps a scalar scalar when the result still holds exactly one element', () => {
    const resolve = resolveByBasename({ A: 'A.md' });
    const current = '[[A]]';

    const result = patchLinksValue(current, {
      remove: new Set(['A.md']),
      add: ['B.md'],
      list: false,
      resolve,
      format,
    });

    expect(result).toStrictEqual('[[B]]');
  });

  it('returns null when the result would be empty', () => {
    const resolve = resolveByBasename({ A: 'A.md' });
    const current = '[[A]]';

    const result = patchLinksValue(current, {
      remove: new Set(['A.md']),
      add: [],
      list: false,
      resolve,
      format,
    });

    expect(result).toBeNull();
  });

  it('builds a fresh list for a key that does not exist yet, honouring `list: true` even for one target', () => {
    const resolve = resolveByBasename({});

    const result = patchLinksValue(undefined, {
      remove: new Set(),
      add: ['A.md'],
      list: true,
      resolve,
      format,
    });

    expect(result).toStrictEqual(['[[A]]']);
  });

  it('builds a fresh scalar for a key that does not exist yet when `list: false`', () => {
    const resolve = resolveByBasename({});

    const result = patchLinksValue(undefined, {
      remove: new Set(),
      add: ['A.md'],
      list: false,
      resolve,
      format,
    });

    expect(result).toBe('[[A]]');
  });

  it('never touches a non-string array element (defensive)', () => {
    const resolve = resolveByBasename({});
    const current = [42, '[[A]]'];

    const result = patchLinksValue(current, {
      remove: new Set(),
      add: [],
      list: true,
      resolve,
      format,
    });

    expect(result).toStrictEqual([42, '[[A]]']);
  });
});

describe('patchListItem', () => {
  it('replaces the old element with the new one at its position, keeping other elements (type: [project, archived] -> task)', () => {
    const result = patchListItem(['project', 'archived'], { remove: 'project', add: 'task' });

    expect(result).toStrictEqual(['task', 'archived']);
  });

  it('matches loosely (case/whitespace-insensitive), staying an array since it already was one', () => {
    const result = patchListItem([' Project '], { remove: 'project', add: 'task' });

    expect(result).toStrictEqual(['task']);
  });

  it('removes without adding, staying an array since it already was one', () => {
    const result = patchListItem(['project', 'archived'], { remove: 'project' });

    expect(result).toStrictEqual(['archived']);
  });

  it('adds without removing, appending when nothing matched', () => {
    const result = patchListItem(['archived'], { add: 'task' });

    expect(result).toStrictEqual(['archived', 'task']);
  });

  it('is a no-op to add a value already present', () => {
    const result = patchListItem(['task'], { add: 'task' });

    expect(result).toStrictEqual(['task']);
  });

  it('keeps an existing single-element array as an array', () => {
    const result = patchListItem(['task'], {});

    expect(result).toStrictEqual(['task']);
  });

  it('returns null once the result is empty', () => {
    const result = patchListItem(['project'], { remove: 'project' });

    expect(result).toBeNull();
  });

  it('builds a fresh scalar from an absent key', () => {
    const result = patchListItem(undefined, { add: 'task' });

    expect(result).toBe('task');
  });
});
