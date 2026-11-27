// custom-compaction: a Claude Code mod (function-hooks plugin) that takes over
// conversation compaction.
//
// The engine raises `session.compact` before any compaction: `/compact`
// (trigger `manual`), the auto-compact threshold or a prompt-too-long recovery
// (`auto`), a plugin's `$.session.compact()` (`plugin`), or a background
// pre-computation (`precompute`). This hook can
//   - skip it:              return { skip: 'reason' }
//   - steer the built-in:   return next({ ...e, instructions })
//   - replace it:           return { messages } without calling next
// In `replace` mode we summarize `e.messages` with our own prompt and model,
// and hand back [summary, ack, ...recent tail] as the new transcript.
// See README.md in this folder for the design and the docs this is built on.

import type { Register, SessionCompactInput, SessionMessage } from 'claude-code'

type Mode = 'replace' | 'steer' | 'off'

type ApiFormat = 'openai' | 'anthropic'

type Settings = {
  mode: Mode
  model: string
  // External summarizer (empty endpoint = the session's own model via $.model.complete)
  endpoint: string
  apiFormat: ApiFormat
  apiKeyEnv: string
  curlPath: string
  extraHeaders: Record<string, string>
  extraBody: Record<string, unknown>
  timeoutSeconds: number
  stream: boolean
  keepMessages: number
  maxSummaryTokens: number
  extraInstructions: string
  applyToSubagents: boolean
  autoTrigger: 'core' | 'replace'
  tailMode: 'text' | 'verbatim'
  saveSummaries: boolean
  systemPromptFile: string
  steerPromptFile: string
  maxSummarizerInputTokens: number
}

// Characters per token for budgets: an estimate for transcripts. English prose is
// closer to 4, but transcripts are full of code, JSON, paths and mixed
// languages, which tokenize less efficiently.
const CHARS_PER_TOKEN = 3
const MAX_TOOL_INPUT_CHARS = 400
const MAX_TOOL_RESULT_CHARS = 1_500

const SUMMARY_TAG = 'custom-compaction-summary'

const SYSTEM = `You compact long Claude Code agent sessions. You receive a transcript and write the
memory the agent will continue from: after this, the agent sees ONLY your summary plus
a few of the most recent messages. Anything you leave out is gone.

Write in terse Markdown with exactly these sections:

## Goal
What the user ultimately wants, in their own terms. Quote key instructions verbatim.

## Standing instructions and preferences
Rules the user set for how to work (style, tools, branches, things to avoid). Verbatim where short.

## Decisions and findings
What was established, chosen, ruled out, and why. Include exact names, paths, commands, ids, URLs, numbers.

## Work done
Files created/changed (paths), commands that mattered and their outcome, commits/pushes.

## Current state
Where things stand right now, including anything half-finished or failing (with the error text).

## Next steps
The concrete next actions, in order.

## Open questions
Anything waiting on the user.

Do not invent details. Prefer exact identifiers over paraphrase. No preamble.`

const STEER = `Use these sections: Goal; Standing instructions and preferences; Decisions and findings;
Work done (paths, commands, commits); Current state (including failures, with error text); Next steps;
Open questions. Keep exact names, paths, ids and numbers. Quote the user's key instructions verbatim.`

