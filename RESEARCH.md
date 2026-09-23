# RESEARCH: Monad, oracles, indexers, sponsor bounties

Fetched 2026-09-22 (UTC 2026-09-23 01:00). Where it says **verified
onchain**, I called the live RPC myself rather than relying on the docs.
Raw doc snapshots are in the session scratchpad, not committed.

---

## 1. Hackathon facts (official page: monad.xyz/developers/hackathons/metropolis)

| Item | Value |
|---|---|
| Window | 1 Sep to 13 Oct 2026 |
| Submission deadline | 13 Oct. **No time or timezone on the public page.** |
| Judging | 14–27 Oct |
| Winners | 3 Nov |
| Track 01, Onchain Finance & Trading | "Fast settlement makes new financial instruments and fully onchain markets more practical." $30k split among 3 teams |
| Track 04, Trust, Identity & AI Infrastructure | "AI has made identity, provenance, data ownership, and agent trust urgent infrastructure problems." $30k split among 3 |
| Grand Champion | $25k |
| Existing projects | "Yes, if the work you submit is new" |
| Submission | "A working product with a public project profile: a demo, a short write-up, and a link to the code." |
| Envio bounty | $1,000, "Best Use of Envio" |
| Chainlink bounty | $3,000, "Best workflow with CRE" |

**Not on the public page:** judging criteria and weights, video length,
**whether testnet deployment is acceptable**, and detailed bounty
requirements. The portal (`hackathon.monad.xyz`) needs a login, and its
landing page shows **"Monad Chain ID · 143" (mainnet)**. You need to confirm
from inside the portal that a testnet submission is eligible (see PLAN.md,
open question Q4).

## 2. Monad network parameters (docs.monad.xyz, verified onchain)

| | Testnet | Mainnet (reference only; we do not deploy here) |
|---|---|---|
| Chain ID | **10143** (verified via `eth_chainId` on 2 RPCs) | 143 |
| Currency | MON | MON |
| RPC (QuickNode) | `https://testnet-rpc.monad.xyz`, 50 rps, 25 rps for `eth_call`/`eth_estimateGas`, batch 100, archive ✅ | `https://rpc.monad.xyz` |
| RPC (Ankr) | `https://rpc.ankr.com/monad_testnet`, 300 req/10 s, no `debug_*` | |
| RPC (Monad Foundation) | `https://rpc-testnet.monadinfra.com`, 20 rps, no batching | |
| Explorers | `https://testnet.monadvision.com`, `https://testnet.monadscan.com` | monadvision.com, monadscan.com |
| Faucet | `https://faucet.monad.xyz` | |
| Version / revision | v0.15.2 / `MONAD_NINE` | |
| Reset | Testnet was **reset from genesis on 2025-12-16** | |

Canonical testnet contracts (from docs): WMON
`0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541` (verified: has code), Multicall3
`0xcA11bde05977b3631167028862bE2a173976CA11`, Permit2
`0x000000000022d473030f116ddee9f6b43ac78ba3`, CreateX
`0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`.

Circle USDC on testnet (registry `monad-crypto/protocols`):
`0x534b2f3A21130d7a60830c2Df862319e593943A3`. We cannot mint it freely, so the
demo uses a mock.

Live testnet block I sampled: #64,879,295, block gas limit 150,000,000.

**Gotcha: viem's built-in `monadTestnet`** (viem 2.56.8) uses the explorer URL
`testnet.monadexplorer.com`, which the official docs do not list. We define
our own chain object with the documented explorers.

## 3. EVM differences that matter for our Solidity

From `developer-essentials/differences` and `summary`:

1. **Gas is charged on the gas LIMIT, not gas used**
   (`value + gas_price * gas_limit`). Over-padded gas estimates cost users
   real MON. The frontend should use tight, measured gas limits. The docs'
   best-practices page recommends hardcoding the limit for static paths.
2. **Blocks every ~300 ms, but `block.timestamp` has 1-second
   granularity**, so 3–4 consecutive blocks share a timestamp. Time-based
   interest accrual (per second) is fine. Anything that assumes the
   timestamp strictly increases between blocks is wrong.
3. **Finality:** "Blocks are finalized after two blocks (600 ms)."
   Speculative finality comes earlier and "can revert under very rare
   circumstances".
