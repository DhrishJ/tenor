'use client'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAccount, useConnect, useSwitchChain } from 'wagmi'
import { devWallet, tenorChain } from '@/config/network'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

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

export function Nav() {
  const path = usePathname()
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
              href={n.href}
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
        <ConnectButton chainStatus="icon" showBalance={false} />
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
