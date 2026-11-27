# custom-compaction-plugin

Customizable conversation compaction for coding-agent harnesses. Instead of the harness's
built-in "summarize and replace" step, you choose the summarizer (the session's own model or
any OpenAI- or Anthropic-format endpoint), the summary prompt, and how much recent
conversation is kept.

| Harness | Plugin | Status |
| --- | --- | --- |
| Claude Code | [`claude-code/custom-compaction`](claude-code/custom-compaction/) | prototype, live-tested on 2.1.332 |
| others | - | not yet |

## Claude Code

A Claude Code **mod** (in-process function-hook plugin) on the `session.compact` event. It
replaces every compaction Claude Code starts: `/compact`, the auto-compact threshold (also
mid-turn), and plugin-started ones. It falls back to the built-in compaction if the summarizer
fails, and its compactions survive a session resume. For an external endpoint it needs curl 8.3+ (no shell).

Install, at the prompt of a terminal session:

```
/plugin install custom-compaction --marketplace rjstone/custom-compaction-plugin
```

From a shell: `claude plugin install custom-compaction --marketplace rjstone/custom-compaction-plugin`.
Then answer `y` to add the marketplace and pick a scope. Options (summarizer model or endpoint,
kept messages, prompt additions) are in the [plugin README](claude-code/custom-compaction/README.md).

Example: summarize with DeepSeek V4.1 Flash on OpenCode Go, in `~/.claude/settings.json` (the key is
`<plugin>@<marketplace>` for an installed plugin; `/plugin configure custom-compaction@custom-compaction` or
`claude plugin install ... --config key=value` write it for you):

```json
{
  "pluginConfigs": {
    "custom-compaction@custom-compaction": {
      "options": {
        "endpoint": "https://opencode.ai/inference/go/v1/chat/completions",
        "apiFormat": "openai",
        "model": "deepseek-v4.1-flash",
        "apiKeyEnv": "OPENCODE_API_KEY"
      }
    }
  }
}
```

For an opencode.ai endpoint the mod sends OpenCode's `x-opencode-session` header itself, set to the
Claude Code session id (OpenCode asks for a stable id per conversation, for routing and prompt caching).

## Docs

- [docs/design.md](docs/design.md): why a mod and not shell hooks (`PreCompact`/`PostCompact` can't replace the summary)
- [docs/live-tests.md](docs/live-tests.md): headless live tests, manual and auto compactions, two summarizers
- [docs/resume-bug.md](docs/resume-bug.md): why hook-replaced compactions first didn't survive a resume, and the fix
- [tools/live-test/](tools/live-test/): the live-test harness (driver and question generator)

## Layout

```
.claude-plugin/marketplace.json   lists the claude-code/* plugins
claude-code/custom-compaction/    the Claude Code mod
docs/                             findings and design
tools/live-test/                  live-test harness
AGENTS.md, CLAUDE.md              instructions for coding agents working on this repo
```

## License

MIT, see [LICENSE](LICENSE).
