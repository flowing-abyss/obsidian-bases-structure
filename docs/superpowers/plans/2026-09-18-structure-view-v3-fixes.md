# Structure View v3 — correctness fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report a schema violation on the link that causes it, never change a note's type without the user choosing it, and show what a drag will carry.

**Architecture:** The detection change lives in the pure `src/core/diagnostics.ts`; the conversion changes are in `src/view/actions-ui.ts` (always confirm) and `src/core/plan-convert.ts` (never adopt new children); the drag highlight is in `src/view/drag.ts` plus one CSS rule.

**Tech Stack:** TypeScript, esbuild, vitest + jsdom + obsidian-test-mocks, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-18-structure-view-v2-design.md` (this plan corrects sections 1.2 and 2.4)

## Global Constraints

- pnpm only. `pnpm run verify` is the gate. ESLint budgets: complexity 10, cognitive complexity 10, 80 lines per function, 4 parameters, 30 statements. Per-file coverage 90/90/90/85.
- `src/core/**` must not import `obsidian`.
- **The plugin only ever writes what the schema describes**: the type tag of a type defined by `tag`, the link properties named in `children`/`inherit`, and the folder of a type defined by `folder`. Every other tag, property and body line of a note stays untouched — including `icon`, `color`, `aliases`, `description` and any user tag such as `mark/ignore`. This is a user ruling from 2026-09-18.
- Conventional Commits; never push. Comments state the guarantee, not the history.
- The user's real schema, used in every fixture below:

```yaml
inherit: [category, meta, problem]
types:
  Category: { tag: system/category, children: { Meta-note: category, Hierarchy: category } }
  Meta-note: { tag: system/high/meta, children: { Problem: meta, Hierarchy: meta } }
  Problem: { tag: system/high/problem, children: { Hierarchy: problem } }
  Hierarchy: { tag: system/high/hierarchy, children: { Hierarchy: file.backlinks } }
```

---

### Task 1: Report a violation on the link that causes it

**Files:** Modify `src/core/diagnostics.ts`; Test `src/core/diagnostics.test.ts`

**Problem (measured).** A Meta-note whose `meta` points at another Meta-note produces no edge (the schema has no Meta-note → Meta-note rule) and no `illegal-parent` diagnostic — `illegal-parent` only inspects properties that are a legal edge for the node's own type. The user sees nothing at the offending link and an amber "does not match its parent" on unrelated descendants instead.

**Required rule.** For every node `N`, every property `P` the schema knows (any `children` right-hand side plus every `inherit` key) and every link target `T` of `N` under `P`:

1. A rule (type(`T`) → type(`N`)) exists and its property is `P` → legal edge, no diagnostic.
2. Otherwise, if `P` is an `inherit` key and `T` is in the inherited set `N` should currently hold for `P` (the same `unionInheritedTargets` the repair uses) → legal inherited copy, no diagnostic.
3. Otherwise, if some rule (type(`T`) → type(`N`)) exists through any property, or `P` is an `inherit` key and `N` has at least one property parent → `inherit-mismatch` as today (amber): the types are compatible, the value simply disagrees with the parent chain.
4. Otherwise → `illegal-parent` (red), with `target: T`, `property: P` and a message naming both types, e.g. `"Meta-note" cannot be the meta of "Meta-note"`. Use the type names, not the note names, when both are typed; fall back to the note name when a side is untyped.

- [ ] **Step 1: Write the failing tests**

```ts
it('flags a meta-note whose meta points at another meta-note', () => {
  // meta2 has `meta: [[information processing]]`; both are Meta-notes
  expect(collectDiagnostics(schema, snap, structure)).toEqual([
    {
      kind: 'illegal-parent',
      node: 'meta2.md',
      target: 'meta1.md',
      property: 'meta',
      message: '"Meta-note" cannot be the meta of "Meta-note"',
    },
  ]);
});

it('keeps a legitimate inherited copy quiet', () => {
  // a Problem under a Meta-note carries `category` copied from that meta-note
  expect(collectDiagnostics(schema, snap, structure)).toEqual([]);
});

it('still reports a plain disagreement as an inherit mismatch', () => {
  // a Hierarchy under a Problem whose `category` names a *different* category note
  expect(collectDiagnostics(schema, snap, structure)[0]).toMatchObject({
    kind: 'inherit-mismatch',
    keys: ['category'],
  });
});

it('flags an orphaned problem that still carries a category link', () => {
  // a Problem with no `meta` at all and `category: [[knowledge base]]`
  expect(collectDiagnostics(schema, snap, structure)[0]).toMatchObject({
    kind: 'illegal-parent',
    property: 'category',
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run src/core/diagnostics.test.ts`

- [ ] **Step 3: Implement the four-branch rule**

Replace the current "only properties that are a legal edge for this node's own type" scoping with the rule above. Keep one `inherit-mismatch` per node listing every differing key; emit one `illegal-parent` per offending link.

- [ ] **Step 4: Run them, then the full core suite**

Run: `pnpm vitest run src/core`

- [ ] **Step 5: Commit**

```bash
git add src/core
git commit -m "fix(core): report a schema violation on the link that causes it"
```

---

### Task 2: Never change a type without the user choosing it

**Files:** Modify `src/view/actions-ui.ts`; Test `src/view/actions-ui.test.ts`

**Problem (measured live).** With exactly one viable type, a Shift-drop converts silently: the note's type tag changes and the user is told only afterwards, by a notice. With the user's own vault settings (native menus) the multi-option menu is an OS menu that is easy to miss, so a conversion feels like "the plugin broke my structure".

**Required behaviour.** A conversion always asks first, whatever the number of options. The menu item spells out the result rather than naming a bare type: `Make "<name>" a <Type> here`. One option means a one-item menu — no silent path. Escape still cancels without writing.

- [ ] **Step 1: Write the failing test**

```ts
it('asks even when only one type fits', () => {
  actions.startConvert('h.md', 'cat.md', { x: 0, y: 0 });
  expect(menu.items.map((item) => item.title)).toEqual(['Make "Child" a Hierarchy here']);
  expect(planAction).not.toHaveBeenCalled();
});

it('converts once the item is chosen', () => {
  actions.startConvert('h.md', 'cat.md', { x: 0, y: 0 });
  menu.items[0]?.click();
  expect(planAction).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    { kind: 'convert', node: 'h.md', parent: 'cat.md', type: 'Hierarchy' },
    expect.anything(),
  );
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run src/view/actions-ui.test.ts -t convert`

- [ ] **Step 3: Implement**

Drop the single-option shortcut; build the menu for every non-empty option list, with the new item copy.

- [ ] **Step 4: Run the view suite**

Run: `pnpm vitest run src/view`

- [ ] **Step 5: Commit**

```bash
git add src/view
git commit -m "fix(view): always confirm a type change before writing it"
```

---

### Task 3: A conversion may never adopt new children

**Files:** Modify `src/core/plan-convert.ts`; Test `src/core/plan-convert.test.ts`

**Problem.** Converting a note into a type whose children come from note text (`file.backlinks`) turns every body mention into a child. On a big structure note that rewrites a whole branch of the user's vault. Verification rejects this today only because such children change parents; that is incidental, and `convertOptions` must be explicit about it.

**Required behaviour.** A type is offered only when, after the conversion, the node's child set is exactly the one it had before. Gaining a child (through `file.backlinks`, `file.links` or any other rule) disqualifies the type, with a rejection reason naming the first note that would be adopted: `"<name>" would become a child of "<node>"`.

- [ ] **Step 1: Write the failing tests**

```ts
it("does not offer a text-link type that would adopt the note's body links", () => {
  // `structure.md` is a Meta-note whose body links to two Hierarchy notes
  expect(convertOptions(context, 'structure.md', 'meta1.md')).toEqual(['Problem']);
});

it('rejects such a conversion with the adopted note named', () => {
  expect(planConvert(schema, snap, convert('structure.md', 'meta1.md', 'Hierarchy'), env)).toEqual({
    ok: false,
    reason: '"knowledge models" would become a child of "structure"',
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run src/core/plan-convert.test.ts`

- [ ] **Step 3: Implement the explicit check**

Compare the node's children before and after in `verifyConvert`, and let `convertOptions` inherit the result through the plan it already runs.

- [ ] **Step 4: Run the core suite**

Run: `pnpm vitest run src/core`

- [ ] **Step 5: Commit**

```bash
git add src/core
git commit -m "fix(core): never convert a node into a type that would adopt new children"
```

---

### Task 4: Show the branch a drag will carry

**Files:** Modify `src/view/drag.ts`, `styles.css`; Test `src/view/drag.test.ts`

**Problem.** Only the dragged node dims, so nothing says the whole branch moves with it.

**Required behaviour.** While a drag is in progress, every descendant of the dragged node carries `is-dragging-branch`, styled like the dragged node but lighter (same opacity family, no new colours). The classes clear when the gesture ends, is cancelled or the view unloads. `DragDeps` gains `descendantsOf: (path: string) => readonly string[]`, wired in `structure-view.ts` from the rendered structure.

- [ ] **Step 1: Write the failing tests**

```ts
it("marks the dragged node's descendants", () => {
  startDrag(nodeEl('parent.md'));
  expect(nodeEl('child.md').classList.contains('is-dragging-branch')).toBe(true);
  expect(nodeEl('unrelated.md').classList.contains('is-dragging-branch')).toBe(false);
});

it('clears the branch marking when the drag ends', () => {
  startDrag(nodeEl('parent.md'));
  dropOn(nodeEl('target.md'));
  expect(container.querySelectorAll('.is-dragging-branch')).toHaveLength(0);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run src/view/drag.test.ts`

- [ ] **Step 3: Implement**

Apply the class in `applyStartClasses`, clear it in `clearAllClasses`, and add the CSS rule next to the existing `.is-dragging` one.

- [ ] **Step 4: Run the view suite and stylelint**

Run: `pnpm vitest run src/view && pnpm run lint:css`

- [ ] **Step 5: Commit**

```bash
git add src/view styles.css
git commit -m "feat(view): show the branch a drag will carry"
```

---

### Task 5: Prove the plugin writes nothing it does not own

**Files:** Test `src/core/plan-retype.test.ts`, `src/core/plan-convert.test.ts`, `src/obsidian/plan-applier.test.ts`

**Problem.** The user's ruling: the plugin may only write the type tag, the schema's link properties and (for a folder-typed type) the note's folder. Nothing enforces that today; a future edit could start clobbering `icon`, `aliases` or a user tag such as `mark/ignore`.

- [ ] **Step 1: Write the tests**

```ts
it('changes only the type tag, keeping every other tag', () => {
  // note tags: ['mark/ignore', 'system/high/meta', 'category/knowledge_base']
  const after = applyPlan(snap, plan).notes.get('n.md');
  expect(after?.frontmatter.tags).toEqual([
    'mark/ignore',
    'system/high/problem',
    'category/knowledge_base',
  ]);
});

it('leaves every property the schema does not name untouched', () => {
  const before = snap.notes.get('n.md')?.frontmatter ?? {};
  const after = applyPlan(snap, plan).notes.get('n.md')?.frontmatter ?? {};
  const untouched = Object.keys(before).filter(
    (key) => !['tags', 'category', 'meta', 'problem'].includes(key),
  );
  for (const key of untouched) {
    expect(after[key]).toEqual(before[key]);
  }
});
```

Write the equivalent for a move, a convert and a fix-inherit plan, and one applier-level test proving a real note's `icon`/`color`/`aliases` survive a commit byte-for-byte.

- [ ] **Step 2: Run them**

Run: `pnpm vitest run src/core src/obsidian`

- [ ] **Step 3: Fix anything they catch**

If a planner does write something it does not own, fix the planner, not the test.

- [ ] **Step 4: Commit**

```bash
git add src/core src/obsidian
git commit -m "test: pin that plans touch only what the schema owns"
```

---

### Task 6: Live verification

- [ ] **Step 1:** Build, install into `dev-vault-structure/.obsidian/plugins/bases-structure/`, reload.
- [ ] **Step 2:** In `demos/high` (a copy of the user's schema — notes: a Category host, two Meta-notes, a Problem, a Hierarchy), give a Meta-note `meta: [[other meta-note]]` and confirm a red dashed edge with ✕ appears between exactly those two notes, with the type-naming message. Screenshot and Read it.
- [ ] **Step 3:** Shift-drag with one viable type and confirm the confirmation menu appears before anything is written (the vault's `nativeMenus` setting hides menus from the DOM — set it to `false` through `app.vault.setConfig` for the check and restore it afterwards).
- [ ] **Step 4:** Add body links to a note, Shift-drag it, and confirm the text-link type is not offered.
- [ ] **Step 5:** Drag a node with a branch and screenshot the branch highlight.
- [ ] **Step 6:** Confirm a converted note keeps `icon`, `color`, `aliases` and every non-type tag, by diffing the file before and after.
- [ ] **Step 7:** `pnpm run verify`, then write the report.
