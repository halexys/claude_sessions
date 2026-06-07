// chat-manager.js — manages Claude Code processes in headless stream-json mode.
//
// One ClaudeProcess per session_id. Stdin is NDJSON of user turns, stdout
// is NDJSON of events from Claude (system/assistant/user/result/etc). This
// module normalises those events into a smaller "ChatEvent" vocabulary that
// the mobile UI can render directly.
//
// A SessionManager keeps an LRU of active processes — sessions that have
// been idle for IDLE_TIMEOUT_MS get their process closed (the JSONL on disk
// remains, so we can resume later). On the next message we respawn with
// --resume <sid>.

const { spawn, execSync } = require('child_process')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const HOME = process.env.HOME || os.homedir()
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects')

const IDLE_TIMEOUT_MS = 10 * 60 * 1000  // 10 min — close process after this
const SPAWN_INIT_TIMEOUT_MS = 3 * 60 * 1000  // 3 min — large JSONLs + plugin hooks
const SPAWN_QUICK_FAIL_MS = 1500           // detect immediate ENOENT/EACCES failures

// Resolve the absolute path to the `claude` binary. systemd user services
// usually run with a stripped PATH that doesn't include node-version-manager
// (fnm/nvm/asdf) bin dirs, so `spawn('claude', …)` would ENOENT. Try common
// locations and fall back to asking a login shell.
function resolveClaudeBinary() {
  const isWin = process.platform === 'win32'
  const candidates = [
    process.env.CLAUDE_BIN,
    // Windows — npm global installs
    isWin && path.join(HOME, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    isWin && path.join(HOME, 'AppData', 'Roaming', 'npm', 'claude'),
    isWin && path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
    // Linux/macOS
    !isWin && path.join(HOME, '.local/bin/claude'),
    !isWin && path.join(HOME, '.npm-global/bin/claude'),
    !isWin && path.join(HOME, '.fnm/current/bin/claude'),
    !isWin && path.join(HOME, '.bun/bin/claude'),
    !isWin && '/usr/local/bin/claude',
    !isWin && '/usr/bin/claude',
  ].filter(Boolean)
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c } catch {}
  }
  if (process.platform !== 'win32') {
    try {
      const out = execSync('bash -lc "command -v claude"', { encoding: 'utf8' }).trim()
      if (out && fs.existsSync(out)) return out
    } catch {}
  }
  return 'claude'  // last resort, will ENOENT and the caller surfaces it
}
const CLAUDE_BIN = resolveClaudeBinary()
// Augment PATH so subprocess can find aux tools (ripgrep, jq, etc.) too.
const SHELL_PATH = (() => {
  if (process.platform === 'win32') return process.env.PATH
  try {
    return execSync('bash -lc "echo -n $PATH"', { encoding: 'utf8' }).trim() || process.env.PATH
  } catch { return process.env.PATH }
})()

// Encode a cwd into the project-dir name Claude Code uses. Claude replaces
// every non-alphanumeric char with `-`, so this must cover Windows paths too
// (`C:\Users\me\app` → `C--Users-me-app`), not just POSIX `/` separators.
function projectDir(cwd) { return cwd.replace(/[^a-zA-Z0-9]/g, '-') }
function sessionJsonlPath(cwd, sessionId) {
  return path.join(PROJECTS_DIR, projectDir(cwd), `${sessionId}.jsonl`)
}

// Read the real cwd straight out of a session JSONL. The encoded project-dir
// name is lossy and ambiguous (a `-` could have been `/`, `\`, `:` or `_`), so
// decoding it back to a path is unreliable — fatal on Windows. Every Claude
// record carries an exact `"cwd"` field; trust that instead. Returns null if
// no record has one (e.g. an empty/legacy file).
function cwdFromJsonl(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.includes('"cwd"')) continue
      try {
        const d = JSON.parse(line)
        if (d && typeof d.cwd === 'string' && d.cwd) return d.cwd
      } catch {}
    }
  } catch {}
  return null
}

