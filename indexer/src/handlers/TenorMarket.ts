import { indexer, type WalletEvent } from 'envio'
import { eventId, newTotals, newWallet, tierName } from './shared.js'

type Ev = { transaction: { hash: string }; logIndex: number; block: { number: number; timestamp: number } }

/** A timeline row with every optional field empty; callers fill what applies. */
function walletEvent(e: Ev, walletId: string, kind: string, fields: Partial<WalletEvent> = {}): WalletEvent {
  return {
    id: eventId(e.transaction.hash, e.logIndex),
    wallet_id: walletId,
    kind,
    blockNumber: BigInt(e.block.number),
    blockTimestamp: BigInt(e.block.timestamp),
    logIndex: e.logIndex,
    txHash: e.transaction.hash,
    amount: undefined,
    score: undefined,
    tier: undefined,
    maxLtvBps: undefined,
    liqThresholdBps: undefined,
    collateralPriceWad: undefined,
    shortfall: undefined,
    fromReserves: undefined,
    socialized: undefined,
    counterparty: undefined,
    ...fields,
  }
}

// ---------------------------------------------------------------- lenders

indexer.onEvent({ contract: 'TenorMarket', event: 'Deposit' }, async ({ event, context }) => {
  const ts = BigInt(event.block.timestamp)
  const t = (await context.MarketTotals.get('market')) ?? newTotals(ts)
  context.MarketTotals.set({ ...t, lenderDeposits: t.lenderDeposits + event.params.assets, updatedAt: ts })
})

indexer.onEvent({ contract: 'TenorMarket', event: 'Withdraw' }, async ({ event, context }) => {
  const ts = BigInt(event.block.timestamp)
  const t = (await context.MarketTotals.get('market')) ?? newTotals(ts)
  context.MarketTotals.set({ ...t, lenderWithdrawals: t.lenderWithdrawals + event.params.assets, updatedAt: ts })
})

// --------------------------------------------------------------- borrowers

indexer.onEvent({ contract: 'TenorMarket', event: 'CollateralDeposited' }, async ({ event, context }) => {
  const w = event.params.wallet.toLowerCase()
  if (!(await context.Wallet.get(w))) context.Wallet.set(newWallet(w))
  context.WalletEvent.set(walletEvent(event, w, 'COLLATERAL_IN', { amount: event.params.amount }))
})

indexer.onEvent({ contract: 'TenorMarket', event: 'CollateralWithdrawn' }, async ({ event, context }) => {
  const w = event.params.wallet.toLowerCase()
  if (!(await context.Wallet.get(w))) context.Wallet.set(newWallet(w))
  context.WalletEvent.set(walletEvent(event, w, 'COLLATERAL_OUT', { amount: event.params.amount }))
})

indexer.onEvent({ contract: 'TenorMarket', event: 'Retiered' }, async ({ event, context }) => {
  const w = event.params.wallet.toLowerCase()
  if (!(await context.Wallet.get(w))) context.Wallet.set(newWallet(w))
  context.WalletEvent.set(
    walletEvent(event, w, 'RETIERED', { tier: tierName(event.params.toTier), score: Number(event.params.score) }),
  )
})

indexer.onEvent({ contract: 'TenorMarket', event: 'Borrowed' }, async ({ event, context }) => {
  const w = event.params.wallet.toLowerCase()
  const ts = BigInt(event.block.timestamp)
  const wallet = (await context.Wallet.get(w)) ?? newWallet(w)
  context.Wallet.set({ ...wallet, borrowCount: wallet.borrowCount + 1 })
  context.WalletEvent.set(
    walletEvent(event, w, 'BORROWED', {
      amount: event.params.amount,
      score: Number(event.params.score),
      tier: tierName(event.params.tier),
      maxLtvBps: Number(event.params.maxLtvBps),
      liqThresholdBps: Number(event.params.liqThresholdBps),
      collateralPriceWad: event.params.collateralPriceWad,
    }),
  )
  const t = (await context.MarketTotals.get('market')) ?? newTotals(ts)
  context.MarketTotals.set({ ...t, borrowVolume: t.borrowVolume + event.params.amount, borrowCount: t.borrowCount + 1, updatedAt: ts })
})

