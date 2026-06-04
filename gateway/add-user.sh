#!/bin/bash
# add-user.sh — run on VPS as root to create an invite code for a new user
# Usage: ./add-user.sh <username> <tunnel-port>
# Example: ./add-user.sh alice 8766

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INVITES_FILE="$SCRIPT_DIR/invites.json"

USERNAME="${1:-}"
PORT="${2:-}"

if [[ -z "$USERNAME" || -z "$PORT" ]]; then
  echo "Usage: $0 <username> <tunnel-port>"
  echo "  username    — identifier for this user (e.g. alice)"
  echo "  tunnel-port — unique SSH reverse-tunnel port (e.g. 8766)"
  exit 1
fi

# Validate port is a number in a reasonable range
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
  echo "Error: tunnel-port must be a number between 1024 and 65535"
  exit 1
fi

# Check the port isn't already in use in invites.json
if [[ -f "$INVITES_FILE" ]]; then
  EXISTING=$(python3 -c "
import json, sys
data = json.load(open('$INVITES_FILE'))
ports = [v['tunnelPort'] for v in data.values()]
print('yes' if $PORT in ports else 'no')
" 2>/dev/null || echo "no")
  if [[ "$EXISTING" == "yes" ]]; then
    echo "Error: port $PORT is already assigned to another user"
    exit 1
  fi
fi

# Generate a random invite code
INVITE=$(openssl rand -hex 12)

# Add to invites.json
if [[ ! -f "$INVITES_FILE" ]]; then
  echo '{}' > "$INVITES_FILE"
fi

python3 - <<PYEOF
import json, sys
path = '$INVITES_FILE'
data = json.load(open(path))
data['$INVITE'] = {
    'username': '$USERNAME',
    'tunnelPort': $PORT,
    'used': False,
    'createdAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z'
}
json.dump(data, open(path, 'w'), indent=2)
print('saved')
PYEOF

echo ""
echo "✓ Invite created for user: $USERNAME (port $PORT)"
echo ""
echo "  Invite code : $INVITE"
echo "  Tunnel port : $PORT"
echo ""
echo "Share this one-liner with $USERNAME:"
echo ""
echo "  curl -fsSL https://claude.example.com/install.sh | bash -s -- $INVITE"
echo ""
