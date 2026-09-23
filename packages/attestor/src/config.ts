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
  CHAINSCORE_BASE_URL: z.string().url(),
  SCORE_TTL_SECONDS: z.coerce.number().int().positive().max(172_800).default(86_400),
  SUBMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  PORT: z.coerce.number().int().positive().default(8787),
  RATE_LIMIT_PER_IP_PER_MIN: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_PER_ADDRESS_PER_MIN: z.coerce.number().int().positive().default(6),
})

const deploymentSchema = z.object({
  chainId: z.number(),
  scoreRegistry: z.string(),
  tenorMarket: z.string(),
  attestor: z.string(),
  eip712Name: z.string(),
  eip712Version: z.string(),
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
  chainscoreBaseUrl: string
  scoreTtlSeconds: number
  submitWindowSeconds: number
  port: number
  rateLimitPerIp: number
  rateLimitPerAddress: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(env)
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
    chainscoreBaseUrl: e.CHAINSCORE_BASE_URL,
    scoreTtlSeconds: e.SCORE_TTL_SECONDS,
    submitWindowSeconds: e.SUBMIT_WINDOW_SECONDS,
    port: e.PORT,
    rateLimitPerIp: e.RATE_LIMIT_PER_IP_PER_MIN,
    rateLimitPerAddress: e.RATE_LIMIT_PER_ADDRESS_PER_MIN,
  }
}
