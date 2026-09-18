# Contributing

Thanks for taking an interest. Issues and pull requests are both welcome.

## Getting set up

You need pnpm and a Node version matching `engines` in `package.json`, then

```
pnpm install
pnpm dev
```

`pnpm dev` rebuilds `main.js` on every save. Copy `main.js`, `manifest.json` and
`styles.css` into `.obsidian/plugins/bases-structure/` in a vault you do not mind
breaking. Obsidian ignores symlinked plugin files, so copy them for real. The view needs
a `.base` with `type: structure` and a note that embeds it.

## Before you open a pull request

```
pnpm verify
```

That runs formatting, lint, styles, types, architecture rules, dead code and the unit
tests with coverage. CI runs the same command, so a green local run means a green pull
request.

Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org),
so `fix: ...`, `feat: ...` or `docs: ...`. A check enforces it.

New behaviour wants a test. Coverage thresholds are enforced per file, so an untested
branch fails the build rather than slipping through.

## Worth knowing

Everything under `src/core` is pure: it takes a schema and a snapshot of the notes and
returns a structure or a plan, with no Obsidian imports. Every write goes through that
core as a plan that is verified by simulation before anything touches a file, and lands
as one undoable transaction. Keeping a change on the right side of that line is most of
the review.

`AGENTS.md` lists the invariants no single file makes obvious, and the commands for
driving a running Obsidian from the terminal while you work on the view.
