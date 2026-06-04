import { useEffect, useState, useCallback, useRef } from 'react'
import { fetchWithAuth } from '../auth'
import { API_BASE } from '../config'
import NewChatModal from './NewChatModal.jsx'
import UsageCard from './UsageCard.jsx'
import Icon from './Icon.jsx'

function semverNewer(remote, local) {
  const a = String(remote).split('.').map(n => parseInt(n, 10) || 0)
  const b = String(local).split('.').map(n => parseInt(n, 10) || 0)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0, y = b[i] || 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

function AboutFooter() {
  const [status, setStatus]   = useState(null)  // { current, pending, sessionsActive, lastCheckAt }
  const [checking, setChecking] = useState(false)
  const [applying, setApplying] = useState(false)
  const [msg, setMsg]           = useState(null)
  const [appUpdate, setAppUpdate] = useState(null)

  async function refreshStatus() {
    try {
      const r = await fetchWithAuth('/api/version')
      if (r.ok) setStatus(await r.json())
    } catch {}
  }

  useEffect(() => { refreshStatus() }, [])

  async function checkUpdates() {
    setChecking(true); setMsg(null); setAppUpdate(null)
    try {
      const url = (API_BASE || '') + '/version.json?ts=' + Date.now()
      const appResp = await fetch(url, { cache: 'no-store' })
      if (appResp.ok) {
        const meta = await appResp.json()
        if (meta?.latest && semverNewer(meta.latest, __APP_VERSION__)) {
          setAppUpdate({ latest: meta.latest, apkUrl: meta.apkUrl })
        }
      }
      const r = await fetchWithAuth('/api/admin/update-now', { method: 'POST' })
      if (r.ok) setStatus(await r.json())
    } catch (e) {
      setMsg(e.message)
    } finally {
      setChecking(false)
    }
  }

  async function applyUpdate(force) {
    if (!status?.pending) return
    if (!force && status.sessionsActive > 0) {
      if (!window.confirm(`Hay ${status.sessionsActive} sesión(es) activa(s). ¿Forzar actualización?`)) return
      force = true
    }
    setApplying(true)
    try {
      await fetchWithAuth('/api/admin/apply-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: !!force }),
      })
      setMsg('Aplicando — el server se reinicia en segundos…')
      // Refresh after restart
      setTimeout(refreshStatus, 8000)
    } catch (e) {
      setMsg('Error: ' + e.message)
    } finally {
      setTimeout(() => setApplying(false), 6000)
    }
  }

  const serverVer = status?.current
  const pending   = status?.pending
  const active    = status?.sessionsActive || 0

  return (
    <div className="mx-4 mt-3 mb-1 px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>App</span>
        <span className="font-mono text-slate-200">v{__APP_VERSION__}</span>
      </div>
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>Servidor</span>
        <span className="font-mono text-slate-200">{serverVer ? `v${serverVer}` : '—'}</span>
      </div>

      {appUpdate && (
        <a
          href={appUpdate.apkUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-1.5 w-full py-2 rounded-lg bg-amber-600 active:bg-amber-700 text-xs text-white font-semibold"
        >
          <Icon name="arrow-up" className="w-3.5 h-3.5" />
          <span>Nueva app v{appUpdate.latest} — descargar APK</span>
        </a>
      )}

      {pending && (
        <div className="bg-amber-900/40 border border-amber-700/50 rounded-lg p-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-amber-200 font-semibold">
            <Icon name="arrow-up" className="w-3.5 h-3.5" />
            <span>Server v{pending.version} disponible</span>
          </div>
          {pending.releaseNotes && (
            <p className="text-[11px] text-amber-300/80">{pending.releaseNotes}</p>
          )}
          {active > 0 && (
            <p className="text-[11px] text-amber-300/70">
              {active} sesión(es) activa(s) — actualizar las cierra.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              onClick={() => applyUpdate(false)}
              disabled={applying || active > 0}
              className="py-1.5 rounded-md bg-slate-700 active:bg-slate-600 disabled:opacity-40 text-xs text-slate-200"
            >Aplicar</button>
            <button
              onClick={() => applyUpdate(true)}
              disabled={applying}
              className="py-1.5 rounded-md bg-amber-600 active:bg-amber-700 disabled:opacity-50 text-xs text-white font-semibold"
            >Forzar</button>
          </div>
        </div>
      )}

      {msg && <p className="text-[11px] text-slate-400">{msg}</p>}

      <button
        onClick={checkUpdates}
        disabled={checking || applying}
        className="w-full py-2 mt-1 rounded-lg bg-slate-700 active:bg-slate-600 disabled:opacity-50 text-xs text-slate-300 flex items-center justify-center gap-2"
      >
        {checking && <span className="w-3 h-3 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin" />}
        <span>{checking ? 'Comprobando…' : 'Comprobar actualizaciones'}</span>
      </button>
    </div>
  )
}

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Math.floor((Date.now() - new Date(ts)) / 1000)
  if (diff < 60) return `${diff}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
}

function truncatePath(p) {
  if (!p) return ''
  const home = window.__homeDir || ''
  if (home && p.startsWith(home)) return '~' + p.slice(home.length)
  if (p.length > 40) return '…' + p.slice(p.length - 38)
  return p
}

const PAGE = 30

export default function ChatList({ onOpenChat }) {
  const [chats, setChats] = useState([])
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [showUsage, setShowUsage] = useState(false)
  const [quotaPct, setQuotaPct] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [query, setQuery] = useState('')
  const [showAgents, setShowAgents] = useState(false)
  const [hasMore, setHasMore]       = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [serverUpdate, setServerUpdate] = useState(null)
  const [pullY, setPullY] = useState(0)         // pull-to-refresh translate
  const [refreshing, setRefreshing] = useState(false)
  const scrollRef = useRef(null)
  const touchStart = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/chat/sessions?limit=${PAGE}&offset=0`)
      if (res.ok) {
        const data = await res.json()
        // Server now returns { chats, total, hasMore }; old shape was a raw array.
        const list  = Array.isArray(data) ? data : (data.chats || [])
        const more  = Array.isArray(data) ? false : !!data.hasMore
        setChats(list)
        setHasMore(more)
        setOffline(false)
      } else if (res.status >= 502 && res.status <= 504) {
        setOffline(true)
      }
    } catch {
      setOffline(true)
    } finally {
      setLoading(false)
    }
  }, [])

  async function loadMore() {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const res = await fetchWithAuth(`/api/chat/sessions?limit=${PAGE}&offset=${chats.length}`)
      if (!res.ok) return
      const data = await res.json()
      const list = Array.isArray(data) ? data : (data.chats || [])
      setChats(prev => [...prev, ...list])
      setHasMore(Array.isArray(data) ? false : !!data.hasMore)
    } finally {
      setLoadingMore(false)
    }
  }

  // Pull-to-refresh: only when scrollTop=0 and user pulls down past threshold.
  const THRESHOLD = 70
  function onTouchStart(e) {
    if ((scrollRef.current?.scrollTop || 0) > 0) return
    touchStart.current = e.touches[0].clientY
  }
  function onTouchMove(e) {
    if (touchStart.current == null || refreshing) return
    const dy = e.touches[0].clientY - touchStart.current
    if (dy < 0) { setPullY(0); return }
    setPullY(Math.min(dy * 0.5, THRESHOLD + 20))  // dampen
  }
  async function onTouchEnd() {
    if (touchStart.current == null) return
    touchStart.current = null
    if (pullY >= THRESHOLD) {
      setRefreshing(true)
      setPullY(THRESHOLD)
      await refresh()
      setRefreshing(false)
    }
    setPullY(0)
  }

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 10000)
    return () => clearInterval(id)
  }, [refresh])

  // Poll server version once per minute so the update notification arrives
  // shortly after the server's hourly self-check finds something.
  useEffect(() => {
    let cancelled = false
    async function fetchVer() {
      try {
        const r = await fetchWithAuth('/api/version')
        if (!r.ok || cancelled) return
        const d = await r.json()
        setServerUpdate(d?.pending ? d : null)
      } catch {}
    }
    fetchVer()
    const id = setInterval(fetchVer, 60000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Quota indicator for the header chip. Self-rescheduling loop so failures
  // retry quickly (5s) while successes back off to every 30s. The previous
  // value is kept on error so the chip doesn't flicker out on transient hiccups.
  useEffect(() => {
    let cancelled = false
    let timer = null
    async function tick() {
      let nextDelay = 30000
      try {
        const res = await fetchWithAuth('/api/quota')
        if (cancelled) return
        if (res.ok) {
          const q = await res.json()
          const pct = Math.max(
            q?.five_hour?.utilization || 0,
            q?.seven_day?.utilization || 0,
          )
          setQuotaPct(pct)
        } else {
          nextDelay = 5000  // quick retry on HTTP error
        }
      } catch {
        nextDelay = 5000
      }
      if (!cancelled) timer = setTimeout(tick, nextDelay)
    }
    tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [])

  async function handleDelete(e, id) {
    e.stopPropagation()
    if (!window.confirm('¿Borrar este chat?')) return
    setDeletingId(id)
    try {
      await fetchWithAuth(`/api/chat/sessions/${id}`, { method: 'DELETE' })
      setChats(prev => prev.filter(c => c.id !== id))
    } finally {
      setDeletingId(null)
    }
  }

  function handleModalClose(newChat) {
    setShowModal(false)
    if (newChat) {
      onOpenChat(newChat.id, newChat)
    }
  }

  return (
    <div className="bg-slate-900 text-white h-full flex flex-col">
      <header className="flex items-center justify-between gap-2 px-4 py-3 bg-slate-800 border-b border-slate-700 flex-shrink-0">
        <button
          onClick={() => setShowUsage(true)}
          className="flex items-center gap-2 min-w-0 active:opacity-70"
          aria-label="Ver uso"
        >
          <Icon name="chat" className="w-5 h-5 text-blue-400 flex-shrink-0" />
          <h1 className="text-lg font-semibold text-slate-100 truncate">Chats</h1>
          {quotaPct != null && (
            <span className={`ml-1 px-2 py-0.5 rounded-full text-[11px] font-semibold flex items-center gap-1 ${
              quotaPct > 80 ? 'bg-red-900/70 text-red-300'
              : quotaPct > 50 ? 'bg-amber-900/70 text-amber-300'
              : 'bg-slate-700 text-slate-300'
            }`}>
              <Icon name="chart" className="w-3 h-3" /> {Math.round(quotaPct)}%
            </span>
          )}
        </button>
        <button
          onClick={() => setShowModal(true)}
          className="w-10 h-10 flex items-center justify-center rounded-full bg-blue-600 active:bg-blue-700 text-white flex-shrink-0"
          aria-label="Nuevo chat"
        ><Icon name="plus" className="w-5 h-5" strokeWidth={2.5} /></button>
      </header>

      {offline && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-900/60 border-b border-amber-700 text-amber-300 text-sm">
          <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
          PC offline — reconectando...
        </div>
      )}

      {serverUpdate?.pending && (
        <button
          onClick={() => setShowUsage(true)}
          className="w-full flex items-center gap-2 px-4 py-2 bg-blue-900/50 border-b border-blue-800 text-blue-200 text-xs active:bg-blue-900/70"
        >
          <Icon name="arrow-up" className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="flex-1 text-left">
            Actualización de server v{serverUpdate.pending.version} disponible
            {serverUpdate.sessionsActive > 0 && ` · ${serverUpdate.sessionsActive} sesión(es) activa(s)`}
          </span>
          <Icon name="chevron-right" className="w-3.5 h-3.5" />
        </button>
      )}

      {chats.some(c => c.active) && (
        <div className="flex items-center gap-3 px-4 py-1.5 bg-slate-850 border-b border-slate-800 text-[10px] text-slate-500">
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-400" />en memoria</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />en curso</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-slate-700" />frío</span>
        </div>
      )}

      {chats.length > 0 && (
        <div className="px-3 py-2 bg-slate-900 border-b border-slate-800 flex items-center gap-2 flex-shrink-0">
          <Icon name="search" className="w-4 h-4 text-slate-500" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Buscar chats..."
            autoCorrect="off" autoCapitalize="none" spellCheck={false}
            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-blue-500"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-slate-500 active:text-slate-300 text-sm w-6 h-6 flex items-center justify-center">✕</button>
          )}
        </div>
      )}

      <div
        ref={scrollRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        className="flex-1 overflow-y-auto relative"
      >
        {/* pull-to-refresh indicator floats above the content */}
        {(pullY > 0 || refreshing) && (
          <div
            className="absolute left-0 right-0 flex justify-center pointer-events-none z-10"
            style={{ top: Math.max(8, pullY - 36) }}
          >
            <div className={`w-9 h-9 rounded-full bg-slate-800 border border-slate-700 shadow-lg flex items-center justify-center ${pullY >= THRESHOLD || refreshing ? 'border-blue-500' : ''}`}>
              <span
                className={`text-blue-400 ${refreshing ? 'animate-spin' : ''}`}
                style={!refreshing ? { display: 'inline-block', transform: `rotate(${Math.min(pullY / THRESHOLD, 1) * 360}deg)`, transition: 'transform 80ms linear' } : {}}
              ><Icon name="refresh" className="w-4 h-4" /></span>
            </div>
          </div>
        )}
      <div
        style={{ transform: pullY > 0 ? `translateY(${pullY}px)` : undefined, transition: pullY === 0 ? 'transform 0.2s' : 'none' }}
      >
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
          </div>
        ) : chats.length === 0 ? (
          <div className="text-center text-slate-500 py-12 px-6">
            <p className="text-base mb-1">Sin chats todavía</p>
            <p className="text-xs">Toca + para empezar uno nuevo</p>
          </div>
        ) : (() => {
          const isAgent = c => c.entrypoint && c.entrypoint !== 'cli'
          const agentCount = chats.filter(isAgent).length
          const baseFiltered = showAgents ? chats : chats.filter(c => !isAgent(c))
          const q = query.trim().toLowerCase()
          const filtered = q
            ? baseFiltered.filter(c =>
                (c.title || '').toLowerCase().includes(q) ||
                (c.lastUserText || '').toLowerCase().includes(q) ||
                (c.lastAssistantText || '').toLowerCase().includes(q) ||
                (c.cwd || '').toLowerCase().includes(q)
              )
            : baseFiltered
          if (filtered.length === 0 && !agentCount) return (
            <div className="text-center text-slate-500 py-8 px-6 text-sm">
              {query ? `Sin resultados para "${query}"` : 'Sin chats'}
            </div>
          )
          return (
          <>
          {agentCount > 0 && (
            <button
              onClick={() => setShowAgents(v => !v)}
              className="w-full flex items-center justify-between px-4 py-2 bg-slate-850 border-b border-slate-800 text-xs text-slate-400 active:bg-slate-800"
            >
              <span className="flex items-center gap-1.5">
                <Icon name="bot" className="w-4 h-4" />
                <span>{showAgents ? 'Ocultar' : 'Mostrar'} agentes ({agentCount})</span>
              </span>
              <Icon name={showAgents ? 'chevron-down' : 'chevron-right'} className="w-4 h-4 text-slate-500" />
            </button>
          )}
          <ul className="divide-y divide-slate-800">
            {filtered.map(c => (
              <li
                key={c.id}
                onClick={() => onOpenChat(c.id, c)}
                className="px-4 py-3 active:bg-slate-800 cursor-pointer flex items-start gap-3"
              >
                <span
                  className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${
                    c.busy ? 'bg-yellow-400 animate-pulse'
                    : c.active ? 'bg-green-400'
                    : 'bg-slate-700'
                  }`}
                  title={c.busy ? 'En curso' : c.active ? 'En memoria — abre instantáneo' : 'Frío — tarda en abrir'}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <span className="text-sm font-medium text-slate-100 truncate flex items-center gap-1.5">
                      {c.entrypoint && c.entrypoint !== 'cli' && <Icon name="bot" className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />}
                      <span className="truncate">{c.title || c.lastUserText?.slice(0, 60) || c.id.slice(0, 8)}</span>
                    </span>
                    <span className="text-xs text-slate-500 flex-shrink-0">{timeAgo(c.ts)}</span>
                  </div>
                  <p className="text-xs text-slate-400 truncate">
                    {c.lastAssistantText || c.lastUserText || '—'}
                  </p>
                  <p className="text-[10px] text-slate-600 font-mono mt-0.5 truncate">{truncatePath(c.cwd)}</p>
                </div>
                <button
                  onClick={e => handleDelete(e, c.id)}
                  disabled={deletingId === c.id}
                  className="w-8 h-8 flex items-center justify-center text-slate-500 active:text-red-400 disabled:opacity-30"
                  aria-label="Borrar"
                ><Icon name="trash" className="w-4 h-4" /></button>
              </li>
            ))}
          </ul>
          {hasMore && !query && (
            <div className="flex justify-center py-3">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="px-4 py-2 rounded-full bg-slate-800 border border-slate-700 text-slate-300 text-xs active:bg-slate-700 disabled:opacity-50 flex items-center gap-2"
              >
                {loadingMore && <span className="w-3 h-3 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin" />}
                <span>{loadingMore ? 'Cargando…' : 'Cargar más chats'}</span>
              </button>
            </div>
          )}
          </>
          )
        })()}
      </div>
      </div>

      {/* end of pull-wrapped scroll */}

      {showModal && <NewChatModal onClose={handleModalClose} />}

      {showUsage && (
        <div
          onClick={e => { if (e.target === e.currentTarget) setShowUsage(false) }}
          className="fixed inset-0 z-50 flex items-end bg-black/60"
        >
          <div className="w-full bg-slate-900 rounded-t-2xl border-t border-slate-700 shadow-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 bg-slate-600 rounded-full" />
            </div>
            <div className="flex items-center justify-between px-5 pt-2 pb-3">
              <h2 className="text-base font-semibold text-slate-100">Uso de Claude</h2>
              <button
                onClick={() => setShowUsage(false)}
                aria-label="Cerrar"
                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 active:bg-slate-700"
              ><Icon name="x" className="w-5 h-5" /></button>
            </div>
            <UsageCard />
            <AboutFooter />
            <div className="h-4" />
          </div>
        </div>
      )}
    </div>
  )
}
