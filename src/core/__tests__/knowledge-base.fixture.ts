// Real-vault-shaped fixture data for `reference.test.ts`: two scenarios (a full
// category/meta/problem/hierarchy tree, and a smaller category/hierarchy-only tree) built with
// the same paths, tags, and property/link shapes the user's actual vault uses. Test-only, lives
// under `__tests__/` (excluded from coverage).

import type { NoteData, Snapshot } from '../snapshot.js';
import { note, snapshot } from './notes.js';

/** The schema config for both scenarios, verbatim from the binding decisions doc — a plain
 * object shaped for `parseSchema`'s `read: (key) => unknown` reader. */
export const KNOWLEDGE_BASE_CONFIG = {
  inherit: ['category', 'meta', 'problem'],
  types: {
    Category: {
      tag: 'system/category',
      children: { 'Meta-note': 'category', Hierarchy: 'category' },
    },
    'Meta-note': { tag: 'system/high/meta', children: { Problem: 'meta', Hierarchy: 'meta' } },
    Problem: { tag: 'system/high/problem', children: { Hierarchy: 'problem' } },
    Hierarchy: { tag: 'system/high/hierarchy', children: { Hierarchy: 'file.backlinks' } },
  },
};

export const KB_CATEGORY = 'base/categories/knowledge base.md';

const INFO_PROCESSING = 'base/_meta-notes/information processing.md';
const LEARNING = 'base/_meta-notes/learning.md';
const NOTE_TAKING = 'base/_meta-notes/note taking.md';
const OBSIDIAN = 'base/_meta-notes/obsidian.md';
const PERIODIC_NOTES = 'base/_meta-notes/periodic notes.md';
const RESEARCH = 'base/_meta-notes/research.md';
const IGNORED_VAULT_STRUCTURE = 'base/_meta-notes/my vault structure in Obsidian.md';
const IGNORED_OVER_SYSTEMATIZATION = 'base/_meta-notes/over-systematization problem.md';

const INFO_ACQUISITION = 'base/_problems/information acquisition.md';

const DATAVIEW = 'base/_hierarchy/dataview.md';
const TEMPLATER = 'base/_hierarchy/templater.md';
const INFO_ARCHITECTURE = 'base/_hierarchy/information architecture.md';
const KNOWLEDGE_MODELS = 'base/_hierarchy/knowledge models.md';
const MENTAL_MODELS = 'base/_hierarchy/mental models and algorithms.md';
const PROBLEM_SOLVING = 'base/_hierarchy/problem solving.md';
const READING_STRATEGIES = 'base/_hierarchy/reading strategies.md';
const NOTE_TAKING_METHODS = 'base/_hierarchy/note-taking methods.md';
const STRUCTURE_OF_INFO = 'base/_hierarchy/structure of information within the note.md';

export const LINUX_CATEGORY = 'base/categories/linux.md';

const RLANG_CATEGORY = 'base/categories/r-lang.md';
const RLANG_HIERARCHY = 'base/_hierarchy/r-lang hierarchy.md';
const BASIC_VARIABLES = 'base/_hierarchy/basic variables types in r.md';
const DATA_PROCESSING = 'base/_hierarchy/data processing in r.md';
const SERVICE_COMMANDS = 'base/_hierarchy/service commands in r.md';

function wikilink(name: string): readonly string[] {
  return [`[[${name}]]`];
}

interface MetaOptions {
  readonly aggregator?: boolean;
  readonly ignored?: boolean;
  readonly extraLinks?: readonly string[];
}

function metaNote(path: string, options: MetaOptions = {}): NoteData {
  const tags = ['system/high/meta'];
  if (options.aggregator === true) {
    tags.push('mark/aggregator');
  }
  if (options.ignored === true) {
    tags.push('mark/ignore');
  }
  return note(path, {
    tags,
    frontmatter: { category: wikilink('knowledge base') },
    propertyLinks: { category: [KB_CATEGORY] },
    links: [KB_CATEGORY, ...(options.extraLinks ?? [])],
  });
}

interface HierarchyOptions {
  readonly metaName?: string;
  readonly problemName?: string;
  readonly extraTags?: readonly string[];
}

function kbHierarchyNote(path: string, options: HierarchyOptions = {}): NoteData {
  const tags = ['system/high/hierarchy', ...(options.extraTags ?? [])];
  const frontmatter: Record<string, unknown> = { category: wikilink('knowledge base') };
  const propertyLinks: Record<string, readonly string[]> = { category: [KB_CATEGORY] };
  if (options.metaName !== undefined) {
    frontmatter['meta'] = wikilink(options.metaName);
    propertyLinks['meta'] = [`base/_meta-notes/${options.metaName}.md`];
  }
  if (options.problemName !== undefined) {
    frontmatter['problem'] = wikilink(options.problemName);
    propertyLinks['problem'] = [`base/_problems/${options.problemName}.md`];
  }
  return note(path, { tags, frontmatter, propertyLinks, links: [KB_CATEGORY] });
}

