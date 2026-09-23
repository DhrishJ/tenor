import { formatUnits } from 'viem'

/** Every number on screen carries a unit and a fixed precision; never raw wei. */
export function tokens(wei: bigint | undefined, symbol: string, digits = 2): string {
  if (wei === undefined) return `— ${symbol}`
  const n = Number(formatUnits(wei, 18))
  return `${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${symbol}`
}

export function usd(wad: bigint | undefined, digits = 2): string {
  if (wad === undefined) return '$ —'
  const n = Number(formatUnits(wad, 18))
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

export const pct = (bps: number | bigint, digits = 0) => `${(Number(bps) / 100).toFixed(digits)}%`

/** Health factor (WAD). type(uint256).max means no debt. */
export function healthFactor(hf: bigint | undefined): string {
  if (hf === undefined) return '—'
  if (hf > 10n ** 30n) return '∞ (no debt)'
  return Number(formatUnits(hf, 18)).toFixed(2)
}

export function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export function duration(seconds: number): string {
  if (seconds <= 0) return 'expired'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h} h ${m} min` : `${m} min ${Math.floor(seconds % 60)} s`
}

export function when(unixSeconds: bigint | number): string {
  return new Date(Number(unixSeconds) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}
