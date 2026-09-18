# Obsidian community plugin

Reference template for an Obsidian Community Plugin (TypeScript → `main.js` via esbuild). Read `src/main.ts`/`src/settings.ts` for the real code pattern, and run `pnpm run <script>` to see what's available — this file only covers what isn't already enforced by config/tooling or discoverable that way.

Before taking action, ensure the `using-superpowers` skill is active. Specifically dispatched subagents follow their task brief instead.

## Manual UI verification

Obsidian ships a CLI for driving a _running_ Obsidian instance from the terminal — use it instead of guessing whether a UI change works: `obsidian devtools` (toggle DevTools), `obsidian plugin:reload id=<plugin-id>` (hot-reload after a build), `obsidian dev:dom selector=<css>` (query the live DOM), `obsidian dev:screenshot path=out.png`, `obsidian dev:console` / `dev:errors` (captured console/errors), `obsidian eval code="..."` (run JS in-app). Requires Obsidian 1.12+ with **Settings → General → Command line interface** enabled, and the app running. Docs: https://obsidian.md/help/cli#Developer+commands

The dev vault for this plugin is `dev-vault-structure/` (gitignored, lives in the repo root). Always target it explicitly with `vault=`:

```shell
obsidian vault="dev-vault-structure" eval code="app.vault.getFiles().length"
obsidian vault="dev-vault-structure" dev:dom selector=".abyss-panel-view" text
obsidian vault="dev-vault-structure" dev:css selector=".abyss-panel-view" prop=color
obsidian vault="dev-vault-structure" dev:screenshot path=screenshot.png
obsidian vault="dev-vault-structure" devtools
```

## Verification

`pnpm run verify` is the canonical quality gate — CI, pre-push, branch
completion, and the release flow all call this single script, not their own
lists of checks. Run it directly rather than assembling lint/typecheck/test/
build by hand. `pnpm run verify:task` is a faster subset (lint, typecheck,
unit tests) for checking a single task mid-implementation, not a substitute
for `verify` at branch completion.

## Constraints nothing else catches

- `id` in `manifest.json` is permanent once released — never rename it.
- Releasing means bumping `version` in **both** `manifest.json` and `versions.json`; the release tag must match `manifest.json`'s version exactly (no leading `v`).
- Any network call or external service needs explicit opt-in and disclosure (README + settings) — default is local/offline. Never fetch-and-eval remote code or self-update outside normal releases.
- Use `this.register*` (`registerEvent`, `registerDomEvent`, `registerInterval`) for anything that needs cleanup — nothing lints for a raw `addEventListener`/`setInterval` leaking past unload.

## References

- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- API docs: https://docs.obsidian.md · Developer policies: https://docs.obsidian.md/Developer+policies · Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Manifest validation rules: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## CodeGraph

Prefer CodeGraph for dependency discovery, blast-radius analysis, unfamiliar code,
and cross-module refactoring. For obvious local changes, prefer ordinary Read/Search.

Step 2 of `using-git-worktrees` automatically initializes/syncs each checkout's own
ignored `.codegraph/` as best effort, including the main checkout. Before a batch
of graph queries, check for `.codegraph/codegraph.db` at the current checkout root
and run `codegraph sync` there; repeat after edits. Always pass that absolute root
(`git rev-parse --show-toplevel`) as MCP `codegraph_explore.projectPath`, or run
`codegraph explore` from that root. MCP can discover a new index without restarting,
but cross-project queries do not start a watcher. If the local index is missing,
sync fails, or results report another worktree/stale files, use Read/Search.
This project policy takes precedence over CodeGraph's generic agent guidance.
