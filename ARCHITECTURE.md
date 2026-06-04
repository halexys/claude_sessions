# Architecture

Notes on how the pieces talk and the non-obvious bits about Claude Code's
headless mode that drove design choices.

---

## Topology

```
                            Internet
                                │
                                ▼
        ┌───────────────────────────────────────────────┐
        │  VPS  (Linux, public IP, Caddy on 443)        │
        │                                               │
        │   Caddy ──┐                                   │
        │           │                                   │
        │           ├──► /api/*, /socket.io/* ─►  Node  │
        │           │                            Gateway│
        │           ├──► /login, /setup         (:3000) │
        │           │    /claim-invite,                 │
        │           │    /firebase-config               │
        │           │                                   │
        │           └──► static (app.apk,               │
        │                version.json, install.sh,     │
        │                React bundle)                  │
        │                                               │
        │   sshd ◄──── ssh -R 87xx:localhost:3001       │
        │          (claude-tunnel@vps, nologin shell)   │
        │                                               │
        └───────────────────────────────────────────────┘
                                ▲
                                │ each user opens ONE reverse tunnel
                                │ from their PC. The VPS uses it to
                                │ reach :3001 on that PC.
                                │
        ┌───────────────────────┴───────────────────────┐
        │                                               │
   ┌────┴────┐                                     ┌────┴────┐
   │ PC: bob │                                     │PC: alice│
   │ port    │                                     │  port   │
   │ 8765    │                                     │  8769   │
   │         │  systemd: claude-mobile (port 3001) │         │
   │         │  systemd: claude-tunnel (SSH -R)    │         │
   │         │  spawns: claude --print ...         │         │
   └─────────┘                                     └─────────┘
                                ▲
                                │ HTTPS/WSS over Caddy
                                │
                       ┌────────┴────────┐
                       │  Android (APK)  │
                       │  Capacitor 8    │
                       │  React + Vite   │
                       └─────────────────┘
```

There is exactly one VPS instance, N PCs (one per onboarded user), and one
mobile device per user (sometimes more). The VPS does **no** persistence of
chats — it's a stateless router. All chat history lives on each user's PC.

---

## Gateway

`gateway/gateway.js`. Express + http-proxy. Runs as user `claude-tunnel` so
it natively owns the `authorized_keys` file.

### Endpoints

| Route                | What it does                                                                                          |
|----------------------|-------------------------------------------------------------------------------------------------------|
| `POST /setup`        | A PC's server announces `{passwordHash, tunnelPort, pcId}`. Auth: `X-Setup-Secret` header.            |
| `POST /login`        | Mobile sends `{password, deviceId, deviceName}`. Gateway looks up `passwordHash`, calls PC's `/api/auth/register` via the tunnel, gets back a per-device token, wraps it in a JWT `{deviceToken, tunnelPort}`, returns it. |
| `POST /claim-invite` | Installer trades an invite code for `{tunnelPort, vpsHost, tunnelUser, setupSecret}`. Side-effect: appends the client's SSH pub key (with restrictions) to `/home/claude-tunnel/.ssh/authorized_keys`. |
| `GET /firebase-config` | Returns the Firebase admin JSON. Auth: `X-Setup-Secret`. PC server downloads it once at install.    |
| `/api/*`             | Proxies to the user's PC. Authenticates by verifying the JWT, then forwards as `Bearer <deviceToken>` to `http://localhost:<tunnelPort>`. |
| `/socket.io/*`       | Same routing, but the JWT comes from `?jwt=` query string because socket.io's WebSocket upgrade can't carry an Authorization header. |

### State on disk

* `registry.json` — `{ [passwordHash]: { tunnelPort, pcId, updatedAt } }`.
  When a PC re-registers (e.g. password reset), old hashes for the same
  `pcId` are purged so the previous password stops working.
* `invites.json` — `{ [inviteCode]: { username, tunnelPort, used, createdAt, usedAt, hostname } }`.

### SSH key writing

The installer sends its pubkey to `/claim-invite`. The gateway appends a line
like this to `authorized_keys`:

```
restrict,port-forwarding,permitopen="localhost:8769" ssh-ed25519 AAAA… # alice@alice-laptop
```

