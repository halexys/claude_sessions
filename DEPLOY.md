# Deployment

Step-by-step for bringing up a fresh Claude Mobile gateway from scratch.

Prereqs:

- A VPS with a public IP and a domain pointing at it (e.g. `claude.you.tech`)
- Root SSH on the VPS
- A dev machine with Node 18+ and Android SDK (Java 21) for APK builds

---

## 1. VPS: install dependencies

```bash
# Debian / Ubuntu
sudo apt update
sudo apt install -y caddy curl git python3
# Node 20 (or fnm/nvm if you prefer)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs
```

Verify:

```bash
node --version  # ≥ 18
caddy version
sshd -t
```

---

## 2. VPS: create the `claude-tunnel` user

This user receives all SSH reverse-tunnels from end-user PCs and owns the
gateway's `authorized_keys` file. Its login shell is `/usr/sbin/nologin`,
so even if `restrict,port-forwarding` failed in the authorized_keys line
(it doesn't — but defense in depth), nobody could get a shell.

```bash
sudo useradd -r -s /usr/sbin/nologin -d /home/claude-tunnel -m claude-tunnel
sudo install -d -o claude-tunnel -g claude-tunnel -m 700 /home/claude-tunnel/.ssh
sudo touch /home/claude-tunnel/.ssh/authorized_keys
sudo chown claude-tunnel: /home/claude-tunnel/.ssh/authorized_keys
sudo chmod 600 /home/claude-tunnel/.ssh/authorized_keys
```

---

## 3. VPS: deploy the gateway code

```bash
# Clone or scp the repo to the VPS, then:
sudo cp -r path/to/repo/gateway /home/claude-tunnel/gateway
sudo chown -R claude-tunnel: /home/claude-tunnel/gateway

# Install Node deps as the unprivileged user
sudo -u claude-tunnel npm --prefix /home/claude-tunnel/gateway install --omit=dev
```

Create the gateway `.env`:

```bash
sudo -u claude-tunnel cp \
  /home/claude-tunnel/gateway/.env.example \
  /home/claude-tunnel/gateway/.env

# Edit it
sudo -u claude-tunnel nano /home/claude-tunnel/gateway/.env
```

Fill in:

```
JWT_SECRET=<openssl rand -hex 32>
SETUP_SECRET=<openssl rand -hex 32>
VPS_HOST=<your VPS public IP or hostname>
PORT=3000
```

Both secrets must be stable forever — rotating them invalidates every
device token and every PC's registration.

---

## 4. VPS: systemd unit

```bash
sudo cp /home/claude-tunnel/gateway/systemd/claude-gateway.service \
       /etc/systemd/system/claude-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now claude-gateway
sudo systemctl status claude-gateway        # should say active (running)
sudo journalctl -u claude-gateway -f        # tail logs in another shell
```

---

## 5. VPS: Caddy

The Caddyfile in this repo (`deploy/Caddyfile`) is a template. Edit the
domain at the top, then:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
# (or include it from your existing /etc/caddy/Caddyfile)
sudo systemctl reload caddy
```

Caddy will auto-provision Let's Encrypt certs. First request to your domain
may take a few seconds while that happens. Visit
`https://claude.you.tech/install.sh` once it's up — you should see the
installer script returned as text.

---

## 6. VPS: static assets directory

The Caddyfile serves these from `/var/www/claude-mobile/`:

| File                | Purpose                                                                |
|---------------------|------------------------------------------------------------------------|
| `install.sh`        | The one-liner installer end-users curl                                 |
| `server.tar.gz`     | Tarball of `server/` — installer downloads and extracts on user's PC   |
| `app.apk`           | The Android build                                                      |
| `version.json`      | Latest APK + server versions; auto-update polls this                   |
| `firebase-service-account.json` | (Optional) for push notifications — gated behind `X-Setup-Secret` |
| `index.html` + assets | React app bundle (`client/dist/` contents)                           |

Initial seeding:

```bash
sudo mkdir -p /var/www/claude-mobile
sudo cp /path/to/repo/install.sh /var/www/claude-mobile/

# Build the server tarball (transform makes the inner dir name "claude-mobile"
# so install.sh's --strip-components=1 lines up)
( cd /path/to/repo && tar -czf /tmp/server.tar.gz \
    --transform 's,^server,claude-mobile,' \
    --exclude node_modules --exclude .env --exclude devices.json \
    --exclude push-tokens.json --exclude '*.log' \
    server )
sudo cp /tmp/server.tar.gz /var/www/claude-mobile/

# Seed version.json — match these to the package.json versions
cat <<JSON | sudo tee /var/www/claude-mobile/version.json
{
  "latest": "1.0.0",
  "apkUrl": "https://claude.you.tech/app.apk",
  "releaseNotes": "Initial release",
  "minSupported": "1.0.0",
  "server": "1.0.0",
  "serverUrl": "https://claude.you.tech/server.tar.gz"
}
JSON

# (Optional) Firebase service account JSON for push notifications
sudo cp firebase-admin-credentials.json /var/www/claude-mobile/firebase-service-account.json
```

The APK comes from the client build below.

---

## 7. Dev machine: build the React app + APK

```bash
cd path/to/repo/client
npm install
npm run build         # writes dist/

# Ship the web bundle (also served as the in-app web view)
rsync -av dist/ root@vps:/var/www/claude-mobile/ \
  --exclude install.sh --exclude server.tar.gz \
  --exclude app.apk --exclude version.json

# Build APK
npx cap sync android
cd android
JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew assembleDebug
scp app/build/outputs/apk/debug/app-debug.apk root@vps:/var/www/claude-mobile/app.apk
```

Bump `client/package.json` `"version"` on every release — the in-app
`__APP_VERSION__` macro reads it at build time, and the auto-update banner
compares against `version.json`.

---

## 8. Onboard a user

```bash
ssh root@vps -t 'cd /home/claude-tunnel/gateway && sudo -u claude-tunnel ./add-user.sh alice 8769'
```

`add-user.sh` validates the port isn't taken (in invites.json), generates a
24-char invite code, persists it, and prints:

```
  curl -fsSL https://claude.you.tech/install.sh | bash -s -- abcdef123…
```

Send that to Alice. On her Linux PC, that one-liner:

1. Generates an SSH ed25519 keypair at `~/.ssh/claude_tunnel{,.pub}`
2. `POST /claim-invite` with her pubkey + hostname — gateway adds the line
   to `authorized_keys` with `permitopen="localhost:8769"`
3. Downloads `server.tar.gz`, extracts to `~/.local/share/claude-mobile/`
4. `npm install --omit=dev` in that dir
5. Downloads `firebase-service-account.json` (gated by `X-Setup-Secret`)
6. Writes `~/.local/share/claude-mobile/.env` with the new random `AUTH_TOKEN`
7. Drops two systemd user units:
   - `claude-mobile` — the local Node server on `:3001`
   - `claude-tunnel` — `ssh -N -R 8769:localhost:3001 claude-tunnel@vps`
8. Enables `loginctl enable-linger` so the services survive logout
9. Wires up Claude Code hooks (`~/.claude/hooks/push.sh` and
   `~/.claude/settings.json`) for push notifications
10. Prints her `AUTH_TOKEN` — that's the password she types in the app

She installs `app.apk` from `https://claude.you.tech/app.apk`, types the
password, done.

---

## 9. Updating

### Updating the server tarball

```bash
( cd /path/to/repo && tar -czf /tmp/server.tar.gz \
    --transform 's,^server,claude-mobile,' \
    --exclude node_modules --exclude .env --exclude devices.json \
    --exclude push-tokens.json server )
scp /tmp/server.tar.gz root@vps:/var/www/claude-mobile/server.tar.gz

# Bump version.json — the "server" field
ssh root@vps 'python3 -c "
import json
p = \"/var/www/claude-mobile/version.json\"
d = json.load(open(p))
d[\"server\"] = \"1.2.0\"
d[\"releaseNotes\"] = \"What changed\"
json.dump(d, open(p, \"w\"), indent=2)
"'
```

Within an hour every PC notices and shows their user a banner. The user
clicks "Apply" when they're ready (or "Force" to kill active sessions and
update immediately). The gateway is **not** restarted — only the per-user
servers.

