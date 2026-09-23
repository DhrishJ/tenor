# BOUNTIES

**The test:** a bounty may be CLAIMED only if removing the integration would
break a feature the submission demonstrates. Otherwise it is USED (a README
mention at most) or DECLINED (with a reason).

Sources: the public page (monad.xyz/developers/hackathons/metropolis). The
full list and each bounty's terms are behind the hackathon portal login and
**haven't been read yet** (OBJECTIONS P3-O14).

| Sponsor | Bounty | State | What breaks without it / reason |
|---|---|---|---|
| Envio | $1,000, best use of Envio | **CLAIM (verified locally 2026-09-23; testnet pending)** | HyperIndex: the Activity page's loop strip, timeline and liquidations feed read only from it. Walked in a browser against the local indexer; without it those views are empty. HyperSync: the attestation service's primary independent history check. Risk: HyperSync has been refusing connections from this machine's IP (see RUNNING_LOG). Re-verify both on testnet in Phase 4. |
| Alchemy | $1,000 credits, best projects using Alchemy | **USED (not yet CLAIMED)** | Built and unit-tested as the fallback history source: Aave debt-token mints on 5 chains, partial verification, source attribution. Not yet demonstrated live, because there is no API key. It becomes CLAIMED only when a live run completes SCORED through Alchemy with HyperSync unavailable. |
| Nansen | $5,000 | **DECLINED (for now)** | Preconditions unmet: the distribution check hasn't been run through the pipeline, and the second history source hasn't shipped. Re-evaluated only if both clear early. If used at all: a refusal trigger, never a score input. |
| Perpl | $3,000, analytics / risk tool | **UNKNOWN** | Terms are on the portal and haven't been read. DECLINE if they require Perpl integration. |
| Chainlink | $3,000, best workflow with CRE | **DECLINED (cut list)** | Workflow deployment needs Chainlink's approval (Early Access). Worth requesting at no cost; not built. |
| Privy | $5,000 | **DECLINED** | Embedded wallets create fresh addresses with no borrowing history, exactly what Tenor can't score. The real version (link external wallets, score the set) is a "what's next" item. |
| Dynamic | $5,000 | **DECLINED** | Same reason as Privy. |
| Kuru | $5,000 × 2 | **DECLINED** | A trading venue; Tenor isn't one. |
| Agora | $10,000 × 2 | **DECLINED** | Would require building something Tenor isn't. |
| MetaMask agent plugin, Aurora Intents | n/a | **DECLINED** | Would require building something Tenor isn't. |
| Kimi, Qwen, Hunyuan (AI credits) | n/a | **DECLINED** | Tenor has no AI component, and adding one for a bounty fails the test above. |

## Submission discipline

- Only CLAIMED rows become bounty entries.
- Each CLAIMED row keeps its one-sentence "what breaks without it" answer
  above.
- Separate submission steps per sponsor: unknown until the portal has been
  read.
