// Static server for the demo shop (SPA fallback). Usage: node scripts/demo-site.mjs [port]
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../demo-app');
export function startDemoSite(port = 5173) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const f = path.join(root, u.pathname);
    const file = u.pathname.startsWith('/fonts/') && existsSync(f) ? f : path.join(root, 'index.html');
    res.writeHead(200, { 'content-type': file.endsWith('.woff2') ? 'font/woff2' : 'text/html; charset=utf-8' });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 5173);
  await startDemoSite(port);
  console.log(`Northwind Gear demo shop: http://localhost:${port}/`);
}
