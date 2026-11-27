// Run with: claude plugin test claude-code/custom-compaction
// Hooks registered on `on` here sit beneath the mod and stand in for the
// engine: `model.complete` fakes the summarizer, `session.compact` fakes the
// built-in compaction (what the mod's next(e) reaches).

import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { resolveHeaders } from '../hooks/register'
import type { TestBody } from 'claude-code/testing'

const u = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const a = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [] })
const aTool = (id: string): SessionMessage => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: 'ls' }, text: 'file.txt' }],
})
const uResult = (id: string): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text: 'file.txt', isError: false }],
})

// 0 prompt, 1-2 tool pair, 3 reply, 4 prompt, 5 reply, 6 prompt, 7-8 tool pair, 9 reply
const TRANSCRIPT: SessionMessage[] = [
  u('Build the thing'), aTool('t1'), uResult('t1'), a('Listed files.'),
  u('Now test it'), a('Tested.'),
  u('Ship it'), aTool('t2'), uResult('t2'), a('Shipped.'),
]

const USAGE = { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const BUILTIN = { messages: [u('BUILT-IN SUMMARY')] }

// Stand-ins for the `$` calls the mod makes. A stand-in for a call on `$`
// answers { value }, what that call resolves to. `reply` is the summarizer's
// answer; `seen` collects the prompt it was sent.
type On = Parameters<TestBody>[1]
function stubs(on: On, reply: unknown, seen?: { prompt: string; called: boolean }) {
  on('model.complete', (_, e) => {
    if (seen) { seen.called = true; seen.prompt = e.prompt }
    return { value: reply } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
}
const OK = (text: string) => ({ isAnswered: true, text, usage: USAGE })

test('replace: summarizes the head, keeps a clean tail', { options: { tailMode: 'verbatim' } }, async ($, on) => {
  const seen = { prompt: '', called: false }
  stubs(on, OK('MY SUMMARY'), seen)
  on('session.compact', () => BUILTIN)

  const r = await $.session.compact({ trigger: 'plugin', messages: TRANSCRIPT, instructions: 'keep the URLs' })

  expect(r.skip).toBeUndefined()
  const msgs = r.messages ?? []
  expect(msgs[0]?.text).toContain('MY SUMMARY')
  expect(msgs[1]?.role).toBe('assistant')
  // keepMessages 6 -> tail starts at index 4, a real prompt
  expect(msgs.slice(2).map(m => m.text)).toEqual(TRANSCRIPT.slice(4).map(m => m.text))
  expect(seen.prompt).toContain('Build the thing')
  expect(seen.prompt).toContain('keep the URLs')
  expect(seen.prompt).not.toContain('Ship it')
})

test('replace: tail never starts on a tool_result', { options: { keepMessages: 2, tailMode: 'verbatim' } }, async ($, on) => {
  stubs(on, OK('S'))
  on('session.compact', () => BUILTIN)
  // keep 2 -> target index 8 is a tool_result carrier; the next clean cut is 9
  const r = await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
  const msgs = r.messages ?? []
  expect(msgs.map(m => m.text)).toEqual([expect.stringContaining('<custom-compaction-summary'), 'Shipped.'])
})

test('replace: a busy last turn does not keep more than keepMessages', { options: { keepMessages: 6, tailMode: 'verbatim' } }, async ($, on) => {
  stubs(on, OK('S'))
  on('session.compact', () => BUILTIN)
  // one prompt followed by 6 tool rounds and a reply: 14 messages after the prompt.
  // The old prompt-only rule kept all 15; now the cut falls between tool rounds.
  const busy: SessionMessage[] = [u('Earlier ask'), a('Earlier reply'), u('Do a lot')]
  for (let k = 0; k < 6; k++) busy.push(aTool(`b${k}`), uResult(`b${k}`))
  busy.push(a('Done.'))
  const r = await $.session.compact({ trigger: 'plugin', messages: busy })
  const tail = (r.messages ?? []).filter(m => !m.text.includes('<custom-compaction-summary') && !m.text.startsWith('Understood.'))
  expect(tail.length).toBeLessThanOrEqual(6)
  expect(tail.length).toBeGreaterThan(0)
  expect(tail[0]?.toolResults?.length ?? 0).toBe(0) // never opens on a tool_result
  // roles alternate across the whole new transcript
  const roles = (r.messages ?? []).map(m => m.role)
  for (let k = 1; k < roles.length; k++) expect(roles[k]).not.toBe(roles[k - 1])
})

test('replace: precompute is skipped', async ($, on) => {
  stubs(on, OK('S'))
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'precompute', messages: TRANSCRIPT })
  expect(r.skip).toBeDefined()
})

test('replace: summarizer failure falls back to built-in', async ($, on) => {
  stubs(on, { isAnswered: false, reason: 'empty-reply', usage: USAGE })
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'plugin', messages: TRANSCRIPT })
  expect(r.messages?.[0]?.text).toBe('BUILT-IN SUMMARY')
})

