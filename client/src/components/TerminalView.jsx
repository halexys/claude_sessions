import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { io } from 'socket.io-client'
import { getToken, getDeviceToken, fetchWithAuth } from '../auth'
import { API_BASE } from '../config'

// ── Input box ─────────────────────────────────────────────────────────────────
// Handles all text typing. Bypasses xterm.js's textarea so Android IME
// composition events never reach it — eliminates the duplication bug.

function InputBox({ onSend }) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState([])  // [{ path, name }]
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const inputRef = useRef(null)
  const fileInputRef = useRef(null)
  const cameraInputRef = useRef(null)

  function submit() {
    if (!text && attachments.length === 0) return
    let message = text.trim()
    if (attachments.length > 0) {
      const paths = attachments.map(a => a.path).join(' ')
      const directive = attachments.length === 1
        ? `Lee la imagen en ${paths}`
        : `Lee las imágenes en: ${paths}`
      message = message ? `${message}\n\n${directive}` : directive
    }
    onSend(message + '\r')
    setText('')
    setAttachments([])
  }

  // Resize large images to keep the request body small and avoid OOM on older
  // Android WebViews. Always re-encodes as JPEG so the server-side extension
  // check is deterministic.
  async function compressImage(file, maxDim = 1920, quality = 0.85) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('No se pudo leer el archivo'))
      reader.readAsDataURL(file)
    })
    const img = await new Promise((resolve, reject) => {
      const im = new Image()
      im.onload = () => resolve(im)
      im.onerror = () => reject(new Error('Imagen inválida'))
      im.src = dataUrl
    })
    let { width, height } = img
    if (width > maxDim || height > maxDim) {
      const scale = maxDim / Math.max(width, height)
      width = Math.round(width * scale)
      height = Math.round(height * scale)
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d').drawImage(img, 0, 0, width, height)
    const out = canvas.toDataURL('image/jpeg', quality)
    return out.split(',')[1]  // base64 payload only
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setUploadError(null)
    try {
      const data = await compressImage(file)
      const res = await fetchWithAuth('/api/upload-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, ext: 'jpg' }),
      })
      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        throw new Error(`Subida fallida (${res.status}) ${errBody.slice(0, 80)}`)
      }
      const { path } = await res.json()
      const name = path.split('/').pop()
      setAttachments(prev => [...prev, { path, name }])
      inputRef.current?.focus()
    } catch (err) {
      setUploadError(err.message || 'Error al subir la imagen')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="bg-slate-800 border-t border-slate-600 flex-shrink-0">
      {uploadError && (
        <div
          onClick={() => setUploadError(null)}
          className="flex items-center gap-2 px-3 py-1.5 bg-red-900/60 border-b border-red-800 text-red-200 text-xs"
        >
          <span>⚠️</span>
          <span className="flex-1">{uploadError}</span>
          <span className="text-red-400">tocar para cerrar</span>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2">
          {attachments.map((a, i) => (
            <span key={i} className="flex items-center gap-1.5 bg-slate-700 border border-slate-600 rounded-full pl-2.5 pr-1 py-1 text-xs text-slate-200">
              <span>🖼️</span>
              <span className="truncate max-w-[120px]">{a.name}</span>
              <button
                onTouchEnd={e => { e.preventDefault(); setAttachments(prev => prev.filter((_, j) => j !== i)) }}
                onMouseDown={e => { e.preventDefault(); setAttachments(prev => prev.filter((_, j) => j !== i)) }}
                className="w-5 h-5 flex items-center justify-center rounded-full bg-slate-600 active:bg-slate-500 text-slate-300"
                aria-label="Quitar"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center" style={{ minHeight: '48px' }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFile}
          className="hidden"
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFile}
          className="hidden"
        />
        <button
          onTouchEnd={e => { e.preventDefault(); fileInputRef.current?.click() }}
          onMouseDown={e => { e.preventDefault(); fileInputRef.current?.click() }}
          disabled={uploading}
          className="w-10 h-12 flex items-center justify-center text-slate-400 active:text-white active:bg-slate-700 flex-shrink-0 text-xl disabled:opacity-40"
          aria-label="Adjuntar imagen"
        >
          {uploading ? (
            <span className="w-4 h-4 border-2 border-slate-500 border-t-blue-400 rounded-full animate-spin" />
          ) : '📎'}
        </button>
        <button
          onTouchEnd={e => { e.preventDefault(); cameraInputRef.current?.click() }}
          onMouseDown={e => { e.preventDefault(); cameraInputRef.current?.click() }}
          disabled={uploading}
          className="w-10 h-12 flex items-center justify-center text-slate-400 active:text-white active:bg-slate-700 flex-shrink-0 text-xl disabled:opacity-40"
          aria-label="Tomar foto"
        >
          📷
        </button>
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); submit() }
            if (e.key === 'Tab')   { e.preventDefault(); onSend('\t') }
          }}
          className="flex-1 bg-transparent text-slate-100 px-3 py-3 text-sm font-mono outline-none placeholder-slate-600"
          placeholder={attachments.length > 0 ? 'Pregunta sobre la imagen...' : 'Escribir...'}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="send"
        />
        <button
          onTouchEnd={e => { e.preventDefault(); submit() }}
          onMouseDown={e => { e.preventDefault(); submit() }}
          className="w-12 h-12 flex items-center justify-center text-slate-400 active:text-white active:bg-slate-700 flex-shrink-0 text-lg"
          aria-label="Enviar"
        >
          ↵
        </button>
      </div>
    </div>
  )
}

