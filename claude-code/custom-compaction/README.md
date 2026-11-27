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

Status: **prototype, live-tested, 0.6.0** (2026-11-27). It passes `claude plugin validate`
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

**Install** (terminal session):

```
/plugin install custom-compaction --marketplace rjstone/custom-compaction-plugin
```

From a shell: `claude plugin install custom-compaction --marketplace rjstone/custom-compaction-plugin`.
Answer `y` to add the marketplace, then pick a scope (user scope loads it in every later
session). In the desktop app: click + next to the prompt, then Plugins > Add marketplace
`rjstone/custom-compaction-plugin` > Add plugin.

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
`pluginConfigs["<plugin>@<marketplace>"].options`, keyed by the marketplace you installed from:
`custom-compaction@custom-compaction` from this repo's marketplace, `custom-compaction@rjstone` from
[rjstone/plugin-marketplace](https://github.com/rjstone/plugin-marketplace) (both live-tested
2026-11-27), or `custom-compaction@inline` for a `--plugin-dir` load. `claude plugin install ... --config key=value` stores them there too.

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `replace` | `replace`, `steer` or `off` |
| `model` | `sonnet` | summarizer model. Without `endpoint`: alias or full id, resolved like `--model`. With `endpoint`: the provider's model id |
| `endpoint` | `""` | empty: the session's own model (`$.model.complete`). Otherwise the full URL of an OpenAI-compatible `chat/completions` or Anthropic-compatible `messages` endpoint |
| `apiFormat` | `openai` | `openai` or `anthropic` (adds `anthropic-version: 2023-06-01`, key as `x-api-key`) |
| `apiKeyEnv` | `""` | NAME of the environment variable holding the endpoint key, read by curl (sent as `Authorization: Bearer`, or `x-api-key` for `anthropic`). Empty: no auth header, e.g. where a proxy injects it |
| `curlPath` | `curl` | curl 8.3+ for endpoint calls, run directly (no shell); set a full path where PATH has an older curl |
| `extraHeaders` | `""` | JSON object of non-secret headers. `{sessionId}` in a value becomes the Claude Code session id, e.g. `{"x-trace":"cc-{sessionId}"}`. For an opencode.ai endpoint, `x-opencode-session` is added automatically (see below) |
| `extraBody` | `""` | JSON object merged into the request body, e.g. `{"reasoning_effort":"low"}` |
| `timeoutSeconds` | `480` | whole endpoint call, 30-590 |
| `stream` | `true` | server-sent events (OpenCode Go cuts non-streamed calls at 300 s) |
| `keepMessages` | `6` | at most this many newest messages kept verbatim (the cut moves forward to the next clean point, see below) |
| `maxSummaryTokens` | `8000` | summarizer reply cap |
| `extraInstructions` | `""` | appended to the summarizer prompt every time |
| `tailMode` | `text` | `text`: the kept tail is rebuilt as plain text, tool calls as one-line `[tool ...]` notes (survives resume). `verbatim`: the engine's own messages (a kept tool result breaks resume, see below) |
| `autoTrigger` | `replace` | `replace`: also replace Claude Code's own mid-turn `auto` compactions (live-tested, 0.4.1+). `core`: leave them to core |
| `applyToSubagents` | `false` | also replace subagent/fork compactions (`agentId` set) |
| `saveSummaries` | `false` | write each summary to `.claude/custom-compaction/<session>-<ms>.md` under the cwd |

### Example: DeepSeek V4.1 Flash on OpenCode Go

```json
{
  "pluginConfigs": {
    "custom-compaction@custom-compaction": {
      "options": {
        "mode": "replace",
        "endpoint": "https://opencode.ai/inference/go/v1/chat/completions",
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
caching." Since 0.5.1 the mod sends it automatically for an opencode.ai endpoint, set to the Claude Code session id
(stable for the conversation, unique across conversations). To set your own, put `x-opencode-session` in
`extraHeaders` (`{sessionId}` works there). Go also accepts the Anthropic format at `.../inference/go/v1/messages` (`"apiFormat": "anthropic"`).
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

## How replace mode works

1. **Pick the tail.** Start at `len - keepMessages` and move *forward* to the
   first clean cut: any message except a user message carrying tool results,
   so a `tool_use` is never separated from its `tool_result`. Cuts can fall
   between tool rounds inside a turn, so `keepMessages` is a ceiling. Only if
   no clean cut follows the target does it move back. Index 0 is always
   summarized. (0.2.0 and earlier only cut at the user's prompts; a busy last
   turn then kept far more than `keepMessages`, 13 instead of 6 in the first
   live test.)
2. **Render the head** as plain text. Each tool call shows its name and input
   (cut to 400 characters) and its result text (cut to 1,500). If the total
   passes about 400k characters (roughly 100k tokens), the oldest messages after
   the first are dropped and replaced with an "N messages omitted" marker.
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

- **The summary reads as hearsay.** Haiku treated the summary as something it
  "can't check" rather than its own memory. Try rewording the wrapper (for
  example "this is your own record of the conversation so far; rely on it") or
  putting the summary in the assistant's voice.
- **One transient endpoint failure** fell back to core as designed. A single
  retry before falling back might be worth it for a slow summarizer.
- **Rough trimming.** The summarizer budget is a character count, and trimming
  just drops the oldest messages. A better version would summarize in chunks
  (map-reduce), or fold in the previous summary step by step.
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
