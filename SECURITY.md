# Security model

What this design protects against, what it doesn't, and how to rotate.

## Trust boundaries

| Boundary                       | Trust                                                                        |
|--------------------------------|------------------------------------------------------------------------------|
| Mobile device ↔ gateway        | TLS via Caddy + per-device JWT signed with `JWT_SECRET`                      |
| Gateway ↔ PC                   | SSH reverse tunnel (ed25519), restricted to one port-forward                 |
| Gateway → PC HTTP              | Bearer token (the unwrapped `deviceToken` from inside the JWT)              |
| PC ↔ Claude process            | Direct child process. Same user. No network involved.                        |
| PC server ↔ gateway (`/setup`) | `X-Setup-Secret` shared secret                                              |
| Claude Code hooks → PC server  | A hook-secret file at `~/.claude/hooks/.hook-secret`, mode 0600, same user   |

The gateway is the only public-internet attack surface. The PCs only accept
SSH on the loopback side of the tunnel — their `:3001` is never exposed.

## SSH hardening

Every accepted public key in `/home/claude-tunnel/.ssh/authorized_keys`
looks like this:

```
restrict,port-forwarding,permitopen="localhost:8769" ssh-ed25519 AAAA… # alice@host
```

* `restrict` — turns off everything: PTY, exec, X11, agent forwarding,
  local forwarding, tunneling.
* `port-forwarding` — explicitly re-enables JUST port forwarding.
* `permitopen="localhost:<port>"` — locks that forwarding to exactly one
  destination. A user authorized for port 8769 cannot forward to any other
  port, can't connect through to other PCs sharing the tunnel host.

The tunnel user is `claude-tunnel`, login shell `/usr/sbin/nologin`. So
even hypothetically — if `restrict` were bypassed by some sshd bug — there
is no shell to drop into. The user can't `cd`, `ls`, anything.

## JWT structure

The mobile login flow returns a token like:

```
eyJ...{
  "deviceToken": "<unique per-device, opaque to gateway>",
  "tunnelPort":  8769,
  "iat": ...,
  "exp": ...   // 90 d
}.<sig>
```

`tunnelPort` is the routing key. The gateway never has to hit
`registry.json` per-request — it reads the port from the JWT, validates the
signature with `JWT_SECRET`, and proxies straight to
`http://localhost:<tunnelPort>` over the tunnel.

`deviceToken` is what the PC's server recognizes. The PC's server has its
own table of `(tokenHash, deviceName, registeredAt)` — see
`server/devices.json`. A stolen JWT works until the user revokes that
device from their PC (or the 90-day expiry kicks in).

## Password storage

* PC keeps the user-readable password (`AUTH_TOKEN`) in
  `~/.local/share/claude-mobile/.env` (mode 600).
* Gateway only ever sees `sha256(password)` — it lives in `registry.json`
  on the VPS. Stolen registry.json doesn't reveal passwords (would need to
  brute force per entry).

When the PC restarts, it re-registers with the gateway. The `/setup`
endpoint **purges old hashes for the same pcId** so password reset
invalidates the previous password immediately — no race window.

## Per-device tokens

The mobile app stores the JWT in `localStorage`. The PC's `/api/auth/register`
endpoint generates a 32-byte random token, hashes it, and stores
`{tokenHash, deviceId, deviceName, registeredAt}` in `server/devices.json`.
The full token is wrapped in the gateway JWT and only ever lives client-side
afterwards.

Revoking a device:

```bash
# On the PC
python3 -c "
import json
p = '/home/$USER/.local/share/claude-mobile/devices.json'
d = json.load(open(p))
d = [x for x in d if x['deviceName'] != 'Android']
json.dump(d, open(p, 'w'), indent=2)
" && systemctl --user restart claude-mobile
```

Or via the in-app UI (not yet wired — TODO).

## Hook secret

`~/.claude/hooks/.hook-secret` (mode 0600) is shared between:

* The Claude Code hooks (`~/.claude/hooks/push.sh`)
* The PC server (`server/index.js`)

The hooks POST `/api/hook/<event>` with `X-Hook-Secret: <secret>`. Without
this gate, anyone reaching localhost:3001 could send fake notifications.

## Firebase admin JSON

Lives at `/var/www/claude-mobile/firebase-service-account.json` on the VPS.
The HTTP route that serves it (`/firebase-config`) requires the
`X-Setup-Secret` header so only the installer (which has it from
`/claim-invite`) can download it. Once on the PC, it lives at
`~/.local/share/claude-mobile/firebase-service-account.json` mode 600.

## Threat model — what's NOT protected

* **PC compromise.** If someone roots a user's PC, they have everything:
  Claude's OAuth tokens (`~/.claude/.credentials.json`), every chat JSONL,
  the user's `AUTH_TOKEN`, the SSH private key for the tunnel. Nothing in
  this design helps.
* **VPS compromise.** Someone with root on the VPS can read `JWT_SECRET` /
  `SETUP_SECRET` from `gateway/.env`, mint JWTs for any registered user,
  modify the gateway code to log passwords as they flow through `/login`,
  and SSH-jump to any user's PC via their tunnel. **Lock down the VPS.**
* **Stolen device.** If a phone is lost while logged in, the attacker has
  full chat access until the user revokes it from their PC or the JWT
  expires (90 d). Mitigation: an app PIN/biometric lock is on the TODO.
* **Replay of an old version.** Until the user updates the APK,
  vulnerabilities in older app versions stay exploitable — the
  `minSupported` field in version.json is advisory only (today nothing
  enforces it).
* **Path-traversal in `/api/read-file`.** The gateway validates that
  resolved paths start with `HOME`, which prevents `..`-escapes but
  follows symlinks. If a user has a symlink in their HOME pointing to
  `/etc`, the app can read `/etc` files. Acceptable since the user
  themselves created any such symlink — but worth knowing.

## Rotation

### Rotating `JWT_SECRET`

Every existing device JWT becomes invalid. Each user has to re-login (type
their password again).

```bash
ssh root@vps 'sudo -u claude-tunnel sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" /home/claude-tunnel/gateway/.env && systemctl restart claude-gateway'
```

### Rotating `SETUP_SECRET`

Every existing PC has the old secret in its `.env`. After rotation, none of
them can re-register on restart (`/setup` rejects), but already-registered
ones keep working through their JWT-routed tunnel. To fully rotate, each PC
needs its `.env` updated too — easiest is reinstall.

### Rotating a tunnel SSH key

```bash
# On the user's PC
rm ~/.ssh/claude_tunnel ~/.ssh/claude_tunnel.pub
ssh-keygen -t ed25519 -C claude-tunnel -N '' -f ~/.ssh/claude_tunnel -q

# On the VPS — remove the old line and add the new key (you'd need to
# manually edit /home/claude-tunnel/.ssh/authorized_keys), then restart
# claude-tunnel on the PC.
```

Simpler: full reinstall with a new invite.

## What we deliberately do NOT log

* Passwords (only their sha256)
* Device tokens (only sha256, in `devices.json`)
* Chat content (the JSONL is logged by Claude Code itself, but the gateway
  never sees plaintext — it's all inside the tunnel)