indexer.onEvent({ contract: 'TenorMarket', event: 'Repaid' }, async ({ event, context }) => {
  const w = event.params.wallet.toLowerCase()
  const ts = BigInt(event.block.timestamp)
  if (!(await context.Wallet.get(w))) context.Wallet.set(newWallet(w))
  context.WalletEvent.set(walletEvent(event, w, 'REPAID', { amount: event.params.amount, counterparty: event.params.payer }))
  const t = (await context.MarketTotals.get('market')) ?? newTotals(ts)
  context.MarketTotals.set({ ...t, repayVolume: t.repayVolume + event.params.amount, updatedAt: ts })
})

// Emitted inside liquidate(), immediately BEFORE the Liquidated event of the
// same transaction (TenorMarket._realizeBadDebt).
indexer.onEvent({ contract: 'TenorMarket', event: 'BadDebtRealized' }, async ({ event, context }) => {
  const w = event.params.wallet.toLowerCase()
  const ts = BigInt(event.block.timestamp)
  context.WalletEvent.set(
    walletEvent(event, w, 'BAD_DEBT', {
      shortfall: event.params.amount,
      fromReserves: event.params.fromReserves,
      socialized: event.params.socialized,
    }),
  )
  const t = (await context.MarketTotals.get('market')) ?? newTotals(ts)
  context.MarketTotals.set({
    ...t,
    badDebt: t.badDebt + event.params.amount,
    badDebtFromReserves: t.badDebtFromReserves + event.params.fromReserves,
    badDebtSocialized: t.badDebtSocialized + event.params.socialized,
    updatedAt: ts,
  })
})

indexer.onEvent({ contract: 'TenorMarket', event: 'Liquidated' }, async ({ event, context }) => {
  const w = event.params.wallet.toLowerCase()
  const ts = BigInt(event.block.timestamp)
  const id = eventId(event.transaction.hash, event.logIndex)
  const shortfall = event.params.shortfall

  // Join the BadDebtRealized log that precedes this one in the same transaction.
  let fromReserves = 0n
  let socialized = 0n
  if (shortfall > 0n) {
    const bad = await context.WalletEvent.get(eventId(event.transaction.hash, event.logIndex - 1))
    if (!bad || bad.kind !== 'BAD_DEBT' || bad.wallet_id !== w) {
      throw new Error(`Liquidated ${id} has shortfall but no BadDebtRealized just before it`)
    }
    fromReserves = bad.fromReserves ?? 0n
    socialized = bad.socialized ?? 0n
  }

  context.LiquidationEvent.set({
    id,
    wallet_id: w,
    liquidator: event.params.liquidator,
    repaid: event.params.repaid,
    collateralSeized: event.params.collateralSeized,
    shortfall,
    fromReserves,
    socialized,
    score: Number(event.params.score),
    tier: tierName(event.params.tier),
    liqThresholdBps: Number(event.params.liqThresholdBps),
    collateralPriceWad: event.params.collateralPriceWad,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: ts,
    txHash: event.transaction.hash,
  })
  context.WalletEvent.set(
    walletEvent(event, w, 'LIQUIDATED', {
      amount: event.params.repaid,
      score: Number(event.params.score),
      tier: tierName(event.params.tier),
      liqThresholdBps: Number(event.params.liqThresholdBps),
      collateralPriceWad: event.params.collateralPriceWad,
      shortfall,
      counterparty: event.params.liquidator,
    }),
  )
  const t = (await context.MarketTotals.get('market')) ?? newTotals(ts)
  context.MarketTotals.set({
    ...t,
    liquidationCount: t.liquidationCount + 1,
    liquidationsWithShortfall: t.liquidationsWithShortfall + (shortfall > 0n ? 1 : 0),
    updatedAt: ts,
  })
})

// ------------------------------------------------------------------ market

indexer.onEvent({ contract: 'TenorMarket', event: 'InterestAccrued' }, async ({ event, context }) => {
  const ts = BigInt(event.block.timestamp)
  context.MarketSnapshot.set({
    id: eventId(event.transaction.hash, event.logIndex),
    borrowIndex: event.params.borrowIndex,
    interest: event.params.interest,
    toReserves: event.params.toReserves,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: ts,
  })
  const t = (await context.MarketTotals.get('market')) ?? newTotals(ts)
  context.MarketTotals.set({
    ...t,
    interestAccrued: t.interestAccrued + event.params.interest,
    toReserves: t.toReserves + event.params.toReserves,
    lastBorrowIndex: event.params.borrowIndex,
    updatedAt: ts,
  })
})
