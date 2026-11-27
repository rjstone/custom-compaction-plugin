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

## Versioning and commits

- Bump the plugin's `version` in its manifest for each behaviour change, and say in the commit
  message what changed and how it was tested (unit tests, live test).
- Don't commit generated editor types (`.claude-plugin/types/`, git-ignored).

## Live tests

`tools/live-test/` drives headless sessions; see its README. Live tests cost model tokens: use a
small model for the session, and stop runs once the question at hand is answered.
