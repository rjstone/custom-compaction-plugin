# TODO

Ideas not yet built. See the [README](README.md) for what the plugin does today.

## Per-format characters-per-token estimate

The summarizer budget (`maxSummarizerInputTokens`) is converted to characters at one fixed rate,
3 characters per token. Measurements so far suggest tokenizers differ enough to use a rate per
summarizer:

- about **2 characters per token** for Claude models: `$.model.complete` (the session's own model)
  and endpoints with `apiFormat: anthropic`;
- about **3 characters per token** for everything else (`apiFormat: openai`).

In one test, the same 1.6M characters were about 787k Claude tokens (2.0 per token) and about 577k
DeepSeek tokens (2.8 per token). That text mixed languages, so typical transcripts may tokenize
somewhat better. An override option (`charsPerToken`) would cover models that don't fit either rate.

## Summary quality

- **Cap summary growth.** Each compaction folds in the previous summary (15.9k characters at the first
  auto compaction, 28k at the second in one test). Re-summarize the old summary harder, or cap it.
- **Keep answer order.** The section template groups facts by topic, so recall loses which question came
  first. Add a short chronological "Q&A log" section.
- **Check the new summary framing more widely.** 0.7.0 tells the model the summary is its own accurate
  record; it fixed the one failing recall case. Test it on more sessions and models.

## Robustness

- **Retry once** on a transient endpoint failure (one curl exit 1 was seen) before falling back to core.
- **Split, don't cut, an oversized message.** A single message bigger than one refine part is cut to fit.
  Nearly impossible at the 128k minimum budget, but splitting it across parts would keep it whole.
- **Count `extraInstructions` and `/compact` arguments in the budget.** Only a fixed 4,000-character
  allowance covers the prompt's own text today.
- **Detect cut-off summaries better on `$.model.complete`.** It reports no stop reason, so 0.7.0 guesses
  from `output_tokens >= maxSummaryTokens - 8`.

## Features

- **`/compaction-preview`**: a slash command (`$.command.register`) that shows the summary without
  installing it.

## Platform and engine

- **Test on Windows**: `curl.exe` (needs 8.3+ for `--variable`), `USERPROFILE`, drive-letter paths, and
  `~\` in prompt paths (only `~/` is expanded today).
- **Engine bug reported** via `/feedback` on 2026-11-27 (watch for a fix; then `tailMode: verbatim` could
  become safe again): kept tool-result messages handed back by a `session.compact`
  hook are written with their original `parentUuid`, so a resumed session reloads the old history. The mod
  works around it with `tailMode: text`.
- **Late load**: in a fresh process, hooks modules wait for a server-side rollout flag
  (`tengu_plugin_hooks_modules`), so a short first turn can run without the mod. Nothing to do in the mod.
- **Other plugins' `session.compact` hooks don't run** for a compaction this mod answers. `next(e)` can't
  fix it: it always ends in Claude Code's own compaction (`next.to` only skips to a deeper tier), so it
  would double every compaction. Needs an engine API to call the plugins beneath without core, or a
  shared event other mods can observe. Documented in the README.

## Smaller items (from the 0.7.0 review)

- Pin the GitHub Actions in `.github/workflows/release.yml` to commit SHAs instead of tags.
- Count cache tokens for non-streamed Anthropic replies too (the SSE path does).
- `saveSummaries` writes relative to the working directory; prompt files resolve from the project root.
  Use the project root for both.
- Validate `extraHeaders` names (a name starting with `@` or containing `:` means something else to curl).
- Redact credentials embedded in an endpoint URL (`user:pass@`) from the log line.

## Releases

- v0.6.0 has a tag but no GitHub Release (the release workflow didn't exist yet): create one by hand.
- Optional: copy the marketplace's notify workflow into this repo so new tags reach
  `rjstone/plugin-marketplace` at once instead of on its daily run.

