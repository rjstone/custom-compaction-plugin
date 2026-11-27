#!/usr/bin/env python3
# Headless live test for custom-compaction: one `claude -p` process per turn (--session-id, then --resume),
# fixed question script, per-turn context size, compaction lines, final transcript chain check.
# usage: driver.py <run-dir> <questions.json> <mode> [window]
# env:   NOTES_DIR (required: the folder the questions are about), PLUGIN_DIR (default: this repo's
#        claude-code/custom-compaction), EXTRA_PLUGIN_DIRS (colon-separated), AUTO_TRIGGER (core|replace),
#        COMPACT_AT_TOKENS (send /compact once context reaches this), N_COMPACT (stop after this many
#        hook compactions, then 2 turns + a recall question), CONT_SID/START_TURN/Q_OFFSET/INIT_CTX (continue
#        an existing session), OPENCODE_API_KEY (summarizer key; a placeholder where a proxy injects it).
import glob, json, os, re, subprocess, sys, time, uuid
W, QF, MODE = os.path.abspath(sys.argv[1]), sys.argv[2], sys.argv[3]
WINDOW = sys.argv[4] if len(sys.argv) > 4 else '200000'
os.makedirs(W, exist_ok=True)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PLUGIN = os.environ.get('PLUGIN_DIR', os.path.join(REPO, 'claude-code', 'custom-compaction'))
NOTES = os.environ['NOTES_DIR']
EXTRA = [p for p in os.environ.get('EXTRA_PLUGIN_DIRS', '').split(':') if p]
THRESH = int(os.environ.get('COMPACT_AT_TOKENS', '99999999'))
N_COMPACT = int(os.environ.get('N_COMPACT', '3'))
opts = {'mode': MODE, 'saveSummaries': True, 'endpoint': 'https://opencode.ai/inference/go/v1/chat/completions',
        'apiFormat': 'openai', 'model': 'deepseek-v4.1-flash', 'apiKeyEnv': 'OPENCODE_API_KEY',
        'extraHeaders': json.dumps({'User-Agent': 'custom-compaction-live-test'}),  # x-opencode-session: added by the mod
        'maxSummaryTokens': 16000, 'autoTrigger': os.environ.get('AUTO_TRIGGER', 'replace')}
json.dump({'autoCompactWindow': int(WINDOW), 'pluginConfigs': {'custom-compaction': {'options': opts},
           'custom-compaction@inline': {'options': opts}}}, open(f'{W}/settings.json', 'w'), indent=1)
qs = [q.get('prompt') or q['question'] for q in json.load(open(QF))]
sid = os.environ.get('CONT_SID') or str(uuid.uuid4()); open(f'{W}/sid', 'w').write(sid)
START = int(os.environ.get('START_TURN', '1'))
QOFF = int(os.environ.get('Q_OFFSET', '0'))
env = dict(os.environ, OPENCODE_API_KEY='inserted-by-proxy', CLAUDE_CODE_AUTO_COMPACT_WINDOW=WINDOW)
log = open(f'{W}/driver.log', 'a')
def say(*a): print(*a, file=log, flush=True)

def transcript():
    t = glob.glob(os.path.expanduser(f'~/.claude/projects/*/{sid}.jsonl')); return t[0] if t else None

def run(turn, prompt):
    cmd = ['claude', '-p', '--model', 'haiku', '--plugin-dir', PLUGIN] + [x for p in EXTRA for x in ('--plugin-dir', p)] + [ '--settings', f'{W}/settings.json',
           '--add-dir', NOTES, '--allowedTools', 'Read Grep Glob', '--output-format', 'json',
           '--debug-file', f'{W}/debug-{turn:02d}.log'] + (['--session-id', sid] if turn == 1 and START == 1 else ['--resume', sid])
    t = time.time()
    p = subprocess.run(cmd + [prompt], cwd=W, env=env, capture_output=True, text=True, timeout=900, stdin=subprocess.DEVNULL)
    try:
        j = json.loads(p.stdout); res = j.get('result', '') or ''
        if j.get('is_error') or j.get('subtype') not in (None, 'success'): res = f"[RESULT ERROR subtype={j.get('subtype')}] " + res
    except Exception: res = '[RESULT ERROR unparsable] ' + (p.stdout + p.stderr)[-500:]
    return res, time.time() - t

