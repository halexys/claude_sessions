# Claude Mobile

Mobile control for [Claude Code](https://claude.com/claude-code) running on
your Linux PC. Talk to Claude from anywhere via an Android chat app — files
edited, commands run, and the conversation history all live on **your** PC,
exposed safely to your phone through a VPS reverse-tunnel + per-device JWT auth.

```
┌──────────────┐                   ┌──────────────────────┐                  ┌────────────────────┐
│  Android app │  HTTPS/WSS        │   VPS Gateway        │  SSH -R          │  Your PC           │
│  (Capacitor) │ ◀────────────────▶│  Caddy + Node        │ ◀───────────────▶│  claude-mobile     │
│              │  claude.you.tech  │  claim-invite/login  │  reverse tunnel  │  server + claude   │
│  React chat  │                   │  proxy /api /ws      │  (port 87xx)     │  headless          │
└──────────────┘                   └──────────────────────┘                  └────────────────────┘
```

Each user gets their own tunnel port on the VPS. The gateway routes by
inspecting a JWT that embeds `{deviceToken, tunnelPort}` — stateless.

---

## What's in here

| Path             | What it is                                                                       |
|------------------|----------------------------------------------------------------------------------|
| `gateway/`       | The VPS Node service. Caddy proxies traffic to it. Holds invites + key registry. |
| `server/`        | The Node service that runs on every user's PC. Spawns Claude Code processes.     |
| `client/`        | React+Capacitor app. Built into an APK and served from the VPS.                  |
| `install.sh`     | One-liner installer end-users run on their PC.                                   |
| `deploy/`        | Caddyfile, systemd units, VPS bootstrap notes.                                   |
| `ARCHITECTURE.md`| How the pieces talk: stream-json, JWT routing, WebSocket events.                 |
| `DEPLOY.md`      | Step-by-step bootstrap of a fresh VPS.                                           |
| `SECURITY.md`    | Threat model, what the SSH restrictions buy you, how to rotate.                  |

---

## Quick mental model

1. You own a VPS with a domain (e.g. `claude.you.tech`) and Caddy on 443.
2. You spin up the **gateway** there — a small Node process that owns invites,
   a registry of `passwordHash → tunnelPort`, and SSH `authorized_keys` for
   the `claude-tunnel` user.
3. For every person you want to onboard you run `add-user.sh <name> <port>`
   on the VPS — it issues a single-use invite code.
4. They paste a one-liner into their PC. The installer:
   - Generates an SSH keypair and exchanges it for the invite
   - Sets up two systemd services: `claude-mobile` (their local API + chat
     manager) and `claude-tunnel` (SSH reverse-tunnel to the VPS)
   - Prints them a freshly-minted password
5. They install the APK from `https://claude.you.tech/app.apk`, type that
   password once, and they're in.

When they open a chat, the app talks WebSocket to the gateway, which forwards
through their SSH tunnel to their PC's `claude-mobile`, which spawns a real
`claude --print --input-format stream-json --output-format stream-json` and
proxies the events back as semantic chat events (text, tool_use, tool_result,
turn_done, etc.).

---

## Quick start (for the operator)

You only need to do the VPS side once.

### 1. Bootstrap the VPS

See [`DEPLOY.md`](./DEPLOY.md) for the full version. Short form:

```bash
# Pick a domain (claude.you.tech) and point an A record at the VPS first.
# Then on the VPS as root:

apt install caddy nodejs npm        # or your distro's equivalent (Node ≥ 18)

# 1. Dedicated SSH tunnel user — nologin shell, owns its authorized_keys.
useradd -r -s /usr/sbin/nologin -d /home/claude-tunnel -m claude-tunnel
install -d -o claude-tunnel -g claude-tunnel -m 700 /home/claude-tunnel/.ssh
touch /home/claude-tunnel/.ssh/authorized_keys
chown claude-tunnel: /home/claude-tunnel/.ssh/authorized_keys
chmod 600 /home/claude-tunnel/.ssh/authorized_keys

# 2. Gateway code (clone or copy this repo's gateway/ dir)
git clone https://github.com/YOU/claude-mobile.git /tmp/cm
cp -r /tmp/cm/gateway /home/claude-tunnel/gateway
chown -R claude-tunnel: /home/claude-tunnel/gateway
sudo -u claude-tunnel npm --prefix /home/claude-tunnel/gateway install --omit=dev

# 3. Secrets
sudo -u claude-tunnel cp /home/claude-tunnel/gateway/.env.example /home/claude-tunnel/gateway/.env
sudo -u claude-tunnel nano /home/claude-tunnel/gateway/.env   # fill JWT_SECRET, SETUP_SECRET, VPS_HOST

# 4. systemd unit
cp /tmp/cm/gateway/systemd/claude-gateway.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now claude-gateway

# 5. Caddy
cp /tmp/cm/deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain first
systemctl reload caddy

# 6. Static assets the installer + app expect
mkdir -p /var/www/claude-mobile
cp /tmp/cm/install.sh /var/www/claude-mobile/

# Build server tarball and put it where install.sh expects:
( cd /tmp/cm && tar -czf /var/www/claude-mobile/server.tar.gz \
    --transform 's,^server,claude-mobile,' \
    --exclude node_modules --exclude .env server )

# Build the APK and copy it (done on your dev machine, not the VPS):
#   cd client && npm run build && npx cap sync android \
#     && cd android && ./gradlew assembleDebug
#   scp app/build/outputs/apk/debug/app-debug.apk vps:/var/www/claude-mobile/app.apk
```

### 2. Onboard a user

```bash
ssh root@vps
cd /home/claude-tunnel/gateway
./add-user.sh alice 8769    # next free port, must be unique per user

# It prints a curl one-liner. Send that to Alice. She pastes it into a terminal
# on her Linux PC. The installer prints her password at the end.
```

### 3. They install the APK

From their phone they open `https://claude.you.tech/app.apk`. Android asks
about installing from an unknown source — they accept. The app opens, asks
for the password the installer printed, and that's it.

---

## What the user experience looks like

* **Chat list**: every Claude Code conversation that's ever existed on their PC
  is here, including ones started from the terminal directly. Pull-to-refresh.
  Search bar. A toggle to show or hide "agent" conversations (those spawned
  by skills like `/security-review` via the Claude Agent SDK).
* **Open chat**: shows history paginated from disk (lazy, no API tokens used).
  If the Claude process for this session isn't running, you see a "Resume"
  button — tap once and it spawns Claude with `--resume <id>`.
* **Send**: typed text + optional images (gallery or camera). Images are
  compressed in-browser to 1280px JPEG q=0.75, included as native
  `{type:'image'}` content blocks — Claude sees the image in the same turn.
* **Tool calls**: rendered as collapsible cards (Bash, Read, Edit, Write, etc).
  File paths Claude mentions are turned into "view" buttons that open the file
  in a modal (markdown gets rendered).
* **Settings sheet** (`⋯`): change model mid-chat, toggle permissions
  (`bypassPermissions` ↔ `plan`), trigger slash commands, close the process
  to free RAM.
* **Push notifications**: a Claude Code hook on the PC POSTs to the local
  server, which sends an FCM push to your device when Claude finishes a turn
  or asks a question.
* **Updates**: server checks the VPS hourly for a newer version; the app shows
  a banner and the user clicks "Apply" when they're ready (refuses if any
  chat is active, unless you force it).

---

## Development

The three pieces have independent npm projects.

```bash
# Gateway (runs on your dev machine for testing)
cd gateway
npm install
PORT=3000 JWT_SECRET=dev SETUP_SECRET=dev VPS_HOST=localhost node gateway.js

# PC server
cd server
npm install
PORT=3001 AUTH_TOKEN=devpass node index.js

# Mobile app
cd client
npm install
npm run dev    # http://localhost:5173, vite proxies /api → :3001
```

For Android builds: `npm run build && npx cap sync android` then
`cd android && JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew assembleDebug`.

---

## Why this exists

Claude Code is a TUI. Wrapping a terminal emulator on a phone is bad UX:
broken scroll, awkward keyboard, no markdown. This project replaces the
terminal with a real chat — same Claude Code underneath (full hooks, MCP,
plugins, skills) but rendered as messages.

The hard part wasn't the UI. It was figuring out how stream-json behaves
(`--print` keeps the process alive across turns if you don't close stdin,
`system/init` only fires on the first user turn, async hooks emit
`hook_progress` AFTER init, etc.) — see `ARCHITECTURE.md`.

---

## License

MIT. See [`LICENSE`](./LICENSE).
