// The browser talks only to this site's own origin; Vercel (or next dev)
// forwards to the attestor and the indexer. CORS then never applies, and the
// indexer stays reachable from networks that filter its host (SC-2).
const attestor = (process.env.NEXT_PUBLIC_ATTESTOR_URL || '').replace(/\/$/, '')
const indexer = process.env.NEXT_PUBLIC_INDEXER_URL || ''

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      ...(attestor ? [{ source: '/proxy/attestor/:path*', destination: `${attestor}/:path*` }] : []),
      ...(indexer ? [{ source: '/proxy/indexer', destination: indexer }] : []),
    ]
  },
  webpack: (config) => {
    // RainbowKit imports every wagmi connector, including Coinbase's, whose SDK
    // (@coinbase/cdp-sdk 1.56.0) statically imports its OPTIONAL @x402/*
    // payment peers. Tenor uses none of that; resolve them to empty modules
    // instead of installing unused payment libraries.
    config.resolve.alias = {
      ...config.resolve.alias,
      '@x402/core': false,
      '@x402/evm': false,
      '@x402/extensions': false,
      '@x402/svm': false,
      // Same pattern: MetaMask's SDK optionally imports React Native storage.
      '@react-native-async-storage/async-storage': false,
      // And WalletConnect's logger optionally imports a dev-only pretty printer.
      'pino-pretty': false,
    }
    return config
  },
}

export default nextConfig
