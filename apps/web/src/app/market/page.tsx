'use client'
import { useState } from 'react'
import { formatUnits, isAddress, maxUint256, parseEther, type Address } from 'viem'
import { useAccount, useReadContracts } from 'wagmi'
import { contracts } from '@/config/network'
import { MockERC20Abi, TenorMarketAbi } from '@/generated/abis'
import { useTenorState, type TenorState } from '@/hooks/useTenorState'
import { FLOOR_TERMS, TERMS, tierFromIndex, type Tier } from '@/lib/tiers'
import { healthFactor, pct, tokens, usd, when } from '@/lib/format'
import { TxFlow, type TxSpec } from '@/components/market/TxFlow'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle, Label } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const WAD = 10n ** 18n
const BPS = 10_000n
type Action = 'deposit' | 'borrow' | 'repay' | 'withdraw'

function parse(v: string): bigint | undefined {
  try {
    const x = parseEther(v.trim() || '0')
    return x > 0n ? x : undefined
  } catch {
    return undefined
  }
}

/** Health factor as the contract computes it: collateral value x LT / debt value. */
function projectHf(coll: bigint, debt: bigint, price: bigint, ltBps: number): bigint | undefined {
  if (debt <= 0n) return maxUint256
  return ((coll * price) / WAD) * BigInt(ltBps) * WAD / (BPS * debt)
}

export default function MarketPage() {
  const { address } = useAccount()
  const s = useTenorState(address)
  return (
    <div className="space-y-6">
      <MarketHeader s={s} />
      {!address ? (
        <Card className="h-40 text-muted">Connect a wallet to borrow. Unscored wallets borrow at floor terms; nobody is turned away.</Card>
      ) : (
        <div className="grid grid-cols-[1fr_1.2fr] gap-6">
          <PositionCard s={s} />
          <Actions wallet={address} s={s} />
        </div>
      )}
      {address && <LiquidateCard wallet={address} s={s} />}
    </div>
  )
}

function MarketHeader({ s }: { s: TenorState }) {
  const idle = s.market.totalAssets !== undefined && s.market.totalDebt !== undefined ? s.market.totalAssets - s.market.totalDebt + (s.market.reserves ?? 0n) : undefined
  const age = s.prices.coll ? Math.floor(Date.now() / 1000) - Number(s.prices.coll.updatedAt) : undefined
  return (
    <Card className="flex items-center gap-10">
      <div>
        <Label>Borrow rate (every tier)</Label>
        <div className="num text-xl">{s.market.borrowRateBps !== undefined ? pct(s.market.borrowRateBps, 2) : '—'} APR</div>
      </div>
      <div>
        <Label>Pool liquidity (idle)</Label>
        <div className="num text-xl">{tokens(idle, 'tUSD', 0)}</div>
      </div>
      <div>
        <Label>Borrowed</Label>
        <div className="num text-xl">{tokens(s.market.totalDebt, 'tUSD', 0)}</div>
      </div>
      <div>
        <Label>tCOLL price</Label>
        <div className="num text-xl">{s.prices.coll ? usd(s.prices.coll.price) : '—'}</div>
        <div className="text-xs text-muted">
          <Badge tone="warning">mock oracle</Badge> set by hand{age !== undefined && `, updated ${Math.round(age / 60)} min ago`}
        </div>
      </div>
      {s.market.paused && <Badge tone="danger">market paused: borrowing and liquidation disabled</Badge>}
    </Card>
  )
}

function HfBar({ current, projected, lt }: { current: bigint | undefined; projected?: bigint; lt: number }) {
  const pos = (hf: bigint | undefined) => (hf === undefined ? undefined : Math.min(100, (Number(formatUnits(hf > 10n ** 30n ? 3n * WAD : hf, 18)) / 3) * 100))
  const c = pos(current)
  const p = pos(projected)
  return (
    <div>
      <div className="relative h-2 rounded-full bg-gradient-to-r from-danger via-warning to-success">
        <div className="absolute top-[-3px] h-3.5 w-0.5 bg-text" style={{ left: `${100 / 3}%` }} title="Liquidation at 1.00" />
        {c !== undefined && <div className="absolute top-[-4px] h-4 w-4 -translate-x-1/2 rounded-full border-2 border-text bg-background" style={{ left: `${c}%` }} />}
        {p !== undefined && <div className="absolute top-[-4px] h-4 w-4 -translate-x-1/2 rounded-full border-2 border-accent bg-accent/40" style={{ left: `${p}%` }} />}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted">
        <span>0</span>
        <span>liquidation at 1.00 (debt = collateral value × {pct(lt)})</span>
        <span>3+</span>
      </div>
    </div>
  )
}