function settingsFrom(options: Record<string, unknown>): Settings {
  const mode = options.mode
  return {
    mode: mode === 'steer' || mode === 'off' ? mode : 'replace',
    model: typeof options.model === 'string' && options.model ? options.model : 'sonnet',
    endpoint: typeof options.endpoint === 'string' ? options.endpoint.trim() : '',
    apiFormat: options.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
    apiKeyEnv: typeof options.apiKeyEnv === 'string' ? options.apiKeyEnv.trim() : '',
    curlPath: typeof options.curlPath === 'string' && options.curlPath.trim() && !/[\r\n]/.test(options.curlPath) ? options.curlPath.trim() : 'curl',
    extraHeaders: jsonObject(options.extraHeaders) as Record<string, string>,
    extraBody: jsonObject(options.extraBody),
    timeoutSeconds: clampInt(options.timeoutSeconds, 30, 590, 480),
    stream: options.stream !== false,
    keepMessages: clampInt(options.keepMessages, 0, 200, 6),
    maxSummaryTokens: clampInt(options.maxSummaryTokens, 512, 64_000, 16_000),
    extraInstructions: typeof options.extraInstructions === 'string' ? options.extraInstructions : '',
    applyToSubagents: options.applyToSubagents === true,
    autoTrigger: options.autoTrigger === 'core' ? 'core' : 'replace',
    tailMode: options.tailMode === 'verbatim' ? 'verbatim' : 'text',
    saveSummaries: options.saveSummaries === true,
    systemPromptFile: typeof options.systemPromptFile === 'string' ? options.systemPromptFile.trim() : '',
    steerPromptFile: typeof options.steerPromptFile === 'string' ? options.steerPromptFile.trim() : '',
    maxSummarizerInputTokens: clampInt(options.maxSummarizerInputTokens, 128_000, 4_000_000, 500_000),
  }
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt
  return Math.min(hi, Math.max(lo, n))
}

