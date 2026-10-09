// Northwind Gear, the demo shop for ReproDesk. Needs only Node.js 18+ (no npm install).
// Usage: node server.mjs [port]   ->  http://localhost:5173/   (Ctrl+C stops it)
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site');
const port = Number(process.argv[2] ?? process.env.PORT ?? 5173);
const types = { '.html': 'text/html; charset=utf-8', '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
  let p = '/';
  try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { /* malformed: serve the shop */ }
  const f = path.join(root, p);
  // The shop is a single page: fonts are real files, every other path gets index.html (the page routes itself).
  const file = p.startsWith('/fonts/') && f.startsWith(root + path.sep) && existsSync(f) && statSync(f).isFile() ? f : path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy. Start on another one: node server.mjs ${port + 1}` : String(e));
  process.exit(1);
});
// localhost only: the shop is never reachable from other computers on the network
server.listen(port, '127.0.0.1', () => console.log(`Northwind Gear demo shop: http://localhost:${port}/   (Ctrl+C or close this window to stop)`));
