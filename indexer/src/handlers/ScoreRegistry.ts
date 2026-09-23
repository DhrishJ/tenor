import { indexer } from 'envio'
import { eventId, newTotals, newWallet, scoreToTier } from './shared.js'

indexer.onEvent({ contract: 'ScoreRegistry', event: 'AttestationSubmitted' }, async ({ event, context }) => {
  const id = eventId(event.transaction.hash, event.logIndex)
  const walletId = event.params.wallet.toLowerCase()
  const score = Number(event.params.score)
  const ts = BigInt(event.block.timestamp)

  context.Attestation.set({
    id,
    wallet_id: walletId,
    score,
    tier: scoreToTier(score),
    issuedAt: event.params.issuedAt,
    expiresAt: event.params.expiresAt,
    nonce: event.params.nonce,
    modelVersion: event.params.modelVersion,
    attestorEpoch: Number(event.params.attestorEpoch),
    blockNumber: BigInt(event.block.number),
    blockTimestamp: ts,
    txHash: event.transaction.hash,
  })

  const w = (await context.Wallet.get(walletId)) ?? newWallet(walletId)
  context.Wallet.set({
    ...w,
    attestationCount: w.attestationCount + 1,
    latestScore: score,
    latestScoreIssuedAt: event.params.issuedAt,
    latestScoreExpiresAt: event.params.expiresAt,
  })

  context.WalletEvent.set({
    id,
    wallet_id: walletId,
    kind: 'ATTESTED',
    blockNumber: BigInt(event.block.number),
    blockTimestamp: ts,
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
    amount: undefined,
    score,
    tier: scoreToTier(score),
    maxLtvBps: undefined,
    liqThresholdBps: undefined,
    collateralPriceWad: undefined,
    shortfall: undefined,
    fromReserves: undefined,
    socialized: undefined,
    counterparty: undefined,
  })

  const t = (await context.MarketTotals.get('market')) ?? newTotals(ts)
  context.MarketTotals.set({ ...t, attestationCount: t.attestationCount + 1, updatedAt: ts })
})

// The registry's record of a Tenor liquidation: this is what invalidates the
// wallet's score on-chain and what the attestation service penalizes.
indexer.onEvent({ contract: 'ScoreRegistry', event: 'LiquidationRecorded' }, async ({ event, context }) => {
  const walletId = event.params.wallet.toLowerCase()
  const w = (await context.Wallet.get(walletId)) ?? newWallet(walletId)
  context.Wallet.set({
    ...w,
    liquidationCount: Number(event.params.liquidationCount),
    shortfallCount: Number(event.params.shortfallCount),
    totalShortfall: event.params.totalShortfall,
    lastLiquidatedAt: event.params.timestamp,
  })
  context.WalletEvent.set({
    id: eventId(event.transaction.hash, event.logIndex),
    wallet_id: walletId,
    kind: 'LIQUIDATION_RECORDED',
    blockNumber: BigInt(event.block.number),
    blockTimestamp: BigInt(event.block.timestamp),
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
    amount: undefined,
    score: undefined,
    tier: undefined,
    maxLtvBps: undefined,
    liqThresholdBps: undefined,
    collateralPriceWad: undefined,
    shortfall: event.params.shortfall,
    fromReserves: undefined,
    socialized: undefined,
    counterparty: event.params.market,
  })
})