/** A userConfig string holding a JSON object; anything else is {}. */
function jsonObject(v: unknown): Record<string, unknown> {
  if (typeof v !== 'string' || !v.trim()) return {}
  try {
    const o = JSON.parse(v)
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// ---- External summarizer endpoint ------------------------------------------------
// $.http.fetch gives up after 30 s (measured: "aborted: no complete answer within"
// 30 s, no option to raise it), and $.env.get only takes a literal variable name. So
// the call runs curl (8.3+) directly through $.process.run (argv, no shell; up to 10
// min): the body goes on stdin, non-secret headers as -H arguments, and curl itself
// reads the key from the variable NAMED in apiKeyEnv (--variable %NAME,
// --expand-header). The key never appears in argv, a file or the mod. No bash, no
// PowerShell, no temp files: the same call on Linux, macOS and Windows (curl.exe).
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export const STATUS_MARK = '\n__CUSTOM_COMPACTION_HTTP__:'

/**
 * `endpoint` is a base URL; `apiFormat` decides the path. Whatever path a user
 * pasted after the base (`/chat/completions`, `/messages`, `/completions`,
 * `/responses`, trailing slashes) is stripped first, so the format always wins
 * (a query string is kept and put back after the path):
 * `https://opencode.ai/inference/go/v1` and `.../v1/chat/completions` both give
 * `.../v1/messages` for `anthropic`.
 */
export function endpointUrl(endpoint: string, apiFormat: ApiFormat): string {
  // Keep the query string (Azure's ?api-version=...) and put it back after the
  // path; drop a #fragment, which has no meaning for an API call.
  const raw = endpoint.trim().replace(/#.*$/, '')
  const q = raw.indexOf('?')
  let base = q >= 0 ? raw.slice(0, q) : raw
  const query = q >= 0 ? raw.slice(q) : ''
  // No scheme: assume https (curl would guess http and send the key in the clear).
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) base = `https://${base}`
  for (;;) {
    const next = base.replace(/\/+$/, '').replace(/\/(?:chat\/completions|completions|messages|responses)$/i, '')
    if (next === base) break
    base = next
  }
  return base + (apiFormat === 'anthropic' ? '/messages' : '/chat/completions') + (query === '?' ? '' : query)
}

/** curl's argument vector for one request (argv[0] is the curl executable). */
export function curlArgs(s: Settings, headers: Record<string, string>): string[] {
  const argv = [s.curlPath, '-sS', '-N', '--max-time', String(s.timeoutSeconds), '-X', 'POST', endpointUrl(s.endpoint, s.apiFormat),
    '-H', 'Content-Type: application/json']
  for (const [k, v] of Object.entries(headers)) argv.push('-H', `${k}: ${v}`)
  if (s.apiKeyEnv) {
    // `%NAME=` reads the environment variable NAME, empty when unset (a proxy may inject the key)
    argv.push('--variable', `%${s.apiKeyEnv}=`, '--expand-header',
      s.apiFormat === 'anthropic' ? `x-api-key: {{${s.apiKeyEnv}}}` : `Authorization: Bearer {{${s.apiKeyEnv}}}`)
  }
  argv.push('--data-binary', '@-', '-w', `${STATUS_MARK}%{http_code}`)
  return argv
}

export type External = { ok: true; text: string; inTokens: number; outTokens: number } | { ok: false; why: string }

export function requestBody(s: Settings, system: string, prompt: string): Record<string, unknown> {
  const base: Record<string, unknown> =
    s.apiFormat === 'anthropic'
      ? { model: s.model, system, messages: [{ role: 'user', content: prompt }], max_tokens: s.maxSummaryTokens }
      : {
          model: s.model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
          max_tokens: s.maxSummaryTokens,
        }
  if (s.stream) {
    base.stream = true
    if (s.apiFormat === 'openai') base.stream_options = { include_usage: true }
  }
  return { ...base, ...s.extraBody }
}

/** Parse a streamed (SSE) or plain JSON reply in either API format. */
export function parseReply(raw: string, fmt: ApiFormat): External {
  let text = ''
  let inTokens = 0
  let outTokens = 0
  const take = (j: Record<string, any>): string | undefined => {
    if (j.error) return typeof j.error === 'string' ? j.error : JSON.stringify(j.error).slice(0, 300)
    if (fmt === 'openai') {
      const c = j.choices?.[0]
      if (typeof c?.delta?.content === 'string') text += c.delta.content
      if (typeof c?.message?.content === 'string') text += c.message.content
      if (j.usage) { inTokens = j.usage.prompt_tokens ?? inTokens; outTokens = j.usage.completion_tokens ?? outTokens }
    } else {
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') text += j.delta.text ?? ''
      // Input tokens: Anthropic reports them in message_start; some gateways (OpenCode Go) send 0
      // there and the real count in message_delta. Take the larger, counting cache reads/writes.
      const inOf = (u: any) => (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)
      if (j.type === 'message_start') inTokens = Math.max(inTokens, inOf(j.message?.usage))
      if (j.type === 'message_delta') { outTokens = j.usage?.output_tokens ?? outTokens; inTokens = Math.max(inTokens, inOf(j.usage)) }
      if (j.type === 'message' && Array.isArray(j.content)) {
        text += j.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
        inTokens = j.usage?.input_tokens ?? inTokens; outTokens = j.usage?.output_tokens ?? outTokens
      }
    }
    return undefined
  }
  const lines = raw.split('\n').filter(l => l.startsWith('data:'))
  const chunks = lines.length ? lines.map(l => l.slice(5).trim()).filter(d => d && d !== '[DONE]') : [raw.trim()]
  for (const c of chunks) {
    let j: Record<string, any>
    try { j = JSON.parse(c) } catch { continue }
    const err = take(j)
    if (err) return { ok: false, why: `endpoint error: ${err}` }
  }
  return text.trim() ? { ok: true, text, inTokens, outTokens } : { ok: false, why: 'empty reply from endpoint' }
}

/** Ids a header value can use: `{sessionId}`, and `{requestId}` (fresh per compaction). */
export type HeaderIds = { sessionId: string; requestId: string }

/**
 * The non-secret request headers: the format's own, then `extraHeaders` with
 * `{sessionId}` / `{requestId}` in a value replaced. OpenCode Go wants "a stable
 * session ID in x-opencode-session for each conversation" (routing and prompt
 * caching). A compaction is its own conversation: one fresh id for all of its
 * calls (several with refine), shared with nothing else, so no stable Claude
 * Code id goes to the provider. For an opencode.ai endpoint the mod adds that
 * header itself unless `extraHeaders` sets it. Lines with CR or LF are dropped.
 */
export function resolveHeaders(
  apiFormat: string,
  endpoint: string,
  extraHeaders: Record<string, string>,
  ids: HeaderIds,
): Record<string, string> {
  const headers: Record<string, string> = apiFormat === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (typeof v !== 'string') continue
    const value = v.split('{sessionId}').join(ids.sessionId).split('{requestId}').join(ids.requestId)
    if (!/[\r\n]/.test(k + value)) headers[k] = value
  }
  let host = ''
  try { host = new URL(endpoint).hostname } catch { /* not a URL: no automatic header */ }
  const hasSession = Object.keys(headers).some(k => k.toLowerCase() === 'x-opencode-session')
  if (!hasSession && (host === 'opencode.ai' || host.endsWith('.opencode.ai')) && ids.requestId && !/[\r\n]/.test(ids.requestId)) {
    headers['x-opencode-session'] = ids.requestId
  }
  return headers
}

async function callExternal($: any, s: Settings, system: string, prompt: string, requestId: string): Promise<External> {
  if (s.apiKeyEnv && !ENV_NAME.test(s.apiKeyEnv)) return { ok: false, why: `apiKeyEnv "${s.apiKeyEnv}" is not a variable name` }
  const headers = resolveHeaders(s.apiFormat, endpointUrl(s.endpoint, s.apiFormat), s.extraHeaders, { sessionId: await $.session.id(), requestId })
  let r: { exitCode: number; stdout?: string; stderr?: string }
  try {
    r = await $.process.run(curlArgs(s, headers), {
      stdin: JSON.stringify(requestBody(s, system, prompt)),
      timeoutMs: Math.min(600_000, (s.timeoutSeconds + 10) * 1000),
    })
  } catch (err) {
    return { ok: false, why: `could not run curl ("${s.curlPath}"): ${err instanceof Error ? err.message : String(err)}` }
  }
  const out = r.stdout ?? ''
  const err = (r.stderr ?? '').trim()
  const at = out.lastIndexOf(STATUS_MARK)
  const status = at >= 0 ? Number(out.slice(at + STATUS_MARK.length).trim()) : 0
  const payload = at >= 0 ? out.slice(0, at) : out
  if (r.exitCode !== 0) {
    const old = /variable|expand-header/i.test(err) && /unknown|unrecognized|not supported/i.test(err)
    return { ok: false, why: old ? `curl is older than 8.3 (no --variable); set curlPath to a newer curl` : `curl exit ${r.exitCode}: ${err.slice(0, 200)}` }
  }
  if (status < 200 || status >= 300) return { ok: false, why: `HTTP ${status}: ${payload.trim().slice(0, 200)}` }
  return parseReply(payload, s.apiFormat)
}

function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)} [... ${s.length - max} chars cut]`
}

// A "clean" cut: the tail may start at any message except a user message that
// carries tool results, because a tool_result must stay right after the
// assistant message holding its tool_use. That lets the cut fall between tool
// rounds inside a busy turn, not only at the user's prompts.
function isCleanCut(m: SessionMessage | undefined): boolean {
  return m !== undefined && !(m.role === 'user' && m.toolResults !== undefined && m.toolResults.length > 0)
}

/**
 * Index where the verbatim tail starts; messages before it get summarized.
 * keepMessages is a ceiling: the first clean cut at or after `n - keep` wins,
 * so the tail never holds more than `keep` messages unless no cut exists
 * after the target (then the nearest one before it).
 */
export function tailStart(messages: readonly SessionMessage[], keep: number): number {
  const n = messages.length
  if (keep <= 0 || n === 0) return n
  const target = Math.max(1, n - keep) // never keep everything: index 0 is always summarized
  for (let i = target; i < n; i++) if (isCleanCut(messages[i])) return i
  for (let i = target - 1; i >= 1; i--) if (isCleanCut(messages[i])) return i
  return n
}

/** One text block per message: role, text, tool calls with cut inputs and results. */
export function renderBlocks(messages: readonly SessionMessage[]): string[] {
  return messages.map((m, i) => {
    const lines = [`### [${i}] ${m.role.toUpperCase()}`]
    if (m.text) lines.push(m.text)
    for (const u of m.toolUses) {
      lines.push(`-> tool ${u.tool} ${cut(JSON.stringify(u.input), MAX_TOOL_INPUT_CHARS)}`)
      if (u.text !== undefined) lines.push(`<- ${u.isError ? 'ERROR ' : ''}${cut(u.text, MAX_TOOL_RESULT_CHARS)}`)
    }
    // A user message's toolResults are skipped: the assistant's toolUses above
    // already carry each call's outcome text.
    return lines.join('\n')
  })
}

