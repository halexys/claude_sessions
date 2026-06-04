import { useCallback, useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { getToken, getDeviceToken, fetchWithAuth } from '../auth'
import { API_BASE } from '../config'
import MarkdownLite from './MarkdownLite.jsx'
import Icon from './Icon.jsx'
import FileViewer from './FileViewer.jsx'

// Tool name → icon name in our Icon component
const TOOL_ICONS = {
  Read: 'file-text', Write: 'pen', Edit: 'pen', Bash: 'zap', Grep: 'search',
  Glob: 'search', WebFetch: 'globe', WebSearch: 'search', Task: 'bot',
  TodoWrite: 'list-check', NotebookEdit: 'file-text',
}
const iconFor = name => TOOL_ICONS[name] || 'wrench'

export default function ChatView({ chatId, onBack }) {
  const [history, setHistory]   = useState([])
  const [hasMore, setHasMore]   = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const isFirstConnectRef = useRef(true)
  const [text,    setText]      = useState('')
  const [attachments, setAttachments] = useState([])  // [{path?, name, base64?, mediaType}]
  const [connected, setConnected] = useState(false)
  const [busy, setBusy]   = useState(false)
  const [cost, setCost]   = useState(0)
  const [model, setModel] = useState('')
  const [cwd, setCwd]     = useState('')
  const [uploadError, setUploadError] = useState(null)
  const [headerOpen, setHeaderOpen]   = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [slashCommands, setSlashCommands] = useState([])
  const [permissionMode, setPermissionMode] = useState('bypassPermissions')
  const [viewingFile, setViewingFile] = useState(null)
  const [processAlive, setProcessAlive] = useState(false) // claude proc currently running on PC?
  const [spawning, setSpawning] = useState(false)  // true while claude is initialising
  const [spawnProgress, setSpawnProgress] = useState(null) // hook name being run
  // Hard-clear the spawn banner after 30 s — claude is almost certainly
  // ready by then and the init event just got lost in the noise.
  useEffect(() => {
    if (!spawning) return
    const t = setTimeout(() => setSpawning(false), 30000)
    return () => clearTimeout(t)
  }, [spawning])
  const socketRef    = useRef(null)
  const scrollRef    = useRef(null)
  const inputRef     = useRef(null)
  const fileInputRef = useRef(null)
  const cameraInputRef = useRef(null)
  // Accumulator for the in-flight assistant message so streaming feels live
  const liveMsgIdRef = useRef(null)

  const fetchInitialHistory = useCallback(() => {
    return fetchWithAuth(`/api/chat/sessions/${chatId}?limit=50`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return
        setCwd(data.cwd || '')
        setHistory(data.entries.map(e => ({ ...e, _hid: cryptoId() })))
        setHasMore(!!data.hasMore)
      })
      .catch(() => {})
  }, [chatId])

  // Initial load
  useEffect(() => { fetchInitialHistory() }, [fetchInitialHistory])

  async function loadMore() {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    const prevHeight = scrollRef.current?.scrollHeight || 0
    try {
      const res = await fetchWithAuth(`/api/chat/sessions/${chatId}?limit=50&before=${history.length}`)
      if (!res.ok) return
      const data = await res.json()
      setHistory(prev => [...data.entries.map(e => ({ ...e, _hid: cryptoId() })), ...prev])
      setHasMore(!!data.hasMore)
      // Preserve scroll: keep the same item under the user's eyes after prepend
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          const newHeight = scrollRef.current.scrollHeight
          scrollRef.current.scrollTop = newHeight - prevHeight
        }
      })
    } finally {
      setLoadingMore(false)
    }
  }

  // Connect socket
  useEffect(() => {
    const socket = io(`${API_BASE || window.location.origin}/chat`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 200,
      reconnectionDelayMax: 3000,
      query: { jwt: getToken() },
      auth:  { token: getDeviceToken() },
    })
    socketRef.current = socket
    socket.on('connect',    () => {
      setConnected(true)
      socket.emit('attach', { chatId })
      if (isFirstConnectRef.current) {
        isFirstConnectRef.current = false
      } else {
        // WS reconnect after a disconnect — events fired during the dead window
        // were lost. JSONL is the source of truth; re-fetch the latest entries.
        fetchInitialHistory()
      }
    })
    socket.on('disconnect', () => setConnected(false))
    socket.on('chat_event', ev => handleEvent(ev))
    socket.on('attached',   ({ active, busy: srvBusy, model: m, permissionMode: pm }) => {
      setProcessAlive(!!active)
      if (m) setModel(m)
      if (pm) setPermissionMode(pm)
      // Sync busy state both ways. Without this, a turn that finished while
      // the WS was disconnected (app backgrounded, network blip) leaves the
      // client stuck on "Pensando…" until the user leaves and re-enters.
      setBusy(!!srvBusy)
      if (active) {
        setSpawning(false)
        setSpawnProgress(null)
        setTimeout(() => socket.emit('request_init'), 800)
      }
    })
    return () => { socket.disconnect() }
  }, [chatId])

  function handleEvent(ev) {
    // Any event from the chat-event bus is proof the process is up. Belt-and-
    // suspenders for the case where init never reaches us cleanly.
    setProcessAlive(true)
    if (ev.kind === 'init') {
      if (ev.model) setModel(ev.model)
      if (ev.permissionMode) setPermissionMode(ev.permissionMode)
      if (Array.isArray(ev.slashCommands)) setSlashCommands(ev.slashCommands)
      setProcessAlive(true)
      setSpawning(false)
      setSpawnProgress(null)
      return
    }
    if (ev.kind === 'spawn_progress') {
      setSpawnProgress(ev.hookName || ev.event || 'cargando')
      return
    }
    if (ev.kind === 'text' && ev.role === 'user') {
      // Dedupe: if we already rendered this locally, drop the server echo.
      setHistory(h => {
        const lastLocal = [...h].reverse().find(m => m._local && m.kind === 'user' && m.text === ev.text)
        if (lastLocal) {
          return h.map(m => m === lastLocal ? { ...m, _local: false } : m)
        }
        return [...h, { kind: 'user', text: ev.text, _hid: cryptoId() }]
      })
      return
    }
    if (ev.kind === 'text' && ev.role === 'assistant') {
      setHistory(h => [...h, { kind: 'text', role: 'assistant', text: ev.text, _hid: cryptoId() }])
      // First assistant token = claude is fully alive; defensively kill the
      // loading banner even if the init event never propagated cleanly.
      setSpawning(false)
      setSpawnProgress(null)
      return
    }
    if (ev.kind === 'tool_use') {
      setHistory(h => [...h, { kind: 'tool_use', id: ev.id, name: ev.name, input: ev.input, _hid: cryptoId() }])
      return
    }
    if (ev.kind === 'tool_result') {
      setHistory(h => [...h, { kind: 'tool_result', id: ev.id, output: ev.output, isError: ev.isError, _hid: cryptoId() }])
      return
    }
    if (ev.kind === 'thinking') {
      setHistory(h => [...h, { kind: 'thinking', text: ev.text, _hid: cryptoId() }])
      return
    }
    if (ev.kind === 'turn_done') {
      setBusy(false)
      setSpawning(false)
      setSpawnProgress(null)
      setCost(c => c + (ev.costDeltaUsd || 0))
      return
    }
    if (ev.kind === 'error') {
      setHistory(h => [...h, { kind: 'error', text: ev.message, _hid: cryptoId() }])
      setBusy(false)
      setSpawning(false)
      return
    }
    if (ev.kind === 'rate_limit') {
      setHistory(h => [...h, { kind: 'info', text: `Rate limit: ${ev.info?.status || ''}`, _hid: cryptoId() }])
      return
    }
    if (ev.kind === 'info') {
      setHistory(h => [...h, { kind: 'info', text: ev.text, _hid: cryptoId() }])
      return
    }
  }

  function changeModel(newModel) {
    setModel(newModel)
    setActionsOpen(false)
    setSpawning(true)
    setSpawnProgress(null)
    socketRef.current?.emit('set_model', { model: newModel })
  }

  function changePermissionMode(mode) {
    setPermissionMode(mode)
    setSpawning(true)
    setSpawnProgress(null)
    socketRef.current?.emit('set_permission_mode', { permissionMode: mode })
  }

  async function closeProcess() {
    setActionsOpen(false)
    try {
      await fetchWithAuth(`/api/chat/sessions/${chatId}/close`, { method: 'POST' })
      setProcessAlive(false)
      setBusy(false)
      setHistory(h => [...h, { kind: 'info', text: 'Proceso cerrado. Pulsa "Reanudar conversación" para levantarlo.', _hid: cryptoId() }])
    } catch {}
  }

  function resume() {
    setSpawning(true)
    setSpawnProgress(null)
    socketRef.current?.emit('resume')
  }

  function runSlash(cmd) {
    setActionsOpen(false)
    if (busy) return
    socketRef.current?.emit('send', { text: cmd, images: [] })
    setBusy(true)
  }

  // Auto-scroll: bottom on first paint and at each turn boundary, but never
  // when the user prepended older messages via "load more".
  const didInitialScroll = useRef(false)
  useEffect(() => {
    if (!scrollRef.current) return
    if (!didInitialScroll.current && history.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      didInitialScroll.current = true
    }
  }, [history.length])
  useEffect(() => {
    if (!busy && scrollRef.current && didInitialScroll.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [busy])

  // Two-pass compression: a tiny thumbnail for the chip + bubble preview,
  // and a larger payload version sent to Claude. Lower-res keeps mobile
  // networks happy without losing enough detail to harm Claude's reading.
  async function compressImage(file, maxDim, quality) {
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader()
      r.onload  = () => res(String(r.result))
      r.onerror = () => rej(new Error('read fail'))
      r.readAsDataURL(file)
    })
    const img = await new Promise((res, rej) => {
      const im = new Image()
      im.onload  = () => res(im)
      im.onerror = () => rej(new Error('decode fail'))
      im.src = dataUrl
    })
    let { width, height } = img
    if (width > maxDim || height > maxDim) {
      const s = maxDim / Math.max(width, height)
      width = Math.round(width * s); height = Math.round(height * s)
    }
    const canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height
    canvas.getContext('2d').drawImage(img, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', quality)
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploadError(null)
    try {
      // Payload to send: 1280px max @ 0.75 — keeps it readable but small.
      // Preview: ~200px @ 0.6, used in chip + sent-message bubble.
      const [fullData, thumbData] = await Promise.all([
        compressImage(file, 1280, 0.75),
        compressImage(file,  240, 0.6),
      ])
      const base64 = fullData.split(',')[1]
      setAttachments(prev => [...prev, {
        base64,
        thumb: thumbData,  // full data URL — used inline in <img src>
        mediaType: 'image/jpeg',
        name: `imagen ${prev.length + 1}`,
      }])
      inputRef.current?.focus()
    } catch (err) {
      setUploadError(err.message || 'Error procesando imagen')
    }
  }

  function send() {
    if (busy) return
    if (!text.trim() && attachments.length === 0) return
    const sentText  = text
    const sentThumbs = attachments.map(a => a.thumb).filter(Boolean)
    // Local echo: render the user bubble immediately with thumbnails. The
    // server's echo is suppressed below via dedupe — we trust local state.
    setHistory(h => [...h, { kind: 'user', text: sentText, thumbs: sentThumbs, _hid: cryptoId(), _local: true }])
    socketRef.current?.emit('send', {
      text: sentText,
      images: attachments.map(a => ({ base64: a.base64, mediaType: a.mediaType })),
    })
    setText('')
    setAttachments([])
    setBusy(true)
  }

  function cancel() {
    socketRef.current?.emit('cancel')
    setBusy(false)
  }

  return (
    <div className="bg-slate-900 flex flex-col text-slate-100" style={{ height: '100dvh', overflow: 'hidden' }}>
      {/* Header */}
      <header className="flex items-center gap-2 px-3 bg-slate-800 border-b border-slate-700 flex-shrink-0" style={{ height: '56px' }}>
        <button
          onClick={onBack}
          className="w-10 h-10 flex items-center justify-center rounded-lg text-slate-400 active:bg-slate-700"
          aria-label="Volver"
        >
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button
          onClick={() => setHeaderOpen(o => !o)}
          className="flex-1 min-w-0 text-left"
        >
          <div className="text-sm font-medium text-slate-200 truncate">
            Chat <span className="text-slate-500">· {chatId.slice(0, 8)}</span>
          </div>
          <div className="text-xs text-slate-500 truncate font-mono">{cwd}</div>
        </button>
        <span
          title={!connected ? 'Sin conexión' : busy ? 'Procesando' : processAlive ? 'Claude en memoria' : 'Claude apagado'}
          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
            !connected ? 'bg-slate-500'
            : busy ? 'bg-yellow-400 animate-pulse'
            : processAlive ? 'bg-green-400'
            : 'bg-slate-600'
          }`}
        />
        <button
          onClick={() => {
            setActionsOpen(true)
            if (slashCommands.length === 0) socketRef.current?.emit('request_init')
          }}
          aria-label="Más opciones"
          className="w-9 h-9 flex items-center justify-center rounded-lg text-slate-400 active:bg-slate-700"
        ><Icon name="more-horizontal" className="w-5 h-5" /></button>
      </header>
      {headerOpen && (
        <div className="bg-slate-800 border-b border-slate-700 px-4 py-2 text-xs text-slate-400 flex justify-between flex-shrink-0">
          <span>{model || '—'}</span>
          <span>${cost.toFixed(4)}</span>
        </div>
      )}

      {spawning && (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-900/40 border-b border-blue-800/50 text-blue-200 text-xs flex-shrink-0">
          <span className="w-3 h-3 border-2 border-blue-700 border-t-blue-300 rounded-full animate-spin flex-shrink-0" />
          <span className="truncate">
            {spawnProgress ? `Hook: ${spawnProgress}` : 'Iniciando Claude…'}
          </span>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {hasMore && (
          <div className="flex justify-center pb-2">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-slate-400 text-xs active:bg-slate-700 disabled:opacity-50 flex items-center gap-2"
            >
              {loadingMore && <span className="w-3 h-3 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin" />}
              <span>{loadingMore ? 'Cargando…' : 'Cargar mensajes anteriores'}</span>
            </button>
          </div>
        )}
        {history.map(m => <MessageItem key={m._hid} m={m} onOpenFile={setViewingFile} />)}
        {busy && (
          <div className="flex items-center gap-2 text-slate-500 text-xs px-2">
            <div className="w-3 h-3 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin" />
            <span>Pensando…</span>
            <button onClick={cancel} className="ml-auto text-red-400 active:text-red-300">Cancelar</button>
          </div>
        )}
      </div>

      {/* Upload error */}
      {uploadError && (
        <div onClick={() => setUploadError(null)}
             className="flex items-center gap-2 px-3 py-1.5 bg-red-900/60 border-t border-red-800 text-red-200 text-xs">
          <Icon name="warning" className="w-4 h-4 flex-shrink-0" /><span className="flex-1">{uploadError}</span>
        </div>
      )}

      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2 bg-slate-800 border-t border-slate-700">
          {attachments.map((a, i) => (
            <span key={i} className="relative flex items-center gap-1.5 bg-slate-700 border border-slate-600 rounded-lg pl-1 pr-1 py-1 text-xs text-slate-200">
              {a.thumb
                ? <img src={a.thumb} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
                : <Icon name="image" className="w-4 h-4" />
              }
              <span className="truncate max-w-[100px]">{a.name}</span>
              <button
                onTouchEnd={e => { e.preventDefault(); setAttachments(p => p.filter((_, j) => j !== i)) }}
                onMouseDown={e => { e.preventDefault(); setAttachments(p => p.filter((_, j) => j !== i)) }}
                className="w-5 h-5 flex items-center justify-center rounded-full bg-slate-600 active:bg-slate-500 text-slate-300"
              ><Icon name="x" className="w-3 h-3" /></button>
            </span>
          ))}
        </div>
      )}

      {/* Slash command autocomplete */}
      {text.startsWith('/') && slashCommands.length > 0 && (
        <SlashAutocomplete
          query={text.slice(1)}
          commands={slashCommands}
          onPick={c => { setText('/' + c + ' '); inputRef.current?.focus() }}
        />
      )}

      {/* Cold session — show resume CTA instead of input */}
      {!processAlive && !spawning && (
        <button
          onClick={resume}
          className="flex items-center justify-center gap-2 px-4 py-4 bg-blue-600 active:bg-blue-700 text-white font-medium border-t border-slate-700 flex-shrink-0"
        >
          <Icon name="play" className="w-4 h-4" />
          <span>Reanudar conversación</span>
        </button>
      )}

      {/* Input bar (hidden when cold) */}
      <div
        style={{ minHeight: '52px', display: (!processAlive && !spawning) ? 'none' : undefined }}
        className="flex items-center bg-slate-800 border-t border-slate-700 flex-shrink-0"
      >
        <input ref={fileInputRef}   type="file" accept="image/*" onChange={handleFile} className="hidden" />
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={handleFile} className="hidden" />
        <button
          onTouchEnd={e => { e.preventDefault(); fileInputRef.current?.click() }}
          onMouseDown={e => { e.preventDefault(); fileInputRef.current?.click() }}
          className="w-10 h-12 flex items-center justify-center text-slate-400 active:bg-slate-700"
          aria-label="Galería"
        ><Icon name="paperclip" className="w-5 h-5" /></button>
        <button
          onTouchEnd={e => { e.preventDefault(); cameraInputRef.current?.click() }}
          onMouseDown={e => { e.preventDefault(); cameraInputRef.current?.click() }}
          className="w-10 h-12 flex items-center justify-center text-slate-400 active:bg-slate-700"
          aria-label="Cámara"
        ><Icon name="camera" className="w-5 h-5" /></button>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          }}
          placeholder={busy ? 'Esperando respuesta…' : 'Escribe a Claude...'}
          autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
          className="flex-1 bg-transparent text-slate-100 px-2 py-3 text-sm outline-none placeholder-slate-500 resize-none"
          style={{ maxHeight: '120px' }}
        />
        <button
          onClick={send}
          disabled={busy || (!text.trim() && attachments.length === 0)}
          className="w-12 h-12 flex items-center justify-center text-blue-400 active:text-blue-300 disabled:opacity-30"
          aria-label="Enviar"
        ><Icon name="send" className="w-5 h-5" /></button>
      </div>

      {viewingFile && <FileViewer path={viewingFile} onClose={() => setViewingFile(null)} />}

      {actionsOpen && (
        <ActionSheet
          model={model}
          permissionMode={permissionMode}
          slashCommands={slashCommands}
          onClose={() => setActionsOpen(false)}
          onPickModel={changeModel}
          onPickPermissionMode={changePermissionMode}
          onRunSlash={runSlash}
          onCloseProcess={closeProcess}
        />
      )}
    </div>
  )
}

function SlashAutocomplete({ query, commands, onPick }) {
  const q = query.toLowerCase().split(/\s/)[0]  // only filter by first word
  const filtered = commands
    .filter(c => c.toLowerCase().includes(q))
    .slice(0, 8)
  if (filtered.length === 0) return null
  return (
    <div className="bg-slate-800 border-t border-slate-700 max-h-48 overflow-y-auto">
      {filtered.map(c => (
        <button
          key={c}
          onTouchEnd={e => { e.preventDefault(); onPick(c) }}
          onMouseDown={e => { e.preventDefault(); onPick(c) }}
          className="w-full text-left px-4 py-2 hover:bg-slate-700 active:bg-slate-600 text-sm text-slate-200 font-mono border-b border-slate-700/50 last:border-b-0"
        >
          <span className="text-blue-400">/</span>{c}
        </button>
      ))}
    </div>
  )
}

const MODELS = [
  { id: '',                 label: 'Auto' },
  { id: 'claude-opus-4-8',   label: 'Opus' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet' },
  { id: 'claude-haiku-4-5',  label: 'Haiku' },
]
const QUICK_SLASH = [
  { cmd: '/clear',   label: 'Limpiar contexto',     icon: 'broom' },
  { cmd: '/compact', label: 'Compactar historial',  icon: 'box' },
  { cmd: '/cost',    label: 'Coste',                icon: 'dollar' },
  { cmd: '/usage',   label: 'Uso de tokens',        icon: 'chart' },
  { cmd: '/context', label: 'Ver contexto',         icon: 'folder' },
  { cmd: '/init',    label: 'Inicializar CLAUDE.md', icon: 'file-text' },
]

function ActionSheet({ model, permissionMode, slashCommands, onClose, onPickModel, onPickPermissionMode, onRunSlash, onCloseProcess }) {
  // Filter quick slashes to only show ones supported by this claude version
  const available = QUICK_SLASH.filter(s => slashCommands.includes(s.cmd.slice(1)))
  const currentModelLabel =
    MODELS.find(m => m.id && model && model.startsWith(m.id))?.label || 'Auto'
  const skipPerms = permissionMode === 'bypassPermissions'
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      className="fixed inset-0 z-50 flex items-end bg-black/60"
    >
      <div className="w-full bg-slate-800 rounded-t-2xl border-t border-slate-700 shadow-2xl max-h-[80vh] overflow-y-auto">
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-slate-600 rounded-full" />
        </div>
        <div className="flex items-center justify-between px-5 pt-2 pb-3">
          <h2 className="text-base font-semibold text-slate-100">Opciones</h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 active:bg-slate-700"
          ><Icon name="x" className="w-5 h-5" /></button>
        </div>

        <div className="px-5 pb-3 space-y-4">
          {/* Model picker */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Modelo</span>
              <span className="text-xs text-slate-500">Actual: {currentModelLabel}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {MODELS.map(m => (
                <button
                  key={m.id || 'auto'}
                  onClick={() => onPickModel(m.id)}
                  className={`py-2.5 rounded-xl text-sm font-medium ${
                    (m.id && model?.startsWith(m.id)) || (!m.id && !model)
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-slate-300 active:bg-slate-600'
                  }`}
                >{m.label}</button>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 mt-1.5">Cambiar reinicia el proceso (no se pierde el historial).</p>
          </div>

          {/* Permission mode */}
          <div>
            <div className="mb-2 text-xs font-semibold text-slate-400 uppercase tracking-wide">Permisos</div>
            <button
              onClick={() => onPickPermissionMode(skipPerms ? 'plan' : 'bypassPermissions')}
              className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border ${
                skipPerms
                  ? 'bg-amber-900/30 border-amber-600/50 text-amber-300'
                  : 'bg-slate-700/50 border-slate-600 text-slate-400'
              }`}
            >
              <div className="text-left">
                <p className="text-sm font-medium">{skipPerms ? 'Saltar permisos' : 'Solo lectura'}</p>
                <p className="text-xs opacity-60 mt-0.5">
                  {skipPerms
                    ? 'Ejecuta todo sin preguntar (bypassPermissions)'
                    : 'No edita ni ejecuta — solo lee y planifica (plan)'}
                </p>
              </div>
              <div className={`w-11 h-6 rounded-full relative ${skipPerms ? 'bg-amber-500' : 'bg-slate-600'}`}>
                <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${skipPerms ? 'translate-x-6' : 'translate-x-1'}`} />
              </div>
            </button>
          </div>

          {/* Quick slash commands */}
          {available.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-semibold text-slate-400 uppercase tracking-wide">Comandos rápidos</div>
              <div className="grid grid-cols-2 gap-2">
                {available.map(s => (
                  <button
                    key={s.cmd}
                    onClick={() => onRunSlash(s.cmd)}
                    className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-slate-700 active:bg-slate-600 text-sm text-slate-200 text-left"
                  >
                    <Icon name={s.icon} className="w-4 h-4 text-blue-400 flex-shrink-0" />
                    <span className="flex-1 min-w-0">
                      <span className="font-mono text-xs text-slate-400 block truncate">{s.cmd}</span>
                      <span className="text-[11px] text-slate-500 block truncate">{s.label}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Close process — frees memory on the PC */}
          <div>
            <button
              onClick={onCloseProcess}
              className="w-full px-4 py-2.5 rounded-xl bg-slate-700 active:bg-slate-600 text-sm text-slate-300 flex items-center justify-center gap-2"
            >
              <Icon name="moon" className="w-4 h-4" />
              <span>Cerrar proceso (libera RAM en el PC)</span>
            </button>
            <p className="text-[11px] text-slate-500 mt-1.5">El próximo mensaje volverá a levantarlo.</p>
          </div>

          {/* All available */}
          {slashCommands.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Todos los comandos ({slashCommands.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {slashCommands.map(c => (
                  <button
                    key={c}
                    onClick={() => onRunSlash('/' + c)}
                    className="px-2.5 py-1 rounded-full bg-slate-700 active:bg-slate-600 text-[11px] font-mono text-slate-300"
                  >/{c}</button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="h-4" />
      </div>
    </div>
  )
}

// Conservative path detector — only matches absolute paths under known roots
// ending in a known extension. Avoids false positives for arbitrary tokens.
const PATH_RE = /\/(?:home|Users|tmp|var)\/[^\s"'`<>)]+\.[A-Za-z0-9]{1,8}/g

