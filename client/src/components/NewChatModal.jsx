import { useState, useRef } from 'react'
import { fetchWithAuth } from '../auth'
import FolderBrowser from './FolderBrowser'

export default function NewChatModal({ onClose }) {
  const [folder, setFolder] = useState(null)
  const [model, setModel]   = useState('')   // '' = default
  const [skipPermissions, setSkipPermissions] = useState(true)  // default ON to mirror current behaviour
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState(null)
  const backdropRef = useRef(null)

  async function handleCreate() {
    setError(null)
    setLaunching(true)
    try {
      const permissionMode = skipPermissions ? 'bypassPermissions' : 'plan'
      const res = await fetchWithAuth('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, model: model || undefined, permissionMode }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Error'); setLaunching(false); return }
      onClose(data)
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
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-slate-600 rounded-full" />
        </div>

        <div className="px-5 pt-3 pb-6 space-y-4">
          <h2 className="text-lg font-semibold text-slate-100">Nuevo chat</h2>

          <div>
            <label className="block text-sm font-medium text-slate-400 mb-1.5">
              Carpeta de trabajo
            </label>
            <FolderBrowser value={folder} onChange={setFolder} />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-400 mb-1.5">
              Modelo
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { v: '', label: 'Auto' },
                { v: 'claude-opus-4-8', label: 'Opus' },
                { v: 'claude-sonnet-4-6', label: 'Sonnet' },
                { v: 'claude-haiku-4-5', label: 'Haiku' },
              ].map(opt => (
                <button
                  key={opt.v || 'auto'}
                  onClick={() => setModel(opt.v)}
                  className={`py-2 rounded-xl text-sm font-medium ${
                    model === opt.v
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-slate-300 active:bg-slate-600'
                  }`}
                >{opt.label}</button>
              ))}
            </div>
          </div>

          <button
            onClick={() => setSkipPermissions(v => !v)}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-colors ${
              skipPermissions
                ? 'bg-amber-900/30 border-amber-600/50 text-amber-300'
                : 'bg-slate-700/50 border-slate-600 text-slate-400'
            }`}
          >
            <div className="text-left">
              <p className="text-sm font-medium">{skipPermissions ? 'Saltar permisos' : 'Solo lectura'}</p>
              <p className="text-xs opacity-60 mt-0.5">
                {skipPermissions
                  ? 'Claude ejecuta todo sin preguntar (bypassPermissions)'
                  : 'No edita ni ejecuta nada — solo lee y planifica (plan)'}
              </p>
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

          <div className="flex gap-3 pt-1">
            <button
              onClick={() => onClose(null)}
              className="flex-1 py-3 rounded-xl border border-slate-600 text-slate-300 font-medium active:bg-slate-700"
            >Cancelar</button>
            <button
              onClick={handleCreate}
              disabled={launching}
              className="flex-1 py-3 rounded-xl bg-blue-600 active:bg-blue-700 disabled:opacity-40 text-white font-medium flex items-center justify-center gap-2"
            >
              {launching ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : 'Empezar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
