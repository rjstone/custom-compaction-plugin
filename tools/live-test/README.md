# Live-test harness

Drives a headless Claude Code session through many turns of note-reading questions until
compactions happen, then checks that they held. Results from 2026-11-26 are in
[docs/live-tests.md](../../docs/live-tests.md) and [docs/resume-bug.md](../../docs/resume-bug.md).

## What it does

Each turn is a separate `claude -p` process (`--session-id` first, then `--resume`) on Haiku,
with the mod loaded by `--plugin-dir`, read-only tools (`Read Grep Glob`) and `NOTES_DIR` added
by `--add-dir`. It writes a `settings.json` into the run folder with `autoCompactWindow` and the
mod's options under `pluginConfigs` (both `custom-compaction` and `custom-compaction@inline`).
It also sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.

After each turn it records the context size (the last assistant message's input + cache-read +
cache-creation tokens) and greps the turn's debug log for compaction lines. After a set number of
hook compactions it asks a recall question about the first subject, then checks the transcript
chain. For each `compact_boundary` row it lists later rows whose `parentUuid` points before the
boundary (back-links), then walks back from the last message to confirm it reaches a boundary. A
back-link means a resumed session reloads the old history.

## Files

| File | What |
| --- | --- |
| `gen_questions.py` | Builds a fixed question script: a seeded shuffle (`random.shuffle`) of `NOTES_DIR/*.md`; for each note, 5 random 10-line windows; a model writes one question per window that never names the note. Output `questions-seed<seed>.json`; each entry records its note and lines |
| `driver.py` | Runs the test over a question file (cycling it if needed) |

Generated question files and run folders quote your notes, so keep them out of public repos
(`runs/` is git-ignored here).

## Usage

```sh
export NOTES_DIR=/path/to/notes          # a folder of Markdown files the questions are about
export OPENCODE_API_KEY=...              # summarizer and question-writer key (a placeholder where a proxy injects it)

python3 gen_questions.py 2026 16         # 16 notes x 5 questions -> questions-seed2026.json

# Claude Code's own auto compactions (at about 90% of the 200k window), replaced by the mod;
# stop after 2, then 2 more turns, a recall question and the chain check:
AUTO_TRIGGER=replace N_COMPACT=2 \
  python3 driver.py runs/auto questions-seed2026.json replace 200000

# Between-turn compactions instead: send /compact once context reaches 140k:
COMPACT_AT_TOKENS=140000 N_COMPACT=2 \
  python3 driver.py runs/manual questions-seed2026.json replace 200000

# Control (core compacts, mod passes through):
python3 driver.py runs/off questions-seed2026.json off 200000
```

To make Haiku read whole files, prefix each question in the JSON with a `prompt` field such as
"Find the note in <NOTES_DIR> that covers this question, read that note in full, then answer: ..."
(the driver sends `prompt` when present, else `question`).

Other environment variables: `PLUGIN_DIR` (default: this repo's `claude-code/custom-compaction`),
`EXTRA_PLUGIN_DIRS` (colon-separated, more `--plugin-dir`s), `CONT_SID`, `START_TURN`, `Q_OFFSET` and
`INIT_CTX` to continue an existing session. The mod options the driver writes (DeepSeek on OpenCode
Go, `saveSummaries: true`) are at the top of `driver.py`.

Output per run folder: `settings.json`, `driver.log` (one line per turn with context size and
compaction lines, `!!!` for turns whose result was an error, and the chain check), `recall.txt`,
`debug-NN.log` per turn, and `.claude/custom-compaction/*.md` (saved summaries).

Notes:
- Hooks modules load behind a server-side rollout flag; a fresh process may log `hooks module
  custom-compaction@inline not loaded` and load it moments later.
- A plugin's `$.session.compact()` is unavailable headless, which is why the driver sends `/compact`.
- OpenCode Go requires an `x-opencode-session` header, a stable id per conversation. The mod adds the session id
  itself (0.5.1+); `gen_questions.py` uses one UUID per run.