/**
 * Groups blocks into chunks of at most `maxChars` (in order, nothing dropped).
 * A single block longer than `maxChars` is cut to fit, with a marker.
 */
export function chunkBlocks(blocks: readonly string[], maxChars: number): string[] {
  const chunks: string[] = []
  let cur = ''
  for (const raw of blocks) {
    const b = raw.length > maxChars ? cut(raw, Math.max(0, maxChars - 40)) : raw
    if (cur && cur.length + 2 + b.length > maxChars) { chunks.push(cur); cur = '' }
    cur = cur ? `${cur}\n\n${b}` : b
  }
  if (cur) chunks.push(cur)
  return chunks
}

export type Part = { index: number; total: number; previous?: string }

/**
 * The summarizer's user prompt. With refine (several chunks), part k > 1 gets
 * the summary so far and asks for it updated with the next part:
 * summary_k = summarize(summary_{k-1} + chunk_k).
 */
export function buildPrompt(transcript: string, s: Settings, e: SessionCompactInput, part: Part = { index: 1, total: 1 }): string {
  const extra = [s.extraInstructions, e.instructions].filter(x => x && x.trim()).join('\n\n')
  const many = part.total > 1
  return [
    part.previous ? `<summary-so-far>\n${part.previous.trim()}\n</summary-so-far>\n` : '',
    many ? `<transcript part="${part.index}" of="${part.total}">` : '<transcript>',
    transcript,
    '</transcript>',
    extra ? `\nAdditional instructions for this summary:\n${extra}` : '',
    part.previous
      ? `\nThis is part ${part.index} of ${part.total} of the transcript; the summary so far covers the parts before it. ` +
        'Write the updated summary: merge in what this part adds or changes, keep everything from the summary so far ' +
        'that still holds, and use the same sections.'
      : many
        ? `\nThis is part 1 of ${part.total} of the transcript; later parts follow in later requests. Write the summary of this part.`
        : '\nWrite the summary now.',
  ].join('\n')
}

