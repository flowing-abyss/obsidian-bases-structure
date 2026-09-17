import { describe, expect, it } from 'vitest';
import { note, snapshot } from './__tests__/notes.js';
import type { KeyWrite, Plan } from './plan-types.js';
import { applyPlan } from './simulate.js';

function emptyPlan(overrides: Partial<Plan> = {}): Plan {
  return { creations: [], changes: [], appends: [], moves: [], bodyLinkRemovals: [], ...overrides };
}

describe('applyPlan — creations', () => {
  it('builds tags, literal, and links writes (list and scalar) into a new note', () => {
    const snap = snapshot([note('project.md')]);
    const writes: readonly KeyWrite[] = [
      { key: 'tags', value: { kind: 'literal', value: ['#type/x'] } },
      { key: 'status', value: { kind: 'literal', value: 'done' } },
      { key: 'category', value: { kind: 'links', remove: [], add: ['cat.md'], list: true } },
      { key: 'meta', value: { kind: 'links', remove: [], add: ['meta.md'], list: false } },
    ];
    const plan = emptyPlan({
      creations: [{ path: 'new.md', writes, bodyLinks: ['cat.md', 'extra.md'] }],
    });

    const result = applyPlan(snap, plan);

    const created = result.notes.get('new.md');
    expect(created).toStrictEqual({
      path: 'new.md',
      basename: 'new',
      tags: ['type/x'],
      frontmatterTags: ['type/x'],
      bodyTags: [],
      frontmatter: {
        tags: ['#type/x'],
        status: 'done',
        category: ['[[cat]]'],
        meta: '[[meta]]',
      },
      propertyLinks: { category: ['cat.md'], meta: ['meta.md'] },
      unresolvedLinks: {},
      links: ['cat.md', 'extra.md', 'meta.md'],
    });
  });

  it('appends the new path to results and adds it to notes', () => {
    const snap = snapshot([note('a.md')], { results: ['a.md'] });
    const plan = emptyPlan({
      creations: [{ path: 'b.md', writes: [], bodyLinks: [] }],
    });

    const result = applyPlan(snap, plan);

    expect(result.results).toStrictEqual(['a.md', 'b.md']);
    expect(result.notes.has('b.md')).toBe(true);
  });

  it('creates a note with no links when there are no link writes or bodyLinks', () => {
    const snap = snapshot([]);
    const plan = emptyPlan({
      creations: [
        {
          path: 'lone.md',
          writes: [{ key: 'status', value: { kind: 'literal', value: 'x' } }],
          bodyLinks: [],
        },
      ],
    });

    const result = applyPlan(snap, plan);

    expect(result.notes.get('lone.md')?.links).toStrictEqual([]);
    expect(result.notes.get('lone.md')?.tags).toStrictEqual([]);
  });
});

