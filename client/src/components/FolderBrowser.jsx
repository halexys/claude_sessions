import { useState, useEffect } from 'react'
import { fetchWithAuth } from '../auth'

export default function FolderBrowser({ value, onChange }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [history, setHistory] = useState([])

  async function load(p) {
    setLoading(true)
    try {
      const res = await fetchWithAuth(`/api/folders${p ? `?path=${encodeURIComponent(p)}` : ''}`)
      if (!res.ok) return
      const d = await res.json()
      setData(d)
      if (!value) onChange(d.current)
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  function navigateTo(p) {
    setHistory(h => [...h, data.current])
    load(p)
    onChange(p)
  }

  function goUp() {
    if (data?.parent) {
      const prev = history[history.length - 1]
      setHistory(h => h.slice(0, -1))
      load(prev || data.parent)
      onChange(prev || data.parent)
    }
  }

  const HOME = data?.dirs ? null : null
  const displayPath = data?.current?.replace(/^\/home\/[^/]+/, '~') || ''

  return (
    <div className="rounded-xl border border-slate-600 overflow-hidden">
      {/* Header: current path + up button */}
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-700 border-b border-slate-600">
        <button
          onClick={goUp}
          disabled={!data?.parent}
          className="p-1 rounded text-slate-400 disabled:opacity-30 active:bg-slate-600"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="flex-1 text-xs font-mono text-slate-300 truncate">{displayPath}</span>
        <button
          onClick={() => { onChange(data?.current); }}
          className="text-xs px-2 py-1 rounded bg-blue-600 text-white font-medium"
        >
          Seleccionar
        </button>
      </div>

      {/* Directory list */}
      <div className="max-h-52 overflow-y-auto divide-y divide-slate-700/50">
        {loading ? (
          <div className="flex justify-center py-6">
            <div className="w-5 h-5 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
          </div>
        ) : data?.dirs?.length === 0 ? (
          <p className="text-center text-slate-500 text-sm py-6">Carpeta vacía</p>
        ) : (
          data?.dirs?.map(dir => (
            <button
              key={dir.path}
              onClick={() => navigateTo(dir.path)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors active:bg-slate-600 ${
                value === dir.path ? 'bg-blue-600/20 text-blue-300' : 'bg-slate-800 text-slate-200'
              }`}
            >
              <svg className="w-4 h-4 shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
              </svg>
              <span className="text-sm font-mono truncate">{dir.name}</span>
              <svg className="w-4 h-4 ml-auto shrink-0 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ))
        )}
      </div>

      {/* Selected path indicator */}
      {value && value !== data?.current && (
        <div className="px-4 py-2 bg-blue-600/10 border-t border-slate-600">
          <p className="text-xs text-blue-400 font-mono truncate">{value.replace(/^\/home\/[^/]+/, '~')}</p>
        </div>
      )}
    </div>
  )
}
