# Structure View v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the structure view show schema violations, move and convert whole branches (including text-link hierarchies), and update without flicker.

**Architecture:** The pure core keeps owning every decision — a new `diagnostics.ts` computes problems from `(schema, snapshot, structure)`, a new `plan-convert.ts` composes retype + move, and a new `body-link.ts` computes body-text edits as pure string surgery. The Obsidian layer only applies what the core decided (`plan-applier.ts`, `undo-manager.ts`). The view layer stops rebuilding: both renderers reconcile node elements by path, and the view renders the plan's simulated snapshot optimistically before Bases re-queries.

**Tech Stack:** TypeScript, esbuild, vitest + jsdom + obsidian-test-mocks, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-18-structure-view-v2-design.md`

## Global Constraints

- pnpm only. `pnpm run verify` is the gate (format, lint, stylelint, typecheck, depcruise, knip, tests, coverage 90/90/90/85 per file, build, release-check). `pnpm run verify:task` mid-task.
- ESLint budgets: complexity 10, cognitive complexity 10, 80 lines per function, 4 parameters, 30 statements. Split helpers instead of growing functions.
- `src/core/**` must not import from `obsidian`. `src/view/**` may import Obsidian types but must stay testable in jsdom.
- Conventional Commits; husky + lint-staged run on commit. Never push.
- No network calls, no new dependencies, no new `.base` schema keys, no new view options.
- Comments: short, describing the guarantee, not the history. Match the surrounding file.
- Dev vault: `dev-vault-structure/` (gitignored). Never modify anything under `dev-vault-structure/base/`; use `dev-vault-structure/demos/` for scratch data. Restore `dev-vault-structure/structure.base` from `/tmp/structure.base.orig3` if you change it, and never overwrite that file.
- User-facing copy is English, sentence case, no trailing period in menu items.

---

## File Structure

- Create `src/core/diagnostics.ts` — pure problem detection (Task 4).
- Create `src/core/body-link.ts` — pure body-text link removal/formatting (Task 7).
- Create `src/core/plan-convert.ts` — move + retype in one plan (Task 9).
- Create `src/core/plan-fix-inherit.ts` — inheritance repair plan (Task 6).
- Modify `src/view/node-element.ts` — add in-place `updateNodeElement` (Task 1), diagnostic markers (Task 5), context menu hook (Task 11).
- Modify `src/view/graph-renderer.ts` / `src/view/outline-renderer.ts` — reconcile instead of rebuild (Task 1), diagnostic edges (Task 5), re-measure after Supercharged Links (Task 2), scroll anchoring (Task 3).
- Modify `src/core/plan-types.ts`, `src/core/simulate.ts`, `src/obsidian/plan-applier.ts`, `src/obsidian/undo-manager.ts` — body-link removals (Task 7).
- Modify `src/core/plan-move.ts`, `src/core/planner.ts` — text edges and the shared target function (Tasks 8, 9).
- Modify `src/view/drag.ts`, `src/view/structure-view.ts`, `src/view/actions-ui.ts` — convert gesture, optimistic render, menus (Tasks 3, 6, 10, 11).

---

### Task 1: Reconcile node elements instead of rebuilding them

**Files:**

- Modify: `src/view/node-element.ts`
- Modify: `src/view/graph-renderer.ts`
- Modify: `src/view/outline-renderer.ts`
- Test: `src/view/node-element.test.ts`, `src/view/graph-renderer.test.ts`, `src/view/outline-renderer.test.ts`

**Interfaces:**

- Consumes: existing `createNodeElement(ctx, node, flags)`.
- Produces: `export function updateNodeElement(el: HTMLElement, ctx: NodeElementContext, node: StructureNode, flags: NodeElementFlags): void` — refreshes an existing element in place, keeping the same `<a class="bases-structure-title">` element instance (so Supercharged Links state survives). Both renderers keep `private readonly elementsByPath = new Map<string, HTMLElement>()` and expose the same `getNodeElement(path)` as today.

- [ ] **Step 1: Write the failing test for in-place update**

```ts
it('keeps the same title element when the node is updated', () => {
  const ctx = makeCtx(snapshotWith({ 'a.md': { basename: 'A' } }));
  const el = createNodeElement(ctx, nodeFor('a.md'), {});
  const title = el.querySelector('a.bases-structure-title');
  title?.setAttribute('data-link-type', 'source');

  updateNodeElement(el, ctx, { ...nodeFor('a.md'), type: 'Task' }, { isOrphan: true });

  expect(el.querySelector('a.bases-structure-title')).toBe(title);
  expect(title?.getAttribute('data-link-type')).toBe('source');
  expect(el.dataset.type).toBe('Task');
  expect(el.classList.contains('is-orphan')).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/view/node-element.test.ts`
Expected: FAIL — `updateNodeElement` is not exported.

- [ ] **Step 3: Implement `updateNodeElement`**

Extract the parts of `createNodeElement` that depend on node data into small helpers and call them from both functions. It must refresh: `data-path`, `data-type`, `is-root`/`is-orphan`/`is-new` classes, the title's text and `href`, the toggle (present only when the node has children, with the right collapsed state and the outline spacer rule from `f087338`), the "also lives here" chip, and the two-way icon. It must not touch `data-link-*` attributes or the title element identity.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run src/view/node-element.test.ts`

- [ ] **Step 5: Write the failing renderer tests**

```ts
it('reuses node elements across updates', () => {
  const renderer = new GraphRenderer(container, ctx);
  renderer.update(inputWith(['a.md', 'b.md']));
  const first = renderer.getNodeElement('a.md');

  renderer.update(inputWith(['a.md', 'b.md', 'c.md']));

  expect(renderer.getNodeElement('a.md')).toBe(first);
  expect(renderer.getNodeElement('c.md')).not.toBeNull();
});

it('drops elements for nodes that are gone', () => {
  const renderer = new GraphRenderer(container, ctx);
  renderer.update(inputWith(['a.md', 'b.md']));
  renderer.update(inputWith(['a.md']));
  expect(renderer.getNodeElement('b.md')).toBeNull();
  expect(container.querySelectorAll('.bases-structure-node')).toHaveLength(1);
});
```

Write the same pair for `OutlineRenderer`, plus one asserting nesting order still follows `structure` after a reconcile that moves a node to a different parent.

- [ ] **Step 6: Run them and watch them fail**

Run: `pnpm vitest run src/view/graph-renderer.test.ts src/view/outline-renderer.test.ts`

- [ ] **Step 7: Implement reconciliation in both renderers**

Graph: keep `elementsByPath`; per render, for each visible entry reuse-or-create, then remove elements whose path is gone, then position as today. Outline: rebuild the `ul`/`li` skeleton but move existing node elements into it (`li.append(existingEl)`), creating only new ones. Keep `collectTitleElements`/`previousTitle` carry-over for genuinely new elements only.

- [ ] **Step 8: Run the full view suite**

Run: `pnpm vitest run src/view`
Expected: PASS, including the existing draft, keyboard, drag and Supercharged Links tests.

- [ ] **Step 9: Commit**

```bash
git add src/view
git commit -m "perf(view): reconcile node elements instead of rebuilding them"
```

---

### Task 2: Re-measure after Supercharged Links changes a node

**Files:**

- Modify: `src/view/graph-renderer.ts`
- Test: `src/view/graph-renderer.test.ts`

**Interfaces:**

- Consumes: Task 1's `elementsByPath`, the existing private `measure`/layout pipeline.
- Produces: no new exports; the renderer re-runs layout when a `data-link-*` attribute changes under its nodes layer.

- [ ] **Step 1: Write the failing test**

```ts
it('re-lays out when Supercharged Links adds an attribute later', async () => {
  const renderer = new GraphRenderer(container, ctx);
  renderer.update(inputWith(['a.md', 'b.md']));
  const before = renderer.getNodeElement('b.md')?.style.top;
  widenMeasure('a.md'); // the stubbed measure now reports a taller node

  renderer.getNodeElement('a.md')?.querySelector('a')?.setAttribute('data-link-tags', 'x');
  await flushFrames();

  expect(renderer.getNodeElement('b.md')?.style.top).not.toBe(before);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/view/graph-renderer.test.ts -t "Supercharged"`

- [ ] **Step 3: Implement the observer**

In the constructor, create a `MutationObserver` on the nodes layer with `{ attributes: true, subtree: true }`. In the callback, ignore mutations whose `attributeName` does not start with `data-link-`, and ignore everything while the renderer is itself positioning (a `private positioning = false` guard). Otherwise schedule one re-layout per frame with `requestAnimationFrame` (store the handle; cancel it in `destroy()`), and on that frame re-measure and re-position from the last layout input without rebuilding any element. Disconnect the observer in `destroy()`.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run src/view/graph-renderer.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/view/graph-renderer.ts src/view/graph-renderer.test.ts
git commit -m "fix(view): re-lay out after Supercharged Links decorates a node"
```

---

### Task 3: Optimistic rendering and scroll anchoring

**Files:**

- Modify: `src/view/structure-view.ts`, `src/view/actions-ui.ts`, `src/view/graph-renderer.ts`
- Test: `src/view/structure-view.test.ts`, `src/view/actions-ui.test.ts`, `src/view/graph-renderer.test.ts`

**Interfaces:**

- Consumes: `applyPlan(snapshot, plan)` from `src/core/simulate.ts`.
- Produces: `StructureActions` calls a new dep `ActionsDeps.showOptimistic(snapshot: Snapshot): void` right after a plan verifies and before the writes land; `StructureView` renders from that snapshot until the next `onDataUpdated`.

- [ ] **Step 1: Write the failing test**

```ts
it('shows the planned result before the vault reports it', async () => {
  const view = makeView(inputWith(['parent.md']));
  await view.actions.startCreate('parent.md', anchorEl, { name: 'Child', type: 'Task' });

  expect(view.renderer.getNodeElement('Tasks/Child.md')).not.toBeNull();
  expect(view.renderCount).toBe(2); // one render for the optimistic state, none wasted
});

it('replaces the optimistic state with real data', () => {
  view.showOptimistic(simulated);
  view.onDataUpdated();
  expect(view.lastInput?.snapshot).toBe(view.realSnapshot);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run src/view/structure-view.test.ts -t "optimistic"`

- [ ] **Step 3: Implement**

`StructureView` gains `private optimistic: Snapshot | null`. `render()` builds the structure from `optimistic ?? realSnapshot`. `onDataUpdated()` clears `optimistic` first. `StructureActions` calls `deps.showOptimistic(applyPlan(snapshot, plan))` after `planAction` succeeds, and calls it again with the original snapshot if the commit throws (plus the existing error notice).

- [ ] **Step 4: Write the failing scroll-anchor test**

```ts
it('keeps the active node still when the layout shifts', () => {
  const renderer = new GraphRenderer(container, ctx);
  renderer.update(inputWith(['a.md', 'b.md'], { active: 'b.md' }));
  const before = renderer.getNodeElement('b.md')?.getBoundingClientRect().top;

  renderer.update(inputWith(['a.md', 'a2.md', 'b.md'], { active: 'b.md' }));

  expect(renderer.getNodeElement('b.md')?.getBoundingClientRect().top).toBe(before);
});
```

- [ ] **Step 5: Implement scroll anchoring**

Before positioning, record the active node's current layout offset; after positioning, add the delta to `scrollLeft`/`scrollTop` (and to `state.scrollLeft`/`state.scrollTop`). Skip when there is no active node or it was not rendered before.

- [ ] **Step 6: Run the view suite**

Run: `pnpm vitest run src/view`

- [ ] **Step 7: Commit**

```bash
git add src/view
git commit -m "feat(view): render planned results optimistically and keep scroll anchored"
```

---

### Task 4: Diagnostics core

**Files:**

- Create: `src/core/diagnostics.ts`
- Modify: `src/obsidian/snapshot-reader.ts`, `src/core/snapshot.ts`
- Test: `src/core/diagnostics.test.ts`, `src/obsidian/snapshot-reader.test.ts`

**Interfaces:**

- Consumes: `Schema`, `Snapshot`, `Structure`, `ruleBetween`, `edgeProperties`, `inheritedTargets`, `unionInheritedTargets`, `propertyParentsOf`.
- Produces:

```ts
export type DiagnosticKind = 'illegal-parent' | 'broken-link' | 'untyped' | 'inherit-mismatch';

export interface Diagnostic {
  readonly kind: DiagnosticKind;
  readonly node: string;
  readonly target?: string;
  readonly property?: string;
  readonly keys?: readonly string[];
  readonly message: string;
}

export function collectDiagnostics(
  schema: Schema,
  snapshot: Snapshot,
  structure: Structure,
): readonly Diagnostic[];
```

`NoteData` gains `readonly unresolvedLinks: Readonly<Record<string, readonly string[]>>` — per frontmatter key, the raw link texts that resolve to no file.

- [ ] **Step 1: Write the failing snapshot-reader test**

```ts
it('records link values that resolve to nothing', () => {
  const app = mockApp({ 'a.md': { frontmatter: { category: ['[[missing]]'] } } });
  const note = readNote(app, fileFor('a.md'));
  expect(note.unresolvedLinks).toEqual({ category: ['missing'] });
  expect(note.propertyLinks).toEqual({});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/obsidian/snapshot-reader.test.ts`

- [ ] **Step 3: Implement it**

In the same loop that resolves `frontmatterLinks` through `getFirstLinkpathDest`, push the link text into `unresolvedLinks[key]` when the destination is `null`. Default to `{}` in every other `NoteData` construction site (tests included).

- [ ] **Step 4: Write the failing diagnostics tests**

One test per kind, each asserting kind, node, property/target and that nothing else is reported:

```ts
it('flags a parent link the schema does not allow', () => {
  // Hierarchy note with `category: [[a problem]]`, where Category → Hierarchy is allowed
  // but Problem is not a legal target for `category`.
  const diagnostics = collectDiagnostics(schema, snapshot, structure);
  expect(diagnostics).toEqual([
    {
      kind: 'illegal-parent',
      node: 'h.md',
      target: 'p.md',
      property: 'category',
      message: '"Problem" cannot be the category of "Hierarchy"',
    },
  ]);
});

it('flags a link that resolves to nothing', () => {
  /* expects kind 'broken-link', target 'missing' */
});
it('flags a note that matches no type', () => {
  /* expects kind 'untyped' */
});
it('flags inherited values that disagree with the parent', () => {
  // child under a parent whose `category` is [[c1]], child's own `category` is [[c2]]
  expect(diagnostics[0]).toMatchObject({ kind: 'inherit-mismatch', keys: ['category'] });
});
it('reports nothing for a consistent tree', () => {
  expect(collectDiagnostics(schema, snapshot, structure)).toEqual([]);
});
it('does not flag a key neither parent nor child has', () => {
  /* empty */
});
it('does not flag the root for inheritance', () => {
  /* empty */
});
```

- [ ] **Step 5: Run them and watch them fail**

Run: `pnpm vitest run src/core/diagnostics.test.ts`

- [ ] **Step 6: Implement `collectDiagnostics`**

Walk `structure.nodes`. For every key in `schema.inherit` and every property that appears as an edge rule, compare the note's resolved targets against what the schema allows (`ruleBetween(schema, targetType, nodeType)` must exist and use that property) — anything else is `illegal-parent`. Every entry in `unresolvedLinks` for such a key is `broken-link`. A node with `type === null` and no catch-all type is `untyped`. For `inherit-mismatch`, compute the expected targets with `unionInheritedTargets` over `propertyParentsOf(node)` and compare as sets against the node's current targets; report one diagnostic per node listing the differing keys. Messages are complete English sentences naming the notes by `displayName`.

- [ ] **Step 7: Run them and watch them pass, then check coverage**

Run: `pnpm vitest run src/core/diagnostics.test.ts --coverage`

- [ ] **Step 8: Commit**

```bash
git add src/core/diagnostics.ts src/core/diagnostics.test.ts src/core/snapshot.ts src/obsidian/snapshot-reader.ts src/obsidian/snapshot-reader.test.ts
git commit -m "feat(core): detect links the schema does not allow"
```

---

### Task 5: Draw diagnostics

**Files:**

- Modify: `src/view/structure-view.ts` (compute once per render), `src/view/node-element.ts`, `src/view/edges.ts`, `src/view/graph-renderer.ts`, `src/view/outline-renderer.ts`, `styles.css`
- Test: `src/view/graph-renderer.test.ts`, `src/view/outline-renderer.test.ts`, `src/view/node-element.test.ts`

**Interfaces:**

- Consumes: `collectDiagnostics` (Task 4), `updateNodeElement` (Task 1).
- Produces: `RenderInput` gains `readonly diagnostics: readonly Diagnostic[]`; `NodeElementFlags` gains `readonly diagnostics?: readonly Diagnostic[]`.

- [ ] **Step 1: Write the failing tests**

```ts
it('draws an error edge for an illegal parent', () => {
  renderer.update(inputWith(['h.md', 'p.md'], { diagnostics: [illegalParent] }));
  const edge = container.querySelector('.bases-structure-edge.is-error');
  expect(edge).not.toBeNull();
  expect(container.querySelector('.bases-structure-edge-problem')).not.toBeNull();
});

