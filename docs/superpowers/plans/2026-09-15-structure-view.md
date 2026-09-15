# Structure View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Bases view type `structure` that renders a typed note hierarchy (graph and outline) from a single root and lets the user create, move and retype notes with undo.

**Architecture:** Pure-TypeScript core (`src/core`) turns a view config and a metadata snapshot into a `Structure`, and turns user actions into verified plans. Thin Obsidian adapters (`src/obsidian`) read snapshots from `metadataCache` and apply plans with undo. `src/view` hosts the `BasesView` and two renderers over the same model.

**Tech Stack:** TypeScript (strict), Obsidian API 1.13 (`BasesView`, `registerBasesView`, `metadataCache`, `fileManager`), vitest + jsdom + obsidian-test-mocks, esbuild. No runtime dependencies.

Spec: `docs/superpowers/specs/2026-09-15-structure-view-design.md`.

## Global Constraints

- Plugin id `bases-structure`, name `Bases Structure`, view type id `structure`, `minAppVersion` `1.10.3`, `isDesktopOnly: false`.
- Config lives only in the Bases view entry; UI state (collapsed, zoom, scroll) is in memory, never written to `.base`.
- `src/core` must not import `obsidian`.
- No new runtime dependencies; `main.js` stays under the 512 KB budget.
- ESLint budgets: complexity 10, cognitive 10, 80 lines per function, 4 params, 30 statements.
- Coverage per file: lines/statements/functions 90 %, branches 85 %.
- Every cleanup-requiring listener goes through `register*` or is removed in `onunload`/`destroy`.
- User-visible UI copy is in English (community plugin); sentence case.
- Commit after every task with Conventional Commits.

## File Map

| File                              | Responsibility                                     |
| --------------------------------- | -------------------------------------------------- |
| `src/core/schema.ts`              | parse/validate view config → `Schema` + issues     |
| `src/core/snapshot.ts`            | `NoteData`/`Snapshot` types, folder/tag helpers    |
| `src/core/typing.ts`              | match notes to types (specificity, conflicts)      |
| `src/core/candidates.ts`          | parent candidates per node from edge rules         |
| `src/core/structure.ts`           | primary parents, cycles, extras, alsoIn, orphans   |
| `src/core/planner.ts`             | action → desired links → `Plan`, verification      |
| `src/core/derive.ts`              | desired link values for a node (edge + inherit)    |
| `src/core/simulate.ts`            | apply `Plan` to a `Snapshot` copy                  |
| `src/core/layout.ts`              | left-to-right tidy tree layout, group frames       |
| `src/obsidian/snapshot-reader.ts` | `Snapshot` from Bases entries + `metadataCache`    |
| `src/obsidian/root-finder.ts`     | host note of an embedded view                      |
| `src/obsidian/plan-applier.ts`    | apply `Plan`, build undo transaction               |
| `src/obsidian/undo-manager.ts`    | undo stack + conflict-checked rollback             |
| `src/view/structure-view.ts`      | `BasesView` subclass: data → structure → renderer  |
| `src/view/node-element.ts`        | shared node DOM (link, hover preview, “+”, badges) |
| `src/view/graph-renderer.ts`      | graph DOM/SVG, zoom, pan, collapse                 |
| `src/view/edges.ts`               | SVG path geometry                                  |
| `src/view/outline-renderer.ts`    | outline list                                       |
| `src/view/actions-ui.ts`          | type menu, inline name input, move picker, notices |
| `src/view/drag.ts`                | pointer drag & drop with target validation         |
| `src/main.ts`                     | registration, undo command                         |
| `styles.css`                      | all styles under `.bases-structure-*`              |

## Core interfaces (shared by all tasks)

