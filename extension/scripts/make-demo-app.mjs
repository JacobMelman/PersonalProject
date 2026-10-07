// Builds demo-app/index.html from the template, inlining Lucide icons. The demo shop contains two DELIBERATE bugs for the presentation:
// the promo discount is displayed but not subtracted from the total, and "Place order" always fails with E-4021.
import { readFileSync, writeFileSync } from 'node:fs';
const dir = new URL('../', import.meta.url);
let html = readFileSync(new URL('scripts/demo-app.template.html', dir), 'utf8');
html = html.replace(/\{\{icon:([\w-]+)\}\}/g, (_m, n) => {
  const svg = readFileSync(new URL(`node_modules/lucide-static/icons/${n}.svg`, dir), 'utf8');
  return svg.replace(/<!--[\s\S]*?-->\s*/, '').replace(/\s+class="[^"]*"/, '').replace(/\s+width="24"\s+height="24"/, '').replace(/\s+fill="none"|\s+stroke="currentColor"|\s+stroke-width="2"|\s+stroke-linecap="round"|\s+stroke-linejoin="round"/g, '').replace('<svg', '<svg class="i"').replace(/\s+/g, ' ');
});
writeFileSync(new URL('demo-app/index.html', dir), html);
console.log('demo-app/index.html written', html.length, 'bytes');
