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
import { Card, CardTitle, Label, PageHeader, Stat } from '@/components/ui/card'
import { TokenIcon } from '@/components/ui/token'
import { TierLadder } from '@/components/score/TierLadder'
import { ConnectButton } from '@rainbow-me/rainbowkit'
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
    <div className="space-y-8">
      <PageHeader eyebrow="Tenor market · Monad testnet" title="Market">
        Post tCOLL as collateral and borrow tUSD at your tier&apos;s terms. One interest rate for everyone; your score changes how much you
        can borrow, not what you pay.
      </PageHeader>
      <MarketHeader s={s} />
      {!address ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <Card className="flex flex-col justify-between gap-6">
            <div>
              <CardTitle>Connect a wallet to borrow</CardTitle>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Unscored wallets borrow at floor terms (60% max LTV); nobody is turned away. A verified ChainScore history moves you up the
                ladder. Test tokens come from the faucet once you&apos;re connected.
              </p>
            </div>
            <ConnectButton.Custom>
              {({ openConnectModal, mounted }) => (
                <Button size="lg" onClick={openConnectModal} disabled={!mounted} className="w-fit">
                  Connect wallet
                </Button>
              )}
            </ConnectButton.Custom>
          </Card>
          <Card className="p-5">
            <CardTitle className="mb-3 px-1 text-base">Terms by tier</CardTitle>
            <TierLadder />
          </Card>
        </div>
      ) : (
        <>
          <PositionSummary s={s} />
          <div className="grid gap-6 lg:grid-cols-[1fr_1.15fr]">
            <PositionCard s={s} />
            <Actions wallet={address} s={s} />
          </div>
          <LiquidateCard wallet={address} s={s} />
        </>
      )}
    </div>
  )
}