// Is a claude process currently running for this session? Used to distinguish
// a genuine duplicate from a stale lock left by a previous unclean exit.
// Linux walks /proc (no shell-out). macOS/Windows have no /proc, so we query
// the process list once via ps/PowerShell — matching the session UUID alone is
// enough since it's unique to the claude child's argv. A previous version only
// handled /proc and silently returned false everywhere else, which made the
// caller delete locks held by a live process on macOS/Windows.
function isSessionActive(sessionId) {
  try {
    if (process.platform === 'linux') {
      for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue
        try {
          const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
          if (cmd.includes('claude') && cmd.includes(sessionId)) return true
        } catch {}
      }
      return false
    }
    if (process.platform === 'win32') {
      // claude.cmd shells out to node, so match on the session id in any
      // command line rather than a process name. Exclude our own PID ($PID):
      // this query string itself contains the session id, so the querying
      // PowerShell process would otherwise match itself.
      const cmd = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${sessionId}*' -and $_.ProcessId -ne $PID } | Select-Object -First 1 -ExpandProperty ProcessId`
      const out = execSync(`powershell -NoProfile -NonInteractive -Command "${cmd}"`,
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      return /^\d+$/.test(out)
    }
    // macOS / other POSIX: ps shows the full argv.
    const out = execSync('ps -axww -o command=', { encoding: 'utf8', timeout: 5000 })
    return out.split('\n').some(l => l.includes('claude') && l.includes(sessionId))
  } catch {}
  return false
}

// Remove a stale lock file that claude refuses to overwrite. Skip the (costly)
// process scan when there's no lock to clear — on Windows the lock is never
// created, so this returns immediately and never shells out. Only delete once
// we've confirmed no live claude owns the session.
function clearStaleLocks(sessionId) {
  const lockPath = path.join(HOME, '.claude', 'security', `security_warnings_state_${sessionId}.lock`)
  if (!fs.existsSync(lockPath)) return
  if (isSessionActive(sessionId)) return
  try { fs.unlinkSync(lockPath) } catch {}
}

// Allowed values from claude --help: acceptEdits, auto, bypassPermissions,
// default, dontAsk, plan. Two we expose to the UI: bypassPermissions (open
// mode) and plan (read-only safe mode). Anything else is rejected to avoid
// hangs on interactive prompts.
const ALLOWED_PERMISSION_MODES = ['bypassPermissions', 'plan', 'acceptEdits', 'dontAsk']
const DEFAULT_PERMISSION_MODE  = 'bypassPermissions'

class ClaudeProcess extends EventEmitter {
  constructor({ sessionId, cwd, model, resume = false, permissionMode }) {
    super()
    this.sessionId = sessionId
    this.cwd       = cwd
    this.model     = model
    this.resume    = resume
    this.permissionMode = ALLOWED_PERMISSION_MODES.includes(permissionMode)
      ? permissionMode
      : DEFAULT_PERMISSION_MODE
    this.proc      = null
    this.buffer    = ''
    this.stderrBuf = ''
    this.init      = null
    this.lastUsedAt = Date.now()
    this.busy      = false
    this.previousCostUsd = 0
    this.pendingToolUses = new Map()  // tool_use_id -> { name, input }
  }

  spawn() {
    if (this.proc) return
    clearStaleLocks(this.sessionId)
    // For an existing JSONL we must use --resume <id>; --session-id only
    // creates brand-new sessions and rejects with "already in use" otherwise.
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', this.permissionMode,
    ]
    if (this.resume) args.push('--resume',     this.sessionId)
    else             args.push('--session-id', this.sessionId)
    if (this.model)  args.push('--model', this.model)

    this.stderrBuf = ''
    this.proc = spawn(CLAUDE_BIN, args, {
      cwd: this.cwd,
      env: { ...process.env, PATH: SHELL_PATH },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stdout.on('data', chunk => this._onStdout(chunk))
    this.proc.stderr.on('data', chunk => {
      const s = chunk.toString()
      this.stderrBuf = (this.stderrBuf + s).slice(-2000)
      this.emit('stderr', s)
    })
    this.proc.on('exit', code => {
      this.emit('exit', code)
      this.proc = null
    })
    this.proc.on('error', err => this.emit('error', err))
    return this
  }

  _onStdout(chunk) {
    this.buffer += chunk.toString()
    let nl
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      try {
        const ev = JSON.parse(line)
        this._handleEvent(ev)
      } catch (err) {
        this.emit('parse-error', { line, err: err.message })
      }
    }
  }

