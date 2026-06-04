#!/bin/bash
# Claude Mobile — PC installer
# Usage: curl -fsSL https://claude.example.com/install.sh | bash -s -- <invite-code>

set -e

GATEWAY="https://claude.example.com"
SERVICE_NAME="claude-mobile"
TUNNEL_SERVICE="claude-tunnel"
INSTALL_DIR="$HOME/.local/share/claude-mobile"
BIN_DIR="$HOME/.local/bin"
SYSTEMD_DIR="$HOME/.config/systemd/user"

# ── helpers ───────────────────────────────────────────────────────────────────
red()   { echo -e "\033[0;31m$*\033[0m"; }
green() { echo -e "\033[0;32m$*\033[0m"; }
bold()  { echo -e "\033[1m$*\033[0m"; }
die()   { red "Error: $*"; exit 1; }

INVITE="${1:-}"

# ── hooks-only mode ───────────────────────────────────────────────────────────
if [[ "$INVITE" == "--hooks-only" ]]; then
  bold "Configurando hooks de notificaciones..."
  INSTALL_DIR="$HOME/.local/share/claude-mobile"
  SETUP_SECRET=$(grep "^SETUP_SECRET=" "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2)
  if [[ -n "$SETUP_SECRET" ]]; then
    mkdir -p "$INSTALL_DIR"
    # Update server to latest version
    curl -fsSL "$GATEWAY/server.tar.gz" -o /tmp/claude-mobile-server.tar.gz \
      && tar -xzf /tmp/claude-mobile-server.tar.gz -C "$INSTALL_DIR" --strip-components=1 \
      && rm /tmp/claude-mobile-server.tar.gz
    # Download Firebase config
    curl -fsSL "$GATEWAY/firebase-config" \
      -H "X-Setup-Secret: $SETUP_SECRET" \
      -o "$INSTALL_DIR/firebase-service-account.json"
    systemctl --user restart claude-mobile 2>/dev/null || true
    sleep 2
  else
    echo "  (sin SETUP_SECRET en $INSTALL_DIR/.env)"
  fi
  mkdir -p "$HOME/.claude/hooks"
  cat > "$HOME/.claude/hooks/push.sh" <<'HOOK'
#!/bin/bash
SECRET=$(cat ~/.claude/hooks/.hook-secret 2>/dev/null)
DATA=$(cat)
curl -s -X POST "http://localhost:3001/api/hook/$1" \
  -H "Content-Type: application/json" \
  -H "X-Hook-Secret: $SECRET" \
  --data-raw "$DATA" > /dev/null 2>&1
exit 0
HOOK
  chmod +x "$HOME/.claude/hooks/push.sh"
  python3 - <<PYEOF
import json, os
path = os.path.expanduser('~/.claude/settings.json')
try:
    d = json.load(open(path))
except:
    d = {}
cmd = os.path.expanduser('~/.claude/hooks/push.sh')
for event in ('Notification', 'Stop'):
    existing = d.get(event, [])
    already = any(any(h.get('command','').startswith(cmd) for h in e.get('hooks',[])) for e in existing)
    if not already:
        d[event] = existing + [{'hooks': [{'type': 'command', 'command': f'{cmd} {event}'}]}]
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(d, open(path, 'w'), indent=2)
PYEOF
  green "✓ Hooks configurados. Las notificaciones ya funcionan."
  exit 0
fi

if [[ -z "$INVITE" ]]; then
  die "Invite code required.\n\n  Usage: curl -fsSL $GATEWAY/install.sh | bash -s -- <invite-code>"
fi

bold "Claude Mobile — installer"
echo ""

# ── check prerequisites ───────────────────────────────────────────────────────
echo "Checking prerequisites..."

command -v node  >/dev/null 2>&1 || die "Node.js not found. Install it first: https://nodejs.org"
command -v ssh   >/dev/null 2>&1 || die "SSH client not found. Install openssh-client."
command -v curl  >/dev/null 2>&1 || die "curl not found."
command -v systemctl >/dev/null 2>&1 || die "systemd not found. This installer requires systemd."

NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
(( NODE_VER >= 18 )) || die "Node.js 18+ required (found v$NODE_VER)."

echo "  node $(node --version)  ssh ok  systemd ok"

# ── SSH keypair for tunnel ────────────────────────────────────────────────────
SSH_KEY="$HOME/.ssh/claude_tunnel"
if [[ ! -f "$SSH_KEY" ]]; then
  echo "Generating SSH key for tunnel..."
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  ssh-keygen -t ed25519 -C "claude-tunnel" -N "" -f "$SSH_KEY" -q
fi
PUB_KEY=$(cat "$SSH_KEY.pub")
HOSTNAME=$(hostname)

# ── Claim invite on gateway ───────────────────────────────────────────────────
echo "Claiming invite code..."
CLAIM=$(curl -fsSL -X POST "$GATEWAY/claim-invite" \
  -H "Content-Type: application/json" \
  -d "{\"invite\":\"$INVITE\",\"sshPubKey\":$(python3 -c "import json,sys; print(json.dumps(open('$SSH_KEY.pub').read().strip()))"),\"hostname\":\"$HOSTNAME\"}" \
  2>&1) || die "Could not reach gateway: $CLAIM"

# Parse JSON response
TUNNEL_PORT=$(echo "$CLAIM" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['tunnelPort'])" 2>/dev/null) \
  || die "Gateway returned an error: $CLAIM"
VPS_HOST=$(echo "$CLAIM"    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['vpsHost'])" 2>/dev/null)
SETUP_SECRET=$(echo "$CLAIM" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['setupSecret'])" 2>/dev/null)
# tunnelUser: new field. Fall back to 'root' so we still work against an old gateway.
TUNNEL_USER=$(echo "$CLAIM" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tunnelUser','root'))" 2>/dev/null)
TUNNEL_USER=${TUNNEL_USER:-root}

echo "  Assigned tunnel port: $TUNNEL_PORT (as $TUNNEL_USER@$VPS_HOST)"

# ── Generate AUTH_TOKEN (password for this installation) ─────────────────────
AUTH_TOKEN=$(openssl rand -hex 16)

# ── Download and install server ───────────────────────────────────────────────
echo "Downloading server..."
mkdir -p "$INSTALL_DIR"
curl -fsSL "$GATEWAY/server.tar.gz" -o /tmp/claude-mobile-server.tar.gz \
  || die "Failed to download server bundle."

tar -xzf /tmp/claude-mobile-server.tar.gz -C "$INSTALL_DIR" --strip-components=1
rm /tmp/claude-mobile-server.tar.gz

echo "Installing npm dependencies..."
(cd "$INSTALL_DIR" && npm install --omit=dev --silent)

# Download Firebase service account (needed for push notifications)
curl -fsSL "$GATEWAY/firebase-config" \
  -H "X-Setup-Secret: $SETUP_SECRET" \
  -o "$INSTALL_DIR/firebase-service-account.json" 2>/dev/null \
  && echo "  push notifications: ok" \
  || echo "  push notifications: skipped (no firebase config)"

# ── Write .env ────────────────────────────────────────────────────────────────
cat > "$INSTALL_DIR/.env" <<ENV
PORT=3001
AUTH_TOKEN=$AUTH_TOKEN
GATEWAY_URL=$GATEWAY
SETUP_SECRET=$SETUP_SECRET
TUNNEL_PORT=$TUNNEL_PORT
ENV
chmod 600 "$INSTALL_DIR/.env"

# ── SSH tunnel wrapper script ─────────────────────────────────────────────────
# Note: the tunnel user is `claude-tunnel` with nologin shell. We can't run
# remote commands anymore (and don't need to — ExitOnForwardFailure handles
# stale ports by failing the connect, then systemd restarts).
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/claude-tunnel.sh" <<TUNNEL
#!/bin/bash
exec ssh -N -i "$SSH_KEY" \\
    -o ServerAliveInterval=5 -o ServerAliveCountMax=2 \\
    -o ExitOnForwardFailure=yes -o ConnectTimeout=10 \\
    -o StrictHostKeyChecking=no -o TCPKeepAlive=yes \\
    -R ${TUNNEL_PORT}:localhost:3001 "${TUNNEL_USER}@${VPS_HOST}"
TUNNEL
chmod +x "$BIN_DIR/claude-tunnel.sh"

# ── systemd services ──────────────────────────────────────────────────────────
mkdir -p "$SYSTEMD_DIR"

# Resolve the actual node binary. systemd has a stripped PATH so we can't rely
# on bare `node` — and many users install via fnm/nvm where /usr/bin/node
# doesn't exist at all.
NODE_BIN=$(command -v node)
[[ -x "$NODE_BIN" ]] || die "Couldn't locate node binary"

cat > "$SYSTEMD_DIR/$SERVICE_NAME.service" <<SVC
[Unit]
Description=Claude Mobile Server
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN index.js
Restart=always
RestartSec=3
EnvironmentFile=$INSTALL_DIR/.env

[Install]
WantedBy=default.target
SVC

cat > "$SYSTEMD_DIR/$TUNNEL_SERVICE.service" <<SVC
[Unit]
Description=Claude SSH Tunnel
After=network.target $SERVICE_NAME.service
Wants=$SERVICE_NAME.service

[Service]
ExecStart=$BIN_DIR/claude-tunnel.sh
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
SVC

# ── Enable and start ──────────────────────────────────────────────────────────
echo "Starting services..."
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"
systemctl --user enable --now "$TUNNEL_SERVICE"

# Enable lingering so services survive logout
loginctl enable-linger "$USER" 2>/dev/null || true

# ── Claude Code hooks for push notifications ──────────────────────────────────
echo "Configuring Claude Code hooks..."

# Wait for server to generate .hook-secret
HOOK_SECRET_FILE="$HOME/.claude/hooks/.hook-secret"
for i in $(seq 1 10); do
  [[ -f "$HOOK_SECRET_FILE" ]] && break
  sleep 1
done

mkdir -p "$HOME/.claude/hooks"

cat > "$HOME/.claude/hooks/push.sh" <<'HOOK'
#!/bin/bash
SECRET=$(cat ~/.claude/hooks/.hook-secret 2>/dev/null)
DATA=$(cat)
curl -s -X POST "http://localhost:3001/api/hook/$1" \
  -H "Content-Type: application/json" \
  -H "X-Hook-Secret: $SECRET" \
  --data-raw "$DATA" > /dev/null 2>&1
exit 0
HOOK
chmod +x "$HOME/.claude/hooks/push.sh"

# Add Notification and Stop hooks to ~/.claude/settings.json
SETTINGS="$HOME/.claude/settings.json"
python3 - <<PYEOF
import json, os
path = os.path.expanduser('$SETTINGS')
try:
    d = json.load(open(path))
except:
    d = {}
hook_cmd = os.path.expanduser('~/.claude/hooks/push.sh')
for event in ('Notification', 'Stop'):
    entry = {'hooks': [{'type': 'command', 'command': f'{hook_cmd} {event}'}]}
    existing = d.get(event, [])
    # Don't duplicate
    already = any(
        any(h.get('command','').startswith(hook_cmd) for h in e.get('hooks',[]))
        for e in existing
    )
    if not already:
        d[event] = existing + [entry]
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(d, open(path, 'w'), indent=2)
print('hooks configured')
PYEOF

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
green "✓ Installation complete!"
echo ""
bold "Your access password:"
echo ""
echo "  $AUTH_TOKEN"
echo ""
echo "Enter this password in the Claude Mobile app to connect."
echo "Keep it safe — you'll need it on each new device."
echo ""
echo "Service status:"
systemctl --user status "$SERVICE_NAME" --no-pager -l 2>/dev/null | grep -E "Active:|running" | head -3 || true
systemctl --user status "$TUNNEL_SERVICE" --no-pager -l 2>/dev/null | grep -E "Active:|running" | head -3 || true