### Updating the gateway itself

```bash
scp gateway/gateway.js root@vps:/home/claude-tunnel/gateway/
ssh root@vps 'chown claude-tunnel: /home/claude-tunnel/gateway/gateway.js
              systemctl restart claude-gateway'
```

This drops any in-flight WebSocket — clients reconnect automatically. There
is no auto-update for the gateway since it's a one-machine deploy you
control directly.

### Updating the APK

```bash
cd client
npm version patch       # or minor/major
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
scp app/build/outputs/apk/debug/app-debug.apk root@vps:/var/www/claude-mobile/app.apk

# Bump version.json "latest"
ssh root@vps 'python3 -c "
import json
p = \"/var/www/claude-mobile/version.json\"
d = json.load(open(p))
d[\"latest\"] = \"1.3.0\"
d[\"releaseNotes\"] = \"What changed\"
json.dump(d, open(p, \"w\"), indent=2)
"'
```

Each device sees an in-app banner with a direct download link. No
auto-install — Android security.

---

## Troubleshooting

### "Contraseña incorrecta" right after install

The PC's `claude-mobile` service either didn't start or couldn't reach the
gateway. Check on the PC:

```bash
systemctl --user status claude-mobile
journalctl --user -u claude-mobile -n 40 --no-pager
```

The most common cause is **node not at `/usr/bin/node`** (fnm/nvm/asdf
users). The installer in this repo resolves `command -v node` at install
time, but if the user is on an older installer they may need:

