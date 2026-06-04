import { useState, useEffect, useRef } from 'react'
import { fetchWithAuth } from '../auth'
import FolderBrowser from './FolderBrowser'

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Math.floor((Date.now() - new Date(ts)) / 1000)
  if (diff < 60) return `${diff}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
}

export default function NewSessionModal({ onClose }) {
  const [tab, setTab] = useState('new') // 'new' | 'resume'
  const [sessionName, setSessionName] = useState('')
  const [selectedFolder, setSelectedFolder] = useState(null)
  const [skipPermissions, setSkipPermissions] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState(null)

  // Resume tab state
  const [claudeSessions, setClaudeSessions] = useState([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [selectedSession, setSelectedSession] = useState(null)
  const backdropRef = useRef(null)

  useEffect(() => {
    if (tab === 'resume' && claudeSessions.length === 0) {
      setLoadingSessions(true)
      fetchWithAuth('/api/claude-sessions')
        .then(r => r.ok ? r.json() : [])
        .then(d => setClaudeSessions(Array.isArray(d) ? d : []))
        .catch(() => {})
        .finally(() => setLoadingSessions(false))
    }
  }, [tab])

  function slugify(s) {
    if (!s) return null
    const slug = s.toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
    return slug || null
  }

  async function handleLaunch(resumeId) {
    setError(null)
    setLaunching(true)
    try {
      const resumeName = resumeId
        ? (slugify(selectedSession?.title || selectedSession?.lastPrompt) || 'resumed') + '-' + Date.now().toString().slice(-4)
        : undefined
      const body = resumeId
        ? { resumeId, name: resumeName, folder: selectedSession?.cwd, skipPermissions }
        : { name: sessionName.trim() || undefined, folder: selectedFolder, skipPermissions }

      const res = await fetchWithAuth('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Error al crear la sesión')
        setLaunching(false)
        return
      }
      onClose(data.name)
    } catch (err) {
      setError(err.message)
      setLaunching(false)
    }
  }

  function handleBackdropClick(e) {
    if (e.target === backdropRef.current) onClose(null)
  }

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-end bg-black/60"
    >
      <div className="w-full bg-slate-800 rounded-t-2xl border-t border-slate-700 shadow-2xl">
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-slate-600 rounded-full" />
        </div>

        {/* Tabs */}
        <div className="flex mx-5 mt-2 mb-4 rounded-xl bg-slate-700/50 p-1">
          <button
            onClick={() => setTab('new')}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'new' ? 'bg-slate-600 text-white' : 'text-slate-400'
            }`}
          >
            Nueva sesión
          </button>
          <button
            onClick={() => setTab('resume')}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'resume' ? 'bg-slate-600 text-white' : 'text-slate-400'
            }`}
          >
            Reanudar
          </button>
        </div>

        <div className="px-5 pb-6 space-y-4">
          {tab === 'new' ? (
            <>
              {/* Session name */}
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1.5">
                  Nombre (opcional)
                </label>
                <input
                  type="text"
                  value={sessionName}
                  onChange={e => setSessionName(e.target.value)}
                  placeholder="auto"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="w-full bg-slate-700 border border-slate-600 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 text-base"
                />
              </div>

              {/* Folder browser */}
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1.5">
                  Carpeta de trabajo
                </label>
                <FolderBrowser value={selectedFolder} onChange={setSelectedFolder} />
              </div>
            </>
          ) : (
            /* Resume tab */
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1.5">
                Conversaciones recientes
              </label>
              <div className="rounded-xl border border-slate-600 overflow-hidden max-h-72 overflow-y-auto divide-y divide-slate-700/50">
                {loadingSessions ? (
                  <div className="flex justify-center py-8">
                    <div className="w-5 h-5 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
                  </div>
                ) : claudeSessions.length === 0 ? (
                  <p className="text-center text-slate-500 text-sm py-8">No hay sesiones guardadas</p>
                ) : (
                  claudeSessions.map(s => (
                    <button
                      key={s.id}
                      onClick={() => setSelectedSession(s)}
                      className={`w-full text-left px-4 py-3 transition-colors active:bg-slate-600 ${
                        selectedSession?.id === s.id
                          ? 'bg-blue-600/20 border-l-2 border-blue-500'
                          : 'bg-slate-800'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <span className="text-sm text-slate-100 truncate font-medium">
                          {s.title || s.lastPrompt?.slice(0, 60) || s.id.slice(0, 8) + '…'}
                        </span>
                        <span className="text-xs text-slate-500 shrink-0">{timeAgo(s.ts)}</span>
                      </div>
                      <span className="text-xs font-mono text-slate-500 truncate block">
                        {s.cwd?.replace(/^\/home\/[^/]+/, '~')}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Skip permissions toggle */}
          <button
            onClick={() => setSkipPermissions(v => !v)}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-colors ${
              skipPermissions
                ? 'bg-amber-900/30 border-amber-600/50 text-amber-300'
                : 'bg-slate-700/50 border-slate-600 text-slate-400'
            }`}
          >
            <div className="text-left">
              <p className="text-sm font-medium">Omitir permisos</p>
              <p className="text-xs opacity-60 mt-0.5">--dangerously-skip-permissions</p>
            </div>
            <div className={`w-11 h-6 rounded-full transition-colors relative ${skipPermissions ? 'bg-amber-500' : 'bg-slate-600'}`}>
              <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${skipPermissions ? 'translate-x-6' : 'translate-x-1'}`} />
            </div>
          </button>

          {error && (
            <div className="bg-red-900/50 border border-red-700 rounded-xl px-4 py-3 text-red-300 text-sm">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              onClick={() => onClose(null)}
              className="flex-1 py-3 rounded-xl border border-slate-600 text-slate-300 font-medium active:bg-slate-700"
            >
              Cancelar
            </button>
            <button
              onClick={() => tab === 'resume' ? handleLaunch(selectedSession?.id) : handleLaunch()}
              disabled={launching || (tab === 'resume' && !selectedSession)}
              className="flex-1 py-3 rounded-xl bg-blue-600 active:bg-blue-700 disabled:opacity-40 text-white font-medium flex items-center justify-center gap-2"
            >
              {launching ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : tab === 'resume' ? 'Reanudar' : 'Lanzar Claude'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
