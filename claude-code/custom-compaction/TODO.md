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
