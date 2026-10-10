'use client'
import { useState } from 'react'
import { usePublicClient, useWriteContract } from 'wagmi'
import type { Address, Hex } from 'viem'
import { contracts, explorerTx } from '@/config/network'
import { ScoreRegistryAbi } from '@/generated/abis'
import { requestAttestation, type AttestResult } from '@/lib/attestor'
import { explainError } from '@/lib/errors'
import { duration, when } from '@/lib/format'
import { FLOOR_TERMS } from '@/lib/tiers'
import { useNow } from '@/hooks/useNow'
import type { TenorState } from '@/hooks/useTenorState'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle, Label } from '@/components/ui/card'

type Signed = Extract<AttestResult, { state: 'SCORED' }> & { signature: Hex; attestation: NonNullable<Extract<AttestResult, { state: 'SCORED' }>['attestation']> }

/** What the registry currently holds for this wallet, and why it is stale if it is. */
export function OnChainStatus({ s, viewing = false }: { s: TenorState; viewing?: boolean }) {
  const now = useNow()
  if (!s.score) return <div className="h-14" />
  if (s.score.score === 0)
    return (
      <p className="text-sm text-muted">
        No score on-chain yet. {viewing ? 'Until one is relayed, this address' : 'Until you submit one, this wallet'} borrows at floor terms.
      </p>
    )
  if (viewing)
    return (
      <div className="text-sm">
        <div className="flex items-center gap-2">
          <span>
            On-chain Tenor score <span className="num font-semibold">{s.score.score}</span>
          </span>
          {s.score.isStale ? <Badge tone="warning">expired: floor terms apply</Badge> : <Badge tone="success">fresh</Badge>}
        </div>
        <p className="mt-1 text-muted">
          {s.score.isStale
            ? `Expired at ${when(s.score.expiresAt)}. This address would borrow at floor terms (${FLOOR_TERMS}) until a fresh attestation is relayed.`
            : `Relayed to the registry; expires in ${duration(Number(s.score.expiresAt) - now)} (24-hour validity).`}
        </p>
      </div>
    )
  const liq = s.liquidation
  const invalidatedByLiquidation = s.score.isStale && liq && liq.liquidationCount > 0 && liq.lastLiquidatedAt >= s.score.issuedAt
  const remaining = Number(s.score.expiresAt) - now
  return (
    <div className="text-sm">
      <div className="flex items-center gap-2">
        <span>
          On-chain Tenor score <span className="num font-semibold">{s.score.score}</span>
        </span>
        {s.score.isStale ? <Badge tone="warning">expired: floor terms apply</Badge> : <Badge tone="success">fresh</Badge>}
      </div>
      {invalidatedByLiquidation ? (
        <p className="mt-1 text-danger">
          Invalidated by your Tenor liquidation at {when(liq.lastLiquidatedAt)}. The registry rejects any score computed before it.
          Request a fresh score: it will carry Tenor’s liquidation penalty and tier cap.
        </p>
      ) : s.score.isStale ? (
        <p className="mt-1 text-warning">
          Expired at {when(s.score.expiresAt)}. You can still borrow at floor terms ({FLOOR_TERMS}). Request a fresh attestation to
          restore your tier.
        </p>
      ) : (
        <p className="mt-1 text-muted">
          Expires in <span className="num">{duration(remaining)}</span> (24-hour validity).
          {remaining < 2 * 3600 && <span className="text-warning"> Re-attest soon to keep your tier.</span>}
        </p>
      )}
    </div>
  )
}

