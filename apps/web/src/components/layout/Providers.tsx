'use client'
import '@rainbow-me/rainbowkit/styles.css'
import { RainbowKitProvider, connectorsForWallets, lightTheme } from '@rainbow-me/rainbowkit'
import { injectedWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { WagmiProvider, createConfig, http, mock } from 'wagmi'
import { devWallet, tenorChain } from '@/config/network'

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID

const walletConnectors = connectorsForWallets(
  [{ groupName: 'Wallets', wallets: projectId ? [injectedWallet, walletConnectWallet] : [injectedWallet] }],
  { appName: 'Tenor', projectId: projectId ?? 'not-configured' },
)

export const wagmiConfig = createConfig({
  chains: [tenorChain],
  connectors: [
    ...walletConnectors,
    // LOCAL ANVIL ONLY: sends transactions from an unlocked anvil account.
    // Present only when NEXT_PUBLIC_DEV_WALLET is set; never in a deployed build.
    ...(devWallet ? [mock({ accounts: [devWallet], features: { reconnect: true } })] : []),
  ],
  // Batch JSON-RPC calls too: the public testnet RPC rate-limits bursts.
  transports: { [tenorChain.id]: http(undefined, { batch: true }) },
  ssr: true,
})

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true } } }))
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={lightTheme({ accentColor: '#0052FF', borderRadius: 'medium', fontStack: 'system' })}>{children}</RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
