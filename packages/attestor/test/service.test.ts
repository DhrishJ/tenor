import { describe, expect, it } from 'vitest'
import { recoverTypedDataAddress } from 'viem'
import { attestationTypes } from '../src/signer.js'
import {
  DOMAIN,
  FakeChainScore,
  FakeHistory,
  FakeRegistry,
  NOW_MS,
  WALLET,
  goodUpstream,
  makeService,
  noHistory,
  withBorrows,
} from './fakes.js'

describe('three states', () => {
  it('INSUFFICIENT_HISTORY: no borrowing anywhere, ChainScore never called, nothing signed', async () => {
    const t = makeService()
    const r = await t.service.attest(WALLET, 'req-1')
    expect(r.state).toBe('INSUFFICIENT_HISTORY')
    expect(t.chainscore.calls).toEqual([])
    expect(t.signCalls()).toBe(0)
    if (r.state === 'INSUFFICIENT_HISTORY') expect(r.excludedChains).toHaveLength(7)
  })

  it('SCORED: minimum across chains with borrowing; other chains excluded with a reason', async () => {
    const t = makeService({
      history: new FakeHistory(withBorrows({ arbitrum: 3, ethereum: 1 })),
      chainscore: new FakeChainScore({ arbitrum: goodUpstream({ score: 812 }), ethereum: goodUpstream({ score: 701 }) }),
    })
    const r = await t.service.attest(WALLET, 'req-1')
    expect(r.state).toBe('SCORED')
    if (r.state !== 'SCORED') return
    expect(r.chainscoreScore).toBe(701)
    expect(r.tenorScore).toBe(701)
    expect(r.adjustments).toEqual([])
    expect(r.tier).toBe('B')
    expect(r.aggregation.rule).toBe('minimum')
    expect(r.contributingChains.map((c) => [c.chain, c.chainscoreScore])).toEqual([
      ['arbitrum', 812],
      ['ethereum', 701],
    ])
    expect(r.excludedChains.map((c) => c.chain).sort()).toEqual(['avalanche', 'base', 'optimism', 'polygon', 'scroll'])
    expect(t.chainscore.calls.sort()).toEqual(['arbitrum', 'ethereum'])
  })

  it('UNAVAILABLE: every history source failed; nothing signed', async () => {
    const h = noHistory()
    for (const k of Object.keys(h) as Array<keyof typeof h>) h[k] = { ok: false, error: 'HyperSync HTTP 502; Alchemy HTTP 503', attempted: ['hypersync', 'alchemy'] }
    const t = makeService({ history: new FakeHistory(h) })
    const r = await t.service.attest(WALLET, 'req-1')
    expect(r.state).toBe('UNAVAILABLE')
    if (r.state === 'UNAVAILABLE') expect(r.reason).toContain('no borrowing-history source answered (tried HyperSync and Alchemy fallback)')
    expect(t.chainscore.calls).toEqual([])
    expect(t.signCalls()).toBe(0)
  })
})

describe('refusal wording names only sources actually tried', () => {
  it('HyperSync only (no fallback configured): does not claim Alchemy was tried', async () => {
    const h = noHistory()
    for (const k of Object.keys(h) as Array<keyof typeof h>) h[k] = { ok: false, error: 'fetch failed', attempted: ['hypersync'] }
    const r = await makeService({ history: new FakeHistory(h) }).service.evaluate(WALLET, 'req-1')
    if (r.state !== 'UNAVAILABLE') throw new Error(r.state)
    expect(r.reason).toContain('(tried HyperSync)')
    expect(r.reason).not.toContain('Alchemy')
  })
})

