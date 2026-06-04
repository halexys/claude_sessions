#!/bin/bash
set -e
cd "$(dirname "$0")"

# Build frontend if dist doesn't exist
if [ ! -d client/dist ]; then
  echo "Building frontend..."
  cd client && npm install && npm run build && cd ..
fi

# Install server deps if needed
if [ ! -d server/node_modules ]; then
  echo "Installing server dependencies..."
  cd server && npm install && cd ..
fi

echo "Starting Claude Mobile on port 3001..."
cd server && node index.js