function PositionCard({ s }: { s: TenorState }) {
  const p = s.position
  const lt = TERMS[p?.tier ?? 'FLOOR'].ltBps
  const invalidated = s.score?.isStale && s.liquidation && s.liquidation.liquidationCount > 0 && s.liquidation.lastLiquidatedAt >= s.score.issuedAt
  return (
    <Card className="space-y-4">
      <CardTitle>Your position</CardTitle>
      <dl className="grid grid-cols-2 gap-y-2 text-sm">
        <dt className="text-muted">Collateral</dt>
        <dd className="num text-right">{tokens(p?.collateral, 'tCOLL', 4)}</dd>
        <dt className="text-muted">Debt (incl. accrued interest)</dt>
        <dd className="num text-right">{tokens(p?.debt, 'tUSD', 4)}</dd>
        <dt className="text-muted">Priced at tier</dt>
        <dd className="text-right">{p && p.debt > 0n ? <Badge tone={p.tier === 'FLOOR' ? 'neutral' : 'accent'}>{p.tier}</Badge> : <span className="text-muted">no open debt</span>}</dd>
        <dt className="text-muted">Tier for your next borrow</dt>
        <dd className="text-right">{s.effectiveTier ? <Badge tone="accent">{s.effectiveTier}</Badge> : '—'}</dd>
        <dt className="text-muted">Health factor</dt>
        <dd className="num text-right">{s.healthFactorError ? 'price stale' : healthFactor(s.healthFactor)}</dd>
        <dt className="text-muted">Max you can borrow now</dt>
        <dd className="num text-right">{s.maxBorrowError ? 'price stale' : tokens(s.maxBorrow, 'tUSD', 2)}</dd>
      </dl>
      <HfBar current={s.healthFactor} lt={lt} />
      {invalidated && (
        <p className="text-sm text-danger">
          Your score was invalidated by a Tenor liquidation ({when(s.liquidation!.lastLiquidatedAt)}). New borrows are priced at floor
          terms until you submit a fresh score from the Score page.
        </p>
      )}
      {!invalidated && s.score?.isStale && s.score.score > 0 && (
        <p className="text-sm text-warning">
          Your on-chain score has expired. You can still borrow at floor terms ({FLOOR_TERMS}); only amounts above that revert.
          Re-attest on the Score page to restore your tier.
        </p>
      )}
      {s.effectiveTier === 'FLOOR' && !s.score?.score && (
        <p className="text-sm text-muted">No score on-chain: you borrow at floor terms (60% max LTV). Nobody is turned away.</p>
      )}
    </Card>
  )
}

