'use client'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Suspense } from 'react'
import { useAccount, useConnect, useSwitchChain } from 'wagmi'
import { devWallet, tenorChain } from '@/config/network'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { shortAddr } from '@/lib/format'
import { useViewedWallet, useViewQuery } from '@/hooks/useViewedWallet'

/** Persistent, on every page. */
export function Banner() {
  return (
    <div className="border-b border-warning/40 bg-warning/10 px-6 py-1.5 text-center text-xs font-medium text-warning">
      Monad testnet. Mock oracle. Unaudited. Not for production use.
      {tenorChain.id !== 10143 && <span className="ml-2 text-muted">(currently pointed at local development chain {tenorChain.id})</span>}
    </div>
  )
}

const NAV = [
  { href: '/', label: 'Score' },
  { href: '/compare', label: 'Compare' },
  { href: '/market', label: 'Market' },
  { href: '/activity', label: 'Activity' },
]

/** Read-only view of an address the viewer does not control (P5-O1). Never reads as ownership. */
export function ViewingBanner() {
  return (
    <Suspense fallback={null}>
      <ViewingBannerInner />
    </Suspense>
  )
}

function ViewingBannerInner() {
  const { wallet, viewing } = useViewedWallet()
  const path = usePathname()
  if (!viewing || !wallet) return null
  return (
    <div className="border-b border-accent/40 bg-accent/10 px-6 py-2 text-center text-sm">
      <b>Read-only view of {shortAddr(wallet)}</b>, a real borrower&apos;s public address. You are not this wallet and Tenor cannot
      act for it: borrowing is disabled here. Anyone can request and relay this address&apos;s attestation.{' '}
      <Link href={path} className="text-accent underline">
        Leave view
      </Link>
    </div>
  )
}

export function Nav() {
  return (
    <Suspense fallback={<header className="h-14 border-b border-border" />}>
      <NavInner />
    </Suspense>
  )
}

function NavInner() {
  const path = usePathname()
  const { viewing } = useViewedWallet()
  const viewQuery = useViewQuery()
  const { connectors, connect } = useConnect()
  const { isConnected } = useAccount()
  const dev = connectors.find((c) => c.type === 'mock')
  return (
    <header className="flex h-14 items-center justify-between border-b border-border px-6">
      <div className="flex items-center gap-8">
        <Link href="/" className="font-grotesk text-lg font-bold">
          Tenor
        </Link>
        <nav className="flex gap-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href === '/market' ? n.href : n.href + viewQuery}
              className={cn('rounded-md px-3 py-1.5 text-sm', path === n.href ? 'bg-border/60 text-text' : 'text-muted hover:text-text')}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex items-center gap-3">
        {devWallet && dev && !isConnected && (
          <Button variant="outline" size="sm" onClick={() => connect({ connector: dev })} title="Local anvil only">
            Dev wallet (local anvil)
          </Button>
        )}
        {viewing ? (
          <Button variant="outline" size="sm" disabled title="Leave the read-only view to connect a wallet">
            Read-only view: wallet connection disabled
          </Button>
        ) : (
          <ConnectButton chainStatus="icon" showBalance={false} />
        )}
      </div>
    </header>
  )
}

/** Wrong network: an explicit prompt, never a silent failure. */
export function NetworkGuard() {
  const { isConnected, chainId } = useAccount()
  const { switchChain, isPending, error } = useSwitchChain()
  if (!isConnected || chainId === tenorChain.id) return null
  return (
    <div className="flex items-center justify-center gap-4 border-b border-danger/50 bg-danger/10 px-6 py-3 text-sm">
      <span>
        Your wallet is on chain {chainId}. Tenor runs on <b>{tenorChain.name}</b> (chain {tenorChain.id}).
      </span>
      <Button size="sm" variant="danger" disabled={isPending} onClick={() => switchChain({ chainId: tenorChain.id })}>
        {isPending ? 'Switching…' : `Switch to ${tenorChain.name}`}
      </Button>
      {error && <span className="text-danger">{error.message.split('\n')[0]}</span>}
    </div>
  )
}
