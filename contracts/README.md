# Tenor contracts

Foundry project. See `../CONTRACTS.md` for the design, invariants, trust
assumptions and attacker capabilities.

```bash
forge build
forge test                       # unit, fuzz (10,000 runs), invariants
forge coverage --no-match-coverage '(test|script)/'
```

Requires Foundry >= 1.8.0 (Monad execution support). `foundry.toml` sets
`network = "monad"`.