```ts
// schema.ts
export type EdgeKind = 'property' | 'links' | 'backlinks';
export interface EdgeRule {
  readonly kind: EdgeKind;
  readonly property: string;
}
export interface TypeMatch {
  readonly tags: readonly string[];
  readonly folder: string | null;
  readonly properties: readonly (readonly [string, string])[];
}
export interface TypeDef {
  readonly name: string;
  readonly level: number;
  readonly match: TypeMatch;
  readonly specificity: number;
  readonly children: ReadonlyMap<string, EdgeRule>;
}
export interface Schema {
  readonly types: readonly TypeDef[];
  readonly typeByName: ReadonlyMap<string, TypeDef>;
  readonly inherit: readonly string[];
  readonly layout: 'graph' | 'outline';
}
export interface SchemaIssue {
  readonly key: string;
  readonly message: string;
}
export function parseSchema(read: (key: string) => unknown): {
  schema: Schema;
  issues: SchemaIssue[];
};

// snapshot.ts
export interface NoteData {
  readonly path: string;
  readonly basename: string;
  readonly tags: readonly string[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly propertyLinks: Readonly<Record<string, readonly string[]>>;
  readonly links: readonly string[];
}
export interface Snapshot {
  readonly notes: ReadonlyMap<string, NoteData>;
  readonly results: readonly string[];
  readonly host: string | null;
}

// structure.ts
export interface ExtraLink {
  readonly parent: string;
  readonly kind: EdgeKind;
}
export interface StructureNode {
  readonly path: string;
  readonly type: string | null;
  readonly parent: string | null;
  readonly edge: EdgeRule | null;
  readonly children: readonly string[];
  readonly extras: readonly ExtraLink[];
  readonly alsoIn: readonly string[];
  readonly twoWay: boolean;
}
export interface StructureIssue {
  readonly path: string | null;
  readonly message: string;
}
export interface Structure {
  readonly root: string | null;
  readonly tops: readonly string[];
  readonly orphans: readonly string[];
  readonly nodes: ReadonlyMap<string, StructureNode>;
  readonly issues: readonly StructureIssue[];
}
export function buildStructure(schema: Schema, snapshot: Snapshot): Structure;

// planner.ts
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
  readonly creations: readonly {
    readonly path: string;
    readonly writes: readonly KeyWrite[];
    readonly bodyLinks: readonly string[];
  }[];
  readonly changes: readonly { readonly path: string; readonly writes: readonly KeyWrite[] }[];
  readonly appends: readonly { readonly path: string; readonly target: string }[];
  readonly moves: readonly { readonly from: string; readonly to: string }[];
}
export type PlanResult =
  | { readonly ok: true; readonly plan: Plan; readonly focus: string }
  | { readonly ok: false; readonly reason: string };
export interface PlanEnv {
  readonly defaultFolder: string;
}
export function planAction(
  schema: Schema,
  snapshot: Snapshot,
  action: Action,
  env: PlanEnv,
): PlanResult;
export function childOptions(
  schema: Schema,
  structure: Structure,
  parent: string,
): readonly { type: string; rule: EdgeRule }[];
export function moveTargets(
  schema: Schema,
  structure: Structure,
  node: string,
): ReadonlySet<string>;
export function retypeOptions(
  schema: Schema,
  structure: Structure,
  node: string,
): readonly string[];
```

---

### Task 1: Schema parsing

**Files:** Create `src/core/schema.ts`, `src/core/schema.test.ts`.

- [ ] Tests (fail first):
  - `parent: up` only → one implicit type `''` (level 0, no conditions) with `children: {'' → property up}`.
  - `note.up` normalises to `up`; `file.links` → kind `links`; `file.backlinks` → kind `backlinks`.
  - vault config from the spec → 4 types with levels 0–3; `Category.children` map has `Meta-note`, `Hierarchy` via `category`; `inherit` = `[category, meta, problem]`.
  - `children: [Module]` with `parent: up` → rule `property up`; without `parent` → issue `types.X.children: list form needs "parent"`.
  - unknown child type → issue and rule dropped; `tag` string or list; `folder` trims slashes; `property` scalar values stringified; specificity = tags + folder + properties.
  - neither `parent` nor `types` → issue `Set "parent" or "types"` and empty types.
  - `layout: outline` accepted; anything else → `graph`.
- [ ] Implement `parseSchema`; run `pnpm vitest run src/core/schema.test.ts`; commit `feat(core): parse structure view schema`.

### Task 2: Snapshot types and type matching

**Files:** Create `src/core/snapshot.ts`, `src/core/typing.ts`, tests.

**Interfaces:** Produces `folderOf(path)`, `hasTag(note, tag)`, `resolveType(schema, note): { type: TypeDef | null; conflict: readonly string[] }`, test helper `note(path, partial)` in `src/core/test-notes.ts` (test-only builder, excluded from coverage by being imported only in tests — keep it in `src/core/__tests__/notes.ts` and exclude `__tests__` from coverage).

- [ ] Tests: nested tag match (`system/high` matches `system/high/meta`, not `system/higher`), case-insensitive; folder match with subfolders; property equals and list-contains, link values compare by link text; empty type matches anything only when nothing else matches; more conditions win; equal specificity → first + conflict names.
- [ ] Implement; commit `feat(core): match notes to structure types`.

