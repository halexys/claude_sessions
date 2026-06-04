// auto-update.js — pulls the server tarball from the gateway when a newer
// version is published and triggers a graceful restart.
//
// Strategy: only runs under systemd (Restart=always handles the relaunch),
// only updates when the chat session manager is idle, and never overwrites
// itself mid-turn. Failures are logged and retried on the next interval.

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const PKG = require('./package.json')
const LOCAL_VERSION = PKG.version || '0.0.0'

const GATEWAY_URL  = process.env.GATEWAY_URL || 'https://claude.example.com'
const VERSION_URL  = `${GATEWAY_URL}/version.json`
const TARBALL_URL  = `${GATEWAY_URL}/server.tar.gz`
const INSTALL_DIR  = path.join(os.homedir(), '.local', 'share', 'claude-mobile')
const CHECK_INTERVAL_MS = 60 * 60 * 1000   // hourly
const INITIAL_DELAY_MS  = 60 * 1000        // 1 min after startup

function isNewer(remote, local) {
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

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

async function downloadTarball() {
  const r = await fetch(TARBALL_URL)
  if (!r.ok) throw new Error(`tarball HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  const tmp = path.join(os.tmpdir(), `claude-mobile-update-${crypto.randomBytes(4).toString('hex')}.tar.gz`)
  fs.writeFileSync(tmp, buf)
  return tmp
}

function extractTarball(tmp) {
  // --strip-components=1 collapses the top-level "claude-mobile/" wrapper.
  execFileSync('tar', ['-xzf', tmp, '-C', INSTALL_DIR, '--strip-components=1'], { stdio: 'pipe' })
}

function inSystemd() {
  // Set by systemd for every service invocation. Without it we have nothing
  // to restart us, so we must not exit.
  return !!process.env.INVOCATION_ID
}

function isIdle(chatSessions) {
  if (!chatSessions) return true
  for (const p of chatSessions.processes.values()) {
    if (p.busy) return false
  }
  return true
}

// Cached pending update advertised to the client. Never applied automatically.
let pendingUpdate = null  // { version, releaseNotes, checkedAt }
let inProgress = false
let lastCheckAt = 0

async function checkOnce() {
  if (inProgress) return
  inProgress = true
  try {
    const meta = await fetchJson(VERSION_URL).catch(() => null)
    lastCheckAt = Date.now()
    if (!meta) return
    const remote = meta.server || meta.serverVersion || null
    if (!remote) return
    if (!isNewer(remote, LOCAL_VERSION)) {
      pendingUpdate = null
      return
    }
    pendingUpdate = {
      version: remote,
      releaseNotes: meta.releaseNotes || null,
      checkedAt: new Date(lastCheckAt).toISOString(),
    }
    console.log(`[auto-update] available: ${LOCAL_VERSION} -> ${remote}`)
  } catch (err) {
    console.error('[auto-update] check error:', err.message)
  } finally {
    inProgress = false
  }
}

async function applyUpdate({ chatSessions, force = false } = {}) {
  if (!pendingUpdate) await checkOnce()
  if (!pendingUpdate) throw new Error('no update available')
  if (!inSystemd()) throw new Error('not running under systemd (no auto-restart)')
  if (!isIdle(chatSessions) && !force) {
    throw new Error('chat sessions are active — pass force:true to kill them and update')
  }
  if (force && chatSessions) {
    chatSessions.shutdown()
  }
  console.log(`[auto-update] applying ${LOCAL_VERSION} -> ${pendingUpdate.version}`)
  const tmp = await downloadTarball()
  try { extractTarball(tmp) } finally { try { fs.unlinkSync(tmp) } catch {} }
  setTimeout(() => process.exit(0), 200)
}

function status({ chatSessions } = {}) {
  return {
    current: LOCAL_VERSION,
    pending: pendingUpdate,
    sessionsActive: chatSessions ? chatSessions.activeStates().length : 0,
    lastCheckAt: lastCheckAt ? new Date(lastCheckAt).toISOString() : null,
  }
}

function start({ chatSessions }) {
  setTimeout(checkOnce, INITIAL_DELAY_MS)
  const t = setInterval(checkOnce, CHECK_INTERVAL_MS)
  if (t.unref) t.unref()
}

module.exports = { start, runNow: checkOnce, applyUpdate, status, LOCAL_VERSION }
