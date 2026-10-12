/** ChainScore-style gauge: a 300–850 arc, red to green, with a marker at the score. */
export function Gauge({ score, label, sub }: { score: number; label?: string; sub?: string }) {
  const cx = 130
  const cy = 128
  const r = 104
  const t = Math.min(1, Math.max(0, (score - 300) / 550))
  const a = Math.PI * (1 - t)
  const mx = cx + r * Math.cos(a)
  const my = cy - r * Math.sin(a)
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`
  return (
    <div className="relative mx-auto w-full max-w-[300px]">
      <svg viewBox="0 0 260 150" className="w-full" aria-label={`Score ${score} on a 300 to 850 scale`}>
        <defs>
          <linearGradient id="gauge" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#EF4444" />
            <stop offset="45%" stopColor="#F59E0B" />
            <stop offset="75%" stopColor="#84CC16" />
            <stop offset="100%" stopColor="#10B981" />
          </linearGradient>
        </defs>
        <path d={arc} fill="none" stroke="#E2E8F0" strokeWidth="16" strokeLinecap="round" />
        <path d={arc} fill="none" stroke="url(#gauge)" strokeWidth="16" strokeLinecap="round" strokeDasharray={`${Math.PI * r * t} 999`} />
        <circle cx={mx} cy={my} r="11" fill="white" stroke="#10B981" strokeWidth="0" />
        <circle cx={mx} cy={my} r="8" fill={t > 0.6 ? '#10B981' : t > 0.35 ? '#F59E0B' : '#EF4444'} stroke="white" strokeWidth="3" />
        <text x="22" y="148" className="fill-slate-400" fontSize="10">300</text>
        <text x="222" y="148" className="fill-slate-400" fontSize="10">850</text>
      </svg>
      <div className="absolute inset-x-0 top-[44%] text-center">
        <div className="font-grotesk text-6xl font-bold tracking-tight text-text">{score}</div>
        {label && <div className="mt-1 text-sm font-medium text-muted">{label}</div>}
        {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
      </div>
    </div>
  )
}
