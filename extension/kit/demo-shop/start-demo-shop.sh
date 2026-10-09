#!/bin/bash
# Linux: start the Northwind Gear demo shop (./start-demo-shop.sh). Ctrl+C stops it.
cd "$(dirname "$0")" || exit 1
PORT="${1:-5173}"
if command -v node >/dev/null 2>&1; then RUN=(node server.mjs "$PORT")
elif command -v python3 >/dev/null 2>&1; then RUN=(python3 server.py "$PORT")
else
  echo "The demo shop needs Node.js (https://nodejs.org, LTS) or Python 3."
  exit 1
fi
( sleep 1; xdg-open "http://localhost:$PORT/" >/dev/null 2>&1 ) &
"${RUN[@]}"