describe('refusal checks (validate.ts through the service)', () => {
  it('provider health: degraded on a chain the wallet borrowed on names the chain', async () => {
    const t = makeService({
      history: new FakeHistory(withBorrows({ base: 2 })),
      chainscore: new FakeChainScore({ base: goodUpstream({ degradedSources: ['etherscan', 'aave'] }) }),
    })
    const r = await t.service.evaluate(WALLET, 'req-1')
    expect(r.state).toBe('UNAVAILABLE')
    if (r.state === 'UNAVAILABLE') {
      expect(r.reason).toContain('Base data unavailable (etherscan, aave degraded at ChainScore)')
      expect(r.chains[0]?.chain).toBe('base')
    }
  })

  it('provider health: degradation on a chain with no borrowing does not matter (never queried)', async () => {
    const t = makeService({
      history: new FakeHistory(withBorrows({ arbitrum: 3 })),
      chainscore: new FakeChainScore({ arbitrum: goodUpstream(), base: goodUpstream({ degradedSources: ['etherscan'] }) }),
    })
    const r = await t.service.evaluate(WALLET, 'req-1')
    expect(r.state).toBe('SCORED')
    expect(t.chainscore.calls).toEqual(['arbitrum'])
  })

  it('consistency (primary defense): a borrower scored on an empty transaction history is refused', async () => {
    // The Phase 0 case: 850 with totalTxns 0, from a transient empty Etherscan response.
    const t = makeService({
      history: new FakeHistory(withBorrows({ arbitrum: 3 })),
      chainscore: new FakeChainScore({ arbitrum: goodUpstream({ score: 850, totalTxns: 0, walletAge: 0, degradedSources: [] }) }),
    })
    const r = await t.service.attest(WALLET, 'req-1')
    expect(r.state).toBe('UNAVAILABLE')
    if (r.state === 'UNAVAILABLE') expect(r.reason).toContain('failed without reporting it')
    expect(t.signCalls()).toBe(0)
  })

  it('history mismatch: ChainScore says new wallet while borrows exist on-chain', async () => {
    const t = makeService({
      history: new FakeHistory(withBorrows({ ethereum: 4 })),
      chainscore: new FakeChainScore({ ethereum: goodUpstream({ score: 300, newWallet: true, totalTxns: 0, walletAge: 0, protocolsUsed: [] }) }),
    })
    const r = await t.service.evaluate(WALLET, 'req-1')
    expect(r.state).toBe('UNAVAILABLE')
    if (r.state === 'UNAVAILABLE') expect(r.reason).toContain('4 borrow(s) were found on-chain')
  })

  it('range: out-of-range or non-integer scores are refused', async () => {
    for (const score of [299, 851, 700.5]) {
      const t = makeService({
        history: new FakeHistory(withBorrows({ arbitrum: 1 })),
        chainscore: new FakeChainScore({ arbitrum: goodUpstream({ score }) }),
      })
      const r = await t.service.evaluate(WALLET, 'req-1')
      expect(r.state).toBe('UNAVAILABLE')
    }
  })

  it('sentinel: 300 with no supporting protocol history is a failure signal', async () => {
    const t = makeService({
      history: new FakeHistory(withBorrows({ arbitrum: 1 })),
      chainscore: new FakeChainScore({ arbitrum: goodUpstream({ score: 300, protocolsUsed: [] }) }),
    })
    const r = await t.service.evaluate(WALLET, 'req-1')
    expect(r.state).toBe('UNAVAILABLE')
    if (r.state === 'UNAVAILABLE') expect(r.reason).toContain('failure signal')
  })

  it('300 WITH supporting history is a real (low) score, not refused', async () => {
    const t = makeService({
      history: new FakeHistory(withBorrows({ arbitrum: 5 })),
      chainscore: new FakeChainScore({ arbitrum: goodUpstream({ score: 300 }) }),
    })
    const r = await t.service.evaluate(WALLET, 'req-1')
    expect(r.state).toBe('SCORED')
    if (r.state === 'SCORED') expect(r.tier).toBe('FLOOR')
  })

  it('freshness: an implausible upstream computation time is refused', async () => {
    const t = makeService({
      history: new FakeHistory(withBorrows({ arbitrum: 1 })),
      chainscore: new FakeChainScore({ arbitrum: goodUpstream({ timestamp: NOW_MS - 3_600_000 }) }),
    })
    expect((await t.service.evaluate(WALLET, 'req-1')).state).toBe('UNAVAILABLE')
  })

  it('forced failure: ChainScore unreachable -> UNAVAILABLE, nothing signed, refusal logged', async () => {
    const t = makeService({
      history: new FakeHistory(withBorrows({ arbitrum: 3 })),
      chainscore: new FakeChainScore({ arbitrum: { ok: false, error: 'ChainScore unreachable (fetch failed)' } }),
    })
    const r = await t.service.attest(WALLET, 'req-9')
    expect(r.state).toBe('UNAVAILABLE')
    expect(t.signCalls()).toBe(0)
    const log = await t.store.listRefusals(10)
    expect(log[0]).toMatchObject({ requestId: 'req-9', endpoint: 'attest', state: 'UNAVAILABLE' })
    expect(log[0]?.reason).toContain('ChainScore unreachable')
  })

  it('a single bad chain makes the whole wallet UNAVAILABLE (the min cannot skip it)', async () => {
    const t = makeService({
      history: new FakeHistory(withBorrows({ arbitrum: 3, polygon: 1 })),
      chainscore: new FakeChainScore({ arbitrum: goodUpstream({ score: 820 }), polygon: { ok: false, error: 'ChainScore HTTP 500' } }),
    })
    const r = await t.service.evaluate(WALLET, 'req-1')
    expect(r.state).toBe('UNAVAILABLE')
    if (r.state === 'UNAVAILABLE') expect(r.chains.map((c) => c.chain)).toEqual(['polygon'])
  })
})

