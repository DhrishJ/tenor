/**
 * Configuration. The network is config: chain id, RPC URL and every contract
 * address come from the environment and deployments/<chainId>.json. No such
 * literal appears in service code.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { getAddress, type Address, type Hex } from 'viem'

const envSchema = z.object({
  CHAIN_ID: z.coerce.number().int().positive(),
  RPC_URL: z.string().url(),
  DEPLOYMENTS_DIR: z.string().default(resolve(import.meta.dirname, '../../../deployments')),
  ATTESTOR_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'ATTESTOR_PRIVATE_KEY must be a 32-byte hex key'),
  ENVIO_API_TOKEN: z.string().min(1),
  /** Optional: enables the Alchemy fallback for the history check. */
  ALCHEMY_API_KEY: z.string().min(1).optional(),
  CHAINSCORE_BASE_URL: z.string().url(),
  SCORE_TTL_SECONDS: z.coerce.number().int().positive().max(172_800).default(86_400),
  SUBMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  PORT: z.coerce.number().int().positive().default(8787),
  /** Comma-separated browser origins allowed to call the service. */
  CORS_ORIGINS: z.string().default(''),
  /** LOCAL DEVELOPMENT ONLY: path to a recorded-history fixture. Every response is then labelled FIXTURE. */
  HISTORY_FIXTURE: z.string().optional(),
  RATE_LIMIT_PER_IP_PER_MIN: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_PER_ADDRESS_PER_MIN: z.coerce.number().int().positive().default(6),
  /** Postgres (Supabase) for reservations, caches and the refusal log. Required off the local chain. */
  DATABASE_URL: z.string().min(1).optional(),
  /** PEM of the database server's CA (Supabase: Project Settings, Database, SSL). */
  DATABASE_CA_CERT: z.string().min(1).optional(),
  /** Throwaway key that owns the mock oracle and re-stamps it daily (OBJECTIONS P4-O13). Required off the local chain. */
  ORACLE_KEEPER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'ORACLE_KEEPER_PRIVATE_KEY must be a 32-byte hex key').optional(),
  KEEPER_INTERVAL_HOURS: z.coerce.number().positive().default(24),
  /** Hosted indexer GraphQL URL; the keeper queries it so it isn't deleted for idleness. */
  INDEXER_URL: z.string().url().optional(),
})

const deploymentSchema = z.object({
  chainId: z.number(),
  scoreRegistry: z.string(),
  tenorMarket: z.string(),
  attestor: z.string(),
  eip712Name: z.string(),
  eip712Version: z.string(),
  mockPriceOracle: z.string().optional(),
  tUSD: z.string().optional(),
  tCOLL: z.string().optional(),
  maxPriceAge: z.number().optional(),
})

export interface Config {
  chainId: number
  rpcUrl: string
  registry: Address
  market: Address
  expectedAttestor: Address
  eip712: { name: string; version: string }
  attestorKey: Hex
  envioToken: string
  alchemyKey: string | undefined
  chainscoreBaseUrl: string
  scoreTtlSeconds: number
  submitWindowSeconds: number
  port: number
  corsOrigins: string[]
  historyFixture: string | undefined
  rateLimitPerIp: number
  rateLimitPerAddress: number
  databaseUrl: string | undefined
  databaseCaCert: string | undefined
  oracleKeeperKey: Hex | undefined
  keeperIntervalMs: number
  indexerUrl: string | undefined
  oracle: { address: Address; tUSD: Address; tCOLL: Address; maxPriceAge: number } | undefined
}

export const LOCAL_CHAIN_ID = 31337

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty variable means unset (hosting dashboards often leave them blank).
  const e = envSchema.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')))
  const file = resolve(e.DEPLOYMENTS_DIR, `${e.CHAIN_ID}.json`)
  const dep = deploymentSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  if (dep.chainId !== e.CHAIN_ID) throw new Error(`${file} is for chain ${dep.chainId}, not ${e.CHAIN_ID}`)
  return {
    chainId: e.CHAIN_ID,
    rpcUrl: e.RPC_URL,
    registry: getAddress(dep.scoreRegistry),
    market: getAddress(dep.tenorMarket),
    expectedAttestor: getAddress(dep.attestor),
    eip712: { name: dep.eip712Name, version: dep.eip712Version },
    attestorKey: e.ATTESTOR_PRIVATE_KEY as Hex,
    envioToken: e.ENVIO_API_TOKEN,
    alchemyKey: e.ALCHEMY_API_KEY,
    chainscoreBaseUrl: e.CHAINSCORE_BASE_URL,
    scoreTtlSeconds: e.SCORE_TTL_SECONDS,
    submitWindowSeconds: e.SUBMIT_WINDOW_SECONDS,
    port: e.PORT,
    corsOrigins: e.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    historyFixture: e.HISTORY_FIXTURE,
    rateLimitPerIp: e.RATE_LIMIT_PER_IP_PER_MIN,
    rateLimitPerAddress: e.RATE_LIMIT_PER_ADDRESS_PER_MIN,
    databaseUrl: e.DATABASE_URL,
    databaseCaCert: e.DATABASE_CA_CERT?.replace(/\\n/g, '\n'),
    oracleKeeperKey: e.ORACLE_KEEPER_PRIVATE_KEY as Hex | undefined,
    keeperIntervalMs: e.KEEPER_INTERVAL_HOURS * 3_600_000,
    indexerUrl: e.INDEXER_URL,
    oracle:
      dep.mockPriceOracle && dep.tUSD && dep.tCOLL && dep.maxPriceAge
        ? { address: getAddress(dep.mockPriceOracle), tUSD: getAddress(dep.tUSD), tCOLL: getAddress(dep.tCOLL), maxPriceAge: dep.maxPriceAge }
        : undefined,
  }
}