/**
 * A prompt file's text, else the built-in. Looked up in order, first found wins:
 * the option's path (`~/` = home, relative = the project root), then
 * `<project>/.claude/custom-compaction/<name>`, then `~/.claude/custom-compaction/<name>`.
 */
async function loadPrompt($: any, optionPath: string, name: string, builtin: string): Promise<{ text: string; from: string }> {
  const home = ((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '').replace(/[\\/]+$/, '')
  let root = ''
  try { root = String(await $.session.root()).replace(/[\\/]+$/, '') } catch { /* no project root */ }
  const abs = (p: string) => (p.startsWith('~/') && home ? `${home}/${p.slice(2)}` : /^([A-Za-z]:[\\/]|[\\/])/.test(p) || !root ? p : `${root}/${p}`)
  const candidates = [
    ...(optionPath ? [abs(optionPath)] : []),
    ...(root ? [`${root}/.claude/custom-compaction/${name}`] : []),
    ...(home ? [`${home}/.claude/custom-compaction/${name}`] : []),
  ]
  for (const [i, path] of candidates.entries()) {
    try {
      if (await $.fs.exists(path)) {
        const text = String(await $.fs.read(path))
        if (text.trim()) return { text, from: path }
      }
    } catch { /* unreadable: try the next */ }
    if (i === 0 && optionPath) $.ui.log(`custom-compaction: prompt file "${optionPath}" not found, empty or unreadable; trying the defaults`)
  }
  return { text: builtin, from: 'built-in' }
}

type Summary = { ok: true; text: string; inTokens: number; outTokens: number } | { ok: false; why: string }

/** One summarizer call: the external endpoint, else the session's own model. */
async function summarize($: any, s: Settings, system: string, prompt: string, requestId: string): Promise<Summary> {
  if (s.endpoint) return callExternal($, s, system, prompt, requestId)
  const r = await $.model.complete({ model: s.model, system, prompt, maxTokens: s.maxSummaryTokens, timeoutMs: 5 * 60_000 })
  if (!r.isAnswered || !r.text.trim()) {
    return { ok: false, why: r.isAnswered ? 'empty reply' : r.reason === 'api-error' ? `api-error ${r.status ?? ''} ${r.error}` : r.reason }
  }
  return { ok: true, text: r.text, inTokens: r.usage.input_tokens, outTokens: r.usage.output_tokens }
}

/**
 * The kept tail rebuilt as plain text: no engine handles, no tool blocks.
 * Why: when a hook hands back kept messages that carry tool results, the
 * engine writes them again with their ORIGINAL parentUuid (a pre-compaction
 * row), so the transcript chain jumps back across the compact boundary and a
 * resumed session reloads the whole old history. Text-only messages without a
 * handle are written fresh and chain correctly. Tool calls become one-line
 * notes on the assistant's text; tool-result carriers are dropped (their
 * outcome is on the call); consecutive same-role messages are merged.
 */
export function textTail(tail: readonly SessionMessage[]): SessionMessage[] {
  const out: SessionMessage[] = []
  for (const m of tail) {
    if (m.role === 'user' && m.toolResults && m.toolResults.length > 0 && !m.text.trim()) continue
    const parts = m.text.trim() ? [m.text.trim()] : []
    for (const u of m.toolUses) {
      const outcome = u.text === undefined ? '' : ` -> ${u.isError ? 'ERROR ' : ''}${cut(u.text.replace(/\s+/g, ' '), 300)}`
      parts.push(`[tool ${u.tool} ${cut(JSON.stringify(u.input), 200)}${outcome}]`)
    }
    if (parts.length === 0) continue
    const text = parts.join('\n')
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role) prev.text = `${prev.text}\n\n${text}`
    else out.push({ role: m.role, text, toolUses: [] })
  }
  return out
}

