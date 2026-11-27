# custom-compaction (Claude Code mod)

A prototype **mod** (a Claude Code plugin made of in-process TypeScript
"function hooks") that takes over conversation compaction. When the
conversation is about to compact, it can:

- **replace** (default): skip the built-in summarizer, summarize the transcript
  itself with its own prompt and model, and install a new transcript of
  `[summary, ack, ...the most recent messages verbatim]`
- **steer**: let the built-in compaction run, but with this mod's section
  template prepended to the summarizer instructions
- **off**: do nothing (pass-through)

It covers every compaction trigger: `/compact` (`manual`), the auto-compact
threshold and prompt-too-long recovery (`auto`), a plugin's
`$.session.compact()` (`plugin`) and the engine's background pre-computation
(`precompute`, which is skipped in replace mode).

Status: **prototype, live-tested, 0.7.0** (2026-11-27). It passes `claude plugin validate`
and its unit tests (`claude plugin test`, 16/16) on Claude Code 2.1.332. In
headless test sessions it has replaced `/compact` and Claude Code's own
mid-turn auto compactions, with both the session's own model and an external
endpoint (see [Live tests](../../docs/live-tests.md)). Since 0.4.0 its
compactions survive a resume; earlier versions' did not (see
[Resume](../../docs/resume-bug.md)). No trigger plugin is needed: it handles
compactions whenever Claude Code starts them.

## Layout

```
claude-code/custom-compaction/   <- the plugin folder (point --plugin-dir here)
  .claude-plugin/plugin.json     manifest + userConfig options
  hooks/hooks.json               { "modules": ["./register.ts"] }
  hooks/register.ts              the session.compact hook
  tests/compaction.test.ts       unit tests (claude plugin test)
```

Design notes: [docs/design.md](../../docs/design.md). Live tests:
[docs/live-tests.md](../../docs/live-tests.md). The resume bug and its fix:
[docs/resume-bug.md](../../docs/resume-bug.md). Live-test harness:
[tools/live-test/](../../tools/live-test/).

## Using it

Paths below are relative to this repository's root.

