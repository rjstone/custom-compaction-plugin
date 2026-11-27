#!/usr/bin/env python3
# Build a fixed question script: seeded shuffle of NOTES_DIR/*.md, 5 questions per note, each written by a
# model from a random 10-line window. usage: gen_questions.py <seed> <n_notes>  (env NOTES_DIR, OPENCODE_API_KEY)
import glob, json, os, random, subprocess, sys
NOTES = os.environ['NOTES_DIR']
SEED, N_NOTES, PER_NOTE, WIN = int(sys.argv[1]), int(sys.argv[2]), 5, 10
rng = random.Random(SEED)
files = sorted(f for f in glob.glob(f'{NOTES}/*.md') if not f.endswith('README.md'))
rng.shuffle(files)  # Fisher-Yates
out = []
def ask(prompt):
    body = json.dumps({'model': 'deepseek-v4.1-flash', 'max_tokens': 4000,
                       'messages': [{'role': 'user', 'content': prompt}]})
    r = subprocess.run(['curl', '-s', '-m', '240', 'https://opencode.ai/inference/go/v1/chat/completions',
                        '-H', 'Authorization: Bearer ' + os.environ.get('OPENCODE_API_KEY', 'inserted-by-proxy'), '-H', 'x-opencode-session: custom-compaction-qgen',
                        '-H', 'Content-Type: application/json', '--data-binary', '@-'], input=body, capture_output=True, text=True)
    return json.loads(r.stdout)['choices'][0]['message']['content']
for f in files:
    if len(out) >= N_NOTES * PER_NOTE: break
    lines = open(f).read().splitlines()
    if len(lines) < 40: continue
    windows = []
    for _ in range(PER_NOTE):
        s = rng.randrange(0, max(1, len(lines) - WIN))
        windows.append((s + 1, '\n'.join(lines[s:s + WIN])))
    prompt = ('Below are 5 excerpts from one Markdown note in a personal notes folder. For EACH excerpt write one '
              'question a curious reader might ask that the excerpt answers. Rules: never name the file or say '
              '"the note/excerpt"; include one or two distinctive terms from the excerpt so someone searching a '
              'folder of ~100 notes can find it; ask about meaning or reasoning, not trivia; one sentence each. '
              'Reply with ONLY a JSON array of 5 strings.\n\n' +
              '\n\n'.join(f'### Excerpt {i+1} (lines {a}-{a+WIN-1})\n{t}' for i, (a, t) in enumerate(windows)))
    txt = ask(prompt).strip()
    txt = txt[txt.index('['): txt.rindex(']') + 1]
    qs = json.loads(txt)[:PER_NOTE]
    for (a, _), q in zip(windows, qs):
        out.append({'note': os.path.basename(f), 'lines': f'{a}-{a+WIN-1}', 'question': q})
    print(os.path.basename(f), len(qs), file=sys.stderr)
json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), f'questions-seed{SEED}.json'), 'w'), indent=1)
print(len(out), 'questions')