export const CONTINUE_NOTE =
  '[Compaction happened in the middle of this task. The latest tool calls and their results are shown as notes above. Continue the task from where it stopped.]'

export function replacementMessages(summary: string, tail: readonly SessionMessage[], e: SessionCompactInput): SessionMessage[] {
  const out: SessionMessage[] = [
    {
      role: 'user',
      text:
        `<${SUMMARY_TAG} trigger="${e.trigger}">\n${summary.trim()}\n</${SUMMARY_TAG}>\n\n` +
        'The conversation above this point was compacted by the custom-compaction mod. ' +
        'The summary replaces the earlier messages; the most recent messages follow verbatim.',
      toolUses: [],
    },
    // The ack keeps roles alternating when the tail opens with a user message
    // (or is empty); a tail that opens with an assistant message needs none.
    ...(tail[0]?.role === 'assistant'
      ? []
      : [{
          role: 'assistant' as const,
          text: 'Understood. I have the summary of the earlier conversation and will continue from it.',
          toolUses: [],
        }]),
    // Kept with their engine `handle` (verbatim) or rebuilt as text (text).
    ...tail,
  ]
  // Claude Code's own auto compaction fires inside a turn, right after a tool
  // result arrives and before the next model request. If the transcript ended
  // on that tool result but the new list ends with an assistant message (the
  // text tail folds tool results into the assistant's notes), the next request
  // would end on an assistant turn, which newer models reject (no prefill).
  // End on a user message so the turn can continue.
  const last = e.messages[e.messages.length - 1]
  const endedOnToolResult = last?.role === 'user' && (last.toolResults?.length ?? 0) > 0
  if (endedOnToolResult && out[out.length - 1]?.role === 'assistant') {
    out.push({ role: 'user', text: CONTINUE_NOTE, toolUses: [] })
  }
  return out
}

