#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "Installing dependencies..."
cd server && npm install && cd ..
cd client && npm install && npm run build && cd ..
echo "Build complete. Run ./start.sh to launch."
