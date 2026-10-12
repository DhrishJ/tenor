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
    <div className="border-b border-amber-200 bg-amber-50 px-6 py-1.5 text-center text-xs font-medium text-warning">
      Monad testnet. Mock oracle. Unaudited. Not for production use.
      {tenorChain.id !== 10143 && <span className="ml-2 text-muted">(currently pointed at local development chain {tenorChain.id})</span>}
    </div>
  )
}

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
    <div className="border-b border-accent/15 bg-accent/[0.05] px-6 py-2.5 text-center text-sm text-text">
      <span className="mr-2 inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" /> Read-only view
      </span>
      <b>{shortAddr(wallet)}</b> is a real borrower&apos;s public address. You are not this wallet and Tenor cannot act for it:
      borrowing is disabled here. Anyone can request and relay this address&apos;s attestation.{' '}
      <Link href={path} className="font-medium text-accent underline underline-offset-2">
        Leave view
      </Link>
    </div>
  )
}

const NAV = [
  { href: '/', label: 'Score' },
  { href: '/compare', label: 'Compare' },
  { href: '/market', label: 'Market' },
  { href: '/activity', label: 'Activity' },
]

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#0052FF] to-[#3B82F6] shadow-lift">
        <svg viewBox="0 0 24 24" className="h-4 w-4 text-white" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" aria-hidden>
          <path d="M5 7h14M12 7v12" />
        </svg>
      </span>
      <span className="font-grotesk text-xl font-bold tracking-tight text-text">Tenor</span>
    </Link>
  )
}

export function Nav() {
  return (
    <Suspense fallback={<header className="h-16 border-b border-border bg-card" />}>
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
    <header className="sticky top-0 z-30 border-b border-border bg-white/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <div className="flex items-center gap-8">
          <Logo />
          <nav className="flex gap-1">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href === '/market' ? n.href : n.href + viewQuery}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  path === n.href ? 'bg-subtle text-text' : 'text-muted hover:bg-subtle/70 hover:text-text',
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-[#836EF9]" />
            {tenorChain.name}
          </span>
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
    <div className="flex items-center justify-center gap-4 border-b border-danger/20 bg-danger/[0.05] px-6 py-3 text-sm">
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

export function Footer() {
  return (
    <footer className="mt-20 border-t border-border bg-card">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-10 text-sm sm:grid-cols-[1.4fr_1fr_1fr]">
        <div className="space-y-3">
          <Logo />
          <p className="max-w-sm text-muted">
            An overcollateralized lending market on Monad where a wallet&apos;s borrowing history sets its terms. Scores come from the
            ChainScore API and are checked against on-chain history before they are signed.
          </p>
        </div>
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Project</div>
          <a className="block text-text hover:text-accent" href="https://github.com/DhrishJ/tenor" target="_blank" rel="noreferrer">
            Source code (GitHub)
          </a>
          <a className="block text-text hover:text-accent" href="https://github.com/DhrishJ/tenor#honest-limitations" target="_blank" rel="noreferrer">
            Honest limitations
          </a>
          <a className="block text-text hover:text-accent" href="https://chainscore.dev" target="_blank" rel="noreferrer">
            ChainScore
          </a>
        </div>
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Status</div>
          <p className="text-muted">Monad testnet only. Mock oracle and mock tokens. Unaudited. Not for production use.</p>
        </div>
      </div>
    </footer>
  )
}
