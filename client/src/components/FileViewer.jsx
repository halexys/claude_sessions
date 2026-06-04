import { useEffect, useState } from 'react'
import { fetchWithAuth } from '../auth'
import Icon from './Icon.jsx'
import MarkdownLite from './MarkdownLite.jsx'

export default function FileViewer({ path: filePath, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    setData(null); setError(null)
    fetchWithAuth(`/api/read-file?path=${encodeURIComponent(filePath)}`)
      .then(async r => {
        if (!r.ok) { setError((await r.json()).error || `HTTP ${r.status}`); return }
        setData(await r.json())
      })
      .catch(e => setError(e.message))
  }, [filePath])

  const ext = data?.ext
  const isMarkdown = ext === 'md' || ext === 'markdown'

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      className="fixed inset-0 z-[60] flex items-end bg-black/70"
    >
      <div className="w-full bg-slate-900 rounded-t-2xl border-t border-slate-700 shadow-2xl max-h-[88vh] flex flex-col">
        <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
          <div className="w-10 h-1 bg-slate-600 rounded-full" />
        </div>
        <div className="flex items-start justify-between gap-2 px-4 pt-1 pb-3 flex-shrink-0 border-b border-slate-800">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-slate-500 truncate font-mono">{filePath}</p>
            {data && <p className="text-[10px] text-slate-600 mt-0.5">{data.size} B · {data.ext || '—'}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 active:bg-slate-700 flex-shrink-0"
          ><Icon name="x" className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {error && (
            <div className="flex items-start gap-2 text-red-300 text-sm bg-red-900/30 border border-red-800 rounded-lg px-3 py-2">
              <Icon name="warning" className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {!error && !data && (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin" />
            </div>
          )}
          {data?.binary && (
            <p className="text-slate-400 text-sm">
              Archivo binario ({data.ext}) — no se muestra contenido.
            </p>
          )}
          {data?.content != null && (
            isMarkdown
              ? <MarkdownLite text={data.content} />
              : <pre className="text-xs font-mono text-slate-200 whitespace-pre-wrap break-words">{data.content}</pre>
          )}
        </div>
      </div>
    </div>
  )
}

// Render a chunk of text replacing detected file paths under HOME with clickable
// chips. Returns an array of React nodes ready to inject inside any element.
export function withFileLinks(text, onOpen) {
  if (!text) return text
  // Match absolute paths starting with /home/ (or /Users/) and ending at
  // a non-path character. Conservative: needs at least one slash after.
  const re = /(\/(?:home|Users|tmp|var)\/[^\s"'`<>)]+\.[A-Za-z0-9]{1,8})/g
  const out = []
  let last = 0, m, key = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const p = m[1]
    out.push(
      <button
        key={`f${key++}`}
        onClick={() => onOpen(p)}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded bg-slate-700 border border-slate-600 text-blue-300 text-[0.85em] font-mono align-baseline active:bg-slate-600"
      >
        <Icon name="file-text" className="w-3 h-3 flex-shrink-0" />
        <span className="break-all">{shortPath(p)}</span>
      </button>
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function shortPath(p) {
  if (p.length < 35) return p
  const parts = p.split('/')
  if (parts.length > 4) return parts.slice(0,2).join('/') + '/…/' + parts.slice(-2).join('/')
  return '…' + p.slice(-32)
}