describe('applyPlan — changes', () => {
  it('a null write deletes the key from frontmatter and propertyLinks, and drops the link if unheld', () => {
    const snap = snapshot([
      note('x.md', {
        frontmatter: { meta: '[[m]]' },
        propertyLinks: { meta: ['m.md'] },
        links: ['m.md'],
      }),
    ]);
    const plan = emptyPlan({
      changes: [{ path: 'x.md', writes: [{ key: 'meta', value: null }] }],
    });

    const result = applyPlan(snap, plan);

    const changed = result.notes.get('x.md');
    expect(changed?.frontmatter).toStrictEqual({});
    expect(changed?.propertyLinks).toStrictEqual({});
    expect(changed?.links).toStrictEqual([]);
  });

  it("keeps a removed key's target in links when another key still holds it", () => {
    const snap = snapshot([
      note('x.md', {
        frontmatter: { meta: '[[shared]]', other: '[[shared]]' },
        propertyLinks: { meta: ['shared.md'], other: ['shared.md'] },
        links: ['shared.md'],
      }),
    ]);
    const plan = emptyPlan({
      changes: [{ path: 'x.md', writes: [{ key: 'meta', value: null }] }],
    });

    const result = applyPlan(snap, plan);

    const changed = result.notes.get('x.md');
    expect(changed?.propertyLinks).toStrictEqual({ other: ['shared.md'] });
    expect(changed?.links).toStrictEqual(['shared.md']);
  });

  it('a links write sets frontmatter and propertyLinks, and adds the new target to links', () => {
    const snap = snapshot([note('x.md', { frontmatter: {}, propertyLinks: {}, links: [] })]);
    const plan = emptyPlan({
      changes: [
        {
          path: 'x.md',
          writes: [
            { key: 'category', value: { kind: 'links', remove: [], add: ['cat.md'], list: true } },
          ],
        },
      ],
    });

    const result = applyPlan(snap, plan);

    const changed = result.notes.get('x.md');
    expect(changed?.frontmatter['category']).toStrictEqual(['[[cat]]']);
    expect(changed?.propertyLinks['category']).toStrictEqual(['cat.md']);
    expect(changed?.links).toStrictEqual(['cat.md']);
  });

  it('a literal write with key "tags" replaces both frontmatter.tags and the tags array', () => {
    const snap = snapshot([note('x.md', { tags: ['old'], frontmatter: { tags: ['old'] } })]);
    const plan = emptyPlan({
      changes: [
        {
          path: 'x.md',
          writes: [{ key: 'tags', value: { kind: 'literal', value: ['#new1', 'new2'] } }],
        },
      ],
    });

    const result = applyPlan(snap, plan);

    const changed = result.notes.get('x.md');
    expect(changed?.frontmatter['tags']).toStrictEqual(['#new1', 'new2']);
    expect(changed?.tags).toStrictEqual(['new1', 'new2']);
  });

  it('a literal write with a non-tags key only touches frontmatter', () => {
    const snap = snapshot([note('x.md', { tags: ['keep'] })]);
    const plan = emptyPlan({
      changes: [
        { path: 'x.md', writes: [{ key: 'status', value: { kind: 'literal', value: 'done' } }] },
      ],
    });

    const result = applyPlan(snap, plan);

    const changed = result.notes.get('x.md');
    expect(changed?.frontmatter['status']).toBe('done');
    expect(changed?.tags).toStrictEqual(['keep']);
  });

  it('skips a change targeting a note not in the snapshot', () => {
    const snap = snapshot([note('a.md')]);
    const plan = emptyPlan({
      changes: [
        { path: 'missing.md', writes: [{ key: 'status', value: { kind: 'literal', value: 'x' } }] },
      ],
    });

    const result = applyPlan(snap, plan);

    expect(result.notes.has('missing.md')).toBe(false);
    expect(result.notes.size).toBe(1);
  });

  it('replacing a links write with a different target removes the old one and keeps order (existing then new)', () => {
    const snap = snapshot([
      note('old.md'),
      note('x.md', {
        frontmatter: { meta: '[[old]]' },
        propertyLinks: { meta: ['old.md'] },
        links: ['before.md', 'old.md'],
      }),
    ]);
    const plan = emptyPlan({
      changes: [
        {
          path: 'x.md',
          writes: [
            {
              key: 'meta',
              value: { kind: 'links', remove: ['old.md'], add: ['new.md'], list: false },
            },
          ],
        },
      ],
    });

    const result = applyPlan(snap, plan);

    const changed = result.notes.get('x.md');
    expect(changed?.links).toStrictEqual(['before.md', 'new.md']);
    expect(changed?.propertyLinks['meta']).toStrictEqual(['new.md']);
  });

  it('replaces the old parent in place, preserving an unresolved link, plain text, and a link outside the base exactly as written (C1)', () => {
    const snap = snapshot([
      note('A.md'),
      note('Ext.md'),
      note('M2.md'),
      note('H.md', {
        frontmatter: { meta: ['[[A]]', '[[Not yet written]]', 'some text', '[[Ext]]'] },
        propertyLinks: { meta: ['A.md', 'Ext.md'] },
      }),
    ]);
    const plan = emptyPlan({
      changes: [
        {
          path: 'H.md',
          writes: [
            { key: 'meta', value: { kind: 'links', remove: ['A.md'], add: ['M2.md'], list: true } },
          ],
        },
      ],
    });

    const result = applyPlan(snap, plan);

    const changed = result.notes.get('H.md');
    expect(changed?.frontmatter['meta']).toStrictEqual([
      '[[M2]]',
      '[[Not yet written]]',
      'some text',
      '[[Ext]]',
    ]);
    expect(changed?.propertyLinks['meta']).toStrictEqual(['M2.md', 'Ext.md']);
  });

  it('turns an existing scalar into a list only once the result holds more than one target (M1)', () => {
    const snap = snapshot([
      note('a.md'),
      note('b.md'),
      note('x.md', { frontmatter: { meta: '[[a]]' }, propertyLinks: { meta: ['a.md'] } }),
    ]);
    const plan = emptyPlan({
      changes: [
        {
          path: 'x.md',
          writes: [
            { key: 'meta', value: { kind: 'links', remove: [], add: ['b.md'], list: false } },
          ],
        },
      ],
    });

    const result = applyPlan(snap, plan);

    const changed = result.notes.get('x.md');
    expect(changed?.frontmatter['meta']).toStrictEqual(['[[a]]', '[[b]]']);
    expect(changed?.propertyLinks['meta']).toStrictEqual(['a.md', 'b.md']);
  });

  it('applies a listItem write, keeping an unrelated element (retype recipe property patch)', () => {
    const snap = snapshot([note('n.md', { frontmatter: { type: ['project', 'archived'] } })]);
    const plan = emptyPlan({
      changes: [
        {
          path: 'n.md',
          writes: [{ key: 'type', value: { kind: 'listItem', remove: 'project', add: 'task' } }],
        },
      ],
    });

    const result = applyPlan(snap, plan);

    expect(result.notes.get('n.md')?.frontmatter['type']).toStrictEqual(['task', 'archived']);
  });

  it('after a listItem tags write, tags is frontmatterTags ∪ body tags (I4) and frontmatterTags never includes the body tag', () => {
    const snap = snapshot([
      note('n.md', {
        tags: ['type/alpha', 'inline-only'],
        frontmatterTags: ['type/alpha'],
        bodyTags: ['inline-only'],
        frontmatter: { tags: ['type/alpha'] },
      }),
    ]);
    const plan = emptyPlan({
      changes: [
        {
          path: 'n.md',
          writes: [
            { key: 'tags', value: { kind: 'listItem', remove: 'type/alpha', add: 'type/beta' } },
          ],
        },
      ],
    });

    const result = applyPlan(snap, plan);

    const changed = result.notes.get('n.md');
    expect(changed?.frontmatter['tags']).toStrictEqual(['type/beta']);
    expect(changed?.frontmatterTags).toStrictEqual(['type/beta']);
    expect(changed?.tags).toStrictEqual(['type/beta', 'inline-only']);
  });
});

