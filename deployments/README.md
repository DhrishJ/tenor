# deployments

One JSON file per chain id, written by `contracts/script/Deploy.s.sol` and
read by the attestor, the indexer config generator and the web app. It's
the only place contract addresses live.

- `10143.json`: Monad testnet (committed).
- `31337.json`: local anvil (gitignored; changes every run).

This README also keeps the directory in a fresh clone: Foundry refuses to
write into a directory that doesn't exist (found by the clean-clone test,
2026-09-24).