describe('Tenor policy (itemized, labelled separately from ChainScore)', () => {
  it('one recent Tenor liquidation: -72 points AND a separate tier-C cap; ChainScore score unchanged', async () => {
    const registry = new FakeRegistry()
    registry.record = { lastLiquidatedAt: NOW_MS / 1000 - 3600, liquidationCount: 1, shortfallCount: 0, totalShortfall: 0n }
    const t = makeService({
      registry,
      history: new FakeHistory(withBorrows({ arbitrum: 3 })),
      chainscore: new FakeChainScore({ arbitrum: goodUpstream({ score: 800 }) }),
    })
    const r = await t.service.evaluate(WALLET, 'req-1')
    expect(r.state).toBe('SCORED')
    if (r.state !== 'SCORED') return
    expect(r.chainscoreScore).toBe(800)
    expect(r.adjustments).toEqual([expect.objectContaining({ rule: 'tenor-liquidation-penalty', points: -72 })])
    // 800 - 72 = 728 (B); the policy cap then limits it to tier C.
    expect(r.policyCaps).toEqual([expect.objectContaining({ rule: 'tenor-liquidation-tier-cap', maxScore: 642, maxTier: 'C', binding: true })])
    expect(r.tenorScore).toBe(642)
    expect(r.tier).toBe('C') // was A
  })

  it('shortfall: capped at 451 (FLOOR) and every step itemized', async () => {
    const registry = new FakeRegistry()
    registry.record = { lastLiquidatedAt: NOW_MS / 1000 - 3600, liquidationCount: 1, shortfallCount: 1, totalShortfall: 5n }
    const t = makeService({
      registry,
      history: new FakeHistory(withBorrows({ arbitrum: 3 })),
      chainscore: new FakeChainScore({ arbitrum: goodUpstream({ score: 800 }) }),
    })
    const r = await t.service.evaluate(WALLET, 'req-1')
    if (r.state !== 'SCORED') throw new Error(r.state)
    expect(r.adjustments.map((a) => a.rule)).toEqual(['tenor-liquidation-penalty'])
    expect(r.policyCaps.map((c) => [c.rule, c.binding])).toEqual([
      ['tenor-liquidation-tier-cap', true],
      ['tenor-shortfall-cap', true],
    ])
    expect(r.tenorScore).toBe(451)
    expect(r.tier).toBe('FLOOR')
  })

  it('old liquidations (outside 180 days) carry no penalty', async () => {
    const registry = new FakeRegistry()
    registry.record = { lastLiquidatedAt: NOW_MS / 1000 - 200 * 86400, liquidationCount: 2, shortfallCount: 1, totalShortfall: 1n }
    const t = makeService({
      registry,
      history: new FakeHistory(withBorrows({ arbitrum: 3 })),
      chainscore: new FakeChainScore({ arbitrum: goodUpstream({ score: 800 }) }),
    })
    const r = await t.service.evaluate(WALLET, 'req-1')
    if (r.state !== 'SCORED') throw new Error(r.state)
    expect(r.adjustments).toEqual([])
    expect(r.policyCaps).toEqual([])
    expect(r.tenorScore).toBe(800)
  })

  it('a cap that does not bind is still listed, marked non-binding', async () => {
    const registry = new FakeRegistry()
    registry.record = { lastLiquidatedAt: NOW_MS / 1000 - 3600, liquidationCount: 1, shortfallCount: 0, totalShortfall: 0n }
    const t = makeService({
      registry,
      history: new FakeHistory(withBorrows({ arbitrum: 3 })),
      chainscore: new FakeChainScore({ arbitrum: goodUpstream({ score: 600 }) }),
    })
    const r = await t.service.evaluate(WALLET, 'req-1')
    if (r.state !== 'SCORED') throw new Error(r.state)
    expect(r.tenorScore).toBe(528) // 600 - 72, below the C cap
    expect(r.policyCaps).toEqual([expect.objectContaining({ binding: false })])
    expect(r.tier).toBe('D')
  })
})