it('marks a broken link without a second node', () => {
  renderer.update(inputWith(['h.md'], { diagnostics: [brokenLink] }));
  expect(container.querySelectorAll('.bases-structure-edge.is-error')).toHaveLength(1);
});

it('marks an inheritance mismatch on the node and its parent edge', () => {
  renderer.update(inputWith(['p.md', 'c.md'], { diagnostics: [inheritMismatch] }));
  expect(renderer.getNodeElement('c.md')?.querySelector('.bases-structure-problem')).not.toBeNull();
  expect(container.querySelector('.bases-structure-edge.is-warning')).not.toBeNull();
});

it('shows the message in the marker title', () => {
  /* title === diagnostic.message */
});
```

Add the outline equivalents: a row with a diagnostic gets `.bases-structure-problem` with the same `title`, and a clean row does not.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run src/view/graph-renderer.test.ts src/view/outline-renderer.test.ts -t "diagnostic"`

- [ ] **Step 3: Implement**

`StructureView` computes diagnostics right after `buildStructure` and passes them in `RenderInput`. `edges.ts` gains an `is-error`/`is-warning` variant plus a mid-edge ✕ marker element (`.bases-structure-edge-problem`); a diagnostic whose target is not a rendered node draws a short stub edge from the node with the same marker. `node-element.ts` renders a `.bases-structure-problem` icon (`alert-circle`) before the title when the node has any diagnostic, with the joined messages as its `title`.

