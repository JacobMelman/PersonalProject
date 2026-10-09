#!/usr/bin/env python3
"""Northwind Gear, the demo shop for ReproDesk, for machines with Python 3 but no Node.js.

Usage: python3 server.py [port]   ->  http://localhost:5173/   (Ctrl+C stops it)
"""
import http.server
import os
import sys
from urllib.parse import unquote, urlsplit

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 5173))


class Shop(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        # The shop is a single page: fonts are real files, every other path gets index.html (the page routes itself).
        p = unquote(urlsplit(self.path).path)
        f = os.path.realpath(os.path.join(ROOT, p.lstrip("/")))
        if not (p.startswith("/fonts/") and f.startswith(ROOT + os.sep) and os.path.isfile(f)):
            self.path = "/index.html"
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    try:
        # localhost only: the shop is never reachable from other computers on the network
        server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Shop)
    except OSError:
        sys.exit(f"Port {PORT} is busy. Start on another one: python3 server.py {PORT + 1}")
    print(f"Northwind Gear demo shop: http://localhost:{PORT}/   (Ctrl+C or close this window to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
