/** History and aggregates come from the Envio indexer (one query per page). */
import { services } from '@/config/network'

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  if (!services.indexer) throw new Error('Indexer URL is not configured')
  const res = await fetch(services.indexer, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(services.indexerDevSecret ? { 'x-hasura-admin-secret': services.indexerDevSecret } : {}),
    },
    body: JSON.stringify({ query, variables }),
  })
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
  if (body.errors?.length) throw new Error(`Indexer: ${body.errors[0]!.message}`)
  if (!body.data) throw new Error(`Indexer HTTP ${res.status}`)
  return body.data
}

export interface WalletEventRow {
  id: string
  kind: string
  blockNumber: string
  blockTimestamp: string
  logIndex: number
  txHash: string
  amount: string | null
  score: number | null
  tier: string | null
  maxLtvBps: number | null
  liqThresholdBps: number | null
  collateralPriceWad: string | null
  shortfall: string | null
  fromReserves: string | null
  socialized: string | null
  counterparty: string | null
}

export interface LiquidationRow {
  id: string
  wallet_id: string
  liquidator: string
  repaid: string
  collateralSeized: string
  shortfall: string
  fromReserves: string
  socialized: string
  score: number
  tier: string
  liqThresholdBps: number
  collateralPriceWad: string
  blockTimestamp: string
  txHash: string
}