- [ ] **Step 4: Style it**

In `styles.css`, scope new rules under `.bases-structure`: `.is-error { stroke: var(--text-error); stroke-dasharray: 4 3; }`, `.is-warning { stroke: var(--text-warning); stroke-dasharray: 1 4; }`, marker colours from the same variables, icon size via the existing `--bases-structure-icon-size`. No new colour literals.

- [ ] **Step 5: Run the view suite and stylelint**

Run: `pnpm vitest run src/view && pnpm run lint:css`

- [ ] **Step 6: Commit**

```bash
git add src/view styles.css
git commit -m "feat(view): mark links that break the schema"
```

---

### Task 6: "Fix inheritance" action

**Files:**

- Create: `src/core/plan-fix-inherit.ts`
- Modify: `src/core/plan-types.ts`, `src/core/planner.ts`, `src/view/actions-ui.ts`
- Test: `src/core/plan-fix-inherit.test.ts`, `src/view/actions-ui.test.ts`

**Interfaces:**

- Consumes: `deriveSubtreeWrites`, `bareContext`, `unionInheritedTargets`, `applyPlan`, `collectDiagnostics`.
- Produces: `Action` gains `| { readonly kind: 'fix-inherit'; readonly node: string }`; `planFixInherit(schema, snapshot, action): PlanResult`; `StructureActions.fixInherit(path: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
it('rewrites the node and its descendants to match the parent', () => {
  const result = planFixInherit(schema, snapshot, { kind: 'fix-inherit', node: 'c.md' });
  expect(result.ok).toBe(true);
  expect(collectDiagnostics(schema, applyPlan(snapshot, result.plan), rebuild()).length).toBe(0);
});

it('rejects a node with nothing to fix', () => {
  expect(planFixInherit(schema, snapshot, { kind: 'fix-inherit', node: 'ok.md' })).toEqual({
    ok: false,
    reason: '"OK" already matches its parent',
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run src/core/plan-fix-inherit.test.ts`

