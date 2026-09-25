# Deploying Tenor's services (Phase 4)

Contracts are already on Monad testnet (`deployments/10143.json`). This
guide covers the four hosted services. It's written for the person who
owns the accounts: **you sign in, create, and paste the secret values.**
Everything else (code, image, configs, non-secret values) is ready and
tested.

**Order:** Supabase → Railway (attestor) → Envio Cloud (indexer) → Vercel
(web) → back to Railway for two values.

**Secrets live in the repo-root `.env`** (gitignored). Open it locally and
copy from there. **Never paste `DEPLOYER_PRIVATE_KEY` into any service.**
The deployer stays on your machine.

---

## 1. Supabase (the attestor's database)

1. supabase.com → sign in → **New project**. Make it a new project, not
   ChainScore's.
   - Name: `tenor-attestor`. Region: any, ideally near the Railway region.
   - Database password: click **Generate a password**, and keep it for
     step 3.
2. Wait for it to finish provisioning.
3. **Connect** (top bar) → **Session pooler** connection string (works
   over IPv4, which Railway needs) → copy it, and put the password into it.
   That's `DATABASE_URL`.
4. **Project Settings → Database → SSL Configuration → Download
   certificate.** Its full contents (the `-----BEGIN CERTIFICATE-----` block)
   are `DATABASE_CA_CERT`.

The attestor creates its own tables on first start (`tenor_*`). Nothing
to run in the SQL editor.

## 2. Railway (the attestor, always on)

1. railway.com → sign in with GitHub → **New Project → Deploy from GitHub
   repo → `DhrishJ/tenor`**. Grant access to that repo only.
2. Service **Settings → Build**:
   - **Builder:** Dockerfile.
   - **Dockerfile path:** `packages/attestor/Dockerfile`. The root directory
     stays the repo root, because the image copies `deployments/`.
3. **Settings → Deploy:** leave the healthcheck path **empty**. `/health`
   returns 503 whenever anything is degraded, which would block deploys.
   It's for people and monitoring, not the deploy gate.
4. **Settings → Networking → Generate Domain.** That URL is the attestor
   URL (`https://<name>.up.railway.app`).
5. **Variables**. The non-secret ones:

   ```
   CHAIN_ID=10143
   RPC_URL=https://testnet-rpc.monad.xyz
   CHAINSCORE_BASE_URL=https://chainscore.dev
   KEEPER_INTERVAL_HOURS=24
   ```

   The secret ones, pasted by you, from `.env` unless noted:

   | Variable | Source |
   |---|---|
   | `ATTESTOR_PRIVATE_KEY` | `.env` |
   | `ORACLE_KEEPER_PRIVATE_KEY` | `.env` |
   | `ENVIO_API_TOKEN` | `.env` |
   | `ALCHEMY_API_KEY` | `.env` |
   | `DATABASE_URL` | Supabase, step 3 |
   | `DATABASE_CA_CERT` | Supabase, step 4 (paste the whole PEM) |

   Leave `CORS_ORIGINS` and `INDEXER_URL` for step 5. **Don't set
   `HISTORY_FIXTURE`:** the service refuses to start with it on testnet,
   by design. `PORT` is set by Railway.
6. Deploy. Then open `https://<attestor>/health`. Expected:
   - `rpc`, `registry-attestor`, `chainscore`, `history-fallback`,
     `store` ("Postgres (survives restarts)"), `keeper` and
     `oracle-freshness` all ok;
   - `hypersync` ok, unless it's blocking the host (P4-O14);
   - `indexer-keepalive` **degraded** until step 5. That's expected.

   If the service exits at startup, the log line `missing_production_config`
   or `attestor_mismatch` names the problem.
7. **Tell me the attestor URL.** I then run the §2 check, the restart
   check and the adversarial pass against it, and record its outbound IP
   (P4-O1).

## 3. Envio Cloud (the indexer)

1. envio.dev → sign in with GitHub → hosted indexers → **Add indexer**
   (or "Deploy") → connect `DhrishJ/tenor`.
2. Settings:
   - **Root directory:** `indexer`.
   - **Config file:** `config.yaml`. Committed, generated for the testnet
     deployment; it syncs through HyperSync with RPC fallback.
   - **Branch:** `main`.
3. If it asks for environment variables, add `ENVIO_API_TOKEN` from `.env`.
4. Deploy. When it's synced, copy the **GraphQL endpoint URL**. That's the
   indexer URL.
5. Note on the dashboard: the free tier's 30-day lifetime, and its
   100k-event / 5 GB / 7-days-idle limits. I log current usage in
   RUNNING_LOG (§4).

## 4. Vercel (the web app)

1. vercel.com → sign in with GitHub → **Add New → Project → import
   `DhrishJ/tenor`**.
2. **Root directory:** `apps/web`. The framework (Next.js) is detected.
   The install command comes from `apps/web/vercel.json`; leave it.
3. Environment variables (all public, and they end up in the browser
   anyway):

   ```
   NEXT_PUBLIC_CHAIN_ID=10143
   NEXT_PUBLIC_CHAIN_NAME=Monad Testnet
   NEXT_PUBLIC_RPC_URL=https://testnet-rpc.monad.xyz
   NEXT_PUBLIC_EXPLORER_URL=https://testnet.monadvision.com
   NEXT_PUBLIC_ATTESTOR_URL=<Railway URL from step 2.4>
   NEXT_PUBLIC_INDEXER_URL=<Envio GraphQL URL from step 3.4>
   ```

   Leave **`NEXT_PUBLIC_DEV_WALLET` and `NEXT_PUBLIC_INDEXER_DEV_SECRET`
   unset.** They are local-only. `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is
   optional (it enables mobile wallets).
4. Deploy. The production URL (`https://<name>.vercel.app`) is the live
   product link.

## 5. Back to Railway: two variables

```
CORS_ORIGINS=https://<name>.vercel.app
INDEXER_URL=<Envio GraphQL URL>
```

Redeploy. `/health` should now be `ok` everywhere (HyperSync aside), and
the keeper's next run pings the indexer.

## After you're done

Send me the three URLs (attestor, indexer, web). I then:
- check that production points at production (no localhost anywhere);
- run the §2 Alchemy check and the restart check on the hosted attestor;
- confirm the keeper fires on the host;
- log the Envio limits and usage;
- start the §6 rehearsal.

For the **final** deployment before filming (P4-O7), the redeploy changes
`deployments/10143.json` and `indexer/config.yaml`. Railway and Vercel then
redeploy from the push, and Envio needs a redeploy. The URLs stay the
same.