```bash
NODE=$(command -v node) && \
  sed -i "s|ExecStart=/usr/bin/node|ExecStart=$NODE|" \
    ~/.config/systemd/user/claude-mobile.service && \
  systemctl --user daemon-reload && \
  systemctl --user restart claude-mobile
```

Second most common: the gateway returned `vpsHost` that the PC can't reach
(firewall on port 22, or wrong IP in `.env`). Try the `claude-tunnel`
service:

```bash
systemctl --user status claude-tunnel
```

### Banner stuck on "Hook: SessionStart:resume"

Plugin hooks (especially the context-mode plugin) declare themselves
`async` with up to 3 min of timeout. The mobile UI auto-clears the banner
after 30 s, and any chat event from claude after that also clears it. If
it's stuck longer, check `journalctl --user -u claude-mobile` for `[chat]`
errors.

### Reset a user's password

```bash
# On their PC
NEW=$(openssl rand -hex 16) && \
  sed -i "s/^AUTH_TOKEN=.*/AUTH_TOKEN=$NEW/" \
    ~/.local/share/claude-mobile/.env && \
  systemctl --user restart claude-mobile && \
  echo "New password: $NEW"
```

The server re-registers with the gateway on startup, and the gateway's
`/setup` handler purges any other passwordHash entries with the same
`pcId`, so the old password stops working.

### Re-issue an invite (full reinstall)

If a user lost their AUTH_TOKEN, password, or wants a clean slate:

```bash
# On the VPS — remove any previous invite for that user
ssh root@vps "python3 -c '
import json
p = \"/home/claude-tunnel/gateway/invites.json\"
d = json.load(open(p))
d = {k: v for k, v in d.items() if v.get(\"username\") != \"alice\"}
json.dump(d, open(p, \"w\"), indent=2)
'"

# Generate a new invite
ssh root@vps 'cd /home/claude-tunnel/gateway && sudo -u claude-tunnel ./add-user.sh alice 8769'
```

Send the user this reinstall command (their port stays the same):

```bash
systemctl --user stop claude-mobile claude-tunnel 2>/dev/null
rm -rf ~/.local/share/claude-mobile ~/.ssh/claude_tunnel ~/.ssh/claude_tunnel.pub
curl -fsSL https://claude.you.tech/install.sh | bash -s -- <NEW_INVITE_CODE>
```