- [ ] **Step 3: Implement**

Build a `SubtreeContext` with no type overrides, compute the node's own inherit writes from `unionInheritedTargets` over its property parents, then `deriveSubtreeWrites` for the descendants. Verify by simulating and re-running `collectDiagnostics`: no `inherit-mismatch` may remain for the node or its subtree; anything else is a rejection with a stable reason.

- [ ] **Step 4: Wire the action**

`planAction` dispatches the new kind. `StructureActions.fixInherit` mirrors `startMove`: plan, notice on rejection, `showOptimistic`, commit, undo transaction.

- [ ] **Step 5: Run the core and view suites**

Run: `pnpm vitest run src/core src/view`

- [ ] **Step 6: Commit**

```bash
git add src/core src/view
git commit -m "feat(core): repair inherited properties from the graph"
```

---

### Task 7: Body-link removals

**Files:**

- Create: `src/core/body-link.ts`
- Modify: `src/core/plan-types.ts`, `src/core/simulate.ts`, `src/obsidian/plan-applier.ts`, `src/obsidian/undo-manager.ts`
- Test: `src/core/body-link.test.ts`, `src/core/simulate.test.ts`, `src/obsidian/plan-applier.test.ts`, `src/obsidian/undo-manager.test.ts`

**Interfaces:**

