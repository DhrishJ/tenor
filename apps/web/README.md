# Tenor web app

Next.js 14 (App Router), wagmi 2, viem, RainbowKit. Four pages: Score, Compare, Market, Activity.

- Addresses come from `deployments/<NEXT_PUBLIC_CHAIN_ID>.json` and ABIs from `contracts/out`, copied by
  `scripts/prebuild.mjs` before `dev`/`build`. No chain id, address or RPC literal lives in components.
- Current state (position, health factor, maxBorrow, score freshness, mock prices) is read from the chain.
  History (timeline, liquidations feed) comes from the Envio indexer.

```bash
cp .env.example .env.local   # fill in
npm install
npm run dev
```

For a local walkthrough against anvil, run anvil with interval mining
(`anvil --network monad --block-time 1`) so block timestamps track real time. `NEXT_PUBLIC_DEV_WALLET` enables a
dev-only wallet button for an impersonated/unlocked anvil account; it must be empty in any deployed build.