describe('feedback loop (P2-O11): after a liquidation, a NEW penalized score is issued', () => {
  it('cached data predating the liquidation is refetched, not reissued', async () => {
    let t0 = NOW_MS
    const chainscore = new FakeChainScore({ arbitrum: () => goodUpstream({ score: 800, timestamp: t0 - 1000 }) })
    const registry = new FakeRegistry()
    const svc = makeService({ registry, chainscore, history: new FakeHistory(withBorrows({ arbitrum: 3 })), now: () => t0 })

    const before = await svc.service.attest(WALLET, 'req-1')
    if (before.state !== 'SCORED') throw new Error(before.state)
    expect(before.tenorScore).toBe(800)

    // Liquidated on Tenor 10 minutes later.
    t0 += 600_000
    registry.nonceValue = 1n
    registry.record = { lastLiquidatedAt: Math.floor(t0 / 1000) - 5, liquidationCount: 1, shortfallCount: 0, totalShortfall: 0n }

    const after = await svc.service.attest(WALLET, 'req-2')
    if (after.state !== 'SCORED') throw new Error(after.state)
    expect(chainscore.calls).toHaveLength(2) // cache bypassed
    expect(after.issuedAt).toBeGreaterThan(registry.record.lastLiquidatedAt)
    expect(after.tenorScore).toBe(642)
    expect(after.signature).not.toBe(before.signature)
  })

  it('an unsubmitted pre-liquidation reservation on the same nonce does not block the new score (found by e2e)', async () => {
    let t0 = NOW_MS
    const chainscore = new FakeChainScore({ arbitrum: () => goodUpstream({ score: 850, timestamp: t0 - 1000 }) })
    const registry = new FakeRegistry()
    const svc = makeService({ registry, chainscore, history: new FakeHistory(withBorrows({ arbitrum: 3 })), now: () => t0 })
    const pre = await svc.service.attest(WALLET, 'req-1') // reserved on nonce 0, never submitted
    if (pre.state !== 'SCORED') throw new Error(pre.state)

    t0 += 60_000 // one minute later, well inside the 15-minute reservation
    registry.record = { lastLiquidatedAt: Math.floor(t0 / 1000) - 5, liquidationCount: 1, shortfallCount: 1, totalShortfall: 1n }
    const post = await svc.service.attest(WALLET, 'req-2') // same nonce 0
    if (post.state !== 'SCORED') throw new Error(`${post.state}: ${'reason' in post ? post.reason : ''}`)
    expect(post.reusedReservation).toBe(false)
    expect(post.tenorScore).toBe(451)
    expect(post.attestation?.nonce).toBe('0')
    expect(post.signature).not.toBe(pre.signature)
  })

  it('a liquidation that lands between evaluation and signing is refused, not signed (best effort)', async () => {
    const registry = new FakeRegistry()
    const rec0 = { lastLiquidatedAt: 0, liquidationCount: 0, shortfallCount: 0, totalShortfall: 0n }
    const rec1 = { lastLiquidatedAt: NOW_MS / 1000, liquidationCount: 1, shortfallCount: 0, totalShortfall: 0n }
    registry.recordSequence = [rec0, rec0, rec1] // evaluation and reservation see none; the pre-sign re-check sees one
    const t = makeService({
      registry,
      history: new FakeHistory(withBorrows({ arbitrum: 3 })),
      chainscore: new FakeChainScore({ arbitrum: goodUpstream() }),
    })
    const r = await t.service.attest(WALLET, 'req-1')
    expect(r.state).toBe('UNAVAILABLE')
    expect(t.signCalls()).toBe(0)
  })
})