describe('applyPlan — appends', () => {
  it('adds the target to links when missing', () => {
    const snap = snapshot([note('parent.md', { links: ['a.md'] })]);
    const plan = emptyPlan({ appends: [{ path: 'parent.md', target: 'b.md' }] });

    const result = applyPlan(snap, plan);

    expect(result.notes.get('parent.md')?.links).toStrictEqual(['a.md', 'b.md']);
  });

  it('does not duplicate a target already present', () => {
    const snap = snapshot([note('parent.md', { links: ['a.md', 'b.md'] })]);
    const plan = emptyPlan({ appends: [{ path: 'parent.md', target: 'b.md' }] });

    const result = applyPlan(snap, plan);

    expect(result.notes.get('parent.md')?.links).toStrictEqual(['a.md', 'b.md']);
  });

  it('does nothing when the target note is not in the snapshot', () => {
    const snap = snapshot([note('a.md')]);
    const plan = emptyPlan({ appends: [{ path: 'missing.md', target: 'x.md' }] });

    const result = applyPlan(snap, plan);

    expect(result.notes.has('missing.md')).toBe(false);
  });
});

describe('applyPlan — bodyLinkRemovals', () => {
  it('drops the target from links when nothing else holds it', () => {
    const snap = snapshot([note('parent.md', { links: ['a.md', 'b.md'] })]);
    const plan = emptyPlan({ bodyLinkRemovals: [{ path: 'parent.md', target: 'b.md' }] });

    const result = applyPlan(snap, plan);

    expect(result.notes.get('parent.md')?.links).toStrictEqual(['a.md']);
  });

  it('keeps the target in links when a property link still holds it', () => {
    const snap = snapshot([
      note('parent.md', { propertyLinks: { up: ['b.md'] }, links: ['a.md', 'b.md'] }),
    ]);
    const plan = emptyPlan({ bodyLinkRemovals: [{ path: 'parent.md', target: 'b.md' }] });

    const result = applyPlan(snap, plan);

    expect(result.notes.get('parent.md')?.links).toStrictEqual(['a.md', 'b.md']);
  });

  it('does nothing when the note is not in the snapshot', () => {
    const snap = snapshot([note('a.md')]);
    const plan = emptyPlan({ bodyLinkRemovals: [{ path: 'missing.md', target: 'x.md' }] });

    const result = applyPlan(snap, plan);

    expect(result.notes.has('missing.md')).toBe(false);
  });

  it('does nothing when the target was never in links', () => {
    const snap = snapshot([note('parent.md', { links: ['a.md'] })]);
    const plan = emptyPlan({ bodyLinkRemovals: [{ path: 'parent.md', target: 'b.md' }] });

    const result = applyPlan(snap, plan);

    expect(result.notes.get('parent.md')?.links).toStrictEqual(['a.md']);
  });
});