  _handleEvent(ev) {
    this.emit('raw', ev)
    if (ev.type === 'system' && ev.subtype === 'hook_started') {
      this.emit('chat-event', { kind: 'spawn_progress', hookName: ev.hook_name, event: ev.hook_event })
      return
    }
    if (ev.type === 'system' && ev.subtype === 'init') {
      this.init = ev
      this.emit('init', ev)
      this.emit('chat-event', {
        kind: 'init',
        tools: ev.tools,
        model: ev.model,
        slashCommands: ev.slash_commands,
        permissionMode: ev.permissionMode || this.permissionMode,
      })
      return
    }
    if (ev.type === 'assistant') {
      const blocks = ev.message?.content || []
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          this.emit('chat-event', { kind: 'text', text: b.text, role: 'assistant', uuid: ev.uuid })
        } else if (b.type === 'tool_use') {
          this.pendingToolUses.set(b.id, { name: b.name, input: b.input })
          this.emit('chat-event', { kind: 'tool_use', id: b.id, name: b.name, input: b.input })
        } else if (b.type === 'thinking' && b.thinking) {
          this.emit('chat-event', { kind: 'thinking', text: b.thinking })
        }
      }
      return
    }
    if (ev.type === 'user') {
      // tool_result blocks from sub-tools
      const blocks = ev.message?.content || []
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const meta = this.pendingToolUses.get(b.tool_use_id) || {}
          const outText = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
              : ''
          this.pendingToolUses.delete(b.tool_use_id)
          this.emit('chat-event', {
            kind: 'tool_result',
            id: b.tool_use_id,
            name: meta.name || 'tool',
            output: outText,
            isError: !!b.is_error,
          })
        }
      }
      return
    }
    if (ev.type === 'rate_limit_event') {
      this.emit('chat-event', { kind: 'rate_limit', info: ev.rate_limit_info })
      return
    }
    if (ev.type === 'result') {
      const cost = (ev.total_cost_usd || 0) - this.previousCostUsd
      this.previousCostUsd = ev.total_cost_usd || this.previousCostUsd
      this.busy = false
      this.emit('chat-event', {
        kind: 'turn_done',
        costDeltaUsd: cost,
        totalCostUsd: ev.total_cost_usd || 0,
        durationMs: ev.duration_ms || 0,
        usage: ev.usage || {},
        result: ev.result || '',
        terminalReason: ev.terminal_reason || 'completed',
      })
      this.emit('turn-done')
      return
    }
    if (ev.type === 'system' && ev.subtype === 'hook_response') {
      // surface only failures
      if (ev.exit_code && ev.exit_code !== 0) {
        this.emit('chat-event', { kind: 'hook_error', name: ev.hook_name, stderr: ev.stderr })
      }
      return
    }
  }

  send({ text, images = [] }) {
    if (!this.proc) throw new Error('process not running')
    this.lastUsedAt = Date.now()
    this.busy = true
    const content = []
    if (text && text.trim()) content.push({ type: 'text', text })
    for (const img of images) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.base64 },
      })
    }
    if (content.length === 0) {
      this.busy = false
      throw new Error('empty turn')
    }
    const payload = { type: 'user', message: { role: 'user', content } }
    this.proc.stdin.write(JSON.stringify(payload) + '\n')
  }

  cancel() {
    // Closing stdin asks Claude to finish current turn; killing INT stops mid-stream
    if (!this.proc) return
    try { this.proc.kill('SIGINT') } catch {}
  }

  close() {
    if (!this.proc) return
    try { this.proc.stdin.end() } catch {}
    setTimeout(() => {
      if (this.proc) { try { this.proc.kill('SIGTERM') } catch {} }
    }, 2000)
  }
}

class SessionManager extends EventEmitter {
  constructor() {
    super()
    this.processes = new Map() // sessionId -> ClaudeProcess
    this.sweepTimer = setInterval(() => this._sweepIdle(), 60 * 1000)
    if (this.sweepTimer.unref) this.sweepTimer.unref()
  }

  // Ensure a process exists for sessionId. If `cwd` is provided we use it for
  // the project-dir lookup; otherwise we try to infer it from the JSONL.
  async ensure({ sessionId, cwd, model, permissionMode }) {
    let p = this.processes.get(sessionId)
    // Mid-chat flag swap (model or permission mode): tear down and respawn.
    const swap = p && p.proc && (
      (model && p.model !== model) ||
      (permissionMode && p.permissionMode !== permissionMode)
    )
    if (swap) {
      p.close()
      this.processes.delete(sessionId)
      p = null
    }
    if (p && p.proc) return p

    const exists  = this._existingProjectFor(sessionId)
    let realCwd   = cwd || exists?.cwd
    if (!realCwd) throw new Error('cwd unknown for session ' + sessionId)
    // If the recorded cwd no longer exists on disk, fall back to HOME so we
    // don't get an ENOENT from child_process.spawn.
    if (!fs.existsSync(realCwd)) realCwd = HOME

    p = new ClaudeProcess({ sessionId, cwd: realCwd, model, resume: !!exists, permissionMode })
    this.processes.set(sessionId, p)
    p.on('exit', () => this.processes.delete(sessionId))
    p.on('chat-event', ev => this.emit('event', { sessionId, ev }))

    p.spawn()
    // Only check the process didn't die immediately (ENOENT/EACCES); let
    // init complete asynchronously — the UI listens for chat-event 'init'.
    await this._awaitQuickFail(p)
    return p
  }