export function AttestPanel({ wallet, state }: { wallet: Address; state: TenorState }) {
  const [signed, setSigned] = useState<Signed>()
  const [info, setInfo] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<'request' | 'submit'>()
  const [tx, setTx] = useState<Hex>()
  const client = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  async function request() {
    setBusy('request')
    setError(undefined)
    setInfo(undefined)
    setSigned(undefined)
    setTx(undefined)
    try {
      const r = await requestAttestation(wallet)
      if (r.state !== 'SCORED') setError(`${r.state}: ${r.reason}`)
      else if (r.alreadyOnChain) setInfo('This exact score is already on-chain and fresh. Nothing to sign.')
      else if (r.signature && r.attestation) setSigned(r as Signed)
    } catch (e) {
      setError(explainError(e))
    } finally {
      setBusy(undefined)
    }
  }

  async function submit() {
    if (!signed || !client) return
    setBusy('submit')
    setError(undefined)
    const a = signed.attestation
    const args = [
      {
        wallet: a.wallet,
        score: a.score,
        issuedAt: BigInt(a.issuedAt),
        expiresAt: BigInt(a.expiresAt),
        deadline: BigInt(a.deadline),
        nonce: BigInt(a.nonce),
        modelVersion: a.modelVersion,
      },
      signed.signature,
    ] as const
    try {
      // Simulate first: a would-be revert gets its specific reason, not a wallet error.
      await client.simulateContract({ address: contracts.registry, abi: ScoreRegistryAbi, functionName: 'submitAttestation', args, account: wallet })
      const hash = await writeContractAsync({ address: contracts.registry, abi: ScoreRegistryAbi, functionName: 'submitAttestation', args })
      setTx(hash)
      await client.waitForTransactionReceipt({ hash })
      setSigned(undefined)
      setInfo('Submitted. The registry now holds this score.')
      state.refetch()
    } catch (e) {
      setError(explainError(e))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Card className="space-y-4">
      <CardTitle>Attestation</CardTitle>
      <OnChainStatus s={state} />
      {!signed && (
        <Button onClick={request} disabled={busy !== undefined}>
          {busy === 'request' ? 'Requesting signature…' : 'Request attestation'}
        </Button>
      )}
      {signed && (
        <div className="space-y-3">
          <Label>You are about to submit exactly this to ScoreRegistry.submitAttestation</Label>
          <dl className="grid grid-cols-[140px_1fr] gap-y-1 rounded-md border border-border bg-background/50 p-3 font-mono text-xs">
            <dt className="text-muted">wallet</dt>
            <dd className="break-all">{signed.attestation.wallet}</dd>
            <dt className="text-muted">score</dt>
            <dd>
              {signed.attestation.score} (Tenor score, tier {signed.tier})
            </dd>
            <dt className="text-muted">issuedAt</dt>
            <dd>
              {signed.attestation.issuedAt} ({when(BigInt(signed.attestation.issuedAt))}, when ChainScore computed the data)
            </dd>
            <dt className="text-muted">expiresAt</dt>
            <dd>
              {signed.attestation.expiresAt} ({when(BigInt(signed.attestation.expiresAt))})
            </dd>
            <dt className="text-muted">deadline</dt>
            <dd>
              {signed.attestation.deadline} (submit by {when(BigInt(signed.attestation.deadline))})
            </dd>
            <dt className="text-muted">nonce</dt>
            <dd>{signed.attestation.nonce}</dd>
            <dt className="text-muted">modelVersion</dt>
            <dd className="break-all">{signed.attestation.modelVersion}</dd>
            <dt className="text-muted">signature</dt>
            <dd className="break-all">{signed.signature.slice(0, 26)}…</dd>
          </dl>
          <div className="flex gap-2">
            <Button onClick={submit} disabled={busy !== undefined}>
              {busy === 'submit' ? 'Confirm in wallet…' : 'Submit on-chain'}
            </Button>
            <Button variant="ghost" onClick={() => setSigned(undefined)} disabled={busy !== undefined}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {tx && (
        <p className="text-xs text-muted">
          Transaction {explorerTx(tx) ? <a className="text-accent underline" href={explorerTx(tx)} target="_blank" rel="noreferrer">{tx.slice(0, 12)}…</a> : tx}
        </p>
      )}
      {info && <p className="text-sm text-success">{info}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
    </Card>
  )
}

/** Read-only view (P5-O1): status only. Nothing here acts for the viewed address. */
export function ViewOnlyAttestation({ state }: { state: TenorState }) {
  return (
    <Card className="space-y-3">
      <CardTitle>On-chain attestation</CardTitle>
      <OnChainStatus s={state} viewing />
      <p className="text-xs text-muted">
        Submitting an attestation is permissionless: the signature binds it to this address, so anyone can relay it and nobody else can
        use it. Borrowing is not: only the holder of this address&apos;s key can borrow against it.
      </p>
    </Card>
  )
}