describe('applyPlan — moves', () => {
  it('rekeys the note, updates results/host, and rewrites references everywhere', () => {
    const snap = snapshot(
      [
        note('a.md', { links: ['b.md'] }),
        note('b.md', { propertyLinks: { up: ['a.md'] }, links: ['a.md'] }),
      ],
      { results: ['a.md', 'b.md'], host: 'a.md' },
    );
    const plan = emptyPlan({ moves: [{ from: 'a.md', to: 'c.md' }] });

    const result = applyPlan(snap, plan);

    expect(result.notes.has('a.md')).toBe(false);
    const moved = result.notes.get('c.md');
    expect(moved?.path).toBe('c.md');
    expect(moved?.basename).toBe('c');
    expect(moved?.links).toStrictEqual(['b.md']);

    const other = result.notes.get('b.md');
    expect(other?.propertyLinks['up']).toStrictEqual(['c.md']);
    expect(other?.links).toStrictEqual(['c.md']);

    expect(result.results).toStrictEqual(['c.md', 'b.md']);
    expect(result.host).toBe('c.md');
  });

  it('does nothing to the notes map when the "from" path is missing, but still rewrites results/host', () => {
    const snap = snapshot([note('b.md')], { results: ['a.md', 'b.md'], host: 'a.md' });
    const plan = emptyPlan({ moves: [{ from: 'a.md', to: 'c.md' }] });

    const result = applyPlan(snap, plan);

    expect(result.notes.has('a.md')).toBe(false);
    expect(result.notes.has('c.md')).toBe(false);
    expect(result.results).toStrictEqual(['c.md', 'b.md']);
    expect(result.host).toBe('c.md');
  });
});

describe('applyPlan — immutability', () => {
  it('never mutates the input snapshot', () => {
    const originalNote = note('x.md', {
      frontmatter: { meta: '[[m]]' },
      propertyLinks: { meta: ['m.md'] },
      links: ['m.md'],
    });
    const snap = snapshot([originalNote, note('m.md')], {
      results: ['x.md', 'm.md'],
      host: 'x.md',
    });
    const plan = emptyPlan({
      creations: [{ path: 'new.md', writes: [], bodyLinks: [] }],
      changes: [{ path: 'x.md', writes: [{ key: 'meta', value: null }] }],
      appends: [{ path: 'm.md', target: 'x.md' }],
      moves: [],
    });

    applyPlan(snap, plan);

    expect(snap.notes.get('x.md')).toBe(originalNote);
    expect(snap.notes.get('x.md')).toStrictEqual({
      path: 'x.md',
      basename: 'x',
      tags: [],
      frontmatterTags: [],
      bodyTags: [],
      frontmatter: { meta: '[[m]]' },
      propertyLinks: { meta: ['m.md'] },
      unresolvedLinks: {},
      links: ['m.md'],
    });
    expect(snap.notes.has('new.md')).toBe(false);
    expect(snap.results).toStrictEqual(['x.md', 'm.md']);
    expect(snap.host).toBe('x.md');
  });
});
