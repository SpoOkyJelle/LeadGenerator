#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi
echo "LeadGen running at http://$(hostname -I | awk '{print $1}'):3001"
node server.js
