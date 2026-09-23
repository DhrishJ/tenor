# Classify each sampled wallet with Tenor's Phase 2 rules, using ChainScore's
# own per-chain view to decide where the wallet borrowed (HyperSync unreachable).
import json, sys, statistics, collections
S = sys.argv[1]
recs = [json.loads(l) for l in open(f'{S}/dist/raw.jsonl')]
by = collections.defaultdict(dict)
for r in recs: by[r['address']][r['chain']] = r
def tier(s):
    return 'A' if s>=774 else 'B' if s>=643 else 'C' if s>=578 else 'D' if s>=452 else 'FLOOR'
out = []
for a, cs in by.items():
    borrowed, unknown, fails, scores = [], [], [], {}
    for c, r in cs.items():
        b = r['body']
        if r['status'] != 200 or not isinstance(b, dict) or 'score' not in b:
            unknown.append((c, f"http {r['status']}")); continue
        deg = b.get('degradedSources') or []
        sees_borrow = ('Aave' in b.get('protocolsUsed', []) or 'Compound' in b.get('protocolsUsed', [])) and not b.get('noBorrowHistory') and not b.get('newWallet')
        if 'aave' in deg or 'compound' in deg:
            unknown.append((c, 'lending source degraded: borrowing unknowable')); continue
        if not sees_borrow: continue
        borrowed.append(c)
        if deg: fails.append((c, f"degraded {','.join(deg)}")); continue
        if b['totalTxns'] == 0 or b['walletAge'] == 0: fails.append((c, 'consistency: empty tx history')); continue
        if not (300 <= b['score'] <= 850): fails.append((c, 'range')); continue
        scores[c] = b['score']
    if not borrowed:
        state = 'INSUFFICIENT_HISTORY' if not unknown else 'INSUFFICIENT_HISTORY*'
    elif fails:
        state = 'UNAVAILABLE'
    else:
        state = 'SCORED'
    out.append({'address': a, 'state': state, 'borrowed': borrowed, 'scores': scores, 'fails': fails, 'unknown': unknown,
                'min': min(scores.values()) if state == 'SCORED' else None,
                'mean': statistics.mean(scores.values()) if state == 'SCORED' else None})
json.dump(out, open(f'{S}/dist/classified.json', 'w'), indent=1)
n = len(out)
print(f'wallets sampled: {n}  (calls: {len(recs)})')
print('states:', dict(collections.Counter(o['state'] for o in out)))
sc = [o for o in out if o['state'] == 'SCORED']
multi = [o for o in sc if len(o['scores']) >= 2]
print(f'SCORED: {len(sc)} (single-chain {len(sc)-len(multi)}, multi-chain {len(multi)})')
print('tiers (SCORED, min rule):', dict(collections.Counter(tier(o['min']) for o in sc)))
print('tiers (multi-chain only):', dict(collections.Counter(tier(o['min']) for o in multi)))
for o in multi:
    print(f"  multi {o['address'][:10]} per-chain {o['scores']} -> min {o['min']} mean {o['mean']:.0f} diff {o['mean']-o['min']:.0f} tier {tier(o['min'])} vs mean-tier {tier(o['mean'])}")
mat = [o for o in multi if o['mean'] - o['min'] >= 50]
print(f'min materially below mean (>=50 pts): {len(mat)} of {len(multi)} multi-chain')
tierdrop = [o for o in multi if tier(o['min']) != tier(o['mean'])]
print(f'min rule changes the tier vs mean: {len(tierdrop)} of {len(multi)}')
print('UNAVAILABLE reasons:', collections.Counter(f[1] for o in out if o['state']=='UNAVAILABLE' for f in o['fails']))
print('UNAVAILABLE chains:', collections.Counter(f[0] for o in out if o['state']=='UNAVAILABLE' for f in o['fails']))
print('unknowable (lending source degraded) by chain:', collections.Counter(u[0] for o in out for u in o['unknown']))
print('borrowing chains seen:', collections.Counter(c for o in out for c in o['borrowed']))