`restrict` disables agent forwarding, X11, PTY, tunneling, and exec. The only
thing the key authorizes is opening ONE specific reverse port forward
(`localhost:8769`). Even if sshd had a bug that bypassed `restrict`, the user
is `claude-tunnel` with `/usr/sbin/nologin` — there is no interactive shell
to drop into.

---

## PC server (`server/`)

Three-letter summary: Express on `:3001`, plus a Socket.IO server with two
namespaces: `/terminal` (legacy tmux flow, kept for backcompat) and `/chat`
(the new flow described below).

### Chat flow (the meat of it)

`chat-manager.js` owns a `SessionManager` that maps `sessionId → ClaudeProcess`.

A `ClaudeProcess` wraps a child `claude --print --input-format stream-json
--output-format stream-json --verbose --permission-mode <mode>` invocation
with either `--session-id <new>` (brand new chat) or `--resume <existing>`
(reopening). It exposes:

* `spawn()` — starts the child. Resolves stale lock files at
  `~/.claude/security/security_warnings_state_<sid>.lock` first.
* `send({text, images})` — writes one NDJSON line to stdin:

  ```json
  {"type":"user","message":{"role":"user","content":[
    {"type":"text","text":"…"},
    {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"…"}}
  ]}}
  ```

* event emitter: every JSON line on stdout is parsed and re-emitted as a
  semantic `chat-event` (`{kind: 'text'|'tool_use'|'tool_result'|'thinking'|
  'spawn_progress'|'turn_done'|'init'|'rate_limit'}`).

The `SessionManager` re-emits all child events as `{sessionId, ev}` so a
single WebSocket can subscribe to one chat at a time. Processes idle for >10
min are reaped.

### Things I learned the hard way about Claude Code headless

1. **`--print` doesn't mean one-shot.** With `--input-format stream-json` it
   keeps the process alive across turns. The process exits only when stdin
   closes.

2. **`system/init` fires once per process, after sync hooks finish.** Async
   hooks (declared `{"async": true, "asyncTimeout": 180000}`) continue
   emitting `hook_progress` AFTER init. Plan around this when you build a
   spinner.

3. **`system/init` also does NOT fire until the first user turn.** If you
   spawn `claude --print --resume <sid>` and never write to stdin, hooks run
   but init never comes. Don't gate UI on init alone — also derive
   "process alive" from any other event arriving (or just from the spawn not
   crashing in the first 1.5 s).

4. **`--session-id <uuid>` vs `--resume <uuid>` are NOT interchangeable.**
   `--session-id` is for *new* sessions and errors with `Session ID already
   in use` if the JSONL exists. `--resume` is for existing ones. We pick
   based on whether the JSONL file exists.

5. **The session JSONL lives at
   `~/.claude/projects/<cwd-encoded>/<session-id>.jsonl`**, where
   `<cwd-encoded>` is the cwd with `/` replaced by `-`. So `/home/alice/code`
   → `-home-alice-code/UUID.jsonl`. Reading this directly lets the app show
   history without spending API tokens.

6. **Lock recovery.** If a claude process dies uncleanly it can leave a
   `security_warnings_state_<sid>.lock` orphan that blocks the next
   `--session-id` invocation. We unlink stale locks before spawn (checks
   `/proc` to be sure no other claude is using the session).

7. **`--print --input-format stream-json` requires `--verbose`.** Without
   it, claude exits silently.

8. **Replay on reconnect.** If the WebSocket dies between spawn and `init`,
   the new connection misses init forever. Our gateway caches the latest
   `init` per process and replays it on every fresh `attach`. We also
   re-fetch the JSONL from disk on every WS reconnect so any messages that
   landed during the dead window appear on screen.