function MarketHeader({ s }: { s: TenorState }) {
  const idle = s.market.totalAssets !== undefined && s.market.totalDebt !== undefined ? s.market.totalAssets - s.market.totalDebt + (s.market.reserves ?? 0n) : undefined
  const util = s.market.totalAssets && s.market.totalDebt !== undefined && s.market.totalAssets > 0n ? Number((s.market.totalDebt * 10_000n) / s.market.totalAssets) : undefined
  const age = s.prices.coll ? Math.floor(Date.now() / 1000) - Number(s.prices.coll.updatedAt) : undefined
  return (
    <Card className="p-0">
      <div className="grid grid-cols-2 gap-6 p-6 md:grid-cols-4">
        <Stat label="Pool liquidity" value={tokens(idle, 'tUSD', 0)} sub="idle tUSD available to borrow" />
        <Stat label="Total borrowed" value={tokens(s.market.totalDebt, 'tUSD', 0)} sub={util !== undefined ? `${pct(util, 1)} utilization` : ' '} />
        <Stat label="Borrow APR" value={s.market.borrowRateBps !== undefined ? pct(s.market.borrowRateBps, 2) : '—'} sub="the same for every tier" />
        <Stat
          label="tCOLL price"
          value={s.prices.coll ? usd(s.prices.coll.price) : '—'}
          sub={
            <span className="inline-flex items-center gap-1.5">
              <Badge tone="warning" dot>
                mock oracle
              </Badge>
              {age !== undefined && `set ${Math.round(age / 60)} min ago`}
            </span>
          }
        />
      </div>
      <div className="border-t border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-muted">
              <th className="px-6 py-3 font-medium">Asset</th>
              <th className="py-3 font-medium">Role</th>
              <th className="py-3 font-medium">Price</th>
              <th className="px-6 py-3 text-right font-medium">Terms</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-border">
              <td className="px-6 py-3">
                <div className="flex items-center gap-3">
                  <TokenIcon symbol="tCOLL" />
                  <div>
                    <div className="font-medium text-text">Tenor Test Collateral</div>
                    <div className="text-xs text-muted">tCOLL · mock token</div>
                  </div>
                </div>
              </td>
              <td className="text-muted">Collateral</td>
              <td className="num">{s.prices.coll ? usd(s.prices.coll.price) : '—'}</td>
              <td className="px-6 text-right text-muted">Max LTV 60–80% by tier</td>
            </tr>
            <tr className="border-t border-border">
              <td className="px-6 py-3">
                <div className="flex items-center gap-3">
                  <TokenIcon symbol="tUSD" />
                  <div>
                    <div className="font-medium text-text">Tenor Test USD</div>
                    <div className="text-xs text-muted">tUSD · mock token</div>
                  </div>
                </div>
              </td>
              <td className="text-muted">Borrow</td>
              <td className="num">{s.prices.usd ? usd(s.prices.usd.price) : '—'}</td>
              <td className="px-6 text-right text-muted">{s.market.borrowRateBps !== undefined ? `${pct(s.market.borrowRateBps, 2)} APR` : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {s.market.paused && (
        <div className="border-t border-danger/20 bg-danger/[0.05] px-6 py-3 text-sm font-medium text-danger">Market paused: borrowing and liquidation disabled. Repay and withdrawals still work.</div>
      )}
    </Card>
  )
}

/** Aave-style position summary: what you have, what you owe, how safe it is. */
function PositionSummary({ s }: { s: TenorState }) {
  const p = s.position
  const price = s.prices.coll?.price
  const collUsd = p && price ? (p.collateral * price) / WAD : undefined
  const debtUsd = p && s.prices.usd ? (p.debt * s.prices.usd.price) / WAD : undefined
  const limit = p && s.maxBorrow !== undefined ? p.debt + s.maxBorrow : undefined
  const used = limit && limit > 0n && p ? Number((p.debt * 10_000n) / limit) : 0
  const hf = s.healthFactor
  const hfNum = hf === undefined ? undefined : hf > 10n ** 30n ? Infinity : Number(formatUnits(hf, 18))
  const hfTone = hfNum === undefined ? 'text-text' : hfNum === Infinity || hfNum >= 1.5 ? 'text-success' : hfNum >= 1.1 ? 'text-warning' : 'text-danger'
  return (
    <Card className="grid grid-cols-2 gap-6 md:grid-cols-5">
      <Stat label="Collateral" value={collUsd !== undefined ? usd(collUsd) : '—'} sub={tokens(p?.collateral, 'tCOLL', 2)} />
      <Stat label="Debt" value={debtUsd !== undefined ? usd(debtUsd) : '—'} sub={tokens(p?.debt, 'tUSD', 2)} />
      <Stat
        label="Health factor"
        value={s.healthFactorError ? 'price stale' : hfNum === Infinity ? '∞' : healthFactor(hf)}
        valueClassName={hfTone}
        sub={hfNum === Infinity ? 'no debt' : 'liquidation below 1.00'}
      />
      <div className="min-w-0">
        <Label>Borrow power used</Label>
        <div className="num mt-1 text-2xl font-semibold tracking-tight text-text">{pct(used, 0)}</div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-subtle">
          <div className={cn('h-full rounded-full', used > 9000 ? 'bg-danger' : used > 7000 ? 'bg-amber-500' : 'bg-accent')} style={{ width: `${Math.min(100, used / 100)}%` }} />
        </div>
      </div>
      <Stat label="Tier for your next borrow" value={s.effectiveTier ? (s.effectiveTier === 'FLOOR' ? 'Floor' : `Tier ${s.effectiveTier}`) : '—'} sub={s.effectiveTier ? `max LTV ${pct(TERMS[s.effectiveTier].maxLtvBps)}` : undefined} />
    </Card>
  )
}

function HfBar({ current, projected, lt }: { current: bigint | undefined; projected?: bigint; lt: number }) {
  const pos = (hf: bigint | undefined) => (hf === undefined ? undefined : Math.min(100, (Number(formatUnits(hf > 10n ** 30n ? 3n * WAD : hf, 18)) / 3) * 100))
  const c = pos(current)
  const p = pos(projected)
  return (
    <div>
      <div className="relative h-2.5 rounded-full bg-gradient-to-r from-red-500 via-amber-400 to-emerald-500">
        <div className="absolute -top-1 h-[18px] w-0.5 rounded bg-text" style={{ left: `${100 / 3}%` }} title="Liquidation at 1.00" />
        {c !== undefined && <div className="absolute -top-[5px] h-5 w-5 -translate-x-1/2 rounded-full border-[3px] border-white bg-text shadow" style={{ left: `${c}%` }} title="now" />}
        {p !== undefined && <div className="absolute -top-[5px] h-5 w-5 -translate-x-1/2 rounded-full border-[3px] border-white bg-accent shadow" style={{ left: `${p}%` }} title="after this action" />}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted">
        <span>0</span>
        <span>liquidation at 1.00 (debt = collateral value × {pct(lt)}) · <span className="text-text">●</span> now <span className="text-accent">●</span> after</span>
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
      <div className="flex items-center justify-between">
        <CardTitle>Your position</CardTitle>
        {p && p.debt > 0n ? <Badge tone={p.tier === 'FLOOR' ? 'neutral' : 'accent'} dot>priced at {p.tier === 'FLOOR' ? 'floor' : `tier ${p.tier}`}</Badge> : <Badge>no open debt</Badge>}
      </div>
      <dl className="grid grid-cols-2 gap-y-2.5 rounded-xl bg-subtle p-4 text-sm">
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
  // Interest accrues every block (0.4 s on Monad), so a limit read now is stale
  // by the time a transaction lands: maxBorrow's own margin is only a few wei.
  // Max borrow and All repay keep 10 minutes of interest on the current debt as
  // headroom (found on testnet 2026-10-11: borrowing exactly maxBorrow with
  // existing debt reverted ExceedsWalletCap).
  const headroom = p && p.debt > 0n ? (p.debt * (s.market.borrowRateBps ?? 1_200n) * 600n) / (10_000n * 31_536_000n) + 10n ** 12n : 0n
  const safeMax = s.maxBorrow !== undefined ? (s.maxBorrow > headroom ? s.maxBorrow - headroom : 0n) : undefined
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
      <div className="grid grid-cols-4 gap-1 rounded-xl bg-subtle p-1">
        {(['deposit', 'borrow', 'repay', 'withdraw'] as Action[]).map((a) => (
          <button
            key={a}
            onClick={() => { setAction(a); setInput('') }}
            className={cn('rounded-lg px-2 py-2 text-sm font-medium capitalize transition-all', action === a ? 'bg-white text-text shadow-sm' : 'text-muted hover:text-text')}
          >
            {a === 'deposit' ? 'Deposit' : a}
          </button>
        ))}
      </div>
      <div className="text-xs text-muted">
        {action === 'deposit' ? 'Post tCOLL as collateral.' : action === 'withdraw' ? 'Take tCOLL collateral back.' : action === 'borrow' ? 'Borrow tUSD against your collateral at your tier.' : 'Pay tUSD debt back.'}
      </div>
      <div className="flex items-center gap-3 rounded-xl border border-border bg-white px-4 py-3 shadow-sm focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/10">
        <TokenIcon symbol={action === 'deposit' || action === 'withdraw' ? 'tCOLL' : 'tUSD'} />
        <input
          className="num w-full bg-transparent text-2xl font-semibold outline-none placeholder:text-slate-300"
          placeholder="0.00"
          inputMode="decimal"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="amount"
        />
        <span className="text-sm font-medium text-muted">{action === 'deposit' || action === 'withdraw' ? 'tCOLL' : 'tUSD'}</span>
        {action === 'borrow' && (
          <Button variant="outline" size="sm" disabled={!safeMax} onClick={() => setInput(formatUnits((safeMax! / 10n ** 12n) * 10n ** 12n, 18))}>
            Max
          </Button>
        )}
        {action === 'repay' && p && p.debt > 0n && (
          <Button variant="outline" size="sm" onClick={() => setInput(formatUnits(((p.debt + headroom) / 10n ** 12n + 1n) * 10n ** 12n, 18))} title="Your debt plus 10 minutes of interest; the contract only takes what is owed">
            All
          </Button>
        )}
      </div>
      <div className="text-xs text-muted">
        {action === 'borrow' && safeMax !== undefined && (
          <>
            Max: <span className="num">{tokens(safeMax, 'tUSD', 4)}</span>
            {headroom > 0n ? ' (the contract’s maxBorrow less 10 minutes of interest on your debt, so it still fits when the transaction lands)' : ' (the contract’s maxBorrow)'}.{' '}
          </>
        )}
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
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center justify-between">
        <Label>Test tokens</Label>
        <span className="text-[11px] text-muted">worthless · one claim per hour per token</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium"><TokenIcon symbol="tCOLL" className="h-6 w-6 text-[10px]" /> tCOLL</div>
          <TxFlow account={wallet} onDone={onDone} spec={{ label: 'Get 1,000 tCOLL', address: contracts.tCOLL, abi: MockERC20Abi, functionName: 'faucet', args: [], params: [['token', 'Tenor Test Collateral (tCOLL)'], ['amount', '1,000 tCOLL']] }} />
        </div>
        <div className="rounded-xl border border-border p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium"><TokenIcon symbol="tUSD" className="h-6 w-6 text-[10px]" /> tUSD</div>
          <TxFlow account={wallet} onDone={onDone} spec={{ label: 'Get 1,000 tUSD', address: contracts.tUSD, abi: MockERC20Abi, functionName: 'faucet', args: [], params: [['token', 'Tenor Test USD (tUSD)'], ['amount', '1,000 tUSD']] }} />
        </div>
      </div>
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
        className="h-11 w-full rounded-xl border border-border bg-white px-4 font-mono text-sm shadow-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
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