function Actions({ wallet, s }: { wallet: Address; s: TenorState }) {
  const [action, setAction] = useState<Action>('borrow')
  const [input, setInput] = useState('')
  const amount = parse(input)
  const p = s.position
  const price = s.prices.coll?.price
  const bal = s.balances
  // After an approval the same amount carries on to the real action.
  const done = (sent: TxSpec) => {
    if (sent.functionName !== 'approve') setInput('')
    s.refetch()
  }

  // Which tier the contract will price this action at (borrow and withdraw re-tier).
  const tier: Tier = action === 'borrow' || action === 'withdraw' ? (s.effectiveTier ?? 'FLOOR') : (p?.tier ?? 'FLOOR')
  let projected: bigint | undefined
  if (p && price && amount !== undefined) {
    const coll = action === 'deposit' ? p.collateral + amount : action === 'withdraw' ? p.collateral - (amount > p.collateral ? p.collateral : amount) : p.collateral
    const debt = action === 'borrow' ? p.debt + amount : action === 'repay' ? (amount >= p.debt ? 0n : p.debt - amount) : p.debt
    projected = projectHf(coll, debt, price, TERMS[tier].ltBps)
  }

  let spec: TxSpec | undefined
  let blocker: string | undefined
  const m = contracts.market
  if (amount !== undefined && bal && p) {
    if (action === 'deposit') {
      if (amount > bal.coll) blocker = `Insufficient balance: you hold ${tokens(bal.coll, 'tCOLL', 4)}. Use the tCOLL faucet.`
      else if (bal.collAllowance < amount)
        spec = { label: 'Approve tCOLL (approval missing)', address: contracts.tCOLL, abi: MockERC20Abi, functionName: 'approve', args: [m, amount], params: [['spender', 'TenorMarket'], ['amount', tokens(amount, 'tCOLL', 4)]] }
      else spec = { label: 'Deposit collateral', address: m, abi: TenorMarketAbi, functionName: 'depositCollateral', args: [amount], params: [['amount', tokens(amount, 'tCOLL', 4)]] }
    } else if (action === 'borrow') {
      if (s.market.paused) blocker = 'The market is paused: borrowing is disabled. Repay and withdrawals still work.'
      else if (s.maxBorrowError) blocker = 'The mock oracle price is stale: borrowing is disabled until it is refreshed.'
      else if (s.maxBorrow !== undefined && amount > s.maxBorrow)
        blocker = `Above your maximum of ${tokens(s.maxBorrow, 'tUSD', 2)} (tier ${tier}: ${pct(TERMS[tier].maxLtvBps)} max LTV, ${tokens(TERMS[tier].walletCap, 'tUSD', 0)} per-wallet cap, market caps and liquidity).${
          s.score?.isStale && s.score.score > 0 ? ' Your score has expired, so floor terms apply; re-attest on the Score page to restore your tier.' : ''
        }`
      else
        spec = {
          label: 'Borrow',
          address: m,
          abi: TenorMarketAbi,
          functionName: 'borrow',
          args: [amount],
          params: [
            ['amount', tokens(amount, 'tUSD', 4)],
            ['priced at tier', `${tier}: max LTV ${pct(TERMS[tier].maxLtvBps)}, liquidation at ${pct(TERMS[tier].ltBps)}`],
            ['rate', s.market.borrowRateBps !== undefined ? `${pct(s.market.borrowRateBps, 2)} APR, same for every tier` : '—'],
            ['health factor after', healthFactor(projected)],
          ],
        }
    } else if (action === 'repay') {
      const full = amount >= p.debt
      const need = full ? p.debt + p.debt / 1000n + 1n : amount // headroom for interest accruing until the block
      if (p.debt === 0n) blocker = 'There is no debt to repay.'
      else if (bal.usd < (full ? p.debt : amount)) blocker = `Insufficient balance: you hold ${tokens(bal.usd, 'tUSD', 4)}. Use the tUSD faucet.`
      else if (bal.usdAllowance < need)
        spec = { label: 'Approve tUSD (approval missing)', address: contracts.tUSD, abi: MockERC20Abi, functionName: 'approve', args: [m, need], params: [['spender', 'TenorMarket'], ['amount', tokens(need, 'tUSD', 4)]] }
      else
        spec = {
          label: full ? 'Repay in full' : 'Repay',
          address: m,
          abi: TenorMarketAbi,
          functionName: 'repay',
          args: [wallet, full ? maxUint256 : amount],
          params: [['wallet', wallet], ['amount', full ? `all debt (${tokens(p.debt, 'tUSD', 4)} plus interest to the block)` : tokens(amount, 'tUSD', 4)]],
        }
    } else {
      if (amount > p.collateral) blocker = `You have ${tokens(p.collateral, 'tCOLL', 4)} posted.`
      else if (p.debt > 0n && projected !== undefined && projected < WAD) blocker = 'That withdrawal would leave the position liquidatable.'
      else
        spec = {
          label: 'Withdraw collateral',
          address: m,
          abi: TenorMarketAbi,
          functionName: 'withdrawCollateral',
          args: [amount],
          params: [['amount', tokens(amount, 'tCOLL', 4)], ...(p.debt > 0n ? ([['re-priced at tier', tier], ['health factor after', healthFactor(projected)]] as Array<[string, string]>) : [])],
        }
    }
  }

  return (
    <Card className="space-y-4">
      <div className="flex gap-1">
        {(['deposit', 'borrow', 'repay', 'withdraw'] as Action[]).map((a) => (
          <button
            key={a}
            onClick={() => { setAction(a); setInput('') }}
            className={cn('rounded-md px-3 py-1.5 text-sm capitalize', action === a ? 'bg-border/60 text-text' : 'text-muted hover:text-text')}
          >
            {a === 'deposit' ? 'Deposit collateral' : a === 'withdraw' ? 'Withdraw collateral' : a}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          className="num w-full rounded-md border border-border bg-background px-3 py-2 text-lg outline-none focus:border-accent"
          placeholder="0.00"
          inputMode="decimal"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="amount"
        />
        <span className="w-16 text-sm text-muted">{action === 'deposit' || action === 'withdraw' ? 'tCOLL' : 'tUSD'}</span>
        {action === 'borrow' && (
          <Button variant="outline" size="sm" disabled={s.maxBorrow === undefined || s.maxBorrow === 0n} onClick={() => setInput(formatUnits((s.maxBorrow! / 10n ** 12n) * 10n ** 12n, 18))}>
            Max
          </Button>
        )}
        {action === 'repay' && p && p.debt > 0n && (
          <Button variant="outline" size="sm" onClick={() => setInput(formatUnits(p.debt, 18))}>
            All
          </Button>
        )}
      </div>
      <div className="text-xs text-muted">
        {action === 'borrow' && s.maxBorrow !== undefined && <>Max (from the contract’s maxBorrow, always borrowable): <span className="num">{tokens(s.maxBorrow, 'tUSD', 4)}</span>. </>}
        Balance: <span className="num">{bal ? (action === 'deposit' || action === 'withdraw' ? tokens(bal.coll, 'tCOLL', 4) : tokens(bal.usd, 'tUSD', 2)) : '—'}</span>
      </div>
      <HfBar current={s.healthFactor} projected={projected} lt={TERMS[tier].ltBps} />
      <TxFlow key={action} spec={spec} account={wallet} onDone={done} disabled={blocker} />
      <Faucets wallet={wallet} onDone={s.refetch} />
    </Card>
  )
}

function Faucets({ wallet, onDone }: { wallet: Address; onDone: () => void }) {
  return (
    <div className="space-y-2 border-t border-border pt-3 text-xs text-muted">
      <div>Test tokens (worthless, one claim per hour per token):</div>
      <TxFlow account={wallet} onDone={onDone} spec={{ label: 'Get 1,000 tCOLL', address: contracts.tCOLL, abi: MockERC20Abi, functionName: 'faucet', args: [], params: [['token', 'Tenor Test Collateral (tCOLL)'], ['amount', '1,000 tCOLL']] }} />
      <TxFlow account={wallet} onDone={onDone} spec={{ label: 'Get 1,000 tUSD', address: contracts.tUSD, abi: MockERC20Abi, functionName: 'faucet', args: [], params: [['token', 'Tenor Test USD (tUSD)'], ['amount', '1,000 tUSD']] }} />
    </div>
  )
}

/** Liquidate someone else's unhealthy position (the second half of the loop demo). */
function LiquidateCard({ wallet, s }: { wallet: Address; s: TenorState }) {
  const [target, setTarget] = useState('')
  const valid = isAddress(target) ? (target as Address) : undefined
  const q = useReadContracts({
    allowFailure: true,
    contracts: valid
      ? [
          { address: contracts.market, abi: TenorMarketAbi, functionName: 'getPosition', args: [valid] },
          { address: contracts.market, abi: TenorMarketAbi, functionName: 'healthFactor', args: [valid] },
        ]
      : [],
    query: { enabled: Boolean(valid), refetchInterval: 4_000 },
  })
  const pos = q.data?.[0]?.status === 'success' ? (q.data[0].result as readonly [bigint, bigint, number, number]) : undefined
  const hf = q.data?.[1]?.status === 'success' ? (q.data[1].result as bigint) : undefined
  const debt = pos?.[1] ?? 0n
  const liquidatable = hf !== undefined && hf < WAD && debt > 0n
  const bal = s.balances
  const need = debt + debt / 1000n + 1n

  let spec: TxSpec | undefined
  let blocker: string | undefined
  if (valid && pos) {
    if (!liquidatable) blocker = debt === 0n ? 'This position has no debt.' : 'This position is healthy (health factor ≥ 1.00): it cannot be liquidated.'
    else if (s.market.paused) blocker = 'The market is paused: liquidation is disabled.'
    else if (bal && bal.usdAllowance < need)
      spec = { label: 'Approve tUSD for liquidation (approval missing)', address: contracts.tUSD, abi: MockERC20Abi, functionName: 'approve', args: [contracts.market, need], params: [['spender', 'TenorMarket'], ['amount', tokens(need, 'tUSD', 4)]] }
    else
      spec = {
        label: 'Liquidate',
        address: contracts.market,
        abi: TenorMarketAbi,
        functionName: 'liquidate',
        args: [valid, need],
        params: [
          ['wallet', valid],
          ['maxRepay', `${tokens(need, 'tUSD', 4)} (the contract caps it at what the collateral covers)`],
          ['bonus', '5% of repaid, paid in seized tCOLL'],
          ['recorded', 'in ScoreRegistry: invalidates the wallet’s score immediately'],
        ],
      }
  }

  return (
    <Card className="space-y-3">
      <CardTitle>Liquidate a position</CardTitle>
      <p className="text-sm text-muted">
        Positions become liquidatable when debt exceeds collateral value × their tier’s liquidation threshold. On testnet the price only
        moves when the mock oracle’s owner sets it.
      </p>
      <input
        className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-accent"
        placeholder="0x… wallet address"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        aria-label="wallet to liquidate"
      />
      {valid && pos && (
        <div className="text-sm">
          Debt <span className="num">{tokens(pos[1], 'tUSD', 4)}</span>, collateral <span className="num">{tokens(pos[0], 'tCOLL', 4)}</span>, tier{' '}
          {tierFromIndex(pos[2])}, health factor <span className={cn('num', liquidatable && 'text-danger')}>{healthFactor(hf)}</span>
        </div>
      )}
      <TxFlow spec={spec} account={wallet} onDone={() => { void q.refetch(); s.refetch() }} disabled={blocker} emptyLabel={valid ? 'Checking position…' : 'Enter a wallet address'} />
    </Card>
  )
}