- Produces:

```ts
export interface BodyLinkRemoval {
  readonly text: string; // the document text after the removal
  readonly removed: string; // exactly what was cut out, for undo
  readonly index: number; // where it was cut from
}

/** Removes the first non-embed wikilink whose target matches one of `linktexts`.
 * Returns null when there is none (an embed-only mention counts as none). */
export function removeBodyLink(text: string, linktexts: readonly string[]): BodyLinkRemoval | null;
```

`Plan` gains `readonly bodyLinkRemovals: ReadonlyArray<{ readonly path: string; readonly target: string }>`; every existing plan construction site sets `[]`. `TransactionStep` gains `{ kind: 'bodyEdit'; path: string; removed: string; index: number }`.

- [ ] **Step 1: Write the failing pure tests**

```ts
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run src/core/body-link.test.ts`

- [ ] **Step 3: Implement `removeBodyLink`**

Scan for `[[...]]` tokens, skipping any preceded by `!`. Compare the token's target (before `|` or `#`), trimmed and compared case-insensitively, against each entry of `linktexts` and against its basename. On a match, cut the token; then, if the token's line now matches `/^\s*([-*+]|\d+\.)?\s*$/`, cut the whole line including its newline; otherwise collapse the double space the cut may leave. Return the exact removed slice and its index.

