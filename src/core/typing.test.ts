import { describe, expect, it } from 'vitest';
import { note } from './__tests__/notes.js';
import type { Schema, TypeDef, TypeMatch } from './schema.js';
import { matchesType, resolveType } from './typing.js';

const emptyMatch: TypeMatch = { tags: [], folder: null, properties: [] };

function typeDef(name: string, level: number, match: TypeMatch, specificity: number): TypeDef {
  return { name, level, match, specificity, children: new Map() };
}

function schemaOf(types: readonly TypeDef[]): Schema {
  return {
    types,
    typeByName: new Map(types.map((type) => [type.name, type])),
    inherit: [],
    layout: 'graph',
  };
}

describe('matchesType — tags', () => {
  it('matches a nested note tag (type tag is a path prefix of it)', () => {
    const def = typeDef('T', 0, { ...emptyMatch, tags: ['system/high'] }, 1);

    expect(matchesType(def, note('a.md', { tags: ['system/high/meta'] }))).toBe(true);
  });

  it('does not match a tag that only shares a text prefix, not a path segment', () => {
    const def = typeDef('T', 0, { ...emptyMatch, tags: ['system/high'] }, 1);

    expect(matchesType(def, note('a.md', { tags: ['system/higher'] }))).toBe(false);
  });

  it('is case-insensitive', () => {
    const def = typeDef('T', 0, { ...emptyMatch, tags: ['System/High'] }, 1);

    expect(matchesType(def, note('a.md', { tags: ['system/high'] }))).toBe(true);
  });

  it('requires every listed tag to be present (AND)', () => {
    const def = typeDef('T', 0, { ...emptyMatch, tags: ['a', 'b'] }, 2);

    expect(matchesType(def, note('a.md', { tags: ['a'] }))).toBe(false);
    expect(matchesType(def, note('a.md', { tags: ['a', 'b'] }))).toBe(true);
  });
});

describe('matchesType — folder', () => {
  it('matches a note directly in the folder', () => {
    const def = typeDef('T', 0, { ...emptyMatch, folder: 'base/hierarchy' }, 1);

    expect(matchesType(def, note('base/hierarchy/x.md'))).toBe(true);
  });

  it('matches a note in a subfolder', () => {
    const def = typeDef('T', 0, { ...emptyMatch, folder: 'base/hierarchy' }, 1);

    expect(matchesType(def, note('base/hierarchy/sub/x.md'))).toBe(true);
  });

  it('does not match a sibling folder that merely shares a text prefix', () => {
    const def = typeDef('T', 0, { ...emptyMatch, folder: 'base/hierarchy' }, 1);

    expect(matchesType(def, note('base/hierarchy2/x.md'))).toBe(false);
  });

  it('is case-sensitive', () => {
    const def = typeDef('T', 0, { ...emptyMatch, folder: 'Base' }, 1);

    expect(matchesType(def, note('base/x.md'))).toBe(false);
  });
});

describe('matchesType — properties', () => {
  it('matches a scalar property, case-insensitively and trimmed', () => {
    const def = typeDef('T', 0, { ...emptyMatch, properties: [['status', 'done']] }, 1);

    expect(matchesType(def, note('a.md', { frontmatter: { status: ' Done ' } }))).toBe(true);
  });

  it('stringifies numbers and booleans before comparing', () => {
    const numberDef = typeDef('T', 0, { ...emptyMatch, properties: [['priority', '1']] }, 1);
    const boolDef = typeDef('T', 0, { ...emptyMatch, properties: [['active', 'true']] }, 1);

    expect(matchesType(numberDef, note('a.md', { frontmatter: { priority: 1 } }))).toBe(true);
    expect(matchesType(boolDef, note('a.md', { frontmatter: { active: true } }))).toBe(true);
  });

  it('matches when any element of a list property equals the expected value', () => {
    const def = typeDef('T', 0, { ...emptyMatch, properties: [['tag', 'x']] }, 1);

    expect(matchesType(def, note('a.md', { frontmatter: { tag: ['a', 'x', 'b'] } }))).toBe(true);
    expect(matchesType(def, note('a.md', { frontmatter: { tag: ['a', 'b'] } }))).toBe(false);
  });

  it('never matches a missing or null property value', () => {
    const def = typeDef('T', 0, { ...emptyMatch, properties: [['status', 'done']] }, 1);

    expect(matchesType(def, note('a.md'))).toBe(false);
    expect(matchesType(def, note('a.md', { frontmatter: { status: null } }))).toBe(false);
  });

  it('never matches a non-scalar property value (e.g. a nested object)', () => {
    const def = typeDef('T', 0, { ...emptyMatch, properties: [['status', 'done']] }, 1);

    expect(matchesType(def, note('a.md', { frontmatter: { status: { nested: true } } }))).toBe(
      false,
    );
  });

  it('requires every listed property to match (AND)', () => {
    const def = typeDef(
      'T',
      0,
      {
        ...emptyMatch,
        properties: [
          ['status', 'done'],
          ['owner', 'me'],
        ],
      },
      2,
    );

    expect(matchesType(def, note('a.md', { frontmatter: { status: 'done' } }))).toBe(false);
    expect(matchesType(def, note('a.md', { frontmatter: { status: 'done', owner: 'me' } }))).toBe(
      true,
    );
  });

  describe('link values compare by link text', () => {
    it('matches a wikilink actual value against a plain expected value', () => {
      const def = typeDef('T', 0, { ...emptyMatch, properties: [['parent', 'Project']] }, 1);

      expect(matchesType(def, note('a.md', { frontmatter: { parent: '[[Project]]' } }))).toBe(true);
    });

    it('matches a plain actual value against a wikilink expected value', () => {
      const def = typeDef('T', 0, { ...emptyMatch, properties: [['parent', '[[Project]]']] }, 1);

      expect(matchesType(def, note('a.md', { frontmatter: { parent: 'Project' } }))).toBe(true);
    });

    it('reduces folder path, heading, and alias before comparing', () => {
      const def = typeDef('T', 0, { ...emptyMatch, properties: [['parent', 'Project']] }, 1);

      expect(
        matchesType(
          def,
          note('a.md', { frontmatter: { parent: '[[folder/Project#Section|Alias Text]]' } }),
        ),
      ).toBe(true);
    });

    it('reduces a trailing .md in the link text before comparing', () => {
      const def = typeDef('T', 0, { ...emptyMatch, properties: [['parent', 'Project']] }, 1);

      expect(matchesType(def, note('a.md', { frontmatter: { parent: '[[Project.md]]' } }))).toBe(
        true,
      );
    });

    it('does not match a wikilink pointing at a different target', () => {
      const def = typeDef('T', 0, { ...emptyMatch, properties: [['parent', 'Project']] }, 1);

      expect(matchesType(def, note('a.md', { frontmatter: { parent: '[[Other]]' } }))).toBe(false);
    });

    it('matches within a list of wikilinks', () => {
      const def = typeDef('T', 0, { ...emptyMatch, properties: [['parents', 'Project']] }, 1);

      expect(
        matchesType(def, note('a.md', { frontmatter: { parents: ['[[Alpha]]', '[[Project]]'] } })),
      ).toBe(true);
    });
  });
});

