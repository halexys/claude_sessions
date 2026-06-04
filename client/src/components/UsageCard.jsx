import { useState, useEffect } from 'react'
import { fetchWithAuth } from '../auth'

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'
  return String(n)
}

function fmtReset(isoStr) {
  if (!isoStr) return null
  const diff = new Date(isoStr) - Date.now()
  if (diff <= 0) return 'Ahora'
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (h > 48) {
    const d = new Date(isoStr)
    return `${d.toLocaleDateString('es', { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`
  }
  if (h > 0) return `en ${h}h ${m}m`
  return `en ${m}m`
}

function QuotaBar({ label, pct, resetsAt, color = 'blue', tokensUsed, tokensTotal, tokensRemaining }) {
  if (pct == null) return null
  const colors = {
    blue:   { bar: pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-yellow-400' : 'bg-blue-500', text: 'text-blue-400' },
    purple: { bar: pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-yellow-400' : 'bg-purple-500', text: 'text-purple-400' },
  }
  const c = colors[color]
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-300 font-medium">{label}</span>
        <span className={`${c.text} font-semibold`}>{Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${c.bar} rounded-full transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      {tokensUsed != null && (
        <div className="flex items-center justify-between text-[10px] text-slate-500">
          <span>
            {fmt(tokensUsed)} usados
            {tokensTotal != null && <> / ~{fmt(tokensTotal)}</>}
          </span>
          {tokensRemaining != null && (
            <span className={pct > 80 ? 'text-red-400' : pct > 50 ? 'text-yellow-500' : 'text-slate-500'}>
              ~{fmt(tokensRemaining)} restantes
            </span>
          )}
        </div>
      )}
      {resetsAt && (
        <span className="text-[10px] text-slate-600">Reinicia {fmtReset(resetsAt)}</span>
      )}
    </div>
  )
}

function MiniBar({ daily }) {
  const max = Math.max(...daily.map(d => d.input + d.output), 1)
  const today = new Date().toISOString().slice(0, 10)
  const days = ['D', 'L', 'M', 'X', 'J', 'V', 'S']
  return (
    <div className="flex items-end gap-1 h-10">
      {daily.map(d => {
        const tokens = d.input + d.output
        const h = Math.max(2, Math.round((tokens / max) * 36))
        const isToday = d.date === today
        const dayName = days[new Date(d.date + 'T12:00:00').getDay()]
        return (
          <div key={d.date} className="flex flex-col items-center gap-0.5 flex-1">
            <div className={`w-full rounded-sm ${isToday ? 'bg-blue-400' : 'bg-slate-600'}`} style={{ height: h }} />
            <span className={`text-[9px] ${isToday ? 'text-blue-400' : 'text-slate-600'}`}>{dayName}</span>
          </div>
        )
      })}
    </div>
  )
}

export default function UsageCard() {
  const [usage, setUsage] = useState(null)
  const [quota, setQuota] = useState(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    fetchWithAuth('/api/usage').then(r => r.ok ? r.json() : null).then(d => { if (d) setUsage(d) }).catch(() => {})
    fetchWithAuth('/api/quota').then(r => r.ok ? r.json() : null).then(d => { if (d) setQuota(d) }).catch(() => {})
  }, [])

  if (!usage && !quota) return null

  const fiveHour   = quota?.five_hour
  const sevenDay   = quota?.seven_day
  const sonnet     = quota?.seven_day_sonnet
  const extraUsage = quota?.extra_usage

  function windowTokens(win, quotaEntry) {
    if (!win || !quotaEntry) return {}
    const used = win.input + win.output
    const pct = quotaEntry.utilization
    const total = pct > 0 ? Math.round(used / (pct / 100)) : null
    const remaining = total != null ? Math.max(0, total - used) : null
    return { used, total, remaining }
  }

  const wFiveHour = windowTokens(usage?.windows?.fiveHour, fiveHour)
  const wSevenDay = windowTokens(usage?.windows?.sevenDay, sevenDay)
  const wSonnet   = windowTokens(usage?.windows?.sevenDaySonnet, sonnet)

  return (
    <div className="mx-4 mt-3 mb-1 bg-slate-800 border border-slate-700 rounded-xl overflow-hidden"
      onClick={() => setExpanded(e => !e)}>

      {/* Compact row */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Quota mini-indicators */}
        <div className="flex flex-col gap-1.5 flex-shrink-0 w-28">
          {fiveHour && (
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 flex-1 bg-slate-700 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${fiveHour.utilization > 80 ? 'bg-red-500' : fiveHour.utilization > 50 ? 'bg-yellow-400' : 'bg-blue-500'}`}
                  style={{ width: `${Math.min(fiveHour.utilization, 100)}%` }} />
              </div>
              <span className="text-[10px] text-slate-400 w-7 text-right">{Math.round(fiveHour.utilization)}%</span>
            </div>
          )}
          {sevenDay && (
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 flex-1 bg-slate-700 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${sevenDay.utilization > 80 ? 'bg-red-500' : sevenDay.utilization > 50 ? 'bg-yellow-400' : 'bg-purple-500'}`}
                  style={{ width: `${Math.min(sevenDay.utilization, 100)}%` }} />
              </div>
              <span className="text-[10px] text-slate-400 w-7 text-right">{Math.round(sevenDay.utilization)}%</span>
            </div>
          )}
        </div>

        {/* Token summary */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {usage ? (
            <>
              <div className="text-xs text-slate-500 truncate">semana</div>
              <div className="text-base font-semibold text-slate-100 truncate">{fmt(usage.week.input + usage.week.output)}</div>
              <div className="text-xs text-slate-500 truncate">hoy {fmt(usage.today.input + usage.today.output)}</div>
            </>
          ) : (
            <span className="text-xs text-slate-500">...</span>
          )}
        </div>

        {usage && (
          <div className="w-20 flex-shrink-0">
            <MiniBar daily={usage.daily} />
          </div>
        )}

        <svg className={`w-4 h-4 text-slate-500 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* Expanded */}
      {expanded && (
        <div className="border-t border-slate-700 px-4 py-3 flex flex-col gap-4">

          {/* Quota bars with token details */}
          {(fiveHour || sevenDay || sonnet) && (
            <div className="flex flex-col gap-3">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Límites</span>
              {fiveHour && (
                <QuotaBar
                  label="Sesión actual (5h)" pct={fiveHour.utilization} resetsAt={fiveHour.resets_at} color="blue"
                  tokensUsed={wFiveHour.used} tokensTotal={wFiveHour.total} tokensRemaining={wFiveHour.remaining}
                />
              )}
              {sevenDay && (
                <QuotaBar
                  label="Semana — todos los modelos" pct={sevenDay.utilization} resetsAt={sevenDay.resets_at} color="purple"
                  tokensUsed={wSevenDay.used} tokensTotal={wSevenDay.total} tokensRemaining={wSevenDay.remaining}
                />
              )}
              {sonnet && (
                <QuotaBar
                  label="Semana — solo Sonnet" pct={sonnet.utilization} resetsAt={sonnet.resets_at} color="purple"
                  tokensUsed={wSonnet.used} tokensTotal={wSonnet.total} tokensRemaining={wSonnet.remaining}
                />
              )}
              {extraUsage?.is_enabled && (
                <div className="text-xs text-amber-400 mt-1">Uso extra activo</div>
              )}
            </div>
          )}

          {/* Token stats */}
          {usage && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Tokens</span>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Hoy',    tokens: usage.today.input + usage.today.output, convs: usage.today.conversations },
                  { label: 'Semana', tokens: usage.week.input  + usage.week.output,  convs: usage.week.conversations  },
                  { label: 'Mes',    tokens: usage.month.input + usage.month.output, convs: usage.month.conversations },
                ].map(({ label, tokens, convs }) => (
                  <div key={label} className="flex flex-col gap-0.5">
                    <span className="text-xs text-slate-500">{label}</span>
                    <span className="text-sm font-semibold text-slate-100">{fmt(tokens)}</span>
                    <span className="text-xs text-slate-600">{convs} conv</span>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-slate-500 mt-1 pt-2 border-t border-slate-700/50">
                <div>Entrada: <span className="text-slate-400">{fmt(usage.week.input)}</span></div>
                <div>Salida: <span className="text-slate-400">{fmt(usage.week.output)}</span></div>
                <div>Cache write: <span className="text-slate-400">{fmt(usage.week.cacheWrite)}</span></div>
                <div>Cache read: <span className="text-slate-400">{fmt(usage.week.cacheRead)}</span></div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
