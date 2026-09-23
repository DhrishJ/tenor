'use client'
import { useState } from 'react'
import { usePublicClient, useWriteContract } from 'wagmi'
import type { Abi, Address, Hex } from 'viem'
import { explorerTx } from '@/config/network'
import { explainError } from '@/lib/errors'
import { Button } from '@/components/ui/button'

export interface TxSpec {
  label: string
  address: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  /** Human rows shown before the wallet prompt: exactly what is committed. */
  params: Array<[string, string]>
}

/** Review -> simulate -> sign -> confirm. Never a generic failure toast. */
export function TxFlow({ spec, account, onDone, disabled, emptyLabel = 'Enter an amount' }: { spec: TxSpec | undefined; account: Address | undefined; onDone: (spec: TxSpec) => void; disabled?: string; emptyLabel?: string }) {
  const client = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const [review, setReview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [tx, setTx] = useState<Hex>()

  async function send() {
    if (!spec || !client || !account) return
    setBusy(true)
    setError(undefined)
    try {
      const call = { address: spec.address, abi: spec.abi, functionName: spec.functionName, args: spec.args } as const
      await client.simulateContract({ ...call, account })
      const hash = await writeContractAsync(call as never)
      setTx(hash)
      await client.waitForTransactionReceipt({ hash })
      setReview(false)
      onDone(spec)
    } catch (e) {
      setError(explainError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      {!review ? (
        <Button disabled={!spec || Boolean(disabled)} onClick={() => { setReview(true); setError(undefined); setTx(undefined) }}>
          {spec?.label ?? emptyLabel}
        </Button>
      ) : (
        spec && (
          <div className="space-y-2 rounded-md border border-border bg-background/50 p-3">
            <div className="text-xs text-muted">
              You are about to call <span className="font-mono text-text">{spec.functionName}</span> on{' '}
              <span className="font-mono">{spec.address}</span> with:
            </div>
            <dl className="grid grid-cols-[160px_1fr] gap-y-1 font-mono text-xs">
              {spec.params.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <div className="flex gap-2">
              <Button onClick={send} disabled={busy}>
                {busy ? 'Confirm in wallet…' : 'Sign and send'}
              </Button>
              <Button variant="ghost" onClick={() => setReview(false)} disabled={busy}>
                Back
              </Button>
            </div>
          </div>
        )
      )}
      {disabled && <p className="text-xs text-warning">{disabled}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
      {tx && (
        <p className="text-xs text-muted">
          {explorerTx(tx) ? (
            <a className="text-accent underline" href={explorerTx(tx)} target="_blank" rel="noreferrer">
              {tx.slice(0, 14)}…
            </a>
          ) : (
            tx.slice(0, 14) + '…'
          )}
        </p>
      )}
    </div>
  )
}