function detectPaths(text) {
  if (!text || typeof text !== 'string') return []
  const matches = text.match(PATH_RE) || []
  return [...new Set(matches)]
}

function shortPath(p) {
  if (p.length < 40) return p
  const parts = p.split('/')
  if (parts.length > 4) return parts.slice(0,2).join('/') + '/…/' + parts.slice(-2).join('/')
  return '…' + p.slice(-37)
}

function FileChips({ paths, onOpen }) {
  if (!paths || paths.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {paths.map(p => (
        <button
          key={p}
          onClick={() => onOpen(p)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-700/70 border border-slate-600 text-blue-300 text-[11px] font-mono active:bg-slate-700"
        >
          <Icon name="file-text" className="w-3 h-3 flex-shrink-0" />
          <span className="break-all">{shortPath(p)}</span>
        </button>
      ))}
    </div>
  )
}

function MessageItem({ m, onOpenFile }) {
  if (m.kind === 'user') return (
    <div className="flex justify-end">
      <div className="max-w-[85%] bg-blue-600 text-white rounded-2xl rounded-tr-md px-3.5 py-2 break-words text-sm space-y-1.5">
        {Array.isArray(m.thumbs) && m.thumbs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {m.thumbs.map((src, i) => (
              <img key={i} src={src} alt="" className="w-24 h-24 rounded-lg object-cover" />
            ))}
          </div>
        )}
        {m.text && <div className="whitespace-pre-wrap">{m.text}</div>}
      </div>
    </div>
  )
  if (m.kind === 'text' && m.role === 'assistant') {
    const paths = detectPaths(m.text)
    return (
      <div className="flex justify-start">
        <div className="max-w-[92%] bg-slate-800 border border-slate-700 rounded-2xl rounded-tl-md px-3.5 py-2">
          <MarkdownLite text={m.text} />
          <FileChips paths={paths} onOpen={onOpenFile} />
        </div>
      </div>
    )
  }
  if (m.kind === 'thinking') return (
    <div className="flex justify-start">
      <div className="max-w-[92%] text-slate-500 italic text-xs px-3 py-1 border-l-2 border-slate-700">
        {m.text}
      </div>
    </div>
  )
  if (m.kind === 'tool_use')    return <ToolCard tool={m} onOpenFile={onOpenFile} />
  if (m.kind === 'tool_result') return <ToolResultCard r={m} />
  if (m.kind === 'error') return (
    <div className="flex items-start gap-2 text-red-300 text-xs bg-red-900/40 border border-red-800 rounded-lg px-3 py-2">
      <Icon name="warning" className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>{m.text}</span>
    </div>
  )
  if (m.kind === 'info') return (
    <div className="text-slate-500 text-xs text-center py-1">{m.text}</div>
  )
  return null
}

