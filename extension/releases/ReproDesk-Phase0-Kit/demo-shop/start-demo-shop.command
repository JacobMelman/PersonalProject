#!/bin/bash
# macOS: double-click to start the Northwind Gear demo shop. Close this window to stop it.
cd "$(dirname "$0")" || exit 1
PORT="${1:-5173}"
if command -v node >/dev/null 2>&1; then RUN=(node server.mjs "$PORT")
elif command -v python3 >/dev/null 2>&1; then RUN=(python3 server.py "$PORT")
else
  echo "The demo shop needs Node.js (https://nodejs.org, LTS) or Python 3."
  read -r -p "Press Enter to close."
  exit 1
fi
( sleep 1; open "http://localhost:$PORT/" ) &
"${RUN[@]}"
