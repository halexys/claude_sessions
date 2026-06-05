require('dotenv').config()
const express   = require('express')
const http      = require('http')
const httpProxy = require('http-proxy')
const jwt       = require('jsonwebtoken')
const crypto    = require('crypto')
const fs        = require('fs')
const path      = require('path')
const net       = require('net')

const PORT         = parseInt(process.env.PORT || '3000')
const JWT_SECRET   = process.env.JWT_SECRET
const SETUP_SECRET = process.env.SETUP_SECRET
const ADMIN_SECRET = process.env.ADMIN_SECRET
const VPS_HOST     = process.env.VPS_HOST

if (!JWT_SECRET || !SETUP_SECRET || !VPS_HOST) {
  console.error('JWT_SECRET, SETUP_SECRET and VPS_HOST required in .env')
  process.exit(1)
}

const REGISTRY_FILE      = path.join(__dirname, 'registry.json')
const INVITES_FILE       = path.join(__dirname, 'invites.json')
// We now run the gateway as the unprivileged `claude-tunnel` user; its home
// owns the file so we write to it natively (no setfacl/sudoers tricks).
const TUNNEL_USER        = process.env.TUNNEL_USER || 'claude-tunnel'
const AUTHORIZED_KEYS    = process.env.AUTHORIZED_KEYS || `/home/${TUNNEL_USER}/.ssh/authorized_keys`

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) }
  catch { return {} }
}
function saveRegistry(r) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(r, null, 2))
}
function loadInvites() {
  try { return JSON.parse(fs.readFileSync(INVITES_FILE, 'utf8')) }
  catch { return {} }
}
function saveInvites(inv) {
  fs.writeFileSync(INVITES_FILE, JSON.stringify(inv, null, 2))
}
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

const app    = express()
const server = http.createServer(app)
const proxy  = httpProxy.createProxyServer({})

// CORS — the WebView in the bundled mobile app runs at https://localhost or
// capacitor://localhost. Bearer auth, no cookies, so allowing * is safe.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Setup-Secret')
  res.setHeader('Access-Control-Max-Age', '86400')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})

const parseJson = express.json()

// ── PC se registra al arrancar ────────────────────────────────────────────────
app.post('/setup', parseJson, (req, res) => {
  if (req.headers['x-setup-secret'] !== SETUP_SECRET)
    return res.status(403).json({ error: 'Forbidden' })
  const { passwordHash, tunnelPort, pcId } = req.body || {}
  if (!passwordHash || !tunnelPort || !pcId)
    return res.status(400).json({ error: 'Missing fields' })
  const registry = loadRegistry()
  // Drop any stale hashes for this pcId so old passwords stop working after a reset
  for (const [hash, entry] of Object.entries(registry)) {
    if (entry.pcId === pcId && hash !== passwordHash) delete registry[hash]
  }
  registry[passwordHash] = { tunnelPort: parseInt(tunnelPort), pcId, updatedAt: new Date().toISOString() }
  saveRegistry(registry)
  console.log(`[setup] ${pcId} → port ${tunnelPort}`)
  res.json({ ok: true })
})

