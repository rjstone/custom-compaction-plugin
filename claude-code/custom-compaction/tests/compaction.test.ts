// Run with: claude plugin test claude-code/custom-compaction
// Hooks registered on `on` here sit beneath the mod and stand in for the
// engine: `model.complete` fakes the summarizer, `session.compact` fakes the
// built-in compaction (what the mod's next(e) reaches).

import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { chunkBlocks, endpointUrl, resolveHeaders } from '../hooks/register'
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
// Stand-ins for the prompt-file lookup: no HOME, project root /proj, and the
// files given (path -> text).
function promptStubs(on: On, files: Record<string, string> = {}, home?: string) {
  on('env.get', (_, e: any) => ({ value: e.name === 'HOME' ? home : undefined }) as never)
  on('session.root', () => ({ value: '/proj' }) as never)
  on('fs.exists', (_, e: any) => ({ value: Object.hasOwn(files, String(e.path ?? e[0])) }) as never)
  on('fs.read', (_, e: any) => ({ value: files[String(e.path ?? e[0])] ?? '' }) as never)
}
function stubs(on: On, reply: unknown, seen?: { prompt: string; called: boolean }) {
  promptStubs(on)
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
  promptStubs(on)
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
  promptStubs(on)
}

test('endpoint: summary comes from the external call, not $.model.complete', { options: EP }, async ($, on) => {
  const seen = { files: {} as Record<string, string>, argv: '', modelCalled: false }
  endpointStubs(on, SSE_OPENAI + STATUS_MARK + '200', seen)
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'plugin', messages: TRANSCRIPT })
  expect(seen.modelCalled).toBe(false)
  expect(r.messages?.[0]?.text).toContain('EXT SUMMARY')
  const call = JSON.parse(seen.argv) as { argv: string[]; init?: { stdin?: string } }
  const argv = call.argv
  expect(argv[0]).toBe('curl')                                   // no bash, no PowerShell
  expect(argv).toContain('https://example.test/v1/chat/completions')
  expect(argv).toContain('%MY_KEY=')                             // curl reads the variable NAMED in apiKeyEnv
  expect(argv).toContain('Authorization: Bearer {{MY_KEY}}')     // the value never appears
  expect(argv).toContain('x-opencode-session: s1')
  expect(argv.slice(-4)).toEqual(['--data-binary', '@-', '-w', STATUS_MARK + '%{http_code}'])
  const body = call.init?.stdin ?? ''
  expect(body).toContain('"model":"deepseek-v4.1-flash"')
  expect(body).toContain('"reasoning_effort":"low"')
  expect(body).toContain('Build the thing')
  expect(Object.keys(seen.files)).toEqual([])                    // no temp files
})

test('endpoint: curlPath and the anthropic key header', { options: { ...EP, curlPath: 'C:\\tools\\curl.exe', apiFormat: 'anthropic' } }, async ($, on) => {
  const seen = { files: {} as Record<string, string>, argv: '', modelCalled: false }
  endpointStubs(on, 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"A"}}\n' + STATUS_MARK + '200', seen)
  on('session.compact', () => BUILTIN)
  await $.session.compact({ trigger: 'plugin', messages: TRANSCRIPT })
  const argv = (JSON.parse(seen.argv) as { argv: string[] }).argv
  expect(argv[0]).toBe('C:\\tools\\curl.exe')
  expect(argv).toContain('x-api-key: {{MY_KEY}}')
  expect(argv).toContain('anthropic-version: 2023-06-01')
})

test('endpoint: an old curl (no --variable) falls back with a clear reason', { options: EP }, async ($, on) => {
  const toasts: string[] = []
  on('process.run', () => ({ value: { exitCode: 2, stdout: '', stderr: "curl: option --variable: is unknown" } }) as never)
  on('ui.toast', (_, e: any) => { toasts.push(String(e.text ?? e[0])); return { value: undefined } as never })
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.id', () => ({ value: 'sess-123' }) as never)
  promptStubs(on)
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'plugin', messages: TRANSCRIPT })
  expect(r.messages?.[0]?.text).toBe('BUILT-IN SUMMARY')
  expect(toasts.join(' ')).toContain('older than 8.3')
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