describe('signing, nonces and caching', () => {
  const scored = () =>
    makeService({
      history: new FakeHistory(withBorrows({ arbitrum: 3 })),
      chainscore: new FakeChainScore({ arbitrum: goodUpstream({ score: 790 }) }),
    })

  it('signature recovers to the attestor over the exact EIP-712 domain and payload', async () => {
    const t = scored()
    t.registry.nonceValue = 4n
    const r = await t.service.attest(WALLET, 'req-1')
    if (r.state !== 'SCORED' || !r.attestation || !r.signature) throw new Error('not signed')
    expect(r.attestation.nonce).toBe('4')
    expect(r.attestation.score).toBe(790)
    expect(Number(r.attestation.expiresAt) - Number(r.attestation.issuedAt)).toBe(86_400)
    const recovered = await recoverTypedDataAddress({
      domain: DOMAIN,
      types: attestationTypes,
      primaryType: 'ScoreAttestation',
      message: {
        wallet: r.attestation.wallet,
        score: r.attestation.score,
        issuedAt: BigInt(r.attestation.issuedAt),
        expiresAt: BigInt(r.attestation.expiresAt),
        deadline: BigInt(r.attestation.deadline),
        nonce: BigInt(r.attestation.nonce),
        modelVersion: r.attestation.modelVersion,
      },
      signature: r.signature,
    })
    expect(recovered).toBe(t.signer.address)
  })

  it('EIP-712 signing is deterministic: identical payload, identical bytes', async () => {
    const t = scored()
    const a = {
      wallet: WALLET,
      score: 700,
      issuedAt: 1n,
      expiresAt: 2n,
      deadline: 2n,
      nonce: 0n,
      modelVersion: `0x${'11'.repeat(32)}` as const,
    }
    expect(await t.signer.sign(a)).toBe(await t.signer.sign(a))
  })

  it('concurrent requests for one wallet never produce two different signatures on one nonce', async () => {
    const t = scored()
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => t.service.attest(WALLET, `req-${i}`)))
    const sigs = new Set(results.map((r) => (r.state === 'SCORED' ? r.signature : null)))
    expect(sigs.size).toBe(1)
    expect([...sigs][0]).toMatch(/^0x[0-9a-f]{130}$/)
    const reused = results.filter((r) => r.state === 'SCORED' && r.reusedReservation).length
    expect(reused).toBe(7)
  })

  it('a changed score cannot replace a live reservation for the same nonce', async () => {
    let score = 790
    const chainscore = new FakeChainScore({ arbitrum: () => goodUpstream({ score }) })
    const t = makeService({ chainscore, history: new FakeHistory(withBorrows({ arbitrum: 3 })) })
    const first = await t.service.attest(WALLET, 'req-1')
    score = 850
    await t.store.deleteChainScores(WALLET) // force a fresh upstream value
    const second = await t.service.attest(WALLET, 'req-2')
    if (first.state !== 'SCORED' || second.state !== 'SCORED') throw new Error('not scored')
    expect(second.signature).toBe(first.signature)
    expect(second.tenorScore).toBe(790) // reports what was actually signed
    expect(second.reusedReservation).toBe(true)
  })

  it('scores are cached for the TTL: a second request does not call ChainScore', async () => {
    const t = scored()
    await t.service.evaluate(WALLET, 'req-1')
    await t.service.evaluate(WALLET, 'req-2')
    expect(t.chainscore.calls).toEqual(['arbitrum'])
  })

  it('already on-chain and fresh: returns SCORED with nothing to sign', async () => {
    const t = scored()
    const first = await t.service.attest(WALLET, 'req-1')
    if (first.state !== 'SCORED') throw new Error('not scored')
    t.registry.onChain = { score: 790, issuedAt: first.issuedAt, expiresAt: first.expiresAt, isStale: false }
    t.registry.nonceValue = 1n
    const again = await t.service.attest(WALLET, 'req-2')
    if (again.state !== 'SCORED') throw new Error('not scored')
    expect(again.alreadyOnChain).toBe(true)
    expect(again.signature).toBeNull()
  })
})