// ── Login: app envía contraseña, gateway devuelve JWT ─────────────────────────
app.post('/login', parseJson, async (req, res) => {
  const { password, deviceId, deviceName } = req.body || {}
  if (!password) return res.status(400).json({ error: 'Contraseña requerida' })
  const registry = loadRegistry()
  const entry    = registry[sha256(password)]
  if (!entry) return res.status(401).json({ error: 'Contraseña incorrecta' })
  try {
    const r = await fetch(`http://localhost:${entry.tunnelPort}/api/auth/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password, deviceId, deviceName }),
    })
    if (!r.ok) return res.status(r.status).json(await r.json())
    const { token: deviceToken } = await r.json()
    const gatewayToken = jwt.sign(
      { deviceToken, tunnelPort: entry.tunnelPort },
      JWT_SECRET,
      { expiresIn: '90d' }
    )
    res.json({ token: gatewayToken })
  } catch {
    res.status(503).json({ error: 'PC no disponible' })
  }
})

// ── Claim invite: instalador canjea código, recibe puerto + VPS info ──────────
app.post('/claim-invite', parseJson, (req, res) => {
  const { invite, sshPubKey, hostname } = req.body || {}
  if (!invite || !sshPubKey) return res.status(400).json({ error: 'Missing fields' })

  const invites = loadInvites()
  const entry   = invites[invite]
  if (!entry)       return res.status(404).json({ error: 'Código de invitación no válido' })
  if (entry.used)   return res.status(410).json({ error: 'Invitación ya usada' })

  // Añadir SSH key a authorized_keys con restricciones de seguridad
  const port    = entry.tunnelPort
  const keyLine = `restrict,port-forwarding,permitopen="localhost:${port}" ${sshPubKey.trim()} # ${entry.username}@${hostname || 'unknown'}\n`
  try {
    fs.mkdirSync(path.dirname(AUTHORIZED_KEYS), { recursive: true, mode: 0o700 })
    fs.appendFileSync(AUTHORIZED_KEYS, keyLine)
  } catch (err) {
    console.error('[claim-invite] error writing authorized_keys:', err.message)
    return res.status(500).json({ error: 'Error al registrar clave SSH' })
  }

  // Marcar invitación como usada
  invites[invite].used      = true
  invites[invite].usedAt    = new Date().toISOString()
  invites[invite].hostname  = hostname
  saveInvites(invites)

  console.log(`[invite] ${entry.username} (${hostname}) → port ${port} as ${TUNNEL_USER}`)
  res.json({ tunnelPort: port, vpsHost: VPS_HOST, tunnelUser: TUNNEL_USER, setupSecret: SETUP_SECRET })
})

// ── Firebase service account (protected) ─────────────────────────────────────
app.get('/firebase-config', (req, res) => {
  if (req.headers['x-setup-secret'] !== SETUP_SECRET)
    return res.status(403).json({ error: 'Forbidden' })
  const file = path.join(__dirname, 'firebase-service-account.json')
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' })
  res.sendFile(file)
})

// ── Admin ─────────────────────────────────────────────────────────────────────

// Simple in-memory rate limiter (no extra dependency)
const _adminHits = new Map()
function adminRateLimit(req, res, next) {
  const ip  = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
  const key = `${ip}:${Math.floor(Date.now() / 60000)}`
  const hits = (_adminHits.get(key) || 0) + 1
  _adminHits.set(key, hits)
  if (hits === 1) setTimeout(() => _adminHits.delete(key), 70000)
  if (hits > 60) return res.status(429).json({ error: 'Too many requests' })
  next()
}

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) return res.status(503).json({ error: 'ADMIN_SECRET not configured in .env' })
  const auth = req.headers.authorization || ''
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== ADMIN_SECRET)
    return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// Check if a local TCP port has an active tunnel
function portOpen(port) {
  return new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1')
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error',   () => resolve(false))
    sock.setTimeout(1200, () => { sock.destroy(); resolve(false) })
  })
}

// Next free port suggestion
function nextFreePort() {
  const used = new Set([
    ...Object.values(loadInvites()).map(v => v.tunnelPort),
    ...Object.values(loadRegistry()).map(v => v.tunnelPort),
  ])
  let p = 8765
  while (used.has(p)) p++
  return p
}

// Serve admin UI (security headers, no caching)
app.get(['/admin', '/admin/'], (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'")
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')
  res.sendFile(path.join(__dirname, 'admin.html'))
})

// GET /admin/api/status — overview
app.get('/admin/api/status', adminRateLimit, requireAdmin, async (req, res) => {
  const invites  = loadInvites()
  const registry = loadRegistry()
  const ports    = [...new Set(Object.values(registry).map(e => e.tunnelPort))]
  const checks   = await Promise.all(ports.map(p => portOpen(p).then(ok => [p, ok])))
  res.json({
    invites:  Object.keys(invites).length,
    pcs:      Object.keys(registry).length,
    online:   checks.filter(([, ok]) => ok).length,
    tunnels:  Object.fromEntries(checks),
    nextPort: nextFreePort(),
  })
})

// GET /admin/api/pcs — registered PCs (no password hashes)
app.get('/admin/api/pcs', adminRateLimit, requireAdmin, async (req, res) => {
  const registry = loadRegistry()
  const list = await Promise.all(Object.entries(registry).map(async ([, e]) => ({
    pcId:      e.pcId,
    port:      e.tunnelPort,
    updatedAt: e.updatedAt,
    online:    await portOpen(e.tunnelPort),
  })))
  list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  res.json(list)
})

// DELETE /admin/api/pcs/:pcId — revoke a PC (it must re-install to reconnect)
app.delete('/admin/api/pcs/:pcId', adminRateLimit, requireAdmin, (req, res) => {
  const pcId = String(req.params.pcId).slice(0, 128)
  const registry = loadRegistry()
  let found = false
  for (const [hash, e] of Object.entries(registry)) {
    if (e.pcId === pcId) { delete registry[hash]; found = true }
  }
  if (!found) return res.status(404).json({ error: 'Not found' })
  saveRegistry(registry)
  console.log(`[admin] revoked PC ${pcId}`)
  res.json({ ok: true })
})