test('resolveHeaders: placeholders; automatic x-opencode-session (the request id) for opencode.ai only', async () => {
  const go = 'https://opencode.ai/inference/go/v1'
  const ids = { sessionId: 'S1', requestId: 'R1' }
  expect(resolveHeaders('openai', go, { 'x-opencode-session': 'cc-{sessionId}-{requestId}' }, ids)).toEqual({ 'x-opencode-session': 'cc-S1-R1' })
  expect(resolveHeaders('openai', go, {}, ids)).toEqual({ 'x-opencode-session': 'R1' })
  expect(resolveHeaders('openai', go, { 'X-OpenCode-Session': 'fixed' }, ids)).toEqual({ 'X-OpenCode-Session': 'fixed' })
  expect(resolveHeaders('anthropic', 'https://api.example.com/v1', {}, ids)).toEqual({ 'anthropic-version': '2023-06-01' })
  expect(resolveHeaders('openai', 'https://openrouter.ai/api/v1', { a: 'x\ny' }, ids)).toEqual({})
})

test('endpointUrl: base URL normalized, apiFormat picks the path', async () => {
  const go = 'https://opencode.ai/inference/go/v1'
  expect(endpointUrl(go, 'openai')).toBe(go + '/chat/completions')
  expect(endpointUrl(go + '/', 'anthropic')).toBe(go + '/messages')
  expect(endpointUrl(go + '/chat/completions', 'anthropic')).toBe(go + '/messages')   // pasted full URL: format wins
  expect(endpointUrl(go + '/messages/', 'openai')).toBe(go + '/chat/completions')
  expect(endpointUrl('https://api.anthropic.com/v1/messages?beta=1', 'anthropic')).toBe('https://api.anthropic.com/v1/messages?beta=1')
  expect(endpointUrl('https://x.openai.azure.com/openai/v1/chat/completions?api-version=preview#frag', 'openai'))
    .toBe('https://x.openai.azure.com/openai/v1/chat/completions?api-version=preview')   // query kept, fragment dropped
  expect(endpointUrl('https://x.example/v1/?', 'openai')).toBe('https://x.example/v1/chat/completions')
  expect(endpointUrl('https://api.openai.com/v1/responses', 'openai')).toBe('https://api.openai.com/v1/chat/completions')
  expect(endpointUrl('opencode.ai/inference/go/v1', 'openai')).toBe(go + '/chat/completions')        // no scheme: https
  expect(endpointUrl('http://localhost:8080/v1/', 'openai')).toBe('http://localhost:8080/v1/chat/completions')
})

test('chunkBlocks: in order, nothing dropped, long blocks cut', async () => {
  expect(chunkBlocks(['aaaa', 'bbbb', 'cccc'], 10)).toEqual(['aaaa\n\nbbbb', 'cccc'])
  const [one] = chunkBlocks(['x'.repeat(100)], 60)
  expect((one ?? '').length).toBeLessThanOrEqual(60 + 30)
})

const LONG: SessionMessage[] = [
  // ~480k characters: over one part at the 128k-token minimum budget (~384k characters)
  u('Start: ' + 'a'.repeat(120_000)), a('Reply one ' + 'b'.repeat(120_000)),
  u('Middle: ' + 'c'.repeat(120_000)), a('Reply two ' + 'd'.repeat(120_000)),
  u('Last ask'), a('Last reply'),
]

test('refine: a transcript over budget is summarized in parts, each with the summary so far', { options: { maxSummarizerInputTokens: 2000 /* raised to the 128k minimum */, maxSummaryTokens: 512, keepMessages: 2 } }, async ($, on) => {
  promptStubs(on)
  const prompts: string[] = []
  on('model.complete', (_, e) => { prompts.push(e.prompt); return { value: OK(`SUMMARY-${prompts.length}`) } as never })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'manual', messages: LONG })
  expect(prompts.length).toBeGreaterThan(1)
  expect(prompts[0]).toContain('part="1"')
  expect(prompts[0]).not.toContain('<summary-so-far>')
  expect(prompts[1]).toContain('<summary-so-far>\nSUMMARY-1')
  expect(prompts[1]).toContain('part="2"')
  expect(r.messages?.[0]?.text).toContain(`SUMMARY-${prompts.length}`)   // the last refine step's summary
  expect(prompts.join('')).toContain('Middle:')                          // nothing dropped
})

