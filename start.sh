#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi
echo "Starting LeadGen on http://localhost:3001 (set HOST=0.0.0.0 to open it to your network)"
node server.js
