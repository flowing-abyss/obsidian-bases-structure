---
name: releasing-an-obsidian-plugin
description: Cuts a release for this Obsidian plugin — bumps the version, verifies it end-to-end against real Obsidian, tags, pushes, and confirms the release actually came out clean on GitHub. Use when the user asks to release, publish, ship, or cut a new version of the plugin.
---

# Releasing an Obsidian Plugin

## The one command

```bash
pnpm run release patch   # or: minor / major
```

**Confirm with the user before running this.** It pushes a commit and a tag to the remote and (via `.github/workflows/release.yml`) creates a draft GitHub release — a one-way action, not a local dry run. (It's a draft — nothing is public until it's manually published; see "What's still manual" below.)

## What it does, in order

1. **`preversion`** runs the canonical verify gate, the release-ready metadata check, and then the local desktop E2E test: `pnpm run verify` (format, lint, types, arch, dead code, coverage, build, artifact checks including README/LICENSE presence), then `node release-check.mjs --release-ready` (fails on unfilled template placeholders — `manifest.json`'s `id`/`name`/`author`/`description`, `package.json`'s `name`), then `pnpm run test:e2e` against real Obsidian, on whatever OS this machine is. Aborts here, untouched, if anything fails — no partial release state.
2. **`version`** — bumps `manifest.json`'s `version`, syncs `versions.json` (via `version-bump.mjs`), stages both.
3. pnpm's own version step commits (`"<new-version>"`) and tags **without a leading `v`** (`--tag-version-prefix ''`) — the tag must equal `manifest.json`'s `version` exactly; this is what `release.yml` and Obsidian's community-plugin submission process both expect.
4. **`postversion`** — `git push --follow-tags`, which pushes the version commit to the branch and pushes its tag. The branch update triggers `ci.yml` (fast gate, redundant with what `preversion` already ran) and `e2e.yml` (the cross-platform proof — desktop on Ubuntu/Windows/macOS **and** real Android — that `preversion`'s local `test:e2e` alone can't give you, since that only covers this one machine's OS). The tag update separately triggers `release.yml` (build, re-verify, generate a changelog from commit messages, open a **draft** GitHub release with `main.js`/`manifest.json`/`styles.css` attached). All three runs refer to the same release commit SHA — `ci.yml`/`e2e.yml` trigger on branch pushes, not tags, so this is a single push producing three runs, not duplicates.

## The command finishing is not the release finishing — verify on GitHub

`pnpm run release` returning success only means the **local** steps and the push worked. The actual release isn't real until the CI it triggered has finished and produced a correct result. Do not tell the user the release shipped until you've checked this.

**First, record exactly which commit and tag this release pushed** — every check below filters on these, not on "whatever the latest run happens to be" (a concurrent push, a re-run, or stale cache could otherwise point you at the wrong run).

Bash:

```bash
release_sha=$(git rev-parse HEAD)
release_tag=$(git describe --tags --exact-match HEAD)

run_id=$(gh run list \
  --workflow=e2e.yml \
  --commit="$release_sha" \
  --limit=1 \
  --json databaseId \
  --jq '.[0].databaseId')

test -n "$run_id"
gh run watch "$run_id" --exit-status
```

PowerShell (the bash snippet above does not run as-is in PowerShell — command substitution, `test -n`, and line-continuation syntax all differ):

```powershell
$release_sha = git rev-parse HEAD
$release_tag = git describe --tags --exact-match HEAD

$run_id = gh run list `
  --workflow=e2e.yml `
  --commit=$release_sha `
  --limit=1 `
  --json databaseId `
  --jq '.[0].databaseId'

if (-not $run_id) {
  throw "No E2E workflow run found for $release_sha"
}

gh run watch $run_id --exit-status
```

`--commit` filters server-side to runs for that exact commit, so `--limit=1` is safe here — unlike an unfiltered `gh run list --limit=1`, which can return someone else's concurrent run or a stale one.

Repeat the same flow for `release.yml` (the build itself), swapping `--workflow=e2e.yml` for `--workflow=release.yml`. Then confirm the release exists at the exact tag, with a real changelog body — not an empty one (a broken changelog-builder step still exits 0):

```bash
gh release view "$release_tag" --json isDraft,body,name
```

If either workflow's conclusion isn't `success`, `$run_id` comes back empty (the push may not have triggered CI yet — wait and re-check, don't assume), or the release body is empty/missing, **stop and report the specific failure**. Diagnose from the failed run's logs (`gh run view <id> --log-failed`) and fix forward.

**Do not rerun `pnpm run release patch` after the version commit and tag were pushed.** It may create the next patch release rather than retrying the failed workflow for the existing tag. Diagnose and fix forward instead.

## What's still manual

- Open the draft release on GitHub, skim the changelog you just confirmed is real, publish it.
- Obsidian now runs an automated review on every submitted version (security + code-quality scan, results in minutes) — see https://obsidian.md/blog/future-of-plugins/. Before a first submission, or if you want a pre-check beyond what this repo's own `eslint-plugin-obsidianmd` rules already catch, use the developer dashboard's own preview-scan feature on the pushed tag (https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins) — it's the same scanner that gates review, and nothing local can fully replicate it.
- First release only: submit the plugin to the community catalog per https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin.

## If `preversion` fails

Nothing was tagged or pushed — fix the failure, rerun `pnpm run release <bump>`. Don't hand-bump `manifest.json`/`versions.json` to route around a failure; that's exactly the drift `release-check.mjs` and this whole chain exist to catch.
