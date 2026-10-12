'use client'
import { useQuery } from '@tanstack/react-query'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Suspense, useState } from 'react'
import { isAddress } from 'viem'
import { getScore } from '@/lib/attestor'
import { explainError } from '@/lib/errors'
import { useTenorState } from '@/hooks/useTenorState'
import { AttestPanel, ViewOnlyAttestation } from '@/components/score/AttestPanel'
import { useViewedWallet } from '@/hooks/useViewedWallet'
import { shortAddr } from '@/lib/format'
import { Chains, Itemization, NotScored, TierTerms } from '@/components/score/Breakdown'
import { Gauge } from '@/components/score/Gauge'
import { TierLadder } from '@/components/score/TierLadder'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle, Label, PageHeader } from '@/components/ui/card'

export default function ScorePage() {
  return (
    <Suspense fallback={<Card className="h-64" />}>
      <Score />
    </Suspense>
  )
}

function Score() {
  const { wallet: address, viewing } = useViewedWallet()
  const state = useTenorState(address)
  const score = useQuery({
    queryKey: ['score', address],
    queryFn: () => getScore(address!),
    enabled: Boolean(address),
    staleTime: 60_000,
    retry: false,
  })

  if (!address) return <Landing />

  return (
    <div className="space-y-8">
      {viewing ? (
        <PageHeader eyebrow="Live score, read-only view" title={<>Credit view: <span className="font-mono">{shortAddr(address)}</span></>}>
          A real borrower&apos;s address, scored live from its public Aave and Compound history on other chains. Read-only: this page does not
          act for it.
        </PageHeader>
      ) : (
        <PageHeader eyebrow="Your live score" title="Your credit, portable to Monad">
          Tenor reads your Aave and Compound borrowing history from other chains, scores it with ChainScore, and lets you post less
          collateral for the same loan. The score changes how much you lock up, not what you pay.
        </PageHeader>
      )}

      {score.data?.notice && (
        <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-3 text-sm text-warning">
          <b>FIXTURE DATA.</b> {score.data.notice}
        </div>
      )}

      {score.isLoading ? (
        <Card className="flex h-72 flex-col items-center justify-center gap-3 text-muted">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-subtle border-t-accent" />
          Checking borrowing history on 7 chains and scoring with ChainScore…
        </Card>
      ) : score.error ? (
        <Card className="border-amber-300">
          <CardTitle>Score service unavailable</CardTitle>
          <p className="mt-2 text-sm">{explainError(score.error)}</p>
          <p className="mt-2 text-sm text-muted">You can still borrow at floor terms on the Market page.</p>
        </Card>
      ) : score.data?.state === 'SCORED' ? (
        <div className="grid gap-6 lg:grid-cols-[1.05fr_1fr]">
          <Card className="space-y-6">
            <div className="flex items-start justify-between">
              <Label>Tenor score</Label>
              <Badge tone="accent" dot className="text-xs">
                Tier {score.data.tier}
              </Badge>
            </div>
            <Gauge score={score.data.tenorScore} label={`Tier ${score.data.tier}`} sub="ChainScore scale, 300 to 850" />
            <Itemization ev={score.data} />
            <div className="rounded-xl bg-subtle p-4">
              <Label className="mb-3">What tier {score.data.tier} unlocks (same interest rate for every tier)</Label>
              <TierTerms tier={score.data.tier} />
            </div>
          </Card>
          <div className="space-y-6">
            <Card>
              <Chains ev={score.data} fixture={Boolean(score.data.notice)} />
            </Card>
            {viewing ? <ViewOnlyAttestation state={state} /> : <AttestPanel wallet={address} state={state} />}
          </div>
        </div>
      ) : score.data ? (
        <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
          <NotScored ev={score.data} />
          {viewing ? <ViewOnlyAttestation state={state} /> : <AttestPanel wallet={address} state={state} />}
        </div>
      ) : null}
    </div>
  )
}

/** No wallet yet: what Tenor is, the terms, and a way in without a wallet. */
function Landing() {
  const router = useRouter()
  const [q, setQ] = useState('')
  const valid = isAddress(q.trim())
  return (
    <div className="space-y-16">
      <section className="relative">
        <div className="hero-grid pointer-events-none absolute -inset-x-10 -top-10 h-[420px]" />
        <div className="relative grid items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              Credit-scored collateral on Monad testnet
            </div>
            <h1 className="font-grotesk text-5xl font-bold leading-[1.05] tracking-tight text-text">
              Your borrowing history,
              <br />
              <span className="text-accent">priced into your collateral</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">
              Every lending protocol asks every wallet for the same collateral. Tenor reads your Aave and Compound record on other chains,
              verifies it on-chain, scores it with ChainScore, and lets a proven borrower post less for the same loan. Same interest rate
              for everyone; nobody is turned away.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <ConnectButton.Custom>
                {({ openConnectModal, mounted }) => (
                  <Button size="lg" onClick={openConnectModal} disabled={!mounted}>
                    Connect wallet to see your score
                  </Button>
                )}
              </ConnectButton.Custom>
              <Link href="/market">
                <Button size="lg" variant="outline">
                  Explore the market
                </Button>
              </Link>
            </div>
            <form
              className="mt-6 max-w-xl"
              onSubmit={(e) => {
                e.preventDefault()
                if (valid) router.push(`/?wallet=${q.trim()}`)
              }}
            >
              <div className="mb-2 text-sm text-muted">Or check any address, read-only:</div>
              <div className="flex gap-2">
                <input
                  className="h-11 w-full rounded-xl border border-border bg-card px-4 font-mono text-sm shadow-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/10"
                  placeholder="0x… any wallet address"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  aria-label="address to check"
                />
                <Button type="submit" variant="outline" className="h-11" disabled={!valid}>
                  Check
                </Button>
              </div>
            </form>
          </div>
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between px-1">
              <div>
                <CardTitle className="text-base">Terms by tier</CardTitle>
                <div className="text-xs text-muted">As the contract applies them. Same interest rate for every tier.</div>
              </div>
              <Badge tone="success" dot>
                on-chain
              </Badge>
            </div>
            <TierLadder />
          </Card>
        </div>
      </section>

      <section className="grid gap-5 md:grid-cols-3">
        {[
          {
            n: '01',
            title: 'Verified, not assumed',
            body: 'Borrowing on Aave and Compound is checked on-chain across seven chains (Envio HyperSync, with an Alchemy fallback). If the data cannot be verified, Tenor refuses rather than guess.',
          },
          {
            n: '02',
            title: 'Scored by ChainScore',
            body: 'Each verified chain is scored 300 to 850; Tenor takes the lowest. A refusal is never shown as a low score, and no score still means floor terms, not no access.',
          },
          {
            n: '03',
            title: 'Priced on-chain, with consequences',
            body: 'A signed attestation sets your tier: max LTV, liquidation threshold and cap. A liquidation on Tenor invalidates the score at once and caps the next one.',
          },
        ].map((s) => (
          <Card key={s.n} className="space-y-2">
            <div className="num text-sm font-semibold text-accent">{s.n}</div>
            <CardTitle className="text-base">{s.title}</CardTitle>
            <p className="text-sm leading-relaxed text-muted">{s.body}</p>
          </Card>
        ))}
      </section>
    </div>
  )
}
