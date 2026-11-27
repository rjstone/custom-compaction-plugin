# AGENTS.md

Instructions for coding agents working in this repository (any harness).

## What this repo is

Customizable conversation compaction for agent harnesses. One folder per harness at the top
level (`claude-code/` today); each harness folder holds its plugins. Harness-neutral findings go
in `docs/`, tooling in `tools/`.

## Layout rules

- A new harness gets its own top-level folder (`codex/`, `opencode/`, ...), with its own plugin
  folders and README. Don't mix harnesses in one plugin folder.
- Shared code (prompt template, transcript renderer) only moves to a shared folder once a second
  harness actually needs it.
- Every plugin listed in `.claude-plugin/marketplace.json` uses a relative `source` under its
  harness folder.
- Keep docs in sync: a behaviour change updates the plugin README, and a new finding or test
  result goes in `docs/` with the date and the harness version tested.

## Privacy

This repository is public. Never commit:
- generated question files, run folders, saved summaries or session transcripts from
  `tools/live-test/` (they quote the private notes the tests run on; `runs/` is git-ignored);
- secrets of any kind: API keys, tokens. Endpoint keys are read from a named environment
  variable at runtime, never stored in options or files;
- paths or names from private repositories or machines.

## Versioning, commits and releases

- **Conventional commits** (from 2026-11-27): `feat:`, `fix:`, `docs:`, `refactor:`, `perf:`,
  `test:`, `chore:`/`ci:`/`build:`, with an optional scope (`feat(claude-code): ...`) and `!` or a
  `BREAKING CHANGE:` footer for breaking changes. git-cliff groups the changelog by these
  (`cliff.toml`). Older commits (`custom-compaction X.Y.Z: ...`) are listed under "Changes".
- Bump the plugin's `version` in its manifest for each behaviour change, and say in the commit
  body what changed and how it was tested (unit tests, live test).
- Don't commit generated editor types (`.claude-plugin/types/`, git-ignored).
- **`CHANGELOG.md` is generated**: never edit it by hand. Regenerate with
  `npx git-cliff@2.14.2 -o CHANGELOG.md`.

Releasing `vX.Y.Z`:

1. Set `version` in `claude-code/custom-compaction/.claude-plugin/plugin.json` to `X.Y.Z`.
2. `npx git-cliff@2.14.2 --tag vX.Y.Z -o CHANGELOG.md`, then commit both as
   `chore(release): vX.Y.Z` and push `main`.
3. Tag that commit `vX.Y.Z` and push the tag (GitHub: Releases > new tag; or
   `git tag vX.Y.Z && git push origin vX.Y.Z`). Cloud agent sessions can't push tags: ask the
   maintainer. `.github/workflows/release.yml` then publishes a GitHub Release with git-cliff's
   notes for that tag.
4. The `rjstone/plugin-marketplace` update job picks up the new tag (daily, or at once if this repo
   has its notify workflow) and points the `custom-compaction@rjstone` entry at it.

Tags must be `vX.Y.Z` (the marketplace ignores other forms, including `claude plugin tag`'s
`name--vX.Y.Z`).

## Live tests

`tools/live-test/` drives headless sessions; see its README. Live tests cost model tokens: use a
small model for the session, and stop runs once the question at hand is answered.
