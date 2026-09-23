/**
 * Client for the attestation service (packages/attestor). The response types
 * are imported from the service itself, so the itemization on screen cannot
 * drift from what the service returns.
 */
import type { AttestResult, Evaluation } from '../../../../packages/attestor/src/service'
import { services } from '@/config/network'

export type { AttestResult, Evaluation }
export type Scored = Extract<Evaluation, { state: 'SCORED' }>

export class AttestorError extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!services.attestor) throw new AttestorError('Attestation service URL is not configured')
  let res: Response
  try {
    res = await fetch(`${services.attestor.replace(/\/$/, '')}${path}`, init)
  } catch {
    throw new AttestorError('The attestation service is unreachable. This is not a score; try again shortly.')
  }
  if (res.status === 429) throw new AttestorError('Too many requests for this address; wait a minute and retry.')
  const body = (await res.json()) as T & { error?: string }
  // 503 carries a typed UNAVAILABLE body; other non-2xx are errors.
  if (!res.ok && res.status !== 503) throw new AttestorError(body.error ?? `Attestation service HTTP ${res.status}`)
  return body
}

/** Present when the service runs in a labelled non-live mode (e.g. FIXTURE). */
export interface Notice {
  notice?: string
}

export const getScore = (address: string) => call<Evaluation & Notice & { requestId: string }>(`/score/${address}`)

export const requestAttestation = (address: string) =>
  call<AttestResult & Notice & { requestId: string }>('/attest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  })
