import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { DisabledHistorySource, FallbackHistoryChecker, type ChainHistorySource } from '../src/history.js'

const W = '0x00000000000000000000000000000000000000e5' as Address

describe('HISTORY_PRIMARY=off (P5-O13)', () => {
  it('routes every chain to the fallback and records why the primary failed', async () => {
    const alchemy: ChainHistorySource = {
      name: 'alchemy',
      checkChain: async () => ({ ok: true, aaveBorrows: 1, compoundBorrows: 0, source: 'alchemy', unverified: ['compound'] }),
    }
    const r = await new FallbackHistoryChecker(new DisabledHistorySource(), alchemy).check(W)
    const eth = r.ethereum
    expect(eth.ok).toBe(true)
    if (!eth.ok) return
    expect(eth.source).toBe('alchemy')
    expect(eth.primaryError).toMatch(/HISTORY_PRIMARY=off/)
  })
})