9. **Permission modes that work in headless.** The CLI supports
   `acceptEdits | auto | bypassPermissions | default | dontAsk | plan`.
   `default` / `acceptEdits` would block waiting for interactive input
   that never comes (no TTY) — useless. We expose two: `bypassPermissions`
   (open) and `plan` (read-only, claude can't edit or exec).

### Push notification hooks

The installer drops two Claude Code hooks (`Notification` and `Stop`) that
POST to the local server with a shared secret. The server sends an FCM
push to all tokens registered for that PC (token registration happens via
`POST /api/push-token` from the mobile app on first launch).

### Auto-update (server)

`auto-update.js`. Every hour the server fetches `version.json` from the
gateway. If `server` field is newer than local, it remembers it — but does
not apply. The mobile app polls `/api/version`, surfaces a banner, and lets
the user choose: apply when idle, or force (kills active sessions). The
server then `wget`s `server.tar.gz`, extracts over the install dir, and
exits — systemd respawns it on the new code.

---

## Mobile app (`client/`)

React 18 + Vite + Tailwind + Capacitor 8. No Redux/Zustand — `useState` and
custom hooks. Capacitor plugins: `@capacitor/app` (Android back button),
`@capacitor/push-notifications` (FCM).

Component graph:

```
App
├── UpdateChecker (toast banner — APK update available)
├── LoginScreen (when no token in localStorage)
├── ChatList
│   ├── header (search, usage chip, +)
│   ├── server-update banner (when /api/version.pending is set)
│   ├── search bar
│   ├── pull-to-refresh wrapper
│   ├── chat row × N
│   ├── load-more pagination button
│   ├── NewChatModal     (when +)
│   └── UsageCard + AboutFooter (when chip tapped)
└── ChatView
    ├── header (cwd, status dot, ⋯ menu)
    ├── spawn-progress banner (during init)
    ├── history list (lazy-paginated)
    ├── FileViewer (when a path chip is tapped)
    ├── input bar (📎 paperclip, 📷 camera, text, send)
    │     OR "Resume conversation" button (when proc is cold)
    └── ActionSheet (when ⋯ tapped — model, perm mode, slash cmds)
```

The bundled SVG icon set is hand-rolled in `src/components/Icon.jsx`
(Lucide-style strokes, ~30 icons, no external dep).

### Network paths

* `API_BASE` is set at build time. In dev it's empty (vite proxy handles it);
  in production it's `https://claude.you.tech` so the bundled APK can fetch
  from the right origin (its own origin is `capacitor://localhost`).
* `fetchWithAuth` wraps every API call with the JWT from localStorage. A 401
  clears the token and bounces the user to login.
* The Socket.IO connection passes the JWT in `?jwt=` (URL) for gateway
  routing AND in `auth.token` (handshake payload) so the PC server can pull
  out the deviceToken once the gateway has unwrapped the JWT and forwarded
  the upgrade.

### Pull-to-refresh

Custom touch handlers on the scroll container. Tracks `pullY` based on
finger movement (damped 0.5×), shows a rotating icon overlay, on release
past threshold triggers `refresh()` and animates back.

### Image upload

Two-pass canvas compression: 1280px @ q=0.75 for the actual payload sent to
Claude; 240px @ q=0.6 for the chip + sent-bubble thumbnail. Images are
inlined as `{type:'image', source:{type:'base64', media_type:'image/jpeg',
data:...}}` in the user turn — Claude sees them in the same round-trip, no
intermediate file path or Read tool needed.

---

## Update flow end-to-end

```
You push code:
  /var/www/claude-mobile/server.tar.gz   ← new server tarball
  /var/www/claude-mobile/app.apk          ← new APK
  /var/www/claude-mobile/version.json     ← bump {latest, server}
       │
       ▼
Every PC's auto-update.js (hourly):
  GET /version.json
  if pending.server > local: store pendingUpdate, do NOT apply
       │
       ▼
Every user's app (every minute):
  GET /api/version
  if pending: show blue banner "Server v1.x.y available"
       │
       ▼
User taps banner → "Apply" button
  POST /api/admin/apply-update {force: false}
  server refuses if active chats → user clicks "Force"
  POST /api/admin/apply-update {force: true}
       │
       ▼
Server downloads server.tar.gz, extracts over install dir, exit 0
  systemd respawns it on the new code
       │
       ▼
App reconnects, fetches /api/version again, banner clears
```

The APK side is similar but the user has to manually download the new APK
(Android security) — the banner gives them a direct link.
