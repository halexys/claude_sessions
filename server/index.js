const path = require('path');
const fs = require('fs');

// Load .env from the server directory if env vars are not already set.
// Needed on Windows where Task Scheduler doesn't pass an EnvironmentFile.
const dotenvPath = path.join(__dirname, '.env');
if (fs.existsSync(dotenvPath)) {
  fs.readFileSync(dotenvPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  });
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { execSync, exec, execFileSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const ALLOWED_ORIGINS = [
  'https://claude.example.com',
  'capacitor://localhost',   // Capacitor Android/iOS WebView
  'http://localhost',        // Capacitor fallback
  'http://localhost:5173',   // Vite dev server
];

function isAllowedOrigin(origin, callback) {
  if (!origin) return callback(null, true);
  callback(null, ALLOWED_ORIGINS.includes(origin));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: isAllowedOrigin, methods: ['GET', 'POST'] },
  // Heartbeat: lenient on purpose. The old 5s/3s declared mobile connections
  // dead on any latency spike >3s (congested cellular, backgrounded app with
  // throttled timers), causing constant false reconnects. ~45s of silence is
  // tolerated before a drop; genuinely dead sockets still recover via the
  // client's infinite reconnect + JSONL re-fetch.
  pingInterval: 25000,
  pingTimeout:  20000,
  // A `send` carries text + base64 image(s). The 1 MB default would drop the
  // packet and kill the socket when a couple of photos are attached.
  maxHttpBufferSize: 16 * 1024 * 1024,
  // Replay events missed during a brief disconnect (incl. in-flight assistant
  // stream chunks) instead of losing them until the turn lands in the JSONL.
  // Auth middleware re-runs on recovery (skipMiddlewares: false).
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: false,
  },
});

const PORT = process.env.PORT || 3001;
const HOME = process.env.HOME || os.homedir();
const MASTER_PASSWORD = process.env.AUTH_TOKEN;
if (!MASTER_PASSWORD) { console.error('AUTH_TOKEN env var is required'); process.exit(1); }
const DEVICES_FILE = path.join(__dirname, 'devices.json');

// Shared secret for the /api/hook endpoint — written to a file that only
// the local hook script can read (mode 0600, same user).
const HOOK_SECRET_FILE = path.join(HOME, '.claude', 'hooks', '.hook-secret');
let hookSecret;
try {
  hookSecret = fs.readFileSync(HOOK_SECRET_FILE, 'utf8').trim();
} catch {
  hookSecret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(HOOK_SECRET_FILE), { recursive: true });
  fs.writeFileSync(HOOK_SECRET_FILE, hookSecret, { mode: 0o600 });
  console.log('[hook] generated new hook secret');
}

// ─── Device store ─────────────────────────────────────────────────────────────

function loadDevices() {
  try { return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')); }
  catch { return []; }
}

function saveDevices(devices) {
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

const TOKEN_TTL_DAYS = 90;

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const tokenHash = hashToken(auth.slice(7));
  const devices = loadDevices();
  const device = devices.find(d => d.tokenHash === tokenHash);
  if (!device) return res.status(401).json({ error: 'Unauthorized' });
  const ageMs = Date.now() - new Date(device.registeredAt).getTime();
  if (ageMs > TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000) {
    return res.status(401).json({ error: 'Token expired', expired: true });
  }
  device.lastSeen = new Date().toISOString();
  saveDevices(devices);
  req.device = device;
  next();
}

// ─── Registration endpoint (public) ──────────────────────────────────────────

app.use(cors({ origin: isAllowedOrigin }));
app.use(express.json({ limit: '25mb' }));

const UPLOADS_DIR = path.join(HOME, '.claude-mobile-uploads');
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' }
});

app.post('/api/auth/register', registerLimiter, (req, res) => {
  const { password, deviceId, deviceName } = req.body || {};
  if (password !== MASTER_PASSWORD) return res.status(401).json({ error: 'Contraseña incorrecta' });
  const devices = loadDevices();
  const idx = devices.findIndex(d => d.id === deviceId);
  if (idx >= 0) devices.splice(idx, 1);
  const token = crypto.randomBytes(32).toString('hex');
  devices.push({
    id: deviceId,
    name: deviceName || 'Dispositivo',
    tokenHash: hashToken(token),
    registeredAt: new Date().toISOString(),
    lastSeen: new Date().toISOString()
  });
  saveDevices(devices);
  console.log(`[auth] registered device: ${deviceName} (${deviceId})`);
  res.json({ token });
});

