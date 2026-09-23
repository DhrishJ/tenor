/** @type {import('next').NextConfig} */
const nextConfig = {
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
    }
    return config
  },
}

export default nextConfig