### Task 3: Parent candidates and structure

**Files:** Create `src/core/candidates.ts`, `src/core/structure.ts`, tests.

- [ ] Tests on hand-built snapshots:
  - untyped `up` chain → tree, children in results order.
  - vault: hierarchy with `category`, `meta`, `problem` → parent = problem, no extras (ancestors).
  - hierarchy with `meta: [A, B]` → parent A, extra B (property).
  - text: parent hierarchy body links child (`backlinks` rule) → nested; beats `category`.
  - mutual text links A↔B, A has 2 more text children → A parent, B `twoWay` true, no extra.
  - 3-cycle via text → broken at the node with most candidate children; cut link becomes extra.
  - host = category not in results, matches `Category` → `root`, metas under it; host untyped with no links → forest (`root` null, `tops` = parentless nodes).
  - meta with `category: [root, other]`, `other` typed Category outside results → `alsoIn: [other]`; its child hierarchy inheriting `[root, other]` has no `alsoIn`.
  - node with no candidates while root exists → `orphans`.
  - type conflict → issue with path.
- [ ] Implement; commit `feat(core): build structure tree from edge rules`.

### Task 4: Reference test against `view.js`

**Files:** Create `src/core/__tests__/knowledge-base.fixture.ts`, `src/core/reference.test.ts`.

- [ ] Fixture mirrors the `knowledge base` category (6 metas incl. aggregators, 1 problem, 9 hierarchies, ignored metas filtered out by results) plus `r-lang` nested hierarchies.
- [ ] Oracle: a port of `view.js` edge rules (meta → hierarchies without problem and not reachable from another hierarchy; meta → problems; problem → hierarchies; hierarchy → outlinked hierarchies; category-level roots) producing `parent → children` sets.
- [ ] Assert `buildStructure` parent map equals the oracle (root = category instead of synthetic roots).
- [ ] Commit `test(core): match view.js structure on knowledge base data`.

### Task 5: Planner — derivation, simulation, create

**Files:** Create `src/core/derive.ts`, `src/core/simulate.ts`, `src/core/planner.ts`, tests.

- [ ] Tests:
  - create Hierarchy under Problem → frontmatter `tags: [system/high/hierarchy]`, `problem: [P]`, `meta: [M]`, `category: [C]`; path `defaultFolder/Name.md` or type folder.
  - create under a `backlinks` rule → `appends: [{path: parent, target: new}]`; under `links` rule → `bodyLinks: [parent]`.
  - property type `property: {type: task}` writes literal `type: task`.
  - invalid name (`a/b`, `x[`) and existing path → `ok: false`.
  - list/scalar shape: key absent + other notes use scalar → scalar.
  - verification failure is reported (e.g. schema forbids type under parent).
  - `childOptions` lists types allowed under the parent’s type (root untyped → all top types with rules).
- [ ] Implement; commit `feat(core): plan note creation with inherited links`.

### Task 6: Planner — move and retype

- [ ] Tests:
  - move meta to another category → changes for meta (`category`) and all descendants (`category` only; `meta`/`problem` untouched).
  - move hierarchy from problem P to meta M2 → `problem` cleared, `meta: [M2]`, category from M2.
  - move keeps extra values: `meta: [A, B]` moving from A to C → `meta: [C, B]`.
  - move into own descendant / onto current parent → rejected; node whose parent edge is text-only stays under text parent → rejected with reason naming the parent.
  - retype Problem → Hierarchy with Hierarchy children linked by `problem` → rejected (children not expressible); retype Hierarchy (leaf under meta) → Problem: tags swapped, parent rule still valid.
  - retype with `folder` in types → `moves` entry.
  - `moveTargets` excludes descendants, self, current parent, types without a rule.
- [ ] Implement; commit `feat(core): plan moves and type changes with cascade`.

### Task 7: Layout

**Files:** Create `src/core/layout.ts`, tests.

- [ ] Tests: single node at origin; parent vertically centred on children; columns by depth use max width of that depth + gap; collapsed subtree hides descendants; forest stacks tops; group frames returned for depth-1 subtrees with children (bounding boxes with padding).
- [ ] Implement; commit `feat(core): tidy left-to-right tree layout`.

### Task 8: Obsidian adapters — snapshot, root, applier, undo