  _awaitQuickFail(p) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { cleanup(); resolve() }, SPAWN_QUICK_FAIL_MS)
      const onExit = code => {
        cleanup()
        const detail = p.stderrBuf ? ` — ${p.stderrBuf.split('\n').filter(Boolean).slice(-2).join(' | ')}` : ''
        reject(new Error('claude exited code=' + code + detail))
      }
      const onError = e => { cleanup(); reject(e) }
      function cleanup() {
        clearTimeout(t)
        p.off('exit', onExit)
        p.off('error', onError)
      }
      p.once('exit', onExit)
      p.once('error', onError)
    })
  }

  _awaitInit(p) {
    return new Promise((resolve, reject) => {
      if (p.init) return resolve()
      const t = setTimeout(() => {
        cleanup()
        // Don't leave the half-initialised process hanging around
        try { p.close() } catch {}
        reject(new Error('claude init timeout'))
      }, SPAWN_INIT_TIMEOUT_MS)
      const onInit = () => { cleanup(); resolve() }
      const onExit = code => {
        cleanup()
        const detail = p.stderrBuf ? ` — ${p.stderrBuf.split('\n').filter(Boolean).slice(-2).join(' | ')}` : ''
        reject(new Error('claude exited code=' + code + detail))
      }
      const onError = e => { cleanup(); reject(e) }
      function cleanup() {
        clearTimeout(t)
        p.off('init', onInit)
        p.off('exit', onExit)
        p.off('error', onError)
      }
      p.once('init', onInit)
      p.once('exit', onExit)
      p.once('error', onError)
    })
  }

  // Find an existing project dir that contains a JSONL for this sessionId.
  _existingProjectFor(sessionId) {
    try {
      const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const f = path.join(PROJECTS_DIR, e.name, `${sessionId}.jsonl`)
        if (fs.existsSync(f)) {
          // Prefer the exact cwd recorded inside the JSONL; only fall back to
          // the lossy dir-name decode (POSIX-only) if the file has no cwd.
          const cwd = cwdFromJsonl(f) || ('/' + e.name.replace(/^-+/, '').replace(/-/g, '/'))
          return { cwd, jsonl: f }
        }
      }
    } catch {}
    return null
  }

  get(sessionId) { return this.processes.get(sessionId) || null }

  // Public state of every live process, for the chat list indicator.
  activeStates() {
    const out = []
    for (const [sid, p] of this.processes) {
      if (!p.proc) continue
      out.push({
        id: sid,
        busy: !!p.busy,
        model: p.model || null,
        idleMs: Date.now() - p.lastUsedAt,
      })
    }
    return out
  }

  close(sessionId) {
    const p = this.processes.get(sessionId)
    if (!p) return
    p.close()
    this.processes.delete(sessionId)
  }

  _sweepIdle() {
    const now = Date.now()
    for (const [sid, p] of this.processes) {
      if (!p.proc) { this.processes.delete(sid); continue }
      if (p.busy) continue
      if (now - p.lastUsedAt > IDLE_TIMEOUT_MS) {
        p.close()
      }
    }
  }

  shutdown() {
    clearInterval(this.sweepTimer)
    for (const p of this.processes.values()) p.close()
    this.processes.clear()
  }
}

// List all known Claude conversations from JSONL files.
// Two-phase: cheap mtime listing first, then summarise only the requested slice.
function listChats({ limit = 30, offset = 0 } = {}) {
  const all = []
  try {
    const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    for (const dir of projects) {
      if (!dir.isDirectory()) continue
      const projectPath = path.join(PROJECTS_DIR, dir.name)
      const cwd = '/' + dir.name.replace(/^-+/, '').replace(/-/g, '/')
      for (const file of fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'))) {
        try {
          const full = path.join(projectPath, file)
          all.push({ id: file.replace('.jsonl', ''), cwd, full, mtime: fs.statSync(full).mtimeMs })
        } catch {}
      }
    }
    all.sort((a, b) => b.mtime - a.mtime)
    const slice = all.slice(offset, offset + limit)
    return {
      total: all.length,
      hasMore: offset + slice.length < all.length,
      chats: slice.map(e => {
        const s = summariseJsonl(e.full) || {}
        // Prefer the exact cwd from inside the JSONL over the lossy dir decode.
        return { id: e.id, ...s, cwd: s.cwd || e.cwd }
      }),
    }
  } catch {
    return { total: 0, hasMore: false, chats: [] }
  }
}

