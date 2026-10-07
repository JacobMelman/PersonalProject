let n = 0;
/** ReproDesk mark: indigo tile, white replay ring, record dot. Self-contained SVG (unique gradient ids per instance). */
export function logo(size = 28): string {
  const id = `rdg${++n}`;
  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <defs><linearGradient id="${id}a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#607dff"/><stop offset="1" stop-color="#2438cd"/></linearGradient>
  <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff6363"/><stop offset="1" stop-color="#e2283c"/></linearGradient></defs>
  <rect width="64" height="64" rx="15" fill="url(#${id}a)"/>
  <path d="M49.8 24.8A19.2 19.2 0 1 1 35.99 13.22" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="butt"/>
  <circle cx="35.99" cy="13.22" r="4.8" fill="#fff"/>
  <circle cx="32" cy="32" r="9.6" fill="url(#${id}b)"/></svg>`;
}