- [ ] **Step 4: Teach the simulation about body links**

In `simulate.ts`, `applyPlan` must add `append.target` to the appended note's `links` and remove `bodyLinkRemovals` targets from theirs, so verification sees the text edge appear and disappear. Test: a simulated snapshot after an append has the target in `links`.

- [ ] **Step 5: Apply and undo the removal**

`plan-applier.ts` gains `applyBodyLinkRemoval`: resolve the link texts for the target (`fileToLinktext` plus the bare basename), `vault.process` the file through `removeBodyLink`, throw a rejection-style error when it returns `null`, and push a `bodyEdit` step. `undo-manager.ts` reverts it by re-inserting `removed` at `index` when the text at that position still matches its neighbours, otherwise appending it at the end and reporting the note as partially restored (the existing skipped-notes notice format).

- [ ] **Step 6: Run the obsidian and core suites**

Run: `pnpm vitest run src/core src/obsidian`

- [ ] **Step 7: Commit**

```bash
git add src/core src/obsidian
git commit -m "feat(core): remove a body mention as part of a plan"
```

---

### Task 8: Move over text links

**Files:**

- Modify: `src/core/plan-move.ts`, `src/core/plan-shared.ts`
- Test: `src/core/plan-move.test.ts`

**Interfaces:**

- Consumes: Task 7's `bodyLinkRemovals` and the existing `Plan.appends`.
- Produces: `moveTargets` also returns parents reachable through a `file.backlinks`/`file.links` rule; `planMove` emits appends and removals for those edges.

- [ ] **Step 1: Write the failing tests**

```ts
it('moves a hierarchy under another hierarchy', () => {
  // h1 links [[h2]] in its body; schema: Hierarchy children: { Hierarchy: file.backlinks }
  const result = planMove(schema, snapshot, { kind: 'move', node: 'h2.md', parent: 'h3.md' });
  expect(result.ok).toBe(true);
  expect(result.plan.appends).toEqual([{ path: 'h3.md', target: 'h2.md' }]);
  expect(result.plan.bodyLinkRemovals).toEqual([{ path: 'h1.md', target: 'h2.md' }]);
});

it('carries the whole branch', () => {
  // h2 has child h4 (text link) and grandchild h5; inherit keys must be rewritten for both
  const paths = result.plan.changes.map((change) => change.path);
  expect(paths).toEqual(expect.arrayContaining(['h2.md', 'h4.md', 'h5.md']));
  const after = buildStructure(schema, applyPlan(snapshot, result.plan));
  expect(after.nodes.get('h4.md')?.parent).toBe('h2.md');
  expect(after.nodes.get('h5.md')?.parent).toBe('h4.md');
});

it('offers text-link parents as move targets', () => {
  expect(moveTargets(schema, structure, 'h2.md')).toContain('h3.md');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run src/core/plan-move.test.ts`

- [ ] **Step 3: Implement**

Replace the `rule.kind !== 'property'` rejection with edge-kind-specific writes: `backlinks` → append to the new parent plus a removal from the old parent; `links` → append to the node plus a removal from the node. Keep the inherited cascade untouched — it already covers the branch. Keep the existing rejection when the old mention is embed-only (the planner cannot know this; `plan-applier` reports it, so add the matching test there instead). Drop the `rule?.kind === 'property'` filter in `moveTargets`.

- [ ] **Step 4: Run the core suite**

Run: `pnpm vitest run src/core`

- [ ] **Step 5: Commit**

```bash
git add src/core
git commit -m "feat(core): move nodes linked through note text"
```

---

### Task 9: Convert (move + retype) in one plan

**Files:**

- Create: `src/core/plan-convert.ts`
- Modify: `src/core/plan-types.ts`, `src/core/planner.ts`, `src/core/plan-retype.ts` (export `failingChildren`)
- Test: `src/core/plan-convert.test.ts`

**Interfaces:**

- Produces:

```ts
export function planConvert(
  schema: Schema,
  snapshot: Snapshot,
  action: Extract<Action, { kind: 'convert' }>,
  env: PlanEnv,
): PlanResult;

export function convertOptions(
  schema: Schema,
  structure: Structure,
  node: string,
  parent: string,
): readonly string[]; // type names that keep the whole branch valid

export function operationTargets(
  schema: Schema,
  structure: Structure,
  node: string,
  mode: 'move' | 'convert',
): ReadonlySet<string>;
```

