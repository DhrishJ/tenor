import { describe, it } from 'vitest'
import { createTestIndexer } from 'envio'

const CHAIN = 31337
const WALLET = '0x04383b40611ee9408cb6fb8a6bb0d66b07ca7e09'
const LIQUIDATOR = '0x00000000000000000000000000000000000000aa'
const MARKET = '0x00000000000000000000000000000000000000bb'
const TX_LIQ = '0x' + 'ab'.repeat(32)
const MODEL = '0x' + '11'.repeat(32)

const at = (block: number, logIndex: number, tx: string) => ({
  block: { number: block, timestamp: 1_790_000_000 + block },
  logIndex,
  transaction: { hash: tx },
})

describe('Tenor indexer: the feedback loop as history', () => {
  it('attest -> borrow -> liquidation with shortfall -> recorded -> re-attest, in one timeline', async (t) => {
    const indexer = createTestIndexer()
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: 'ScoreRegistry',
              event: 'AttestationSubmitted',
              params: { wallet: WALLET, score: 850n, issuedAt: 100n, expiresAt: 86_500n, nonce: 0n, modelVersion: MODEL, attestorEpoch: 1n },
              ...at(10, 0, '0x' + '01'.repeat(32)),
            },
            {
              contract: 'TenorMarket',
              event: 'Borrowed',
              params: {
                wallet: WALLET,
                amount: 800n * 10n ** 18n,
                debtAfter: 800n * 10n ** 18n,
                score: 850n,
                tier: 4n,
                maxLtvBps: 8000n,
                liqThresholdBps: 8500n,
                collateralPriceWad: 2n * 10n ** 18n,
              },
              ...at(11, 0, '0x' + '02'.repeat(32)),
            },
            // liquidate(): BadDebtRealized, then Liquidated, then the registry's LiquidationRecorded.
            {
              contract: 'TenorMarket',
              event: 'BadDebtRealized',
              params: { wallet: WALLET, amount: 419n * 10n ** 18n, fromReserves: 0n, socialized: 419n * 10n ** 18n },
              ...at(12, 3, TX_LIQ),
            },
            {
              contract: 'TenorMarket',
              event: 'Liquidated',
              params: {
                wallet: WALLET,
                liquidator: LIQUIDATOR,
                repaid: 381n * 10n ** 18n,
                collateralSeized: 500n * 10n ** 18n,
                shortfall: 419n * 10n ** 18n,
                score: 850n,
                tier: 4n,
                liqThresholdBps: 8500n,
                collateralPriceWad: 8n * 10n ** 17n,
              },
              ...at(12, 4, TX_LIQ),
            },
            {
              contract: 'ScoreRegistry',
              event: 'LiquidationRecorded',
              params: {
                wallet: WALLET,
                market: MARKET,
                shortfall: 419n * 10n ** 18n,
                liquidationCount: 1n,
                shortfallCount: 1n,
                totalShortfall: 419n * 10n ** 18n,
                timestamp: 1_790_000_012n,
              },
              ...at(12, 5, TX_LIQ),
            },
            {
              contract: 'ScoreRegistry',
              event: 'AttestationSubmitted',
              params: { wallet: WALLET, score: 451n, issuedAt: 1_790_000_020n, expiresAt: 1_790_086_420n, nonce: 1n, modelVersion: MODEL, attestorEpoch: 1n },
              ...at(20, 0, '0x' + '03'.repeat(32)),
            },
          ],
        },
      },
    })

    const w = await indexer.Wallet.getOrThrow(WALLET)
    t.expect(w).toMatchObject({
      attestationCount: 2,
      latestScore: 451,
      borrowCount: 1,
      liquidationCount: 1,
      shortfallCount: 1,
      totalShortfall: 419n * 10n ** 18n,
      lastLiquidatedAt: 1_790_000_012n,
    })

    const timeline = (await indexer.WalletEvent.getAll())
      .filter((e) => e.wallet_id === WALLET)
      .sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex)
      .map((e) => [e.kind, e.tier ?? null])
    t.expect(timeline).toEqual([
      ['ATTESTED', 'A'],
      ['BORROWED', 'A'],
      ['BAD_DEBT', null],
      ['LIQUIDATED', 'A'],
      ['LIQUIDATION_RECORDED', null],
      ['ATTESTED', 'FLOOR'],
    ])

    const [liq] = await indexer.LiquidationEvent.getAll()
    t.expect(liq).toMatchObject({
      wallet_id: WALLET,
      repaid: 381n * 10n ** 18n,
      shortfall: 419n * 10n ** 18n,
      fromReserves: 0n,
      socialized: 419n * 10n ** 18n,
      tier: 'A',
      txHash: TX_LIQ,
    })

    const totals = await indexer.MarketTotals.getOrThrow('market')
    t.expect(totals).toMatchObject({
      borrowCount: 1,
      borrowVolume: 800n * 10n ** 18n,
      liquidationCount: 1,
      liquidationsWithShortfall: 1,
      badDebt: 419n * 10n ** 18n,
      badDebtSocialized: 419n * 10n ** 18n,
      attestationCount: 2,
    })
  })

  it('a liquidation without shortfall needs no BadDebtRealized join', async (t) => {
    const indexer = createTestIndexer()
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: 'TenorMarket',
              event: 'Liquidated',
              params: {
                wallet: WALLET,
                liquidator: LIQUIDATOR,
                repaid: 400n * 10n ** 18n,
                collateralSeized: 300n * 10n ** 18n,
                shortfall: 0n,
                score: 0n,
                tier: 0n,
                liqThresholdBps: 6500n,
                collateralPriceWad: 14n * 10n ** 17n,
              },
              ...at(5, 1, '0x' + '09'.repeat(32)),
            },
          ],
        },
      },
    })
    const [liq] = await indexer.LiquidationEvent.getAll()
    t.expect(liq).toMatchObject({ shortfall: 0n, fromReserves: 0n, socialized: 0n, tier: 'FLOOR' })
  })

  it('lender flows and interest accrue into market totals and snapshots', async (t) => {
    const indexer = createTestIndexer()
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            { contract: 'TenorMarket', event: 'Deposit', params: { sender: MARKET, owner: MARKET, assets: 1000n, shares: 1n }, ...at(1, 0, '0x' + '04'.repeat(32)) },
            { contract: 'TenorMarket', event: 'Withdraw', params: { sender: MARKET, receiver: MARKET, owner: MARKET, assets: 100n, shares: 1n }, ...at(2, 0, '0x' + '05'.repeat(32)) },
            { contract: 'TenorMarket', event: 'InterestAccrued', params: { borrowIndex: 10n ** 27n + 1n, interest: 21n, toReserves: 2n }, ...at(3, 0, '0x' + '06'.repeat(32)) },
          ],
        },
      },
    })
    t.expect(await indexer.MarketTotals.getOrThrow('market')).toMatchObject({
      lenderDeposits: 1000n,
      lenderWithdrawals: 100n,
      interestAccrued: 21n,
      toReserves: 2n,
      lastBorrowIndex: 10n ** 27n + 1n,
    })
    t.expect(await indexer.MarketSnapshot.getAll()).toHaveLength(1)
  })
})