// GET /admin/api/invites
app.get('/admin/api/invites', adminRateLimit, requireAdmin, (req, res) => {
  const invites = loadInvites()
  const list = Object.entries(invites).map(([code, v]) => ({ code, ...v }))
  list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  res.json(list)
})

// POST /admin/api/invites — create invite
app.post('/admin/api/invites', adminRateLimit, requireAdmin, parseJson, (req, res) => {
  const { username, tunnelPort } = req.body || {}
  if (!username || !/^[a-zA-Z0-9_-]{1,32}$/.test(username))
    return res.status(400).json({ error: 'username must be 1-32 chars: letters, numbers, _ or -' })
  const port = parseInt(tunnelPort, 10)
  if (!port || port < 1024 || port > 65535)
    return res.status(400).json({ error: 'tunnelPort must be 1024–65535' })

  const invites  = loadInvites()
  const registry = loadRegistry()
  const usedPorts = new Set([
    ...Object.values(invites).map(v => v.tunnelPort),
    ...Object.values(registry).map(v => v.tunnelPort),
  ])
  if (usedPorts.has(port))
    return res.status(409).json({ error: `Port ${port} already assigned` })

  const code = crypto.randomBytes(12).toString('hex')
  invites[code] = { username, tunnelPort: port, used: false, createdAt: new Date().toISOString() }
  saveInvites(invites)
  console.log(`[admin] invite created for ${username} on port ${port}`)
  res.json({ code, username, tunnelPort: port })
})

// DELETE /admin/api/invites/:code — revoke invite + remove SSH key + registry entry
app.delete('/admin/api/invites/:code', adminRateLimit, requireAdmin, (req, res) => {
  const code = String(req.params.code)
  if (!/^[a-f0-9]{24}$/.test(code)) return res.status(400).json({ error: 'Invalid code format' })

  const invites = loadInvites()
  const entry   = invites[code]
  if (!entry) return res.status(404).json({ error: 'Invite not found' })

  // Remove SSH key line for this port from authorized_keys
  try {
    const ak       = fs.readFileSync(AUTHORIZED_KEYS, 'utf8')
    const filtered = ak.split('\n')
      .filter(l => !l.includes(`permitopen="localhost:${entry.tunnelPort}"`))
      .join('\n')
    fs.writeFileSync(AUTHORIZED_KEYS, filtered)
  } catch {}

  // Remove any registry entries for this port
  const registry = loadRegistry()
  for (const [hash, e] of Object.entries(registry)) {
    if (e.tunnelPort === entry.tunnelPort) delete registry[hash]
  }
  saveRegistry(registry)

  delete invites[code]
  saveInvites(invites)
  console.log(`[admin] revoked invite ${code} (${entry.username}, port ${entry.tunnelPort})`)
  res.json({ ok: true })
})

// ── Helpers JWT ───────────────────────────────────────────────────────────────
function fromBearer(req) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  try { return jwt.verify(auth.slice(7), JWT_SECRET) } catch { return null }
}
function fromQuery(req) {
  try {
    const url = new URL(req.url, 'http://x')
    const tok = url.searchParams.get('jwt')
    if (!tok) return null
    return jwt.verify(tok, JWT_SECRET)
  } catch { return null }
}

// ── Proxy /api/* ──────────────────────────────────────────────────────────────
app.use('/api', (req, res) => {
  const payload = fromBearer(req)
  if (!payload) return res.status(401).json({ error: 'Unauthorized' })
  req.headers.authorization = `Bearer ${payload.deviceToken}`
  req.url = '/api' + req.url  // restore prefix stripped by app.use
  proxy.web(req, res, { target: `http://localhost:${payload.tunnelPort}` }, () => {
    res.status(503).json({ error: 'PC no disponible' })
  })
})

// ── Proxy /socket.io/* ────────────────────────────────────────────────────────
app.use('/socket.io', (req, res) => {
  const payload = fromQuery(req)
  if (!payload) return res.status(401).end()
  req.url = '/socket.io' + req.url  // restore prefix stripped by app.use
  proxy.web(req, res, { target: `http://localhost:${payload.tunnelPort}` }, () => {
    res.status(503).end()
  })
})

// ── WebSocket upgrade ─────────────────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  const payload = fromQuery(req)
  if (!payload) { socket.destroy(); return }
  proxy.ws(req, socket, head, { target: `http://localhost:${payload.tunnelPort}` }, () => {
    socket.destroy()
  })
})

proxy.on('error', (err, req, res) => {
  console.error('[proxy]', err.message)
  if (res?.writeHead) res.writeHead(503).end()
})

server.listen(PORT, () => console.log(`Gateway :${PORT}`))