`Action` gains `| { readonly kind: 'convert'; readonly node: string; readonly parent: string; readonly type: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists the types a problem can become under a category', () => {
  expect(convertOptions(schema, structure, 'p.md', 'cat.md')).toEqual(['Meta-note', 'Hierarchy']);
});

it('leaves out a type that would orphan the branch', () => {
  // p.md has Hierarchy children; Meta-note → Hierarchy exists, Hierarchy → Hierarchy exists,
  // so a type with no link to Hierarchy must not be listed
  expect(convertOptions(schema, structure, 'p.md', 'cat.md')).not.toContain('Problem');
});

it('retypes the node, moves it and rewrites the branch', () => {
  const result = planConvert(schema, snapshot, convert('p.md', 'cat.md', 'Meta-note'), env);
  const after = buildStructure(schema, applyPlan(snapshot, result.plan));
  expect(after.nodes.get('p.md')?.parent).toBe('cat.md');
  expect(after.nodes.get('p.md')?.type).toBe('Meta-note');
  expect(after.nodes.get('h.md')?.parent).toBe('p.md'); // child kept its place
});

it('rejects a conversion the branch cannot survive', () => {
  expect(planConvert(schema, snapshot, convert('p.md', 'cat.md', 'Hierarchy'), env)).toEqual({
    ok: false,
    reason: '"Problem note" cannot become "Hierarchy": "Child" would have no parent',
  });
});

it('offers convert targets only where some type fits', () => {
  expect(operationTargets(schema, structure, 'p.md', 'convert')).toEqual(new Set(['cat.md']));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run src/core/plan-convert.test.ts`

- [ ] **Step 3: Implement**

