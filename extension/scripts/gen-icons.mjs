// Brand icon: indigo gradient rounded square, white "replay" ring with a gap, coral record dot. Drawn per pixel with 4x4 supersampling (no dependencies).
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
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function sample(u, v) {
  // rounded square
  const r = 0.23, cx = Math.max(r - u, 0, u - (1 - r)), cy = Math.max(r - v, 0, v - (1 - r));
  if (cx * cx + cy * cy > r * r) return [0, 0, 0, 0];
  let c = mix([96, 125, 255], [36, 56, 205], Math.min(1, (u + v) / 2 * 1.05)); // top-left -> bottom-right gradient
  const dx = u - 0.5, dy = v - 0.5, d = Math.hypot(dx, dy);
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, 0 = right, -90 = up
  const inGap = ang > -78 && ang < -22;
  if (d <= 0.335 && d >= 0.265 && !inGap) c = [255, 255, 255]; // ring
  // arrowhead at the end of the ring (replay), just before the gap
  const ax = 0.5 + Math.cos((-78 * Math.PI) / 180) * 0.3, ay = 0.5 + Math.sin((-78 * Math.PI) / 180) * 0.3;
  if (Math.hypot(u - ax, v - ay) < 0.075 && !(d <= 0.335 && d >= 0.265 && !inGap)) c = [255, 255, 255];
  if (d <= 0.15) c = mix([255, 99, 99], [226, 40, 60], (v - 0.35) / 0.3); // record dot
  if (d <= 0.15 && d >= 0.13) c = mix(c, [255, 255, 255], 0.0);
  return [c[0], c[1], c[2], 255];
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const S = 4;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const p = sample((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
        r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (a > 0) { raw[o] = Math.round(r / a); raw[o + 1] = Math.round(g / a); raw[o + 2] = Math.round(b / a); raw[o + 3] = Math.round(a / (S * S)); }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dir = new URL('../public/icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const s of [16, 32, 48, 128, 256]) writeFileSync(new URL(`icon-${s}.png`, dir), png(s));
console.log('icons written');