export const register: Register = (on, options) => {
  const s = settingsFrom(options as Record<string, unknown>)

  on('session.compact', async ($, e, next) => {
    if (s.mode === 'off') return next(e)
    if (e.agentId !== undefined && !s.applyToSubagents) return next(e)

    if (s.mode === 'steer') {
      const steer = await loadPrompt($, s.steerPromptFile, 'steer.md', STEER)
      $.ui.log(`custom-compaction (${e.trigger}): steer mode, instructions from ${steer.from}`, { to: 'debug' })
      const instructions = [steer.text, s.extraInstructions, e.instructions].filter(x => x && x.trim()).join('\n\n')
      return next({ ...e, instructions })
    }

    // replace mode
    if (e.trigger === 'auto' && s.autoTrigger === 'core') {
      // Opt-out (autoTrigger: core): leave core's own mid-turn auto compactions
      // to core. Not needed since 0.4.x: with the text tail and the continue
      // note, hook-answered auto compactions survive resume (README: live tests).
      $.ui.log('custom-compaction: auto compaction left to core (autoTrigger: core)', { to: 'debug' })
      return next(e)
    }
    if (e.trigger === 'precompute') {
      // Core would pre-summarize in the background with its own prompt; we
      // replace every real compaction, so that work would be wasted.
      return { skip: 'custom-compaction replaces compaction' }
    }

    const start = tailStart(e.messages, s.keepMessages)
    const head = e.messages.slice(0, start)
    const tail = s.tailMode === 'verbatim' ? e.messages.slice(start) : textTail(e.messages.slice(start))
    if (head.length === 0) return next(e)

    const system = await loadPrompt($, s.systemPromptFile, 'system.md', SYSTEM)
    // Budget for one request: the transcript part, plus the system prompt, the
    // summary so far (at most maxSummaryTokens) and the prompt's own text.
    const budget = s.maxSummarizerInputTokens * CHARS_PER_TOKEN
    const chunkChars = Math.max(8_000, budget - system.text.length - s.maxSummaryTokens * CHARS_PER_TOKEN - 4_000)
    const chunks = chunkBlocks(renderBlocks(head), chunkChars)
    // One id for the whole compaction (all refine calls), shared with nothing else.
    const requestId = crypto.randomUUID()
    let summary = ''
    let inTokens = 0
    let outTokens = 0
    for (let k = 0; k < chunks.length; k++) {
      const part: Part = { index: k + 1, total: chunks.length, ...(summary ? { previous: summary } : {}) }
      const r = await summarize($, s, system.text, buildPrompt(chunks[k] ?? '', s, e, part), requestId)
      if (!r.ok) {
        const where = chunks.length > 1 ? ` on part ${k + 1} of ${chunks.length}` : ''
        $.ui.toast(`custom-compaction: summarizer failed${where} (${r.why}); using built-in compaction`)
        return next(e)
      }
      summary = r.text
      inTokens += r.inTokens
      outTokens += r.outTokens
    }
    const via = s.endpoint ? ` via ${endpointUrl(s.endpoint, s.apiFormat)}` : ''
    const tokens = `${inTokens} in / ${outTokens} out tokens${via}` +
      (chunks.length > 1 ? `, refine over ${chunks.length} parts` : '') +
      (system.from !== 'built-in' ? `, system prompt from ${system.from}` : '')

    if (s.saveSummaries) {
      const sid = await $.session.id()
      await $.fs.write(`.claude/custom-compaction/${sid}-${Date.now()}.md`, summary)
    }

    $.ui.log(
      `custom-compaction (${e.trigger}): ${head.length} messages -> ${summary.length}-char summary by ${s.model}` +
        ` (${tokens}); kept ${tail.length} recent messages`,
    )

    // No `usage`: that field reports core's own summarizer call; ours is billed by
    // $.model.complete (session ledger) or by the external endpoint's own account.
    return { messages: replacementMessages(summary, tail, e) }
  }).catch(($, e, next) => {
    // Any failure in our hook: fall back to the engine's own compaction so a
    // context-limit recovery never dies because of this mod.
    $.ui.toast('custom-compaction: hook failed; using built-in compaction')
    return next(e)
  })
}