`planConvert` plans the retype (reusing `planRetype`'s recipe writes) and the move in one `SubtreeContext`, merges the writes per path with the existing `mergeWritesByPath`, and verifies once by simulation: the node must end up under `action.parent` with `action.type`, every descendant must keep its own parent, and no other node may change. `convertOptions` filters `schema.types` by: a rule exists between the parent's type and the candidate type, `failingChildren` is empty for the candidate, and `planConvert` returns ok. `operationTargets` returns `moveTargets` for `'move'` and, for `'convert'`, every candidate parent with a non-empty `convertOptions`.

- [ ] **Step 4: Run the core suite and check coverage**

Run: `pnpm vitest run src/core --coverage`

- [ ] **Step 5: Commit**

```bash
git add src/core
git commit -m "feat(core): convert a node's type while moving it"
```

---

### Task 10: Shift-drag gesture and the type menu

**Files:**

- Modify: `src/view/drag.ts`, `src/view/structure-view.ts`, `src/view/actions-ui.ts`
- Test: `src/view/drag.test.ts`, `src/view/actions-ui.test.ts`

**Interfaces:**

- Consumes: `operationTargets`, `convertOptions`, `planConvert`.
- Produces: `DragDeps.targetsFor(path: string, mode: 'move' | 'convert')`; `DragDeps.onDrop(node: string, parent: string, mode: 'move' | 'convert', event: PointerEvent)`; `StructureActions.startConvert(node: string, parent: string, position: { x: number; y: number }): void`.

- [ ] **Step 1: Write the failing drag tests**

```ts
it('uses convert targets while Shift is held', () => {
  startDrag(nodeEl, { shiftKey: true });
  expect(targetsFor).toHaveBeenCalledWith('p.md', 'convert');
  expect(targetEl.classList.contains('is-drop-target')).toBe(true);
});

it('switches target sets when Shift is pressed mid-drag', () => {
  startDrag(nodeEl, { shiftKey: false });
  pressShift();
  expect(targetsFor).toHaveBeenLastCalledWith('p.md', 'convert');
});

it('reports the mode on drop', () => {
  dropOn(targetEl, { shiftKey: true });
  expect(onDrop).toHaveBeenCalledWith('p.md', 'cat.md', 'convert', expect.anything());
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run src/view/drag.test.ts`

- [ ] **Step 3: Implement the gesture**

Track the modifier from the pointer event and from `keydown`/`keyup` on the owner document during the drag; recompute the target set and the highlight whenever it flips; add a `is-convert` class on the ghost so the cursor state reads differently. Release the key listeners with the drag session.

- [ ] **Step 4: Write the failing action test**

```ts
it('asks which type when several fit', () => {
  actions.startConvert('p.md', 'cat.md', { x: 10, y: 20 });
  expect(menu.items.map((item) => item.title)).toEqual(['Meta-note', 'Hierarchy']);
});

it('converts straight away when only one type fits', async () => {
  await actions.startConvert('h.md', 'cat.md', { x: 0, y: 0 });
  expect(planAction).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    {
      kind: 'convert',
      node: 'h.md',
      parent: 'cat.md',
      type: 'Hierarchy',
    },
    expect.anything(),
  );
});
```

- [ ] **Step 5: Implement `startConvert`**

One option → plan and commit immediately (same path as `startMove`, including the optimistic render and the undo transaction). Several → `Menu.showAtPosition` at the drop point with one item per type. None → a notice with the planner's own rejection reason.

- [ ] **Step 6: Run the view suite**

Run: `pnpm vitest run src/view`

- [ ] **Step 7: Commit**

```bash
git add src/view
git commit -m "feat(view): convert a node by dropping it with Shift"
```

---

### Task 11: Native link context menu

**Files:**

- Modify: `src/view/node-element.ts`, `src/view/actions-ui.ts`
- Test: `src/view/actions-ui.test.ts`

**Interfaces:**

- Produces: `StructureActions.showNodeMenu(path: string, event: MouseEvent | { x: number; y: number }, anchorEl: HTMLElement): void` — the one menu both the right click and the node's menu button use.

- [ ] **Step 1: Write the failing test**

```ts
it('fills the menu with the native link items first', () => {
  actions.showNodeMenu('a.md', mouseEvent, anchorEl);
  expect(app.workspace.trigger).toHaveBeenCalledWith(
    'file-menu',
    expect.anything(),
    fileFor('a.md'),
    'link-context-menu',
  );
  expect(menu.items.map((item) => item.title)).toEqual(['Add child', 'Move to…', 'Change type']);
});

it('offers Fix inheritance only when something is off', () => {
  actions.showNodeMenu('mismatch.md', mouseEvent, anchorEl);
  expect(menu.items.map((item) => item.title)).toContain('Fix inheritance');
});

it('opens on right click on the title', () => {
  title.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  expect(showNodeMenu).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run src/view/actions-ui.test.ts -t "menu"`

- [ ] **Step 3: Implement**

Build one `Menu`, trigger `file-menu` with source `'link-context-menu'`, `addSeparator()`, then the structure items, then `showAtMouseEvent`/`showAtPosition`. Route the existing node menu button through the same function. Add a delegated `contextmenu` listener next to the existing click delegation, calling `preventDefault()` only when the event lands on a node.

- [ ] **Step 4: Run the view suite**

Run: `pnpm vitest run src/view`

- [ ] **Step 5: Commit**

```bash
git add src/view
git commit -m "feat(view): open the native link menu on a node"
```

---

### Task 12: Live verification in the dev vault

**Files:**

- Modify: `dev-vault-structure/demos/**` (scratch only, gitignored), `.superpowers/sdd/2026-09-18-structure-view-v2/report.md`

- [ ] **Step 1: Build and install**

```bash
pnpm run build
cp main.js styles.css manifest.json dev-vault-structure/.obsidian/plugins/bases-structure/
obsidian vault="dev-vault-structure" plugin:reload id=bases-structure
```

- [ ] **Step 2: Check the diagnostics**

In `demos/projects`, break one note on purpose (point a child's parent property at a note of the wrong type, and a second child's at a note that does not exist). Open the host note, screenshot, Read the screenshot, and confirm a red dashed edge with a ✕ on the first and a stub marker on the second. Then fix the notes back.

- [ ] **Step 3: Check the operations**

On the user's own scheme (`base/categories/knowledge base.md`, read-only — operate only on `demos/`, mirroring the same shape): drag a hierarchy onto another hierarchy and confirm the bullet moved between the two parents' bodies and the whole branch followed; Shift-drag a problem onto a category and confirm the type menu, the resulting metadata, and that the branch below it survived. Undo each one and confirm the files return to their original bytes (`git status` is not enough — compare with copies taken before the run).

- [ ] **Step 4: Check the rendering**

Create a note through "+" and confirm nothing flickers or scrolls: capture `scrollTop`/`scrollLeft` before and after through `obsidian eval`, and screenshot mid-flow.

- [ ] **Step 5: Check the menu and the icons**

Right-click a node title: the native link items must be there, with the structure items below. Confirm no Supercharged Links icon overlaps a neighbouring node.

- [ ] **Step 6: Report**

Write what you verified, with the screenshot paths and the measured values, into `.superpowers/sdd/2026-09-18-structure-view-v2/report.md`. Restore `dev-vault-structure/structure.base` and clean up the scratch notes.

- [ ] **Step 7: Full verification**

Run: `pnpm run verify`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs: record the v2 live verification"
```
