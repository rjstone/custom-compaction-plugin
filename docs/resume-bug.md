# The resume bug and its fix

> Part of [custom-compaction-plugin](../README.md). Plugin docs: [claude-code/custom-compaction](../claude-code/custom-compaction/README.md).

**Summary.** When a `session.compact` hook hands back kept messages that carry tool results
with their engine `handle`, Claude Code writes those tool-result rows again with their
*original* `parentUuid`, a row from before the compact boundary. The transcript chain then
jumps back across the boundary, and a resumed session reloads the whole pre-compaction
history. Core's own compaction links correctly. custom-compaction 0.4.0+ avoids it by
rebuilding the kept tail as plain text (`tailMode: text`). Below is how it was found, in
order, including one wrong hypothesis.

## How it showed up

The message counts above should not keep growing: after the first compaction
leaves 7 messages, one turn adds about 6. They grew because **each resumed
process reloaded the full pre-compaction history**, crossed the threshold
again, and compacted it again. The 200k run's recall turn ran at about 214k
tokens, over the window, so its near-perfect recall came from the original
messages, not the summary.

Why, from the session's `.jsonl` transcript:

- Each compaction is recorded: a `compact_boundary` row (`compactMetadata.trigger`
  `auto`) followed by the mod's `<custom-compaction-summary>` message.
- After **every** boundary, the first `tool_result` written afterwards has a
  `parentUuid` pointing to a row from *before* the boundary (rows 339 -> 314,
  400 -> 384, 446 -> 430 in the 200k run), instead of to the post-compaction
  copy of its `tool_use`.
- The engine writes the kept messages again as new rows with new ids, but the
  turn in progress still links to the old ids. Following `parentUuid` back from
  the last message takes 253 hops and never reaches a boundary, so a resume
  rebuilds the whole old chain.

Within one process the compaction holds; a resumed process does not.

**Root cause (found in the confirmation run below, corrects an earlier guess).**
It is not about the turn in progress. The back-linking rows are **tool results
inside the kept tail**. When a hook hands back kept messages with their engine
`handle`, the engine writes them again after the boundary: tool-use messages
get new ids, but tool-result rows keep their *original* `parentUuid`, a
pre-compaction row. In the confirmation run, boundary 606 (a `manual`
compaction by 0.3.0 with a verbatim tail) has back-links 610 -> 590 and
613 -> 593: both are kept `tool_result` rows. Any kept tool round breaks the
chain, between turns or not. The engine probably resolves a tool result's
parent by `tool_use_id`. Report it with `/feedback`.

**Fix (0.4.0, `tailMode: text`, default):** hand back no engine messages. The
tail is rebuilt as plain text (see [How replace mode works](../claude-code/custom-compaction/README.md)),
so every row after the boundary is written fresh and chains to the summary.

**Control run (`mode: off`, core compacts), confirmed.** A fixed question
script: a seeded shuffle of the notes, 5 questions per note from random
10-line windows written by DeepSeek, 40 questions, cycled; then full reads of
the largest notes to reach the threshold. 90 turns of `claude -p --resume`
with a 200k window (the debug log reports `effectiveWindow=180000`). Core
auto-compacted 3 times, at 170k, 175k and 174k tokens (turns 63, 71, 78).
After each one, the next resumed process started at about 75k and grew
normally. Chain check on the `.jsonl`: **no** back-links at any of the three
boundaries, and walking back from the last message reaches a boundary in 103
hops. So core's own compaction chains correctly and the hook path did not. Core's
compaction logs `autocompact: ... level=compact` and `routing through
reactive`, not a `session.compact (auto)` line.

**Confirmation run (0.3.0, then 0.4.0).** Same harness, 80-question script (16
notes x 5; each prompt says to find the note and read it in full),
custom-compaction in `replace` with DeepSeek, plus
a separate trigger plugin (`compact-trigger`, not published) at 140k. In `claude -p`,
`$.session.compact()` answers "not available in a headless (-p / SDK)
session yet", so the driver stood in for the trigger: once context passed 140k,
its next prompt was `/compact`.

| Turn | Version | Compaction | Next resumed turn's context | Back-links after the boundary |
| --- | --- | --- | --- | --- |
| 47 | 0.3.0 (verbatim tail) | `/compact`, 7 messages stand | **154.6k** (full history reloaded) | 610 -> 590, 613 -> 593 (kept tool results) |
| 49 | 0.4.0 (text tail) | `/compact`, 208 messages -> 11.7k-char summary, 4 stand | **67.2k** | none |
| 98 | 0.4.0 | `/compact`, 6 stand | **74.2k** | none |

The final chain check walks back from the last message to a boundary in 47
hops. Core never compacted (`core auto compactions 0`).

Turn 49's first DeepSeek call failed (`curl exit 1` after 21.5 s); the mod fell
back to core as designed, then the compaction ran again and DeepSeek answered in
34 s. Haiku rarely re-read a note in full: a Token Optimizer `PreToolUse:Read`
hook blocks re-reading an unchanged file, and 5 questions in a row share a note.

**Recall after two compactions.** The recall question asked for the first
subject and the key points of the first five answers. The latest saved summary
still held the substance of all five answers. Haiku named the first subject correctly, but answered from the
four questions still in its kept tail and said it "can't check" the summary's
details. The summary kept the facts; the model didn't fully trust it.