4. Contract size limit 128 KB (initcode 256 KB). This is irrelevant for us;
   we stay far below 24 KB anyway, to stay portable.
5. Storage is warmed per 128-slot page (MIP-8). Normal Solidity layouts
   benefit automatically.
6. **Reserve balance:** EIP-7702-delegated EOAs cannot drop below 10 MON.
   Doesn't affect us unless we use 7702, and we won't.
7. No blob transactions and no global mempool.
8. **Full nodes do not serve arbitrary historical state.** Historical
   `eth_call` requires an archive-capable RPC (QuickNode's testnet RPC
   advertises archive). This is one more reason the dashboard reads history
   from the indexer, not from the chain.
9. `secp256r1` precompile at `0x0100` (EIP-7951). Not needed.

**Toolchain:** Monad's docs require **Foundry ≥ v1.8.0** and recommend
`network = "monad"` in `foundry.toml`, which makes local forge, anvil and cast
use Monad's gas model, opcode pricing and size limits. The default local
hardfork is `MonadTen`; forking testnet auto-selects the live hardfork. The
docs pin no Solidity version. **Foundry is not installed on this machine
yet.** I'll install it with `foundryup` on the first contracts day.

**Verification** (docs guide, testnet variant): Sourcify via BlockVision,
`forge verify-contract <addr> <Name> --chain 10143 --verifier sourcify
--verifier-url https://sourcify-api-monad.blockvision.org/`, or Monadscan
via Etherscan v2 (needs an Etherscan API key). `foundry.toml` needs
`metadata = true`, `metadata_hash = "none"`, `use_literal_content = true`.

## 4. Price oracles on Monad testnet

From `tooling-and-infra/oracles`, checked onchain where noted:

| Provider | Testnet status | Model | Usable for us? |
|---|---|---|---|
| **Pyth** | Price feeds `0x2880aB155794e7179c9eE2e38200202908C17B43` (has code). MON/USD feed id `0x3149…6cd1` | Pull | **Verified onchain:** `getPriceUnsafe(MON/USD)` returns $0.02626, **published 1,287,543 s (~15 days) ago.** Pull oracles are only fresh if *we* push a Hermes update (paying a fee) in the same transaction. Workable, but it adds a Hermes dependency and fee handling to every borrow and liquidation. |
| Stork | `0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62` (has code), includes MON/USD | Pull | Same trade-off as Pyth. |
| Supra | Storage, pull, router and deposit contracts listed | Push + pull | Not checked onchain. |
| RedStone | Push feeds listed for network 10143 (0.5% deviation, 6 h heartbeat) | Push | Addresses are only in a JS app. **Not verified.** |
| Chainlink | Price-feed proxies listed for **mainnet** in the `monad-crypto/protocols` registry; none listed for testnet | Push | **Not available on testnet** as far as I can verify. |

**Conclusion: build a labelled mock oracle behind `IPriceOracle`.** It's
the right call on its merits, not just a fallback:

- Both demo assets are mock ERC20s on testnet, so no real feed prices them.
- The liquidation half of the demo *requires* a controllable price drop.
  No real feed will move on cue during a 3-minute video.

The README will say this openly. A `PythAdapter` behind the same interface
(pricing WMON via MON/USD) is on the cut list as a stretch goal, to show the
interface isn't just decoration.

## 5. Envio HyperIndex

- **Monad testnet is natively supported:** chain 10143, HyperSync
  `https://10143.hypersync.xyz`, HyperRPC `https://10143.rpc.hypersync.xyz`
  (from `docs.envio.dev/docs/HyperIndex/supported-networks`).