// ── Keyboard toolbar ──────────────────────────────────────────────────────────

function KeyboardToolbar({ onSend, scrollMode, onExitScroll }) {
  const [ctrlActive, setCtrlActive] = useState(false)

  function send(data) { onSend(data); setCtrlActive(false) }
  function ctrl(ch) { send(String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 64)) }

  function btn(label, action, highlight = false) {
    return (
      <button
        key={label}
        onTouchEnd={e => { e.preventDefault(); action() }}
        onMouseDown={e => e.preventDefault()}
        className={`flex-shrink-0 px-3.5 h-full flex items-center justify-center text-sm font-mono font-medium border-r border-slate-600 last:border-r-0 select-none
          ${highlight ? 'bg-blue-600 text-white' : 'text-slate-200 active:bg-slate-500'}`}
      >
        {label}
      </button>
    )
  }

  if (scrollMode) {
    return (
      <div className="bg-amber-600 border-t border-amber-500 flex-shrink-0 flex" style={{ height: '44px' }}>
        <button
          onTouchEnd={e => { e.preventDefault(); onExitScroll() }}
          onMouseDown={e => e.preventDefault()}
          className="flex-1 h-full flex items-center justify-center text-white font-medium text-sm select-none active:bg-amber-700"
        >
          Modo scroll — toca para salir
        </button>
      </div>
    )
  }

  const ctrlKeys = [
    btn('C', () => ctrl('c'), true),
    btn('D', () => ctrl('d')),
    btn('L', () => ctrl('l')),
    btn('Z', () => ctrl('z')),
    btn('U', () => ctrl('u')),
    btn('W', () => ctrl('w')),
    btn('✕', () => setCtrlActive(false)),
  ]

  const mainKeys = [
    btn('Esc',  () => send('\x1b')),
    btn('Tab',  () => send('\t')),
    btn('Ctrl', () => setCtrlActive(true), ctrlActive),
    btn('|',    () => send('|')),
    btn('~',    () => send('~')),
    btn('/',    () => send('/')),
    btn('-',    () => send('-')),
    btn('↑',    () => send('\x1b[A')),
    btn('↓',    () => send('\x1b[B')),
  ]

  return (
    <div className="bg-slate-700 border-t border-slate-500 flex flex-shrink-0" style={{ height: '44px' }}>
      <div className="flex overflow-x-auto flex-1">
        {ctrlActive ? ctrlKeys : mainKeys}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export default function TerminalView({ session, onBack }) {
  const containerRef   = useRef(null)
  const termRef        = useRef(null)
  const fitAddonRef    = useRef(null)
  const socketRef      = useRef(null)
  const sendInputRef   = useRef(null)
  const scrollModeRef  = useRef(false)
  const [connected,    setConnected]    = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [sessionEnded, setSessionEnded] = useState(false)
  const [errorMsg,     setErrorMsg]     = useState(null)
  const [scrollMode,   setScrollMode]   = useState(false)

  function exitScrollMode() {
    scrollModeRef.current = false
    setScrollMode(false)
    sendInputRef.current?.('q')
  }

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0f172a',
        foreground: '#e2e8f0',
        cursor: '#60a5fa',
        selectionBackground: '#334155',
        black: '#1e293b',   red: '#f87171',     green: '#4ade80',
        yellow: '#facc15',  blue: '#60a5fa',    magenta: '#c084fc',
        cyan: '#22d3ee',    white: '#e2e8f0',
        brightBlack: '#475569', brightRed: '#fca5a5',   brightGreen: '#86efac',
        brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',   brightWhite: '#f8fafc',
      },
      allowTransparency: false,
      scrollback: 5000,
    })

    const fitAddon     = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    termRef.current    = term
    fitAddonRef.current = fitAddon

    if (containerRef.current) {
      term.open(containerRef.current)
      requestAnimationFrame(() => {
        try { fitAddon.fit() } catch (_) {}
        if (term.textarea) {
          term.textarea.setAttribute('inputmode', 'none')
        }
        // Swipe on terminal → tmux copy-mode scroll.
        // 25px of finger movement = 1 scroll line.
        if (term.element) {
          let ty = 0, accum = 0
          term.element.addEventListener('touchstart', e => {
            ty = e.touches[0].clientY
            accum = 0
          }, { passive: true, capture: true })
          term.element.addEventListener('touchmove', e => {
            const dy = ty - e.touches[0].clientY
            ty = e.touches[0].clientY
            accum += dy
            const lines = Math.trunc(accum / 4)
            if (lines === 0) return
            accum -= lines * 4
            const keys = (lines > 0 ? '\x1b[A' : '\x1b[B').repeat(Math.abs(lines))
            if (!scrollModeRef.current) {
              scrollModeRef.current = true
              setScrollMode(true)
              sendInput('\x02[' + keys) // enter tmux copy mode + scroll
            } else {
              sendInput(keys)
            }
          }, { passive: true, capture: true })
        }
      })
    }

    const socket = io(`${API_BASE || window.location.origin}/terminal`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 200,
      reconnectionDelayMax: 3000,
      randomizationFactor: 0.1,
      query: { jwt: getToken() },        // gateway routing
      auth:  { token: getDeviceToken() }, // PC auth (forwarded through gateway)
    })
    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      setReconnecting(false)
      socket.emit('attach', { session })
      requestAnimationFrame(() => {
        try {
          fitAddon.fit()
          socket.emit('resize', { cols: term.cols, rows: term.rows })
        } catch (_) {}
      })
    })

    socket.on('output', data => term.write(data))

    socket.on('session-exit', () => {
      setSessionEnded(true)
      setConnected(false)
    })

    socket.on('error', msg => {
      const text = typeof msg === 'string' ? msg : 'Connection error'
      if (text.includes('not found') || text.includes('Unauthorized')) setErrorMsg(text)
      setConnected(false)
    })

    socket.on('disconnect',    () => { setConnected(false); setReconnecting(true) })
    socket.on('connect_error', () => { setReconnecting(true) })

    // Batch rapid sends (toolbar special keys) — still useful for arrow spam etc.
    let inputBuf = ''
    let inputTimer = null
    function flushInput() {
      if (inputBuf) { socket.emit('input', inputBuf); inputBuf = '' }
      inputTimer = null
    }
    function sendInput(data) {
      inputBuf += data
      if (!inputTimer) inputTimer = setTimeout(flushInput, 8)
    }
    sendInputRef.current = sendInput

    // Physical keyboard → xterm.js onData (USB/Bluetooth keyboards, no IME)
    term.onData(sendInput)

    function handleResize() {
      try {
        fitAddon.fit()
        socket.emit('resize', { cols: term.cols, rows: term.rows })
      } catch (_) {}
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      socket.disconnect()
      term.dispose()
    }
  }, [session])

  return (
    <div className="bg-slate-900 flex flex-col" style={{ height: '100dvh', overflow: 'hidden' }}>
      {/* Header */}
      <header className="flex items-center gap-3 px-3 bg-slate-800 border-b border-slate-700 flex-shrink-0" style={{ height: '56px' }}>
        <button
          onClick={onBack}
          className="w-10 h-10 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-700 active:bg-slate-600 transition-colors"
          aria-label="Volver"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        <div className="flex-1 min-w-0 text-center">
          <span className="text-sm font-medium text-slate-200 truncate block">{session}</span>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className={`w-2.5 h-2.5 rounded-full transition-colors ${
            connected ? 'bg-green-400' : reconnecting ? 'bg-yellow-400 animate-pulse' : 'bg-slate-500'
          }`} />
          <span className="text-xs text-slate-500">
            {connected ? 'live' : reconnecting ? 'reconectando' : 'off'}
          </span>
        </div>
      </header>

      {/* Terminal */}
      <div
        ref={containerRef}
        onClick={() => termRef.current?.focus()}
        className="flex-1 overflow-hidden"
      />

      {/* Input box — soft keyboard types here, no IME issues */}
      <InputBox onSend={data => sendInputRef.current?.(data)} />

      {/* Special keys toolbar */}
      <KeyboardToolbar
        onSend={data => sendInputRef.current?.(data)}
        scrollMode={scrollMode}
        onExitScroll={exitScrollMode}
      />

      {/* Session ended / error overlay */}
      {(sessionEnded || errorMsg) && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900/90 z-20">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 mx-6 text-center shadow-2xl">
            {sessionEnded ? (
              <>
                <div className="text-4xl mb-3">✓</div>
                <h2 className="text-xl font-semibold text-slate-100 mb-2">Sesión terminada</h2>
                <p className="text-slate-400 text-sm mb-6">La sesión tmux ha finalizado.</p>
              </>
            ) : (
              <>
                <div className="text-4xl mb-3">⚠️</div>
                <h2 className="text-xl font-semibold text-slate-100 mb-2">Error de conexión</h2>
                <p className="text-slate-400 text-sm mb-6">{errorMsg}</p>
              </>
            )}
            <button
              onClick={onBack}
              className="w-full py-3 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-medium rounded-xl transition-colors"
            >
              Volver a sesiones
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