describe('partial verification (fallback) and Scroll (P3-O7, P3-O15)', () => {
  const hs = (aave: number) => ({ ok: true as const, aaveBorrows: aave, compoundBorrows: 0, source: 'hypersync' as const, unverified: [] as Array<'compound'> })
  const al = (aave: number, unverified: Array<'compound'> = []) => ({ ok: true as const, aaveBorrows: aave, compoundBorrows: 0, source: 'alchemy' as const, unverified, primaryError: 'HyperSync HTTP 429 on chain 1' })
  const down = (chain: string) => ({ ok: false as const, error: `HyperSync timeout; Alchemy fallback does not cover ${chain}`, attempted: ['hypersync', 'alchemy'] as Array<'hypersync' | 'alchemy'> })

  it('HyperSync down: Alchemy completes SCORED; unchecked chains are labelled; the response says which source answered', async () => {
    const h = noHistory()
    h.ethereum = al(0, ['compound'])
    h.arbitrum = al(3)
    h.optimism = al(0)
    h.polygon = al(0)
    h.base = al(0)
    h.avalanche = down('Avalanche')
    h.scroll = down('Scroll')
    const t = makeService({
      history: new FakeHistory(h),
      chainscore: new FakeChainScore({
        arbitrum: goodUpstream({ score: 790 }),
        ethereum: goodUpstream({ score: 300, newWallet: true, totalTxns: 0, walletAge: 0, protocolsUsed: [] }),
        avalanche: goodUpstream({ score: 0, noBorrowHistory: true, protocolsUsed: [] }),
      }),
    })
    const r = await t.service.attest(WALLET, 'req-1')
    if (r.state !== 'SCORED') throw new Error(`${r.state}: ${'reason' in r ? r.reason : ''}`)
    expect(r.signature).toBeTruthy()
    expect(r.history.verification).toBe('partial')
    expect(r.contributingChains).toEqual([expect.objectContaining({ chain: 'arbitrum', verifiedBy: 'alchemy' })])
    const reasons = Object.fromEntries(r.excludedChains.map((c) => [c.chain, c.reason]))
    expect(reasons.avalanche).toContain('unverified')
    expect(reasons.ethereum).toContain('unverified')
    expect(reasons.scroll).toContain('ChainScore does not score Scroll')
    expect(r.history.sources.find((s) => s.chain === 'arbitrum')).toMatchObject({ source: 'alchemy', primaryError: 'HyperSync HTTP 429 on chain 1' })
    expect(t.chainscore.calls).not.toContain('scroll')
  })

  it('a chain only ChainScore could see still lowers the minimum (cannot be hidden)', async () => {
    const h = withBorrows({ arbitrum: 3 })
    h.avalanche = down('Avalanche')
    const t = makeService({
      history: new FakeHistory(h),
      chainscore: new FakeChainScore({ arbitrum: goodUpstream({ score: 820 }), avalanche: goodUpstream({ score: 610 }) }),
    })
    const r = await t.service.evaluate(WALLET, 'req-1')
    if (r.state !== 'SCORED') throw new Error(r.state)
    expect(r.chainscoreScore).toBe(610)
    expect(r.contributingChains.find((c) => c.chain === 'avalanche')?.verifiedBy).toBe('chainscore-only')
  })

  it('borrowing reported only by ChainScore, confirmed nowhere independently -> UNAVAILABLE', async () => {
    const h = noHistory()
    h.avalanche = down('Avalanche')
    const t = makeService({ history: new FakeHistory(h), chainscore: new FakeChainScore({ avalanche: goodUpstream({ score: 700 }) }) })
    const r = await t.service.evaluate(WALLET, 'req-1')
    expect(r.state).toBe('UNAVAILABLE')
    if (r.state === 'UNAVAILABLE') expect(r.reason).toContain('could not be confirmed independently')
  })

  it('verified Scroll borrowing -> UNAVAILABLE naming the cause; ChainScore is never asked about Scroll', async () => {
    const h = withBorrows({ ethereum: 2 })
    h.scroll = hs(4)
    const t = makeService({ history: new FakeHistory(h), chainscore: new FakeChainScore({ ethereum: goodUpstream({ score: 800 }) }) })
    const r = await t.service.attest(WALLET, 'req-1')
    expect(r.state).toBe('UNAVAILABLE')
    if (r.state === 'UNAVAILABLE') {
      expect(r.reason).toContain('ChainScore does not score Scroll')
      expect(r.reason).toContain('issue #21')
    }
    expect(t.chainscore.calls).not.toContain('scroll')
    expect(t.signCalls()).toBe(0)
  })

  it('history results are cached: a second evaluation does not re-query sources', async () => {
    const t = makeService({ history: new FakeHistory(withBorrows({ arbitrum: 3 })), chainscore: new FakeChainScore({ arbitrum: goodUpstream() }) })
    await t.service.evaluate(WALLET, 'req-1')
    await t.service.evaluate(WALLET, 'req-2')
    expect(t.history.calls).toBe(1)
  })
})