**Install** from the central marketplace, [rjstone/plugin-marketplace](https://github.com/rjstone/plugin-marketplace)
(terminal session):

```
/plugin marketplace add rjstone/plugin-marketplace
/plugin install custom-compaction@rjstone
```

From a shell, in one step: `claude plugin install custom-compaction --marketplace rjstone/plugin-marketplace`
(add `--scope project` for the current project only, and `--config key=value` per option). Answer `y`
to add the marketplace, then pick a scope (user scope loads it in every later session). In the
desktop app: click + next to the prompt, then Plugins > Add marketplace `rjstone/plugin-marketplace` >
Add plugin. Tested 2026-11-27: installed at project scope with `--config`, it replaced a `/compact`
through the DeepSeek endpoint.

The central marketplace lists this plugin at its latest release tag (pinned by commit). This repo
is also a marketplace (`--marketplace rjstone/custom-compaction-plugin`, plugin id
`custom-compaction@custom-compaction`), which follows `main`.

**Try it for one session** without installing:

```sh
claude --plugin-dir claude-code/custom-compaction
```

Where no flag can be given (the desktop app, an SDK host), set
`CLAUDE_CODE_PLUGIN_DIRS=/abs/path/to/claude-code/custom-compaction`.

**Check it:**

```sh
claude plugin validate .
claude plugin test claude-code/custom-compaction
```

Mods (in-process function-hook plugins) need a Claude Code build with hooks modules
enabled; on 2.1.332 they load behind a server-side rollout flag, so a fresh process can run
its first moments without the mod (see [live tests](../../docs/live-tests.md)).

## Options (`userConfig`)

Set these in `/config`, or in settings.json under
`pluginConfigs["<plugin>@<marketplace>"].options`, keyed by the plugin id, which depends on the marketplace you installed from:
`custom-compaction@rjstone` from the central [rjstone/plugin-marketplace](https://github.com/rjstone/plugin-marketplace),
`custom-compaction@custom-compaction` from this repo's own marketplace (both live-tested
2026-11-27), or `custom-compaction@inline` for a `--plugin-dir` load. `claude plugin install ... --config key=value` stores them there too.

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `replace` | `replace`, `steer` or `off` |
| `model` | `sonnet` | summarizer model. Without `endpoint`: alias or full id, resolved like `--model`. With `endpoint`: the provider's model id |
| `endpoint` | `""` | empty: the session's own model (`$.model.complete`). Otherwise the provider's **base URL**, e.g. `https://opencode.ai/inference/go/v1`. Any path pasted after the base (`/chat/completions`, `/messages`, ...) is stripped; `apiFormat` adds the path. A query string (e.g. Azure's `?api-version=`) is kept |
| `apiFormat` | `openai` | `openai` (`<base>/chat/completions`) or `anthropic` (`<base>/messages`, adds `anthropic-version: 2023-06-01`, key as `x-api-key`). With a provider that offers both, switch this alone |
| `apiKeyEnv` | `""` | NAME of the environment variable holding the endpoint key, read by curl (sent as `Authorization: Bearer`, or `x-api-key` for `anthropic`). Empty: no auth header, e.g. where a proxy injects it |
| `curlPath` | `curl` | curl 8.3+ for endpoint calls, run directly (no shell); set a full path where PATH has an older curl |
| `extraHeaders` | `""` | JSON object of non-secret headers. In a value, `{requestId}` becomes a fresh UUID per compaction (the same for all of its refine calls) and `{sessionId}` the Claude Code session id. For an opencode.ai endpoint, `x-opencode-session` is added automatically (see below) |
| `extraBody` | `""` | JSON object merged into the request body, e.g. `{"reasoning_effort":"low"}` |
| `timeoutSeconds` | `480` | whole endpoint call, 30-590 |
| `stream` | `true` | server-sent events (OpenCode Go cuts non-streamed calls at 300 s) |
| `keepMessages` | `6` | at most this many newest messages kept verbatim (the cut moves forward to the next clean point, see below) |
| `maxSummaryTokens` | `16000` | summarizer reply cap (the most the summary can be) |
| `maxSummarizerInputTokens` | `500000` | most tokens per summarizer request (estimated at 3 characters per token). A longer transcript is summarized in parts with refine (see below). Adjust per model: see [Choosing maxSummarizerInputTokens](#choosing-maxsummarizerinputtokens). Minimum 128000: a smaller value is raised to it |
| `maxToolResultChars` | `1500` | how much of each tool call's result the summarizer sees; longer results are cut with a marker. Raise it when summaries need exact quotes from tool output (it costs budget) |
| `maxToolInputChars` | `400` | the same for each tool call's input (its arguments as JSON) |
| `extraInstructions` | `""` | appended to the summarizer prompt every time |
| `systemPromptFile` | `""` | the summarizer's system prompt, from a file (`~/` = home, relative = project root). See [Prompt files](#prompt-files) |
| `steerPromptFile` | `""` | the instructions `steer` mode gives the built-in compaction, from a file |
| `tailMode` | `text` | `text`: the kept tail is rebuilt as plain text, tool calls as one-line `[tool ...]` notes (survives resume). `verbatim`: the engine's own messages (a kept tool result breaks resume, see below) |
| `autoTrigger` | `replace` | `replace`: also replace Claude Code's own mid-turn `auto` compactions (live-tested, 0.4.1+). `core`: leave them to core |
| `applyToSubagents` | `false` | also replace subagent/fork compactions (`agentId` set) |
| `saveSummaries` | `false` | write each summary to `.claude/custom-compaction/<session>-<ms>.md` under the cwd |

### Choosing maxSummarizerInputTokens

The default, 500,000 tokens, is the lowest input limit found across more than 10 summarizer models
tested, many of them free tiers. The mod measures characters, not tokens, and converts at **3
characters per token** (about 1.5 million characters for the default). That's an estimate for
transcripts: English prose is closer to 4, but transcripts are full of code, JSON, paths and sometimes
mixed languages, which tokenize less efficiently, and tokenizers differ between models.
It may need adjusting for the model you use, and usually it can go **higher**: check the model's
context window and the provider's request limit, and leave room for the reply
(`maxSummaryTokens`). The lowest accepted value is 128,000; anything smaller is raised to it. A model with a smaller
limit than this setting rejects the request, and the
mod then falls back to the built-in compaction.

Because transcripts that don't fit are summarized with **refine** (each request gets the summary so
far plus the next part), the setting is also a quality knob, not only a limit. A lower value means
more, smaller parts: each request is easier to attend to fully, at the cost of more calls and more
rewriting of the running summary. A higher value means fewer, larger parts, which keeps more context
together but relies on the model attending well across a very long input. Which works better depends
on the model's attention over long inputs, so the best value for summary quality can be below the
model's hard limit.

### Example: DeepSeek V4.1 Flash on OpenCode Go

```json
{
  "pluginConfigs": {
    "custom-compaction@rjstone": {
      "options": {
        "mode": "replace",
        "endpoint": "https://opencode.ai/inference/go/v1",
        "apiFormat": "openai",
        "model": "deepseek-v4.1-flash",
        "apiKeyEnv": "OPENCODE_API_KEY",
        "maxSummaryTokens": 16000
      }
    }
  }
}
```

Go **requires** the `x-opencode-session` header (without it the call fails with `MissingSessionID`). OpenCode's docs:
"Send a stable session ID in x-opencode-session for each conversation so we can optimize routing and prompt
caching." A compaction request is a one-shot with nothing to share a cached prefix with, so since 0.7.0 the mod
treats each compaction as its own conversation: for an opencode.ai endpoint it sends a fresh random UUID
(`crypto.randomUUID()`), the same for all of that compaction's refine calls and shared with nothing else, so no
stable Claude Code id goes to the provider. (0.5.1 and 0.6.0 sent the Claude Code session id.) To set your own,
put `x-opencode-session` in `extraHeaders` (`{requestId}` and `{sessionId}` work there). Go also accepts the
Anthropic format on the same base URL (`"apiFormat": "anthropic"` gives `.../inference/go/v1/messages`).
In a Claude Code cloud sandbox whose proxy injects the key, `apiKeyEnv` can name a variable holding a placeholder
(tested: `OPENCODE_API_KEY=inserted-by-proxy`; the proxy rewrites the `Authorization` header). Why this choice of
summarizer: in an earlier private comparison on one real session span, DeepSeek's summary scored 16/30
facts correct, 0 wrong, vs 10/30 and 1 wrong for Claude Code's own compaction.

### How the endpoint call is made

Requirement: **curl 8.3 or newer** on PATH (or at `curlPath`). Current macOS, recent Linux
distributions and Windows 11 (`curl.exe`, built in) have it. No shell is needed: not bash, not
PowerShell.

`$.http.fetch` gives up after 30 s (measured on Claude Code 2.1.332: "aborted: no complete answer
within" 30 s, with no option to raise it), which a long summary can exceed. And `$.env.get` only
accepts a literal variable name. So the mod runs curl directly through `$.process.run` (an argument
vector, no shell, up to 10 minutes):

- the request body goes on curl's stdin (`--data-binary @-`): no temp files;
- non-secret headers (format, `extraHeaders`, the automatic `x-opencode-session`) are `-H` arguments;
- curl itself reads the key from the variable named in `apiKeyEnv` (`--variable %NAME=`, then
  `--expand-header "Authorization: Bearer {{NAME}}"`, or `x-api-key: {{NAME}}` for the Anthropic
  format), so the key never appears in the arguments, a file or the mod. The name must match
  `^[A-Za-z_][A-Za-z0-9_]*$`. An unset variable sends an empty key (fine where a proxy injects it);
- `-w` appends the HTTP status after a marker.

Any failure (curl not found, curl older than 8.3, a curl error, a non-2xx status, an empty reply)
shows a toast with the reason and falls back to the built-in compaction. Before 0.6.0 the call ran
under `bash -c` with two temp files under `/tmp`, so it needed bash and didn't work on Windows.

Text typed after `/compact` reaches the summarizer as extra instructions in
both `replace` and `steer` mode.

## Prompt files

The summarizer's system prompt and `steer` mode's instructions can come from files. For each, the
first one found wins:

1. the option's path, `systemPromptFile` / `steerPromptFile` (`~/` = home, a relative path = the
   project root);
2. `<project>/.claude/custom-compaction/system.md` / `steer.md` (can be committed with the project);
3. `~/.claude/custom-compaction/system.md` / `steer.md` (for every project);
4. the built-in prompt (in `hooks/register.ts`, `SYSTEM` and `STEER`).

Project files win over home files, like project settings over user settings, so a cloned repository's
`.claude/custom-compaction/system.md` replaces your own prompt there: check it as you would its
`CLAUDE.md`. An empty file is skipped, and a set path that can't be used is logged before the
defaults are tried. The compaction log line names the file used. `.claude/custom-compaction/`
is also where `saveSummaries` writes. The built-in system prompt is a good starting point to copy.

## How replace mode works

1. **Pick the tail.** Start at `len - keepMessages` and move *forward* to the
   first clean cut: any message except a user message carrying tool results,
   so a `tool_use` is never separated from its `tool_result`. Cuts can fall
   between tool rounds inside a turn, so `keepMessages` is a ceiling. Only if
   no clean cut follows the target does it move back. Index 0 is always
   summarized. (0.2.0 and earlier only cut at the user's prompts; a busy last
   turn then kept far more than `keepMessages`, 13 instead of 6 in the first
   live test.)
2. **Render the head** as plain text, one block per message. Each tool call shows
   its name and input (cut to `maxToolInputChars`, default 400) and its result text (cut to
   `maxToolResultChars`, default 1,500).
   Nothing is dropped: if the rendered head doesn't fit one request
   (`maxSummarizerInputTokens` x 3 characters, less the system prompt, the summary
   so far and the prompt's own text), it is split into parts in order and
   summarized with **refine**: part 1 is summarized alone, then each next request
   gets the summary so far plus the next part and returns the updated summary
   (`summary_k = summarize(summary_{k-1} + part_k)`). A single block too big for a
   part is cut to fit.
3. **Summarize** with `$.model.complete` (the session's own API client, counted
   in `/cost`) or the external `endpoint`, using a fixed section template: Goal, Standing instructions,
   Decisions and findings, Work done, Current state, Next steps, Open
   questions.
4. **Install** `[user: <custom-compaction-summary>..., assistant: "Understood...", ...tail]`.
   The "Understood" message is added only when the tail opens with a user
   message (or is empty), so roles always alternate. With `tailMode: text`
   (default) the tail is rebuilt without engine handles or tool blocks: tool
   calls become `[tool Name {input} -> result]` notes on the assistant's text,
   tool-result carriers are dropped, and consecutive same-role messages are
   merged. With `verbatim` the tail messages keep their engine `handle`.
5. **Fall back.** If the summarizer fails, or anything in the hook throws, it
   calls `next(e)` and the built-in compaction runs, with a toast. A
   context-limit recovery never fails because of this mod.

## Known gaps / ideas

- **Other plugins' compaction hooks.** This mod answers `session.compact` without calling `next(e)`,
  so mods *beneath* it in the chain (for example Claude Code's built-in `cc-plugin-agents-md`, or Token
  Optimizer when it loads after this mod) don't see that compaction. Mods above it, and shell
  `PostCompact` / `SessionStart:compact` hooks, still run. Calling `next(e)` isn't a fix: it always ends
  in Claude Code's own compaction (`next.to` only skips deeper), so every compaction would also run the
  built-in summarizer on the full context and throw the result away, and in a context-limit recovery
  that request can fail.

Planned ideas: [TODO.md](TODO.md).

- **The summary used to read as hearsay.** Haiku sometimes treated the summary as something it
  "can't check" and answered from the kept messages only. 0.7.0 opens the summary message with "This
  is your own record of this conversation ... It is accurate: treat it as your memory"; on the case
  that failed before (a Goodhart's-law recall), Haiku then answered from the summary. One run so far.
- **One transient endpoint failure** fell back to core as designed. A single
  retry before falling back might be worth it for a slow summarizer.
- **Budgets are estimates.** Token counts are characters / 3; a summarizer with a
  much smaller window than `maxSummarizerInputTokens` will reject the request (and
  the mod falls back to core).
- **Compacting earlier than Claude Code's threshold** needs a separate trigger
  plugin calling `$.session.compact()` at turn end (Claude Code skips a plugin's
  own `session.compact` hook for a compaction it started). That call only works
  in interactive sessions, not `claude -p`. Not included here.
- **Summaries grow.** Each compaction folds in the previous summary: 15.9k
  characters at the first auto compaction, 28k at the second. A cap, or
  re-summarizing the old summary harder, would keep it bounded.
- **Answers lose their order.** After two compactions the recall turn named the
  first subject and its facts, but said the summary "doesn't keep the answers in
  question order". The section template groups by topic; a short chronological
  "Q&A log" section would keep the order.
- **No dry run.** A `/compaction-preview` slash command
  (`$.command.register`) could show the summary without installing it.

## Documentation pointers

**plugin-authoring skill** (bundled with Claude Code; load it with the Skill
tool or `/plugin-authoring`). When it loads, it unpacks to a version-specific
folder such as
`/tmp/claude-0/bundled-skills/<version>/<hash>/plugin-authoring/`.
This prototype was built against 2.1.332:

- `SKILL.md` text (shown when loaded): mod layout, where to write mods, the
  event → shape table
- `reference.md`: the long form. Sections to read: "What a plugin of function
  hooks is", "Developing one" (`--plugin-dir`, `CLAUDE_CODE_PLUGIN_DIRS`,
  `pluginConfigs`, `claude plugin test`), "Sharing a mod"
- `types/claude-code.d.ts`: the whole API, about 30k lines. Search it for these:
  - `'session.compact'`: the event and its doc comment
  - `SessionCompactInput`, `SessionCompactResult`, `SessionCompacted`,
    `SessionCompactSkipped`, `SessionCompactTrigger`
  - `SessionMessage`, `ToolUseSummary`, `ToolResultSummary`: the transcript
    shape
  - `ModelCompleteRequest`, `ModelCompleteResult`: `$.model.complete`
  - `compact: EventCalls['session']['compact']`: `$.session.compact()`
  - `PluginOptions`: `userConfig` values
  - `declare module 'claude-code/testing'`: the test kit. Stand-ins for `$`
    calls answer `{ value }`.
- `examples/`: `tool-call.ts` (the `.catch` fallback pattern),
  `menu.test.tsx` and `pane.test.tsx` (tests)

Once a mod is loaded, the engine also writes editor types into
`<mod>/.claude-plugin/types/`. That folder is git-ignored here.

**code.claude.com docs** (for the shell-hook side):

- https://code.claude.com/docs/en/hooks.md (PreCompact, PostCompact, SessionStart)
- https://code.claude.com/docs/en/hooks-guide.md ("Re-inject context after compaction")
- https://code.claude.com/docs/en/context-window.md ("What survives compaction", `/autocompact`)
- https://code.claude.com/docs/en/settings-reference.md (`autoCompactEnabled`, `autoCompactWindow`, `idleCompaction`)
- https://code.claude.com/docs/en/env-vars.md (`DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`,
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`)