function ToolCard({ tool, onOpenFile }) {
  const [open, setOpen] = useState(false)
  const summary = summariseToolInput(tool.name, tool.input)
  const filePath = tool.input?.file_path || tool.input?.path
  const canOpen = filePath && /^\/(?:home|Users|tmp|var)\//.test(filePath)
  return (
    <div className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left active:bg-slate-700/50"
      >
        <Icon name={iconFor(tool.name)} className="w-4 h-4 text-blue-400 flex-shrink-0" />
        <span className="text-xs font-mono font-semibold text-slate-300">{tool.name}</span>
        <span className="text-xs text-slate-500 truncate flex-1">{summary}</span>
        {canOpen && (
          <span
            onClick={e => { e.stopPropagation(); onOpenFile?.(filePath) }}
            className="text-blue-400 text-xs px-1.5 py-0.5 rounded bg-slate-700 active:bg-slate-600 flex items-center gap-1"
          >
            <Icon name="file-text" className="w-3 h-3" /> ver
          </span>
        )}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} className="w-3 h-3 text-slate-500" />
      </button>
      {open && (
        <div className="border-t border-slate-700 px-3 py-2 text-xs font-mono text-slate-400 max-h-48 overflow-auto">
          <pre className="whitespace-pre-wrap break-words">{JSON.stringify(tool.input, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}

function ToolResultCard({ r }) {
  const [open, setOpen] = useState(false)
  const preview = (r.output || '').slice(0, 120).replace(/\n/g, ' ')
  return (
    <div className={`border rounded-xl overflow-hidden ${r.isError ? 'bg-red-900/30 border-red-800' : 'bg-slate-800/40 border-slate-700'}`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left active:bg-slate-700/50"
      >
        <Icon name={r.isError ? 'warning' : 'corner-down-left'} className={`w-3.5 h-3.5 flex-shrink-0 ${r.isError ? 'text-red-400' : 'text-slate-500'}`} />
        <span className="text-xs text-slate-400 truncate flex-1">{preview || '(sin salida)'}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} className="w-3 h-3 text-slate-500" />
      </button>
      {open && (
        <div className="border-t border-slate-700 px-3 py-2 text-xs font-mono text-slate-300 max-h-72 overflow-auto whitespace-pre-wrap break-words">
          {r.output || '(sin salida)'}
        </div>
      )}
    </div>
  )
}

function summariseToolInput(name, input) {
  if (!input || typeof input !== 'object') return ''
  if (name === 'Bash' && input.command)  return input.command
  if (input.file_path) return input.file_path
  if (input.path)      return input.path
  if (input.pattern)   return input.pattern
  if (input.url)       return input.url
  if (input.query)     return input.query
  if (input.description) return input.description
  return JSON.stringify(input).slice(0, 80)
}

function cryptoId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
