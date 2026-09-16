// Shared shapes for the planner: what a user-facing `Action` can be, the write/plan/result shapes
// produced by planning an action, and the environment hooks the planner needs to check for path
// collisions. No Obsidian imports.

export type Action =
  | {
      readonly kind: 'create';
      readonly parent: string;
      readonly type: string;
      readonly name: string;
    }
  | { readonly kind: 'move'; readonly node: string; readonly parent: string }
  | { readonly kind: 'retype'; readonly node: string; readonly type: string };

export type WriteValue =
  // A link property patch: `remove`/`add` are resolved target *paths*, applied against whatever
  // the note's raw frontmatter value for `key` already looks like — unresolved links, plain text,
  // aliases/headings, and links outside the base are preserved untouched; only elements resolving
  // to a `remove` path are dropped, and `add` targets not already present are inserted at the
  // removed element's position (or appended). `list` only decides the shape for a *brand-new* key
  // (create, or a key the note never had); an existing scalar/list keeps its own shape unless the
  // result grows past one element (see `patchLinksValue` in `link-patch.ts`).
  | {
      readonly kind: 'links';
      readonly remove: readonly string[];
      readonly add: readonly string[];
      readonly list: boolean;
    }
  | { readonly kind: 'literal'; readonly value: unknown }
  // A single-element patch on a plain (non-link) list-shaped property — retype's recipe-property
  // and frontmatter-tag writes, so an unrelated element already in the list (e.g. `archived` in
  // `type: [project, archived]`) survives a retype instead of being clobbered by a literal
  // whole-value set. A scalar current value keeps today's literal set/delete behaviour instead
  // (see `plan-retype.ts`); this kind only appears when the current value is already an array.
  | { readonly kind: 'listItem'; readonly remove?: string; readonly add?: string };

export interface KeyWrite {
  readonly key: string;
  readonly value: WriteValue | null;
}

export interface Plan {
  readonly creations: ReadonlyArray<{
    readonly path: string;
    readonly writes: readonly KeyWrite[];
    readonly bodyLinks: readonly string[];
  }>;
  readonly changes: ReadonlyArray<{ readonly path: string; readonly writes: readonly KeyWrite[] }>;
  readonly appends: ReadonlyArray<{ readonly path: string; readonly target: string }>;
  readonly moves: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: Plan; readonly focus: string }
  | { readonly ok: false; readonly reason: string };

export interface PlanEnv {
  readonly defaultFolder: string; // '' = vault root
  readonly exists: (path: string) => boolean; // any file in the vault at this path
}
