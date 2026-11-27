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
}

// Roughly 100k tokens of transcript text sent to the summarizer at most.
const MAX_TRANSCRIPT_CHARS = 400_000
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
    extraHeaders: jsonObject(options.extraHeaders) as Record<string, string>,
    extraBody: jsonObject(options.extraBody),
    timeoutSeconds: clampInt(options.timeoutSeconds, 30, 590, 480),
    stream: options.stream !== false,
    keepMessages: clampInt(options.keepMessages, 0, 200, 6),
    maxSummaryTokens: clampInt(options.maxSummaryTokens, 512, 64_000, 8_000),
    extraInstructions: typeof options.extraInstructions === 'string' ? options.extraInstructions : '',
    applyToSubagents: options.applyToSubagents === true,
    autoTrigger: options.autoTrigger === 'core' ? 'core' : 'replace',
    tailMode: options.tailMode === 'verbatim' ? 'verbatim' : 'text',
    saveSummaries: options.saveSummaries === true,
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
// $.http.fetch caps a call at 30 s and $.env.get needs a literal variable name, so the
// endpoint call runs curl through $.process.run (up to 10 min). bash reads the key from
// the variable NAMED in apiKeyEnv (${!name}) and pipes the auth header to curl on stdin
// (-H @-): the key never appears in argv, a file or the mod's own memory.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export const STATUS_MARK = '\n__CUSTOM_COMPACTION_HTTP__:'
export const CURL_SCRIPT = `set -u
url=$1 body=$2 hdrs=$3 keyvar=$4 fmt=$5 maxt=$6
key=""
if [ -n "$keyvar" ]; then key=\${!keyvar:-}; fi
if [ -n "$key" ] && [ "$fmt" = anthropic ]; then printf 'x-api-key: %s\\n' "$key"
elif [ -n "$key" ]; then printf 'Authorization: Bearer %s\\n' "$key"
fi | curl -sS -N --max-time "$maxt" -X POST "$url" -H 'Content-Type: application/json' -H @"$hdrs" -H @- \\
  --data-binary @"$body" -w '${STATUS_MARK.replace('\n', '\\n')}%{http_code}'
rc=$?
rm -f "$body" "$hdrs"
exit $rc`

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
      if (j.type === 'message_start') inTokens = j.message?.usage?.input_tokens ?? inTokens
      if (j.type === 'message_delta') outTokens = j.usage?.output_tokens ?? outTokens
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

/**
 * The non-secret request headers: the format's own, then `extraHeaders` with
 * `{sessionId}` in a value replaced by the Claude Code session id. OpenCode Go
 * wants "a stable session ID in x-opencode-session for each conversation"
 * (routing and prompt caching), so for an opencode.ai endpoint the mod adds
 * that header itself when `extraHeaders` doesn't set it. Header lines with a
 * CR or LF are dropped.
 */
export function resolveHeaders(
  apiFormat: string,
  endpoint: string,
  extraHeaders: Record<string, string>,
  sessionId: string,
): Record<string, string> {
  const headers: Record<string, string> = apiFormat === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (typeof v !== 'string') continue
    const value = v.split('{sessionId}').join(sessionId)
    if (!/[\r\n]/.test(k + value)) headers[k] = value
  }
  let host = ''
  try { host = new URL(endpoint).hostname } catch { /* not a URL: no automatic header */ }
  const hasSession = Object.keys(headers).some(k => k.toLowerCase() === 'x-opencode-session')
  if (!hasSession && (host === 'opencode.ai' || host.endsWith('.opencode.ai')) && sessionId && !/[\r\n]/.test(sessionId)) {
    headers['x-opencode-session'] = sessionId
  }
  return headers
}

async function callExternal($: any, s: Settings, system: string, prompt: string): Promise<External> {
  if (s.apiKeyEnv && !ENV_NAME.test(s.apiKeyEnv)) return { ok: false, why: `apiKeyEnv "${s.apiKeyEnv}" is not a variable name` }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const body = `/tmp/custom-compaction-${id}.body.json`
  const hdrs = `/tmp/custom-compaction-${id}.headers`
  const headers = resolveHeaders(s.apiFormat, s.endpoint, s.extraHeaders, await $.session.id())
  await $.fs.write(hdrs, Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n')
  await $.fs.write(body, JSON.stringify(requestBody(s, system, prompt)))
  const r = await $.process.run(
    ['bash', '-c', CURL_SCRIPT, 'custom-compaction', s.endpoint, body, hdrs, s.apiKeyEnv, s.apiFormat, String(s.timeoutSeconds)],
    { timeoutMs: (s.timeoutSeconds + 10) * 1000 },
  )
  const out: string = r.stdout ?? ''
  const at = out.lastIndexOf(STATUS_MARK)
  const status = at >= 0 ? Number(out.slice(at + STATUS_MARK.length).trim()) : 0
  const payload = at >= 0 ? out.slice(0, at) : out
  if (r.exitCode !== 0) return { ok: false, why: `curl exit ${r.exitCode}: ${(r.stderr ?? '').trim().slice(0, 200)}` }
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

/** The transcript as plain text for the summarizer, within a size budget. */
export function renderTranscript(messages: readonly SessionMessage[], budget = MAX_TRANSCRIPT_CHARS): string {
  const blocks = messages.map((m, i) => {
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
  // Over budget: keep the first block (the original ask) and drop the oldest
  // blocks after it until the rest fits.
  let total = blocks.reduce((a, b) => a + b.length + 2, 0)
  let omitted = 0
  while (total > budget && blocks.length > 2) {
    total -= (blocks[1] ?? '').length + 2
    blocks.splice(1, 1)
    omitted++
  }
  if (omitted > 0) blocks.splice(1, 0, `[... ${omitted} earlier messages omitted to fit the summarizer ...]`)
  return blocks.join('\n\n')
}

export function buildPrompt(transcript: string, s: Settings, e: SessionCompactInput): string {
  const extra = [s.extraInstructions, e.instructions].filter(x => x && x.trim()).join('\n\n')
  return [
    '<transcript>',
    transcript,
    '</transcript>',
    extra ? `\nAdditional instructions for this summary:\n${extra}` : '',
    '\nWrite the summary now.',
  ].join('\n')
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
      const instructions = [STEER, s.extraInstructions, e.instructions].filter(x => x && x.trim()).join('\n\n')
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

    const transcript = renderTranscript(head)
    const prompt = buildPrompt(transcript, s, e)
    let summary: string
    let tokens: string
    if (s.endpoint) {
      const x = await callExternal($, s, SYSTEM, prompt)
      if (!x.ok) {
        $.ui.toast(`custom-compaction: endpoint summarizer failed (${x.why}); using built-in compaction`)
        return next(e)
      }
      summary = x.text
      tokens = `${x.inTokens} in / ${x.outTokens} out tokens via ${s.endpoint}`
    } else {
      const r = await $.model.complete({
        model: s.model,
        system: SYSTEM,
        prompt,
        maxTokens: s.maxSummaryTokens,
        timeoutMs: 5 * 60_000,
      })
      if (!r.isAnswered || !r.text.trim()) {
        const why = r.isAnswered ? 'empty reply' : r.reason === 'api-error' ? `api-error ${r.status ?? ''} ${r.error}` : r.reason
        $.ui.toast(`custom-compaction: summarizer failed (${why}); using built-in compaction`)
        return next(e)
      }
      summary = r.text
      tokens = `${r.usage.input_tokens} in / ${r.usage.output_tokens} out tokens`
    }

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
