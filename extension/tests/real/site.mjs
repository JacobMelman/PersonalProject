import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './lib.mjs';
const e2e = path.resolve(root, '../e2e/site');
/** Serves the fixture shop and the complex-rendering page on one port; `iframe.html` is served from a second origin for cross-origin tests. */
export async function startSites(port, otherPort) {
  const handler = (q, r) => {
    const u = new URL(q.url, 'http://x');
    let file = 'index.html', dir = e2e;
    if (u.pathname === '/popup.html') file = 'popup.html';
    if (u.pathname === '/complex.html') { file = 'complex.html'; dir = path.join(root, 'site'); }
    if (u.pathname === '/inner.html') { file = 'inner.html'; dir = path.join(root, 'site'); }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(readFileSync(path.join(dir, file)));
  };
  const a = http.createServer(handler), b = http.createServer(handler);
  await new Promise((r) => a.listen(port, r));
  await new Promise((r) => b.listen(otherPort, r));
  return { close: () => { a.close(); b.close(); } };
}
