'use client'
import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { getScore } from '@/lib/attestor'
import { explainError } from '@/lib/errors'
import { useTenorState } from '@/hooks/useTenorState'
import { AttestPanel } from '@/components/score/AttestPanel'
import { Chains, Itemization, NotScored, TierTerms } from '@/components/score/Breakdown'
import { Badge } from '@/components/ui/badge'
import { Card, CardTitle, Label } from '@/components/ui/card'

export default function ScorePage() {
  const { address } = useAccount()
  const state = useTenorState(address)
  const score = useQuery({
    queryKey: ['score', address],
    queryFn: () => getScore(address!),
    enabled: Boolean(address),
    staleTime: 60_000,
    retry: false,
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-grotesk text-3xl font-bold">Your credit, portable to Monad</h1>
        <p className="mt-1 max-w-3xl text-muted">
          Tenor reads your Aave and Compound borrowing history from other chains, scores it with ChainScore, and lets you post less
          collateral for the same loan. The score changes how much you lock up, not what you pay.
        </p>
      </div>

      {score.data?.notice && (
        <div className="rounded-md border-2 border-warning bg-warning/10 p-3 text-sm text-warning">
          <b>FIXTURE DATA.</b> {score.data.notice}
        </div>
      )}

      {!address ? (
        <Card className="h-40 text-muted">Connect a wallet to see its score.</Card>
      ) : score.isLoading ? (
        <Card className="h-64 animate-pulse text-muted">Checking borrowing history on 7 chains and scoring with ChainScore…</Card>
      ) : score.error ? (
        <Card className="border-warning/50">
          <CardTitle>Score service unavailable</CardTitle>
          <p className="mt-2 text-sm">{explainError(score.error)}</p>
          <p className="mt-2 text-sm text-muted">You can still borrow at floor terms on the Market page.</p>
        </Card>
      ) : score.data?.state === 'SCORED' ? (
        <div className="grid grid-cols-[1.1fr_1fr] gap-6">
          <Card className="space-y-5">
            <div className="flex items-end justify-between">
              <div>
                <Label>Tenor score</Label>
                <div className="num text-5xl font-semibold">{score.data.tenorScore}</div>
              </div>
              <Badge tone="accent" className="text-sm">
                Tier {score.data.tier}
              </Badge>
            </div>
            <Itemization ev={score.data} />
            <div>
              <Label className="mb-2">What tier {score.data.tier} unlocks (same interest rate for every tier)</Label>
              <TierTerms tier={score.data.tier} />
            </div>
          </Card>
          <div className="space-y-6">
            <Card>
              <Chains ev={score.data} fixture={Boolean(score.data.notice)} />
            </Card>
            <AttestPanel wallet={address} state={state} />
          </div>
        </div>
      ) : score.data ? (
        <div className="grid grid-cols-[1.1fr_1fr] gap-6">
          <NotScored ev={score.data} />
          <AttestPanel wallet={address} state={state} />
        </div>
      ) : null}
    </div>
  )
}