describe('matchesType — combined conditions', () => {
  it('a type with no conditions matches any note', () => {
    const def = typeDef('T', 0, emptyMatch, 0);

    expect(matchesType(def, note('anywhere/x.md'))).toBe(true);
  });

  it('requires all condition kinds together (AND across tags/folder/properties)', () => {
    const def = typeDef(
      'T',
      0,
      { tags: ['a'], folder: 'base', properties: [['status', 'done']] },
      3,
    );

    expect(
      matchesType(def, note('base/x.md', { tags: ['a'], frontmatter: { status: 'done' } })),
    ).toBe(true);
    expect(matchesType(def, note('base/x.md', { tags: ['a'] }))).toBe(false);
    expect(
      matchesType(def, note('other/x.md', { tags: ['a'], frontmatter: { status: 'done' } })),
    ).toBe(false);
  });
});

describe('resolveType', () => {
  it('returns null with no conflict when nothing matches', () => {
    const schema = schemaOf([typeDef('T', 0, { ...emptyMatch, tags: ['a'] }, 1)]);

    expect(resolveType(schema, note('a.md'))).toStrictEqual({ type: null, conflict: [] });
  });

  it('resolves the single matching type with no conflict', () => {
    const t = typeDef('T', 0, { ...emptyMatch, tags: ['a'] }, 1);
    const schema = schemaOf([t]);

    expect(resolveType(schema, note('a.md', { tags: ['a'] }))).toStrictEqual({
      type: t,
      conflict: [],
    });
  });

  it('the type with more matching conditions wins over a less specific match', () => {
    const broad = typeDef('Broad', 0, { ...emptyMatch, tags: ['a'] }, 1);
    const narrow = typeDef('Narrow', 1, { ...emptyMatch, tags: ['a'], folder: 'base' }, 2);
    const schema = schemaOf([broad, narrow]);

    const result = resolveType(schema, note('base/x.md', { tags: ['a'] }));

    expect(result).toStrictEqual({ type: narrow, conflict: [] });
  });

  it('an empty type only wins when nothing more specific matches', () => {
    const specific = typeDef('Specific', 0, { ...emptyMatch, tags: ['a'] }, 1);
    const implicit = typeDef('', 1, emptyMatch, 0);
    const schema = schemaOf([specific, implicit]);

    expect(resolveType(schema, note('a.md', { tags: ['a'] }))).toStrictEqual({
      type: specific,
      conflict: [],
    });
    expect(resolveType(schema, note('a.md'))).toStrictEqual({ type: implicit, conflict: [] });
  });

  it('equal top specificity picks the lowest level and reports every tied type as a conflict', () => {
    // Declared out of level order on purpose: the higher-level type comes first in `types`, so
    // this proves the winner is chosen by `level`, not by array position.
    const second = typeDef('Second', 5, { ...emptyMatch, tags: ['a'] }, 1);
    const first = typeDef('First', 2, { ...emptyMatch, folder: 'base' }, 1);
    const schema = schemaOf([second, first]);

    const result = resolveType(schema, note('base/x.md', { tags: ['a'] }));

    expect(result.type).toBe(first);
    expect(result.conflict).toStrictEqual(['Second', 'First']);
  });

  it('picks the lowest level among 3+ tied types regardless of position', () => {
    const high = typeDef('High', 9, { ...emptyMatch, tags: ['a'] }, 1);
    const lowest = typeDef('Lowest', 1, { ...emptyMatch, folder: 'base' }, 1);
    const mid = typeDef('Mid', 4, { ...emptyMatch, properties: [['k', 'v']] }, 1);
    const schema = schemaOf([high, lowest, mid]);

    const result = resolveType(schema, note('base/x.md', { tags: ['a'], frontmatter: { k: 'v' } }));

    expect(result.type).toBe(lowest);
    expect(result.conflict).toStrictEqual(['High', 'Lowest', 'Mid']);
  });
});
