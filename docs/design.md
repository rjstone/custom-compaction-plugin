# Design: why a mod and not shell hooks

> Part of [custom-compaction-plugin](../README.md). Plugin docs: [claude-code/custom-compaction](../claude-code/custom-compaction/README.md).

The goal was: cancel compaction, run a custom compaction, clear the context,
and load the custom compacted context in its place. Shell (settings.json)
hooks can't do that. These findings come from the code.claude.com docs, as of
2026-11-26:

| Shell hook | Can do | Can't do |
| --- | --- | --- |
| `PreCompact` | block (exit 2 or `{"decision":"block"}`); stdout becomes extra summary instructions | supply the summary itself |
| `PostCompact` | read `compact_summary`, side effects | change or replace the summary (no decision control) |
| `SessionStart` with source `compact` | add stdout to the compacted context | remove the built-in summary |
| any hook | | run `/clear` or `/compact` |

Blocking also has a catch. If the compaction was a recovery from a
context-limit error, blocking makes that request fail. The best a shell-hook
setup can do is steer the summary and add to it, or block it and have a
person type `/clear` so that a `SessionStart(clear)` hook can inject a file.

A mod's `session.compact` hook is middleware around the compaction itself.
Returning `{ messages }` without calling `next(e)` *is* the cancel, the clear
and the load in one step: the returned list becomes the transcript.

How the mod builds the new transcript is in the plugin README, "How replace mode works".