app.get('/api/auth/devices', requireAuth, (req, res) => {
  res.json(loadDevices().map(({ id, name, registeredAt, lastSeen }) =>
    ({ id, name, registeredAt, lastSeen })
  ));
});

app.delete('/api/auth/devices/:id', requireAuth, (req, res) => {
  const devices = loadDevices().filter(d => d.id !== req.params.id);
  saveDevices(devices);
  res.json({ ok: true });
});

// Serve built frontend
const distPath = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// ─── Socket.io auth ───────────────────────────────────────────────────────────

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Unauthorized'));
  const devices = loadDevices();
  const device = devices.find(d => d.tokenHash === hashToken(token));
  if (!device) return next(new Error('Unauthorized'));
  socket.device = device;
  next();
});

// ─── Push token store (persisted to disk) ────────────────────────────────────

const PUSH_TOKENS_FILE = path.join(__dirname, 'push-tokens.json');

function loadPushTokens() {
  try { return new Set(JSON.parse(fs.readFileSync(PUSH_TOKENS_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function savePushTokens(set) {
  try { fs.writeFileSync(PUSH_TOKENS_FILE, JSON.stringify([...set])); } catch {}
}

const pushTokens = loadPushTokens();

app.post('/api/push-token', requireAuth, express.json(), (req, res) => {
  const { token } = req.body;
  if (token) { pushTokens.add(token); savePushTokens(pushTokens); }
  res.json({ ok: true });
});

app.delete('/api/push-token', requireAuth, express.json(), (req, res) => {
  const { token } = req.body;
  pushTokens.delete(token); savePushTokens(pushTokens);
  res.json({ ok: true });
});

// ─── FCM push notifications ───────────────────────────────────────────────────

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[mGKHFABCDJn]/g, '')
    .replace(/\x1b\][^\x07\x1b]*[\x07\x1b]/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
}

function getFirebaseAdmin() {
  const admin = require('firebase-admin');
  const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');
  if (!fs.existsSync(serviceAccountPath)) return null;
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(
      JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))
    )});
  }
  return admin;
}

async function sendPush(title, body) {
  if (pushTokens.size === 0) return;
  let admin;
  try { admin = getFirebaseAdmin(); } catch { return; }
  if (!admin) return;
  const tokens = [...pushTokens];
  await Promise.allSettled(tokens.map(token =>
    admin.messaging().send({
      token,
      notification: { title, body },
      android: { priority: 'high' }
    }).catch(() => pushTokens.delete(token))
  ));
}

// ─── Claude Code hook endpoint ────────────────────────────────────────────────
// Called by ~/.claude/hooks/push.sh (localhost only, no auth token needed).

app.post('/api/hook/:event', express.json(), (req, res) => {
  const secret = req.headers['x-hook-secret'];
  if (!secret || secret !== hookSecret) return res.status(403).end();

  const { event } = req.params;
  const body = req.body || {};

  if (event === 'Notification') {
    const msg = (body.message || 'Claude pide permiso').slice(0, 120);
    sendPush('Permiso requerido', msg).catch(() => {});
  } else if (event === 'Stop') {
    sendPush('Claude respondió', 'Claude ha terminado de responder').catch(() => {});
  }

  res.json({ ok: true });
});

// ─── REST API ────────────────────────────────────────────────────────────────

// Apply auth to all /api routes
app.use('/api', requireAuth);


// GET /api/read-file?path=... — read a file under HOME for the "view" links
// that the app overlays on assistant messages.
app.get('/api/read-file', (req, res) => {
  const raw = String(req.query.path || '');
  if (!raw) return res.status(400).json({ error: 'path required' });
  let resolved;
  try { resolved = path.resolve(raw); } catch { return res.status(400).json({ error: 'bad path' }); }
  // Only allow files under HOME, never traverse out
  if (!resolved.startsWith(HOME + '/') && resolved !== HOME) {
    return res.status(403).json({ error: 'outside home' });
  }
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile())             return res.status(400).json({ error: 'not a file' });
    if (st.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'file too large (>2MB)' });
    const ext = path.extname(resolved).toLowerCase().replace('.', '');
    // For binary types, only return metadata, not content
    const binary = ['png','jpg','jpeg','gif','webp','heic','pdf','zip','tar','gz','bin','exe','o','so'];
    if (binary.includes(ext)) {
      return res.json({ path: resolved, ext, size: st.size, binary: true });
    }
    const content = fs.readFileSync(resolved, 'utf8');
    res.json({ path: resolved, ext, size: st.size, content });
  } catch (err) {
    res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: err.message });
  }
});

