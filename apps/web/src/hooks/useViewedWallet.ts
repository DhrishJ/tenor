'use client'
/**
 * Read-only view of any address (OBJECTIONS P5-O1): `?wallet=0x…` on Score,
 * Compare and Activity. Score data and on-chain reads are public, so anyone
 * can look at any address. Nothing in this mode may suggest the viewer is
 * that wallet: borrowing and submitting are disabled and the connect button
 * is replaced (see ViewingBanner, Nav).
 */
import { useSearchParams } from 'next/navigation'
import { getAddress, isAddress, type Address } from 'viem'
import { useAccount } from 'wagmi'

export function useViewedWallet(): { wallet: Address | undefined; viewing: boolean } {
  const params = useSearchParams()
  const { address } = useAccount()
  const q = params.get('wallet')
  if (q && isAddress(q)) {
    const w = getAddress(q)
    return { wallet: w, viewing: w !== address }
  }
  return { wallet: address, viewing: false }
}

/** The query string to carry between pages while viewing. */
export function useViewQuery(): string {
  const params = useSearchParams()
  const q = params.get('wallet')
  return q && isAddress(q) ? `?wallet=${getAddress(q)}` : ''
}