test('prompt files: <project>/.claude/custom-compaction/system.md replaces the built-in system prompt', async ($, on) => {
  promptStubs(on, { '/proj/.claude/custom-compaction/system.md': 'MY SYSTEM PROMPT' })
  let system = ''
  on('model.complete', (_, e: any) => { system = String(e.system); return { value: OK('S') } as never })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.compact', () => BUILTIN)
  await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
  expect(system).toBe('MY SYSTEM PROMPT')
})

test('endpoint refine: one fresh x-opencode-session for every call of a compaction', { options: { ...EP, endpoint: 'https://opencode.ai/inference/go/v1', extraHeaders: '', maxSummarizerInputTokens: 2000 /* raised to the 128k minimum */, maxSummaryTokens: 512, keepMessages: 2 } }, async ($, on) => {
  const calls: string[][] = []
  on('process.run', (_, e: any) => { calls.push(e.argv); return { value: { exitCode: 0, stdout: SSE_OPENAI + STATUS_MARK + '200', stderr: '' } } as never })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.id', () => ({ value: 'sess-123' }) as never)
  promptStubs(on)
  on('session.compact', () => BUILTIN)
  await $.session.compact({ trigger: 'manual', messages: LONG })
  expect(calls.length).toBeGreaterThan(1)
  const ids = calls.map(argv => argv.find(x => x.startsWith('x-opencode-session: ')) ?? '')
  expect(new Set(ids).size).toBe(1)
  expect(ids[0]).toMatch(/^x-opencode-session: [0-9a-f-]{36}$/)
  expect(ids[0]).not.toContain('sess-123')
  expect(calls[0]).toContain('https://opencode.ai/inference/go/v1/chat/completions')
})

test('parseReply anthropic: input tokens from message_delta when message_start says 0 (OpenCode Go)', async () => {
  const go =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n' +
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n' +
    'data: {"type":"message_delta","usage":{"input_tokens":35,"output_tokens":3,"cache_read_input_tokens":5}}\n\n'
  const r = parseReply(go, 'anthropic')
  expect(r.ok && r.inTokens).toBe(40)
  expect(r.ok && r.outTokens).toBe(3)
})

// ---- prompt-file lookup order and steer prompt file ----
async function systemSeen($: any, on: On, files: Record<string, string>, home?: string): Promise<string> {
  promptStubs(on, files, home)
  let system = ''
  on('model.complete', (_, e: any) => { system = String(e.system); return { value: OK('S') } as never })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.compact', () => BUILTIN)
  await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
  return system
}

test('prompt files: the option path wins over project and home', { options: { systemPromptFile: 'prompts/mine.md' } }, async ($, on) => {
  const s = await systemSeen($, on, {
    '/proj/prompts/mine.md': 'OPTION', '/proj/.claude/custom-compaction/system.md': 'PROJECT', '/h/.claude/custom-compaction/system.md': 'HOME',
  }, '/h')
  expect(s).toBe('OPTION')
})

test('prompt files: a missing option path falls back to the project file', { options: { systemPromptFile: '~/nope.md' } }, async ($, on) => {
  const s = await systemSeen($, on, { '/proj/.claude/custom-compaction/system.md': 'PROJECT', '/h/.claude/custom-compaction/system.md': 'HOME' }, '/h')
  expect(s).toBe('PROJECT')
})

test('prompt files: no project file uses the home file; an empty one is skipped', async ($, on) => {
  const s = await systemSeen($, on, { '/proj/.claude/custom-compaction/system.md': '  \n', '/h/.claude/custom-compaction/system.md': 'HOME' }, '/h')
  expect(s).toBe('HOME')
})

test('prompt files: nothing found uses the built-in system prompt', async ($, on) => {
  const s = await systemSeen($, on, {}, '/h')
  expect(s).toContain('You compact long Claude Code agent sessions')
})