export function knowledgeBaseSnapshot(): Snapshot {
  const notes = [
    note(KB_CATEGORY, { tags: ['category/knowledge_base', 'system/category'] }),

    metaNote(INFO_PROCESSING, {
      aggregator: true,
      extraLinks: [
        INFO_ACQUISITION,
        INFO_ARCHITECTURE,
        KNOWLEDGE_MODELS,
        MENTAL_MODELS,
        PROBLEM_SOLVING,
        READING_STRATEGIES,
      ],
    }),
    metaNote(LEARNING, { aggregator: true }),
    metaNote(NOTE_TAKING, {
      aggregator: true,
      extraLinks: [NOTE_TAKING_METHODS, STRUCTURE_OF_INFO],
    }),
    metaNote(OBSIDIAN, { aggregator: true, extraLinks: [DATAVIEW, TEMPLATER] }),
    metaNote(PERIODIC_NOTES),
    metaNote(RESEARCH, { aggregator: true }),
    metaNote(IGNORED_VAULT_STRUCTURE, { ignored: true }),
    metaNote(IGNORED_OVER_SYSTEMATIZATION, { ignored: true }),

    note(INFO_ACQUISITION, {
      tags: ['system/high/problem', 'mark/aggregator'],
      frontmatter: {
        category: wikilink('knowledge base'),
        meta: wikilink('information processing'),
      },
      propertyLinks: { category: [KB_CATEGORY], meta: [INFO_PROCESSING] },
      links: [KB_CATEGORY],
    }),

    kbHierarchyNote(DATAVIEW, { metaName: 'obsidian' }),
    kbHierarchyNote(TEMPLATER, { metaName: 'obsidian' }),
    kbHierarchyNote(INFO_ARCHITECTURE, { metaName: 'information processing' }),
    kbHierarchyNote(KNOWLEDGE_MODELS, { metaName: 'information processing' }),
    kbHierarchyNote(MENTAL_MODELS, { metaName: 'information processing' }),
    kbHierarchyNote(PROBLEM_SOLVING, {
      metaName: 'information processing',
      extraTags: ['mark/discourse'],
    }),
    kbHierarchyNote(READING_STRATEGIES, {
      metaName: 'information processing',
      problemName: 'information acquisition',
    }),
    kbHierarchyNote(NOTE_TAKING_METHODS, { metaName: 'note taking' }),
    kbHierarchyNote(STRUCTURE_OF_INFO, { metaName: 'note taking' }),
  ];

  return snapshot(notes, {
    host: KB_CATEGORY,
    results: [
      INFO_PROCESSING,
      LEARNING,
      NOTE_TAKING,
      OBSIDIAN,
      RESEARCH,
      PERIODIC_NOTES,
      INFO_ACQUISITION,
      DATAVIEW,
      INFO_ARCHITECTURE,
      KNOWLEDGE_MODELS,
      MENTAL_MODELS,
      NOTE_TAKING_METHODS,
      PROBLEM_SOLVING,
      READING_STRATEGIES,
      STRUCTURE_OF_INFO,
      TEMPLATER,
    ],
  });
}

/** `knowledgeBaseSnapshot()` plus a second, unrelated root-level Category note ("linux") — used by
 * the move planner's tests to exercise moving a node from one category to another. */
export function knowledgeBaseWithLinuxSnapshot(): Snapshot {
  const base = knowledgeBaseSnapshot();
  const notes = new Map(base.notes);
  notes.set(LINUX_CATEGORY, note(LINUX_CATEGORY, { tags: ['category/linux', 'system/category'] }));
  return {
    notes,
    results: [...base.results, LINUX_CATEGORY],
    host: base.host,
  };
}

export function rLangSnapshot(): Snapshot {
  const notes = [
    note(RLANG_CATEGORY, { tags: ['category/r-lang', 'system/category'] }),
    note(RLANG_HIERARCHY, {
      tags: ['system/high/hierarchy', 'mark/aggregator'],
      frontmatter: { category: wikilink('r-lang') },
      propertyLinks: { category: [RLANG_CATEGORY] },
      links: [RLANG_CATEGORY, BASIC_VARIABLES, DATA_PROCESSING, SERVICE_COMMANDS],
    }),
    note(BASIC_VARIABLES, {
      tags: ['system/high/hierarchy', 'category/r-lang'],
      frontmatter: { category: wikilink('r-lang') },
      propertyLinks: { category: [RLANG_CATEGORY] },
      links: [RLANG_CATEGORY],
    }),
    note(DATA_PROCESSING, {
      tags: ['system/high/hierarchy'],
      frontmatter: { category: wikilink('r-lang') },
      propertyLinks: { category: [RLANG_CATEGORY] },
      links: [RLANG_CATEGORY],
    }),
    note(SERVICE_COMMANDS, {
      tags: ['system/high/hierarchy'],
      frontmatter: { category: wikilink('r-lang') },
      propertyLinks: { category: [RLANG_CATEGORY] },
      links: [RLANG_CATEGORY],
    }),
  ];

  return snapshot(notes, {
    host: RLANG_CATEGORY,
    results: [RLANG_HIERARCHY, BASIC_VARIABLES, DATA_PROCESSING, SERVICE_COMMANDS],
  });
}
