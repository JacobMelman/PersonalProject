// Draws simple PNG icons (dark rounded square + red record dot) without external dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size * 0.22, cx = size / 2, cy = size / 2, dot = size * 0.26, ring = size * 0.34;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const dx = Math.max(r - x, 0, x - (size - 1 - r)), dy = Math.max(r - y, 0, y - (size - 1 - r));
      const inside = dx * dx + dy * dy <= r * r;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let px = [0, 0, 0, 0];
      if (inside) px = [24, 59, 86, 255];
      if (inside && d <= dot) px = [229, 57, 53, 255];
      else if (inside && d <= ring && d > ring - Math.max(1, size * 0.05)) px = [255, 255, 255, 255];
      raw.set(px, o);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dir = new URL('../public/icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(new URL(`icon-${s}.png`, dir), png(s));
console.log('icons written');