test('steer mode reads its instructions from steer.md', { options: { mode: 'steer' } }, async ($, on) => {
  promptStubs(on, { '/proj/.claude/custom-compaction/steer.md': 'MY STEER RULES' })
  on('ui.log', () => ({ value: undefined }) as never)
  let got = ''
  on('session.compact', (_, e) => { got = e.instructions ?? ''; return BUILTIN })
  await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT, instructions: 'USER ARGS' })
  expect(got).toContain('MY STEER RULES')
  expect(got).not.toContain('Standing instructions')   // the built-in steer text is replaced
  expect(got).toContain('USER ARGS')
})

test('refine: a failure on part 2 falls back to the built-in compaction', { options: { maxSummarizerInputTokens: 2000 /* raised to the 128k minimum */, maxSummaryTokens: 512, keepMessages: 2 } }, async ($, on) => {
  promptStubs(on)
  let calls = 0
  on('model.complete', () => {
    calls++
    return { value: calls === 1 ? OK('PART-1') : { isAnswered: false, reason: 'empty-reply', usage: USAGE } } as never
  })
  const toasts: string[] = []
  on('ui.toast', (_, e: any) => { toasts.push(String(e.text ?? e[0])); return { value: undefined } as never })
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'manual', messages: LONG })
  expect(calls).toBe(2)
  expect(r.messages?.[0]?.text).toBe('BUILT-IN SUMMARY')
  expect(toasts.join(' ')).toContain('on part 2 of')
})

test('maxSummarizerInputTokens below 128k is raised to 128k (one part for a transcript that fits)', { options: { maxSummarizerInputTokens: 2000, keepMessages: 2 } }, async ($, on) => {
  promptStubs(on)
  let calls = 0
  on('model.complete', () => { calls++; return { value: OK('S') } as never })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.compact', () => BUILTIN)
  // ~60k characters: several parts at a literal 2000-token budget, one part at 128k
  const mid: SessionMessage[] = [u('x'.repeat(30_000)), a('y'.repeat(30_000)), u('Last ask'), a('Last reply')]
  await $.session.compact({ trigger: 'manual', messages: mid })
  expect(calls).toBe(1)
})

test('parseReply: a cut-off reply is flagged (finish_reason length / stop_reason max_tokens)', async () => {
  const o = parseReply('data: {"choices":[{"delta":{"content":"half"},"finish_reason":"length"}]}\n\n', 'openai')
  expect(o.ok && o.truncated).toBe(true)
  const a = parseReply('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"half"}}\n\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":9}}\n\n', 'anthropic')
  expect(a.ok && a.truncated).toBe(true)
  expect(parseReply(SSE_OPENAI, 'openai').ok && (parseReply(SSE_OPENAI, 'openai') as any).truncated).toBe(false)
})

test('a summary that used all of maxSummaryTokens is installed with a warning', { options: { maxSummaryTokens: 512 } }, async ($, on) => {
  promptStubs(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'CUT SUMMARY', usage: { ...USAGE, output_tokens: 512 } } }) as never)
  const toasts: string[] = []
  on('ui.toast', (_, e: any) => { toasts.push(String(e.text ?? e[0])); return { value: undefined } as never })
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
  expect(r.messages?.[0]?.text).toContain('CUT SUMMARY')
  expect(toasts.join(' ')).toContain('may be cut off')
})

test('the summary message tells the model it is its own accurate record', async ($, on) => {
  stubs(on, OK('S'))
  on('session.compact', () => BUILTIN)
  const r = await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
  expect(r.messages?.[0]?.text).toStartWith('This is your own record of this conversation')
  expect(r.messages?.[0]?.text).toContain('<custom-compaction-summary trigger="manual">')
})

test('maxToolResultChars / maxToolInputChars set how much of each tool call the summarizer sees', { options: { maxToolResultChars: 3, maxToolInputChars: 5, keepMessages: 2 } }, async ($, on) => {
  const seen = { prompt: '', called: false }
  stubs(on, OK('S'), seen)
  on('session.compact', () => BUILTIN)
  await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
  expect(seen.prompt).toContain('<- fil [... 5 chars cut]')            // "file.txt" cut to 3
  expect(seen.prompt).toContain('-> tool Bash {"com [... 11 chars cut]') // {"command":"ls"} cut to 5
})
