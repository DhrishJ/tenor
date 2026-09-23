# Regenerates src/aaveDebtTokens.json from bgd-labs/aave-address-book at a pinned
# commit: every V_TOKEN (variable debt token) per market. Stable debt tokens are
# not listed by the address book (Aave deprecated stable-rate borrowing), so
# historical stable-rate borrows are invisible to the Alchemy fallback.
import base64, json, re, subprocess, sys
SHA = '59e086fd3868'
FILES = {'ethereum': ['AaveV3Ethereum', 'AaveV2Ethereum'], 'arbitrum': ['AaveV3Arbitrum'], 'optimism': ['AaveV3Optimism'],
         'polygon': ['AaveV3Polygon'], 'base': ['AaveV3Base']}
out = {'_source': f'bgd-labs/aave-address-book@{SHA} src/ts/*.ts V_TOKEN', 'chains': {}}
for chain, files in FILES.items():
    toks = set()
    for f in files:
        raw = subprocess.run(['gh', 'api', f'repos/bgd-labs/aave-address-book/contents/src/ts/{f}.ts?ref={SHA}', '--jq', '.content'],
                             capture_output=True, text=True, check=True).stdout
        toks |= set(re.findall(r"V_TOKEN:\s*'(0x[0-9a-fA-F]{40})'", base64.b64decode(raw).decode()))
    out['chains'][chain] = sorted(toks)
json.dump(out, open(sys.argv[1], 'w'), indent=1)
print({k: len(v) for k, v in out['chains'].items()})
