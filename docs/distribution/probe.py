# Read-only distribution probe. Discovery of per-chain borrowing comes from
# ChainScore itself (HyperSync unreachable), so this is labelled as such.
import csv, json, random, time, urllib.request, urllib.error, sys
S = sys.argv[1]
rows = list(csv.DictReader(open(sys.argv[2])))
cands = sorted({r['address'].lower() for r in rows if float(r.get('total_borrows') or 0) > 0})
random.seed(20260922)
sample = random.sample(cands, 50)
chains = ['ethereum','arbitrum','optimism','polygon','base','avalanche','scroll']
out = open(f'{S}/dist/raw.jsonl', 'a')
done = {(json.loads(l)['address'], json.loads(l)['chain']) for l in open(f'{S}/dist/raw.jsonl')}
for i, a in enumerate(sample):
    for c in chains:
        if (a, c) in done: continue
        url = f'https://chainscore.dev/api/score/{a}?chain={c}'
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=90) as r:
                    body = json.load(r); status = r.status
                break
            except urllib.error.HTTPError as e:
                status = e.code; body = None
                if e.code == 429: time.sleep(65); continue
                break
            except Exception as e:
                status = 0; body = {'error': str(e)}; break
        out.write(json.dumps({'i': i, 'address': a, 'chain': c, 'status': status, 'body': body}) + '\n'); out.flush()
        time.sleep(3.5)
print('done')