def ctx():
    last = 0
    for line in open(transcript() or os.devnull):
        try: d = json.loads(line)
        except Exception: continue
        u = (d.get('message') or {}).get('usage') if d.get('type') == 'assistant' else None
        if u: last = u.get('input_tokens', 0) + u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0)
    return last

def events(turn):
    try: txt = open(f'{W}/debug-{turn:02d}.log').read()
    except Exception: return []
    pats = [r'session\.compact \((?:auto|manual|plugin)\).*', r'custom-compaction \((?:auto|manual|plugin)\).*',
            r'custom-compaction: auto compaction left to core.*', r'autocompact: [^\n]*level=compact[^\n]*',
            r'.*summarizer failed.*', r'.*hook failed.*', r'hooks module custom-compaction@inline not loaded']
    return [l[:240] for p in pats for l in re.findall(p, txt)]

def chain_check():
    rows = [json.loads(l) for l in open(transcript())]
    idx = {d.get('uuid'): i for i, d in enumerate(rows) if d.get('uuid')}
    bounds = [i for i, d in enumerate(rows) if d.get('subtype') == 'compact_boundary']
    say(f'chain check: {len(rows)} rows, boundaries at {bounds}')
    for k, b in enumerate(bounds):
        end = bounds[k + 1] if k + 1 < len(bounds) else len(rows)
        bad = [(i, idx[rows[i]['parentUuid']]) for i in range(b + 1, end)
               if rows[i].get('parentUuid') in idx and idx[rows[i]['parentUuid']] < b]
        say(f'   boundary {b} ({rows[b].get("compactMetadata", {}).get("trigger")}, preTokens {rows[b].get("compactMetadata", {}).get("preTokens")}): back-links {bad}')
    last = [d for d in rows if d.get('type') in ('user', 'assistant')][-1]
    u, hops = last.get('uuid'), 0
    while u in idx and rows[idx[u]].get('subtype') != 'compact_boundary':
        u = rows[idx[u]].get('parentUuid'); hops += 1
    say(f'   walk back from last message: {hops} hops, ' + ('reached a boundary' if u in idx else 'never reached a boundary'))

compacted_at, MAX, n_plugin, n_core = None, 160, 0, 0
qi, last_ctx = 0, int(os.environ.get('INIT_CTX', '0'))
for turn in range(START, MAX + 1):
    recall = compacted_at and turn > compacted_at + 2
    if recall:
        q = ('Without searching or reading files again: what was the very first subject we discussed in this '
             'conversation, and what were the key points of your answers to the first five questions about it?')
    elif last_ctx >= THRESH:
        q = '/compact'  # between-turn compaction (a plugin can't call $.session.compact() headless)
    else:
        q = qs[(QOFF + qi) % len(qs)]; qi += 1
    res, dt = run(turn, q)
    ev = events(turn)
    last_ctx = ctx()
    say(f'=== turn {turn} ({dt:.0f}s) ctx_after={last_ctx} q#{"RECALL" if recall else ("/compact" if q == "/compact" else (QOFF + qi - 1) % len(qs) + 1)}')
    for l in ev: say('   ', l)
    n_plugin += sum(1 for l in ev if l.startswith(('session.compact (plugin)', 'session.compact (manual)', 'session.compact (auto)')))
    n_core += sum(1 for l in ev if 'level=compact' in l)
    if any(l.startswith(('session.compact (plugin)', 'session.compact (manual)', 'session.compact (auto)')) for l in ev): say(f'*** hook compaction #{n_plugin} at turn {turn}')
    if res.startswith('[RESULT ERROR') or 'API Error' in res: say('!!! turn error:', res[:300].replace(chr(10), ' '))
    if any('level=compact' in l for l in ev): say(f'*** core auto compaction (#{n_core}) at turn {turn}')
    if n_plugin >= N_COMPACT and not compacted_at:
        compacted_at = turn
    if recall:
        open(f'{W}/recall.txt', 'w').write(res); break
chain_check()
say('done; trigger compactions', n_plugin, 'core auto compactions', n_core)
