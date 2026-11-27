# Live tests (Claude Code 2.1.332, 2026-11-26)

> Part of [custom-compaction-plugin](../README.md). Plugin docs: [claude-code/custom-compaction](../claude-code/custom-compaction/README.md).

All runs were headless: one `claude -p` process per turn (`--session-id`, then `--resume`)
on Haiku, the mod loaded with `--plugin-dir`, read-only tools, questions about a personal
notes folder. The harness is in [tools/live-test/](../tools/live-test/). The per-run records
(question files, summaries, logs) stay private because they quote the notes.

Headless `claude -p` sessions on Haiku (default effort), mod loaded with
`--plugin-dir`, read-only tools, the `notes/` folder added with `--add-dir`.
Three turns built up context (questions about topics in a personal notes folder,
including one topic the notes don't cover, and a summary of one note), then
`/compact`, then a recall turn asking about all three without searching again.

| Run | Summarizer | Time | Tokens in / out | Summarized / kept | Recall |
| --- | --- | --- | --- | --- | --- |
| 1 (0.2.0 tail rule) | Sonnet via `$.model.complete` | 5.2 s | 2,009 / 824 | 11 / **13** | 3/3 correct |
| 2 (0.2.1 tail rule) | `deepseek-v4.1-flash` on OpenCode Go | 9.3 s | 1,870 / 1,030 | 15 / 6 | 3/3 correct |

Both debug logs show `custom-compaction (user) answered session.compact without
next()` and `a hook's N messages stand ... core never ran`. After the swap,
the shell hooks `PostCompact` and `SessionStart:compact` (superpowers,
token-optimizer) still fired on the new transcript. In run 2 the endpoint's temp
files were removed from `/tmp`, and the cut fell mid-turn: the summary called
the second question "half-answered", and the kept messages carried the actual
answer. Both summaries followed the section template and kept exact paths and
line numbers. Run 1's summary also pointed out that some quotes came from tool
output the mod had cut short.

Findings:

- **The mod can load late.** Hooks modules of installed and `--plugin-dir`
  plugins wait for a server-side rollout flag (`tengu_plugin_hooks_modules`).
  In a fresh process that flag may not have arrived when the run starts, so it
  prints `custom-compaction: hooks module not loaded`. It loaded tens of
  milliseconds later, in time for `/compact`. A short `-p` turn can run
  entirely without the mod; long interactive sessions should be unaffected.
- **It bypasses other compaction hooks.** Token Optimizer and the built-in
  `cc-plugin-agents-md` also hook `session.compact`. Because this mod answers
  without `next(e)`, their hooks don't run for that compaction ("nothing
  beneath it ran"). Their shell `SessionStart:compact` hooks still run.
- **Tool output is cut short** for the summarizer (1,500 characters per result),
  and the summarizer notices. Raise `MAX_TOOL_RESULT_CHARS` if summaries need
  more exact quotes.

### Auto-compaction runs

Same harness, but each turn is a separate `claude -p --resume` process asking
Haiku about a random line from a random note ("read the note and explain this
line in context"). The window is set with both `autoCompactWindow` and
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`. The summarizer is `deepseek-v4.1-flash` on
OpenCode Go. Once an auto compaction is seen, two more turns run, then a recall
question about the first three notes.

| Window | Turns to first auto compaction | Compactions (messages summarized -> kept) | DeepSeek tokens in / out (time) |
| --- | --- | --- | --- |
| 100k | 3 (about 60k of the window is fixed overhead: system prompt, tools, skills, plugin context) | turn 3: 6 -> 6; turn 4: 19 -> 5; turn 5: 28 -> 5 | 1.4k / 1.4k; 4.3k / 2.7k; 6.6k / 2.9k |
| 200k | 22 (fired at about 170k) | turn 22: 98 -> 6; turn 23: 111 -> 5; turn 24: 120 -> 5 | 22.9k / 3.1k (about 35 s); 25.7k / 4.7k; 27.2k / 3.9k |

Every one of these was answered by the mod (`core never ran`), including the
ones that fired in the middle of a turn's tool calls. In the 200k run, context
fell from about 165k to 72k at the first compaction. A 100k window is too small
to be useful: with about 60k of fixed overhead it compacts almost every turn.

### autoTrigger: replace (0.4.1), mid-turn auto compactions

Fresh session, same 80-question full-read script, `autoTrigger: replace`, no
trigger plugin, the driver never sends `/compact`: only Claude Code's own
threshold (about 180k with a 200k window) starts compactions, inside turns.

| Turn | Compaction | Next turns' context | Back-links |
| --- | --- | --- | --- |
| 61 | `auto`, 241 messages -> 15.9k-char summary (30.3k in / 4.6k out), 3 kept, 5 stand | 65.4k, 66.6k, 67.4k, ... 76.3k at turn 70 | none |
| 117 | `auto`, 219 messages -> 28k-char summary (27.3k in / 8.5k out), 2 kept, 3 stand | 75.6k, 76.8k, 78.1k | none |

120 turns, **no turn errors**, `core never ran` both times, and walking back
from the last message reaches a boundary in 42 hops. At turn 61 the compaction
landed in the middle of a tool round: the new transcript ends
`[tool Grep ...]` (assistant notes) then the user continue note, and the turn
carried on normally. Recall: Haiku named the first subject and its main facts
from the summary, and said it couldn't give the five answers in order
(see gaps). Result: 0.5.0 makes `autoTrigger: replace` the default, and no
trigger plugin is needed.
