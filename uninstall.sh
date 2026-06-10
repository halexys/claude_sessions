#!/bin/bash
# Claude Mobile — Linux uninstaller

set -e

red()   { echo -e "\033[0;31m$*\033[0m"; }
green() { echo -e "\033[0;32m$*\033[0m"; }
bold()  { echo -e "\033[1m$*\033[0m"; }

bold "Claude Mobile — uninstaller"
echo ""
read -rp "Esto eliminara todos los archivos y servicios de Claude Mobile. Continuar? [s/N] " confirm
[[ "$confirm" =~ ^[sS]$ ]] || { echo "Cancelado."; exit 0; }
echo ""

# Stop and disable systemd services
echo "Deteniendo servicios..."
systemctl --user disable --now claude-mobile  2>/dev/null && echo "  claude-mobile: detenido" || echo "  claude-mobile: no estaba activo"
systemctl --user disable --now claude-tunnel  2>/dev/null && echo "  claude-tunnel: detenido" || echo "  claude-tunnel: no estaba activo"
systemctl --user daemon-reload

# Remove install directory
if [[ -d "$HOME/.local/share/claude-mobile" ]]; then
    rm -rf "$HOME/.local/share/claude-mobile"
    echo "  ~/.local/share/claude-mobile: eliminado"
fi

# Remove tunnel script
if [[ -f "$HOME/.local/bin/claude-tunnel.sh" ]]; then
    rm -f "$HOME/.local/bin/claude-tunnel.sh"
    echo "  ~/.local/bin/claude-tunnel.sh: eliminado"
fi

# Remove systemd unit files
rm -f "$HOME/.config/systemd/user/claude-mobile.service" \
      "$HOME/.config/systemd/user/claude-tunnel.service"
echo "  unit files: eliminados"

# Remove SSH tunnel key
if [[ -f "$HOME/.ssh/claude_tunnel" ]]; then
    rm -f "$HOME/.ssh/claude_tunnel" "$HOME/.ssh/claude_tunnel.pub"
    echo "  clave SSH: eliminada"
fi

# Remove hooks
rm -f "$HOME/.claude/hooks/push.sh" "$HOME/.claude/hooks/.hook-secret"
echo "  hooks: eliminados"

# Patch settings.json — remove push.sh entries from Notification and Stop
SETTINGS="$HOME/.claude/settings.json"
if [[ -f "$SETTINGS" ]]; then
    python3 - <<'PYEOF'
import json, os
path = os.path.expanduser('~/.claude/settings.json')
try:
    d = json.load(open(path))
except Exception:
    exit(0)
changed = False
for event in ('Notification', 'Stop'):
    if event not in d:
        continue
    filtered = [e for e in d[event]
                if not any('push.sh' in h.get('command', '') for h in e.get('hooks', []))]
    if len(filtered) != len(d[event]):
        d[event] = filtered
        changed = True
if changed:
    json.dump(d, open(path, 'w'), indent=2)
    print('  settings.json: hooks eliminados')
PYEOF
fi

echo ""
green "Desinstalacion completa."
echo ""
echo "Nota: si quieres revocar el acceso al VPS, usa el panel admin:"
echo "  https://claude.polymitia.tech/admin/"