**Files:** Create `src/obsidian/snapshot-reader.ts`, `root-finder.ts`, `plan-applier.ts`, `undo-manager.ts`, tests with obsidian-test-mocks fakes.

**Failure-handling requirements:** applying a plan is user-triggered and touches several files: wrap in one boundary that shows `new Notice('Structure: <short reason>')` and logs `console.error('[bases-structure]', error)`; partial failure keeps the already-applied part in the undo transaction so the user can roll it back; undo conflicts produce a Notice listing skipped notes. No silent catch.

- [ ] Tests: snapshot resolves frontmatter links via `getFirstLinkpathDest`, tags from `getAllTags` without `#`, links from `resolvedLinks`, includes host and external property targets; applier writes `"[[linktext]]"` via `fileToLinktext`, preserves list/scalar, creates files with frontmatter, appends `\n- [[x]]`, moves via `renameFile`; undo reverts in reverse order and skips changed values.
- [ ] Commit `feat(obsidian): snapshot reader, plan applier and undo`.

**Risk checks:** vault writes — see Risk Scan.

### Task 9: Plugin registration and StructureView skeleton

**Files:** Modify `src/main.ts`, `manifest.json`, `package.json#name`, `versions.json`; delete `src/settings.ts`, `src/utils/merge-settings.ts` and their tests; create `src/view/structure-view.ts`, tests.

- [ ] Tests: plugin registers view `structure` with options `parent` (property), `layout` (dropdown); view renders issues banner for a bad config; `onDataUpdated` rebuilds and calls renderer `update(structure)`; state key stable across updates.
- [ ] Commit `feat: register structure bases view`.

### Task 10: Graph renderer

**Files:** Create `src/view/node-element.ts`, `src/view/edges.ts`, `src/view/graph-renderer.ts`, `styles.css`, tests.

- [ ] Tests (jsdom): nodes positioned from layout; SVG path per parent edge, dashed path per extra, `marker-start` when `twoWay`; `alsoIn` chip; collapse toggle hides subtree and survives `update`; zoom buttons change scale and survive `update`; click opens link via `workspace.openLinkText`; hover triggers `hover-link`.
- [ ] Manual: build, reload plugin in `dev-vault-structure`, screenshot `knowledge base`.
- [ ] Commit `feat(view): graph renderer`.

### Task 11: Create flow (“+”)

**Files:** Create `src/view/actions-ui.ts`; modify renderers and view.

- [ ] Tests: “+” with one type opens inline input directly, with several shows menu; Enter plans + applies + focuses new node; Esc cancels; rejected plan shows Notice with reason; notice has Undo button; Tab/Enter chaining.
- [ ] Manual: create meta → problem → hierarchy in dev vault, undo.
- [ ] Commit `feat(view): create typed notes from the graph`.

### Task 12: Move, retype, context menu

**Files:** Create `src/view/drag.ts`; modify `actions-ui.ts`, renderers.

- [ ] Tests: drag highlights `moveTargets`, invalid targets get `is-invalid`; drop plans move; “Move to…” suggest modal lists targets; “Change type” menu from `retypeOptions`; Cmd/Ctrl+Z triggers undo.
- [ ] Manual: move `obsidian` meta to another category, verify descendants’ `category`, undo.
- [ ] Commit `feat(view): move and retype notes with undo`.

### Task 13: Outline renderer

**Files:** Create `src/view/outline-renderer.ts`; modify view.

- [ ] Tests: nested list order, collapse, extras as “also under X” chips, “+” and drag reuse the same handlers.
- [ ] Commit `feat(view): outline layout`.

### Task 14: Demo vaults and visual verification

- [ ] In `dev-vault-structure`: `demos/projects` (folder + tag, inherit project), `demos/sources` (property type), `demos/course` (`parent: up`, folder + property), `demos/moc` (backlinks, mutual links, cycle), `demos/org` (matrix manager → dashed), each with its `.base` and host note.
- [ ] Screenshot each via `obsidian dev:screenshot`, fix visual issues, run `pnpm run verify`.
- [ ] Update README (config reference with examples).
- [ ] Commit `docs: document structure view config`.

## Risk Scan

- Vault writes across many notes (move cascade): Check — planner verification test rejects any plan that changes other nodes’ parents; applier test covers partial failure recorded in the undo transaction.
- Undo after external edits: Check — undo-manager test skips keys whose current value differs from the recorded “after”.
- Critical workflow not provable by unit tests (drag, embed root detection): Check — manual CLI verification in Task 10–12 and 14 with screenshots.