// GET /api/folders?path= — navigable directory browser (restricted to HOME)
app.get('/api/folders', (req, res) => {
  try {
    const requestedPath = req.query.path ? path.resolve(req.query.path) : HOME;
    if (!requestedPath.startsWith(HOME)) {
      return res.status(403).json({ error: 'Access outside home directory is not allowed' });
    }
    const entries = fs.readdirSync(requestedPath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(requestedPath, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = requestedPath !== path.parse(requestedPath).root
      ? path.dirname(requestedPath)
      : null;
    res.json({ current: requestedPath, parent, dirs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/upload-image — save a base64-encoded image and return its absolute path
app.post('/api/upload-image', (req, res) => {
  const { data, ext } = req.body || {};
  if (!data || typeof data !== 'string') {
    return res.status(400).json({ error: 'Missing image data' });
  }
  const safeExt = String(ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'png';
  if (!['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic'].includes(safeExt)) {
    return res.status(400).json({ error: 'Unsupported image type' });
  }
  const filename = `img-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${safeExt}`;
  const filepath = path.join(UPLOADS_DIR, filename);
  try {
    fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
    res.json({ path: filepath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Chat sessions — Claude Code running in headless stream-json mode.
// /api/chat/sessions      GET    list all known chats (from JSONL files)
// /api/chat/sessions      POST   start a new chat { folder, model? } → { id, cwd }
// /api/chat/sessions/:id  GET    full history reconstructed from JSONL
// /api/chat/sessions/:id  DELETE close process + remove JSONL
// ───────────────────────────────────────────────────────────────────────────
const chatMgr = require('./chat-manager');
const chatSessions = new chatMgr.SessionManager();

const autoUpdate = require('./auto-update');
autoUpdate.start({ chatSessions });

// Manual trigger — useful for forcing an update without waiting for the next
// hourly tick. Authed by the existing /api/ requireAuth middleware.
// Manual trigger: check the gateway for a newer version. Does NOT apply.
app.post('/api/admin/update-now', async (req, res) => {
  try {
    await autoUpdate.runNow();
    res.json({ ok: true, ...autoUpdate.status({ chatSessions }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apply the pending update. Without force, refuses if any chat is active.
// With { force: true }, kills all chat sessions and updates immediately.
app.post('/api/admin/apply-update', express.json(), async (req, res) => {
  try {
    const force = !!req.body?.force;
    res.json({ ok: true, restarting: true, force });
    setImmediate(() => autoUpdate.applyUpdate({ chatSessions, force }).catch(err => {
      console.error('[update] apply failed:', err.message);
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/version — current server version + pending update info.
app.get('/api/version', (req, res) => {
  res.json(autoUpdate.status({ chatSessions }));
});

app.get('/api/chat/sessions', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '30', 10), 100);
  const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);
  const { chats, total, hasMore } = chatMgr.listChats({ limit, offset });
  const live = new Map(chatSessions.activeStates().map(s => [s.id, s]));
  res.json({
    chats: chats.map(c => ({
      ...c,
      active: live.has(c.id),
      busy: live.get(c.id)?.busy || false,
    })),
    total,
    hasMore,
  });
});

// GET /api/chat/active — small endpoint just for fast polling
app.get('/api/chat/active', (req, res) => {
  res.json(chatSessions.activeStates());
});

// POST /api/chat/sessions/:id/close — manually evict process (free memory)
app.post('/api/chat/sessions/:id/close', (req, res) => {
  const { id } = req.params;
  if (!/^[a-f0-9-]{36}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
  chatSessions.close(id);
  res.json({ ok: true });
});

// Pre-created chat metadata kept in memory until the first JSONL exists.
// Survives until restart — that's fine, sessions without a JSONL after a
// restart are effectively gone anyway.
const pendingNewChats = new Map();

app.post('/api/chat/sessions', (req, res) => {
  const { folder, model, permissionMode } = req.body || {};
  const cwd = folder && fs.existsSync(folder) ? folder : HOME;
  const id  = chatMgr.newSessionId();
  // Use the shared encoder (handles Windows paths too) instead of a POSIX-only
  // slash replace, so the pre-created dir matches the one Claude will use.
  try { fs.mkdirSync(path.dirname(chatMgr.sessionJsonlPath(cwd, id)), { recursive: true }); } catch {}
  const pm = chatMgr.ALLOWED_PERMISSION_MODES.includes(permissionMode)
    ? permissionMode : chatMgr.DEFAULT_PERMISSION_MODE;
  pendingNewChats.set(id, { cwd, model: model || null, permissionMode: pm });
  res.json({ id, cwd, model: model || null, permissionMode: pm });
});

app.get('/api/chat/sessions/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[a-f0-9-]{36}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
  const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
  const before = Math.max(parseInt(req.query.before || '0',  10), 0);
  const data = chatMgr.readHistory(id, { limit, before });
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

app.delete('/api/chat/sessions/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[a-f0-9-]{36}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
  chatSessions.close(id);
  // Find and delete the JSONL
  const projectsDir = path.join(HOME, '.claude', 'projects');
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const f = path.join(projectsDir, dir, `${id}.jsonl`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  } catch {}
  res.json({ ok: true });
});

// Look up the HTTPS proxy that claude itself routes through. We MUST egress
// via the same proxy — otherwise direct hits to api.anthropic.com can fight
// with an active claude session and invalidate its auth.
function claudeProxyUrl() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(HOME, '.claude/settings.json'), 'utf8'));
    return s.env?.HTTPS_PROXY || s.env?.https_proxy || s.env?.HTTP_PROXY || s.env?.http_proxy || null;
  } catch { return null; }
}

// curl shells out to honour HTTPS_PROXY natively — node's built-in fetch
// here has no proxy support.
const { spawn: spawnProc } = require('child_process');
function curlJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-fsSL', '--max-time', '15']
    for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`)
    args.push(url)
    const proxy = claudeProxyUrl()
    const env = { ...process.env }
    if (proxy) { env.HTTPS_PROXY = proxy; env.https_proxy = proxy }
    const p = spawnProc('curl', args, { env })
    let out = '', err = ''
    p.stdout.on('data', c => out += c)
    p.stderr.on('data', c => err += c)
    p.on('close', code => {
      if (code !== 0) return reject(new Error(`curl exited ${code}: ${err.slice(0, 200)}`))
      try { resolve(JSON.parse(out)) } catch (e) { reject(new Error('Bad JSON: ' + e.message)) }
    })
  })
}

// GET /api/quota — cached for 60s. Anthropic rate-limits this endpoint hard
// and several clients polling at once was getting us 429s.
const quotaCache = { value: null, fetchedAt: 0, ttl: 60 * 1000, inflight: null };
async function fetchQuota() {
  const now = Date.now();
  if (quotaCache.value && (now - quotaCache.fetchedAt) < quotaCache.ttl) {
    return quotaCache.value;
  }
  if (quotaCache.inflight) return quotaCache.inflight;
  quotaCache.inflight = (async () => {
    try {
      const credsFile = path.join(HOME, '.claude', '.credentials.json');
      const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
      const { accessToken, expiresAt } = creds.claudeAiOauth || {};
      if (!accessToken) throw new Error('No OAuth token');
      if (expiresAt && Date.now() > expiresAt) throw new Error('Token expired');
      const data = await curlJson('https://api.anthropic.com/api/oauth/usage', {
        Authorization:        `Bearer ${accessToken}`,
        'anthropic-version':  '2023-06-01',
        'anthropic-beta':     'oauth-2025-04-20',
      });
      quotaCache.value = data;
      quotaCache.fetchedAt = Date.now();
      return data;
    } finally {
      quotaCache.inflight = null;
    }
  })();
  return quotaCache.inflight;
}
app.get('/api/quota', requireAuth, async (req, res) => {
  try {
    const data = await fetchQuota();
    res.json(data);
  } catch (err) {
    // On error, serve a slightly stale value rather than nothing
    if (quotaCache.value) {
      res.set('X-Stale', '1');
      return res.json(quotaCache.value);
    }
    res.status(502).json({ error: err.message });
  }
});

// GET /api/usage — aggregate token usage from JSONL files

app.get('/api/usage', (req, res) => {
  const projectsDir = path.join(HOME, '.claude', 'projects');
  const byDay = {};
  const now = Date.now();
  const win5h  = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const win7d  = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const win7ds = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }; // sonnet only

  function dayKey(ts) { return (ts || '').slice(0, 10); }

  function addDay(key, usage) {
    if (!key || key.length < 10) return;
    if (!byDay[key]) byDay[key] = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, conversations: 0 };
    const d = byDay[key];
    d.input      += usage.input_tokens                || 0;
    d.output     += usage.output_tokens               || 0;
    d.cacheWrite += usage.cache_creation_input_tokens || 0;
    d.cacheRead  += usage.cache_read_input_tokens     || 0;
  }

  function addWindow(win, usage) {
    win.input      += usage.input_tokens                || 0;
    win.output     += usage.output_tokens               || 0;
    win.cacheWrite += usage.cache_creation_input_tokens || 0;
    win.cacheRead  += usage.cache_read_input_tokens     || 0;
  }

  try {
    for (const project of fs.readdirSync(projectsDir)) {
      const projectPath = path.join(projectsDir, project);
      try { if (!fs.statSync(projectPath).isDirectory()) continue; } catch { continue; }
      for (const file of fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'))) {
        try {
          const lines = fs.readFileSync(path.join(projectPath, file), 'utf8').split('\n').filter(Boolean);
          let firstTs = null;
          let counted = false;
          for (const line of lines) {
            try {
              const d = JSON.parse(line);
              if (!firstTs && d.timestamp) firstTs = d.timestamp;
              if (d.type === 'assistant' && d.message?.usage) {
                const ts = d.timestamp || firstTs;
                const model = d.message.model || '';
                const key = dayKey(ts);
                addDay(key, d.message.usage);
                if (!counted && key) { byDay[key].conversations++; counted = true; }
                const age = now - new Date(ts).getTime();
                if (age <= 5 * 3600 * 1000) addWindow(win5h, d.message.usage);
                if (age <= 7 * 24 * 3600 * 1000) {
                  addWindow(win7d, d.message.usage);
                  if (model.includes('sonnet')) addWindow(win7ds, d.message.usage);
                }
              }
            } catch {}
          }
        } catch {}
      }
    }
  } catch {}

  // Build last-30-days array
  const today = new Date();
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    daily.push({ date: key, ...(byDay[key] || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, conversations: 0 }) });
  }

  function sumDays(days) {
    return days.reduce((acc, d) => ({
      input: acc.input + d.input,
      output: acc.output + d.output,
      cacheWrite: acc.cacheWrite + d.cacheWrite,
      cacheRead: acc.cacheRead + d.cacheRead,
      conversations: acc.conversations + d.conversations,
    }), { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, conversations: 0 });
  }

  res.json({
    today:  sumDays(daily.slice(-1)),
    week:   sumDays(daily.slice(-7)),
    month:  sumDays(daily),
    daily:  daily.slice(-7),
    windows: {
      fiveHour:       win5h,
      sevenDay:       win7d,
      sevenDaySonnet: win7ds,
    },
  });
});

// SPA fallback — serve index.html for non-API routes
app.get('*', (req, res) => {
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not built. Run build.sh first.');
  }
});

// ─── /chat namespace — headless Claude Code over WebSocket ───────────────────
const chat = io.of('/chat');

chat.on('connection', (socket) => {
  let attachedChatId = null;
  let onEvent = null;

  console.log(`[chat] client connected: ${socket.id} (${socket.device?.name})`);

  // attach: just subscribes to the event bus for this chatId. Does NOT spawn
  // claude — that only happens on `resume` or `send` (lazy).
  let attachOpts = null;  // { cwd, model, permissionMode } stashed for later ensure()
  async function attach({ chatId, cwd, model, permissionMode }) {
    if (!chatId || !/^[a-f0-9-]{36}$/.test(chatId)) {
      socket.emit('chat_event', { kind: 'error', message: 'invalid chatId' });
      return;
    }
    attachedChatId = chatId;
    // Recover cwd/model/permissionMode from the pending-new-chat map if the
    // client didn't pass them explicitly (e.g. fresh chats with no JSONL yet).
    const pending = pendingNewChats.get(chatId);
    attachOpts = {
      cwd:            cwd            || pending?.cwd,
      model:          model          || pending?.model,
      permissionMode: permissionMode || pending?.permissionMode,
    };
    onEvent = ({ sessionId, ev }) => {
      if (sessionId === attachedChatId) socket.emit('chat_event', ev);
    };
    chatSessions.on('event', onEvent);
    const p = chatSessions.get(chatId);
    socket.emit('attached', {
      chatId,
      active: !!(p && p.proc),
      busy:   !!(p && p.busy),
      model:  p?.model || null,
      permissionMode: p?.permissionMode || null,
    });
    // Replay init for re-attaching clients (WS reconnect on mobile) so the
    // banner clears even though the original init went to a now-dead socket.
    if (p && p.init) {
      socket.emit('chat_event', {
        kind: 'init',
        tools: p.init.tools,
        model: p.init.model,
        slashCommands: p.init.slash_commands,
        permissionMode: p.init.permissionMode || p.permissionMode,
      });
    }
  }
  socket.on('attach', attach);

  // Force-replay the cached init event so the client can repopulate model,
  // slash commands and permission mode without leaving the chat.
  socket.on('request_init', () => {
    if (!attachedChatId) return;
    const p = chatSessions.get(attachedChatId);
    if (!p || !p.init) return;
    socket.emit('chat_event', {
      kind: 'init',
      tools: p.init.tools,
      model: p.init.model,
      slashCommands: p.init.slash_commands,
      permissionMode: p.init.permissionMode || p.permissionMode,
    });
  });

  socket.on('resume', async () => {
    if (!attachedChatId) return;
    try {
      const p = await chatSessions.ensure({ sessionId: attachedChatId, ...attachOpts });
      socket.emit('attached', {
        chatId: attachedChatId,
        active: true,
        busy:   !!p.busy,
        model:  p.model || null,
        permissionMode: p.permissionMode || null,
      });
    } catch (err) {
      socket.emit('chat_event', { kind: 'error', message: 'spawn failed: ' + err.message });
    }
  });

  socket.on('send', async ({ text, images }) => {
    if (!attachedChatId) {
      socket.emit('chat_event', { kind: 'error', message: 'not attached' });
      return;
    }
    try {
      const p = await chatSessions.ensure({ sessionId: attachedChatId, ...attachOpts });
      socket.emit('chat_event', { kind: 'text', role: 'user', text: text || '', images: (images||[]).map(i => ({ mediaType: i.mediaType })) });
      p.send({ text, images });
    } catch (err) {
      socket.emit('chat_event', { kind: 'error', message: 'send failed: ' + err.message });
    }
  });

  socket.on('cancel', () => {
    if (!attachedChatId) return;
    const p = chatSessions.get(attachedChatId);
    if (p) p.cancel();
  });

  // Mid-chat model swap. Closes the current claude process; the next `send`
  // will respawn it with the new --model flag.
  socket.on('set_model', async ({ model }) => {
    if (!attachedChatId) return;
    try {
      await chatSessions.ensure({ sessionId: attachedChatId, model: model || undefined });
      socket.emit('chat_event', { kind: 'info', text: 'Modelo cambiado' });
    } catch (err) {
      socket.emit('chat_event', { kind: 'error', message: 'set_model failed: ' + err.message });
    }
  });

  // Mid-chat permission-mode swap (same respawn pattern).
  socket.on('set_permission_mode', async ({ permissionMode }) => {
    if (!attachedChatId) return;
    if (!chatMgr.ALLOWED_PERMISSION_MODES.includes(permissionMode)) {
      socket.emit('chat_event', { kind: 'error', message: 'invalid permission mode' });
      return;
    }
    try {
      await chatSessions.ensure({ sessionId: attachedChatId, permissionMode });
      socket.emit('chat_event', { kind: 'info', text: `Permisos: ${permissionMode}` });
    } catch (err) {
      socket.emit('chat_event', { kind: 'error', message: 'set_permission_mode failed: ' + err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[chat] client disconnected: ${socket.id}`);
    if (onEvent) chatSessions.off('event', onEvent);
    attachedChatId = null;
    onEvent = null;
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function registerWithGateway() {
  const gatewayUrl   = process.env.GATEWAY_URL;
  const setupSecret  = process.env.SETUP_SECRET;
  const tunnelPort   = process.env.TUNNEL_PORT || '8765';
  if (!gatewayUrl || !setupSecret) return;
  const passwordHash = crypto.createHash('sha256').update(MASTER_PASSWORD).digest('hex');
  try {
    const res = await fetch(`${gatewayUrl}/setup`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Secret': setupSecret },
      body:    JSON.stringify({ passwordHash, tunnelPort: parseInt(tunnelPort), pcId: os.hostname() }),
    });
    if (res.ok) console.log(`[gateway] registered on port ${tunnelPort}`);
    else        console.error('[gateway] registration failed:', res.status);
  } catch (err) {
    console.error('[gateway] registration error:', err.message);
  }
}

server.listen(PORT, () => {
  console.log(`Claude Mobile server running on http://localhost:${PORT}`);
  registerWithGateway();
});
