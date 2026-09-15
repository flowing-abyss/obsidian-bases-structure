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
  | { readonly kind: 'links'; readonly targets: readonly string[]; readonly list: boolean }
  | { readonly kind: 'literal'; readonly value: unknown };

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
