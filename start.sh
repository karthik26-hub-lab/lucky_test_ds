#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Download the LTS version from https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
node server.js --open