- The latest `envio` CLI on npm is **3.12.1** (HyperIndex V3 config schema).
- The Monad docs include an official Envio guide ("transfer notification bot
  with Envio HyperIndex").
- **Hosting:** Envio Cloud's free "Development" plan has a **30-day maximum
  lifespan** and no uptime guarantee. If we deploy around Oct 7, it expires
  around Nov 6, which covers judging (Oct 14–27) and winners (Nov 3). Plan to
  **redeploy on Oct 12** to reset the clock, or self-host
  (`envio start` + Postgres) as a fallback.
- **Bounty fit:** genuine. The dashboard, liquidation feed and
  score-attestation history are exactly an indexer's job, and the brief
  already requires it. We should claim this bounty.

## 6. Chainlink CRE (Runtime Environment)

- Monad Testnet is supported: chain selector name `monad-testnet`.
  Simulation forwarder `0xB9F79d863261869B234c481D1f9A7af84AeAd192`;
  production forwarder listed as `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`.
  Minimum CLI and SDK versions apply (changelog: `evm.MonadTestnet` constant
  added).
- **Deploying a workflow to a live DON requires approval** ("Deploying
  workflows requires approval… run `cre account access`"; Early Access form).
  Local `cre workflow simulate --broadcast` works without approval and writes
  through the *mock* forwarder.
- **Where it would fit honestly:** replace the single attestor key with a CRE
  workflow. An HTTP trigger fetches the score from ChainScore on multiple DON
  nodes, they reach consensus, and the workflow writes a signed report to
  `ScoreRegistry` through the forwarder. That is a real trust improvement
  (no single hot key signs scores), not decoration.
- **Why it's not in the core:**
  - It depends on an approval we don't control and can't schedule.
  - It doubles the attestation surface.
  - All DON nodes still call the same ChainScore API, so the trust gain is
    "no single signing key", not "no trusted scorer". We'd have to say that
    plainly.

  I recommend building the registry so a second attestor type (the CRE
  forwarder) can be added without a redeploy, and putting the CRE workflow on
  the cut list as a stretch goal. **Request Early Access now anyway**; it
  costs nothing.

## 7. Other sponsor bounties (from the public page)

Kuru ($5k × 2), Dynamic ($5k), Alchemy ($1k credits), Perpl ($5k + $3k),
Privy ($5k), Nansen ($5k), Agora ($10k × 2), and others. None of these is
earned by the design as it stands:

- Dynamic and Privy would mean replacing RainbowKit.
- Kuru and Perpl are trading venues.
- Alchemy is used only inside the prior-art scoring pipeline, which isn't
  hackathon work.

**Recommendation: claim Envio; treat CRE as conditional; chase nothing
else.**

## 8. Frontend library versions (npm, 2026-09-22)

| Package | Latest | Note |
|---|---|---|
| viem | 2.56.8 | has `monadTestnet` (id 10143), but see the explorer gotcha above |
| wagmi | 3.7.7 | **RainbowKit 2.2.11 requires `wagmi ^2.9.0`**, so pin wagmi 2.x |
| @rainbow-me/rainbowkit | 2.2.11 | peers: viem 2.x, react ≥18, @tanstack/react-query ≥5 |
| next | 14.x per brief | ChainScore uses 14.2.35 |

## 9. Local toolchain status

| Tool | Status |
|---|---|
| gh | 2.101.0, `~/.local/bin`, logged in as DhrishJ |
| node / npm | v24.21.0 LTS / 11.19.0, `~/.local/node` (sha256 verified) |
| git | `/usr/bin/git`; **global user.name/user.email not set** (needed before the first commit) |
| foundry | not installed (install on first contracts day, must be ≥ 1.8.0) |
| python xgboost/sklearn | not installed (only needed to rerun the stale `ml/train_model.py`) |
| Homebrew | not installed (needs your admin password) |

## 10. Pushback on the brief's framing

"Fast finality is what makes repricing risk per block practical."

A competent judge will poke at this. The score comes from an off-chain
attestation that lasts hours or days. It does not reprice every block, and
nothing in the model changes per block. Here is what Monad's ~300 ms blocks
and ~600 ms finality genuinely enable, and what I'd claim instead:

1. **Health-factor enforcement tracks price in near real time.**
   Undercollateralized loans have a thinner buffer between "healthy" and
   "insolvent" than 150% loans. That makes liquidation latency the dominant
   risk, and short block times directly shrink the window between a price
   move and a liquidation.
2. **Score updates can land on-chain within seconds.** A downgrade (for
   example, a fresh liquidation on Arbitrum) can be pushed on-chain almost
   immediately, and the next borrow is priced off it. Cheap, fast blocks make
   frequent re-attestation economical.
3. **Cheap per-action gas makes per-borrower parameters affordable.** Per-user
   LTV and rate lookups on every action add storage reads that matter less on
   Monad.

I'll write the thesis around (1) and (2).
