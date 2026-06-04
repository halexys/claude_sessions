import { useState, useEffect, useCallback } from 'react'
import NewSessionModal from './NewSessionModal.jsx'
import UsageCard from './UsageCard.jsx'
import { fetchWithAuth } from '../auth'

function formatRelativeTime(unixSeconds) {
  if (!unixSeconds) return '—'
  const now = Math.floor(Date.now() / 1000)
  const diff = now - unixSeconds
  if (diff < 0) return 'just now'
  if (diff < 60) return `${diff}s ago`
  const mins = Math.floor(diff / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function truncatePath(p) {
  if (!p) return ''
  const home = window.__homeDir || ''
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length)
  }
  if (p.length > 40) return '…' + p.slice(p.length - 38)
  return p
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-8">
      <div className="w-8 h-8 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
    </div>
  )
}

export default function SessionList({ onOpenTerminal }) {
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [deletingName, setDeletingName] = useState(null)

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/sessions')
      if (res.ok) {
        const data = await res.json()
        setSessions(data)
        setOffline(false)
      } else if (res.status === 401) {
        // token cleared by fetchWithAuth — React will re-render to LoginScreen
      } else if (res.status >= 502 && res.status <= 504) {
        setOffline(true)
      }
    } catch (_) {
      setOffline(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSessions()
    const id = setInterval(fetchSessions, 5000)
    return () => clearInterval(id)
  }, [fetchSessions])

  async function handleDelete(e, name) {
    e.stopPropagation()
    setDeletingName(name)
    try {
      await fetchWithAuth(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' })
      setSessions(prev => prev.filter(s => s.name !== name))
    } catch (_) {
      // ignore
    } finally {
      setDeletingName(null)
    }
  }

  function handleModalClose(newSessionName) {
    setShowModal(false)
    if (newSessionName) {
      fetchSessions()
      onOpenTerminal(newSessionName)
    }
  }

  return (
    <div className="bg-slate-900 text-white min-h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 bg-slate-800 border-b border-slate-700 sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <span className="text-xl">🤖</span>
          <h1 className="text-lg font-semibold text-slate-100">Claude Sessions</h1>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="w-10 h-10 flex items-center justify-center rounded-full bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-2xl font-light transition-colors"
          aria-label="New session"
        >
          +
        </button>
      </header>

      <UsageCard />

      {/* Offline banner */}
      {offline && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-900/60 border-b border-amber-700 text-amber-300 text-sm">
          <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
          PC offline — reconectando...
        </div>
      )}

      {/* Body */}
      <main className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <Spinner />
        ) : offline && sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-4 text-slate-400">
            <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center">
              <svg className="w-8 h-8 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-base font-medium text-slate-300">PC no disponible</p>
              <p className="text-sm mt-1">Comprueba que el PC está encendido y conectado</p>
            </div>
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-6 text-slate-400">
            <div className="text-center">
              <p className="text-lg font-medium text-slate-300">No active sessions</p>
              <p className="text-sm mt-1">Start a new Claude session to begin</p>
            </div>
            <button
              onClick={() => setShowModal(true)}
              className="w-16 h-16 flex items-center justify-center rounded-full bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-4xl font-light transition-colors shadow-lg"
              aria-label="New session"
            >
              +
            </button>
          </div>
        ) : (
          <ul className="space-y-3">
            {sessions.map(session => (
              <li
                key={session.name}
                onClick={() => onOpenTerminal(session.name)}
                className="flex items-center gap-3 bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 min-h-[64px] active:bg-slate-700 cursor-pointer transition-colors select-none"
              >
                {/* Status dot */}
                <span className="w-2.5 h-2.5 rounded-full bg-green-400 flex-shrink-0" />

                {/* Session info */}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-100 truncate">{session.name}</div>
                  <div className="text-xs text-slate-400 truncate mt-0.5">
                    {truncatePath(session.currentPath)}
                  </div>
                </div>

                {/* Time */}
                <div className="text-xs text-slate-500 flex-shrink-0 mr-1">
                  {formatRelativeTime(session.activity)}
                </div>

                {/* Delete button */}
                <button
                  onClick={(e) => handleDelete(e, session.name)}
                  disabled={deletingName === session.name}
                  className="w-10 h-10 flex items-center justify-center rounded-lg text-slate-500 hover:text-red-400 hover:bg-slate-700 active:bg-slate-600 transition-colors flex-shrink-0"
                  aria-label={`Delete session ${session.name}`}
                >
                  {deletingName === session.name ? (
                    <div className="w-4 h-4 border border-slate-500 border-t-red-400 rounded-full animate-spin" />
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                    </svg>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>

      {showModal && <NewSessionModal onClose={handleModalClose} />}
    </div>
  )
}