test('subagent compactions pass through by default', async ($, on) => {
  const seen = { prompt: '', called: false }
  stubs(on, OK('S'), seen)
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: TRANSCRIPT })
  expect(seen.called).toBe(false)
  expect(r.messages?.[0]?.text).toBe('BUILT-IN SUMMARY')
})

test('steer mode adds instructions to the built-in compaction', { options: { mode: 'steer', extraInstructions: 'EXTRA' } }, async ($, on) => {
  let got = ''
  on('session.compact', (_, e) => { got = e.instructions ?? ''; return BUILTIN })
  await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT, instructions: 'USER ARGS' })
  expect(got).toContain('Standing instructions')
  expect(got).toContain('EXTRA')
  expect(got).toContain('USER ARGS')
})

test('off mode is a pass-through', { options: { mode: 'off' } }, async ($, on) => {
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
  expect(r.messages?.[0]?.text).toBe('BUILT-IN SUMMARY')
})

// ---- External endpoint (endpoint set: curl via $.process.run instead of $.model.complete) ----
import { parseReply, STATUS_MARK } from '../hooks/register'

const EP = {
  endpoint: 'https://example.test/v1/chat/completions',
  model: 'deepseek-v4.1-flash',
  apiKeyEnv: 'MY_KEY',
  extraHeaders: '{"x-opencode-session":"s1"}',
  extraBody: '{"reasoning_effort":"low"}',
}
const SSE_OPENAI =
  'data: {"choices":[{"delta":{"content":"EXT "}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"SUMMARY"}}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":900,"completion_tokens":40}}\n\ndata: [DONE]\n'

function endpointStubs(on: On, stdout: string, seen: { files: Record<string, string>; argv: string; modelCalled: boolean }) {
  on('fs.write', (_, e: any) => { seen.files[String(e.path ?? e[0])] = String(e.text ?? e.content ?? e[1]); return { value: undefined } as never })
  on('process.run', (_, e: any) => { seen.argv = JSON.stringify(e); return { value: { exitCode: 0, stdout, stderr: '' } } as never })
  on('model.complete', () => { seen.modelCalled = true; return { value: OK('SHOULD NOT BE USED') } as never })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.id', () => ({ value: 'sess-123' }) as never)
}

test('endpoint: summary comes from the external call, not $.model.complete', { options: EP }, async ($, on) => {
  const seen = { files: {} as Record<string, string>, argv: '', modelCalled: false }
  endpointStubs(on, SSE_OPENAI + STATUS_MARK + '200', seen)
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'plugin', messages: TRANSCRIPT })
  expect(seen.modelCalled).toBe(false)
  expect(r.messages?.[0]?.text).toContain('EXT SUMMARY')
  expect(seen.argv).toContain('https://example.test/v1/chat/completions')
  expect(seen.argv).toContain('MY_KEY')            // the variable NAME, never a value
  const body = Object.values(seen.files).find(t => t.includes('"messages"')) ?? ''
  expect(body).toContain('"model":"deepseek-v4.1-flash"')
  expect(body).toContain('"reasoning_effort":"low"')
  expect(body).toContain('Build the thing')
  expect(Object.values(seen.files).some(t => t.includes('x-opencode-session: s1'))).toBe(true)
})

test('endpoint: HTTP error falls back to built-in', { options: EP }, async ($, on) => {
  const seen = { files: {} as Record<string, string>, argv: '', modelCalled: false }
  endpointStubs(on, '{"error":"unauthorized"}' + STATUS_MARK + '401', seen)
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'plugin', messages: TRANSCRIPT })
  expect(r.messages?.[0]?.text).toBe('BUILT-IN SUMMARY')
})

test('endpoint: a bad apiKeyEnv name is refused before any call', { options: { ...EP, apiKeyEnv: 'X; rm -rf /' } }, async ($, on) => {
  const seen = { files: {} as Record<string, string>, argv: '', modelCalled: false }
  endpointStubs(on, SSE_OPENAI + STATUS_MARK + '200', seen)
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'plugin', messages: TRANSCRIPT })
  expect(seen.argv).toBe('')
  expect(r.messages?.[0]?.text).toBe('BUILT-IN SUMMARY')
})