// Claude Code stores message content in two shapes: an array of blocks (the
// API format) or a plain string (legacy / shortcut). Normalise both to text.
function extractText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(c => c && c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join(' ')
    .trim()
}

// Cheap summary used in the chat list: title, last user/assistant snippet, timestamp.
// Also extracts `entrypoint` (cli vs sdk-*) so the UI can group agent runs
// separately from user-initiated chats.
function summariseJsonl(filePath) {
  let title = null, lastUserText = null, lastAssistantText = null, ts = null, entrypoint = null, cwd = null
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const d = JSON.parse(line)
        if (!cwd && typeof d.cwd === 'string' && d.cwd) cwd = d.cwd
        if (!entrypoint && d.entrypoint) entrypoint = d.entrypoint
        if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle
        if (d.type === 'last-prompt' && d.lastPrompt) lastUserText = d.lastPrompt
        if (d.timestamp) ts = d.timestamp
        if (d.type === 'user' && d.message?.content) {
          const txt = extractText(d.message.content)
          if (txt) lastUserText = txt
        }
        if (d.type === 'assistant' && d.message?.content) {
          const txt = extractText(d.message.content)
          if (txt) lastAssistantText = txt
        }
      } catch {}
    }
    return { title, lastUserText, lastAssistantText, ts, entrypoint, cwd }
  } catch {
    return null
  }
}

// Reconstruct a chat history into ChatEvent-shaped messages so the UI can
// render past conversations identically to live ones.
//
// `limit` returns the last N user-visible entries; `before` paginates further
// back (entries strictly before this 0-indexed offset from the END are kept).
function readHistory(sessionId, { limit = 50, before = 0 } = {}) {
  const entries = []
  try {
    const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    for (const dir of projects) {
      if (!dir.isDirectory()) continue
      const f = path.join(PROJECTS_DIR, dir.name, `${sessionId}.jsonl`)
      if (!fs.existsSync(f)) continue
      let cwd = '/' + dir.name.replace(/^-+/, '').replace(/-/g, '/')
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const d = JSON.parse(line)
          // The recorded cwd is exact; the dir-decode above is only a fallback.
          if (typeof d.cwd === 'string' && d.cwd) cwd = d.cwd
          if (d.type === 'user' && d.message?.content) {
            const content = d.message.content
            if (typeof content === 'string') {
              entries.push({ kind: 'user', text: content, ts: d.timestamp })
            } else if (Array.isArray(content)) {
              const text = content
                .filter(c => c?.type === 'text').map(c => c.text).join('\n')
              const hasTool = content.some(c => c?.type === 'tool_result')
              if (!hasTool && text) {
                entries.push({ kind: 'user', text, ts: d.timestamp })
              }
              for (const c of content) {
                if (c?.type === 'tool_result') {
                  const outText = typeof c.content === 'string'
                    ? c.content
                    : Array.isArray(c.content)
                      ? c.content.filter(x => x?.type === 'text').map(x => x.text).join('\n')
                      : ''
                  entries.push({
                    kind: 'tool_result',
                    id: c.tool_use_id,
                    output: outText,
                    isError: !!c.is_error,
                    ts: d.timestamp,
                  })
                }
              }
            }
          }
          if (d.type === 'assistant' && d.message?.content) {
            const content = d.message.content
            if (typeof content === 'string') {
              entries.push({ kind: 'text', role: 'assistant', text: content, ts: d.timestamp })
            } else if (Array.isArray(content)) {
              for (const c of content) {
                if (c?.type === 'text' && c.text) {
                  entries.push({ kind: 'text', role: 'assistant', text: c.text, ts: d.timestamp })
                } else if (c?.type === 'tool_use') {
                  entries.push({ kind: 'tool_use', id: c.id, name: c.name, input: c.input, ts: d.timestamp })
                }
              }
            }
          }
        } catch {}
      }
      const total = entries.length
      // Apply pagination: window = [total-before-limit, total-before)
      const end   = Math.max(0, total - before)
      const start = Math.max(0, end - limit)
      const slice = entries.slice(start, end)
      return { cwd, entries: slice, total, hasMore: start > 0 }
    }
  } catch {}
  return null
}

function newSessionId() {
  return crypto.randomUUID()
}

module.exports = {
  SessionManager,
  ClaudeProcess,
  listChats,
  readHistory,
  newSessionId,
  sessionJsonlPath,
  ALLOWED_PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
}
