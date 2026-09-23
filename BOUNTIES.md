# BOUNTIES

**The test:** a bounty may be CLAIMED only if removing the integration would
break a feature the submission demonstrates. Otherwise it is USED (a README
mention at most) or DECLINED (with a reason).

Sources: the public page (monad.xyz/developers/hackathons/metropolis). The
full list and each bounty's terms are behind the hackathon portal login and
**haven't been read yet** (OBJECTIONS P3-O14).

| Sponsor | Bounty | State | What breaks without it / reason |
|---|---|---|---|
| Envio | $1,000, best use of Envio | **PENDING → CLAIM if built as planned** | HyperIndex: the liquidations feed, the per-wallet loop timeline and the attestation history have no other source. HyperSync: the independent borrowing-history check in the attestation service. Not claimed if the dashboard ends up reading history from direct RPC. |
| Alchemy | $1,000 credits, best projects using Alchemy | **PENDING** | Planned as the second history source (addendum 1.2). The free plan limits it to Aave on 5 of 7 chains (P3-O7). CLAIMED only if the demo shows the fallback answering; otherwise USED. Needs an API key. |
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