test('parseReply: openai SSE, anthropic SSE, plain JSON, errors', async () => {
  const o = parseReply(SSE_OPENAI, 'openai')
  expect(o.ok && o.text).toBe('EXT SUMMARY')
  expect(o.ok && o.inTokens).toBe(900)
  const an =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":70}}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"AN"}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n'
  const a = parseReply(an, 'anthropic')
  expect(a.ok && a.text).toBe('AN')           // thinking is not part of the summary
  expect(a.ok && a.outTokens).toBe(5)
  const plain = parseReply('{"choices":[{"message":{"content":"PLAIN"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}', 'openai')
  expect(plain.ok && plain.text).toBe('PLAIN')
  expect(parseReply('data: {"error":{"message":"rate"}}\n', 'openai').ok).toBe(false)
  expect(parseReply('', 'openai').ok).toBe(false)
})

test('autoTrigger: core leaves auto compactions to core', { options: { autoTrigger: 'core' } }, async ($, on) => {
  const seen = { prompt: '', called: false }
  stubs(on, OK('S'), seen)
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })
  expect(seen.called).toBe(false)
  expect(r.messages?.[0]?.text).toBe('BUILT-IN SUMMARY')
})

test('auto compactions are replaced by default', async ($, on) => {
  stubs(on, OK('MY SUMMARY'))
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })
  expect(r.messages?.[0]?.text).toContain('MY SUMMARY')
})

test('tailMode text (default): tail has no handles or tool blocks, roles alternate', async ($, on) => {
  stubs(on, OK('S'))
  on('session.compact', () => BUILTIN)
  const withHandles = TRANSCRIPT.map((m, i) => ({ ...m, handle: `h${i}` }))
  const r = await $.session.compact({ trigger: 'manual', messages: withHandles })
  const msgs = r.messages ?? []
  for (const m of msgs) {
    expect(m.handle).toBeUndefined()
    expect(m.toolUses).toEqual([])
    expect(m.toolResults ?? []).toEqual([])
  }
  for (let k = 1; k < msgs.length; k++) expect(msgs[k]?.role).not.toBe(msgs[k - 1]?.role)
  // index 4.. kept: 'Now test it', 'Tested.', 'Ship it', then the t2 tool round folded into 'Shipped.'
  const last = msgs[msgs.length - 1]?.text ?? ''
  expect(last).toContain('[tool Bash {"command":"ls"} -> file.txt]')
  expect(last).toContain('Shipped.')
})

test('text tail mid tool round (auto, autoTrigger replace): ends on a user continue note', { options: { autoTrigger: 'replace', keepMessages: 3 } }, async ($, on) => {
  stubs(on, OK('S'))
  on('session.compact', () => BUILTIN)
  // ends right after a tool result: where core's auto compaction fires
  const midTurn: SessionMessage[] = [...TRANSCRIPT.slice(0, 7), aTool('t9'), uResult('t9')]
  const r = await $.session.compact({ trigger: 'auto', messages: midTurn })
  const msgs = r.messages ?? []
  expect(msgs[msgs.length - 1]?.role).toBe('user')
  expect(msgs[msgs.length - 1]?.text).toContain('Continue the task')
  expect(msgs[msgs.length - 2]?.text).toContain('[tool Bash')
  for (let k = 1; k < msgs.length; k++) expect(msgs[k]?.role).not.toBe(msgs[k - 1]?.role)
})

test('resolveHeaders: {sessionId} placeholder, automatic x-opencode-session for opencode.ai only', async () => {
  const go = 'https://opencode.ai/inference/go/v1/chat/completions'
  expect(resolveHeaders('openai', go, { 'x-opencode-session': 'cc-{sessionId}' }, 'S1')).toEqual({ 'x-opencode-session': 'cc-S1' })
  expect(resolveHeaders('openai', go, {}, 'S1')).toEqual({ 'x-opencode-session': 'S1' })
  expect(resolveHeaders('openai', go, { 'X-OpenCode-Session': 'fixed' }, 'S1')).toEqual({ 'X-OpenCode-Session': 'fixed' })
  expect(resolveHeaders('anthropic', 'https://api.example.com/v1/messages', {}, 'S1')).toEqual({ 'anthropic-version': '2023-06-01' })
  expect(resolveHeaders('openai', 'https://openrouter.ai/api/v1/chat/completions', { a: 'x\ny' }, 'S1')).toEqual({})
})
