// Generates icons/icon{16,32,48,128}.png with no dependencies: a rounded slate
// tile holding two columns of bars (removed / added) — a tiny side-by-side diff.
// Run: `npm run icons`.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor per axis (anti-aliasing)

const BG = [30, 41, 59];      // slate-800
const LEFT = [251, 113, 133]; // rose-400 (removed)
const RIGHT = [74, 222, 128]; // green-400 (added)

// Shapes in unit coordinates (0..1). Each column is a stack of bars.
const TILE_RADIUS = 0.22;
const BARS = 4;
const BAR_H = 0.09;
const BAR_GAP = 0.05;
const STACK_H = BARS * BAR_H + (BARS - 1) * BAR_GAP;
const STACK_Y0 = (1 - STACK_H) / 2;
// Each column: [x0, x1, colour, per-bar width fractions to suggest differing lines]
const COLUMNS = [
  [0.16, 0.46, LEFT, [1, 0.7, 1, 0.55]],
  [0.54, 0.84, RIGHT, [1, 0.85, 0.6, 1]],
];

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Returns [r, g, b, a] for a unit-space sample point.
function sample(x, y) {
  if (!inRoundedRect(x, y, 0, 0, 1, 1, TILE_RADIUS)) return [0, 0, 0, 0];
  for (const [x0, x1, colour, widths] of COLUMNS) {
    for (let i = 0; i < BARS; i++) {
      const by0 = STACK_Y0 + i * (BAR_H + BAR_GAP);
      const bx1 = x0 + (x1 - x0) * widths[i];
      if (inRoundedRect(x, y, x0, by0, bx1, by0 + BAR_H, BAR_H / 2)) return [...colour, 255];
    }
  }
  return [...BG, 255];
}

function pixel(px, py, size) {
  const acc = [0, 0, 0, 0];
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const s = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
      // Premultiply while accumulating so transparent samples don't tint edges.
      acc[0] += s[0] * s[3]; acc[1] += s[1] * s[3]; acc[2] += s[2] * s[3]; acc[3] += s[3];
    }
  }
  if (acc[3] === 0) return [0, 0, 0, 0];
  return [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3], acc[3] / (SS * SS)].map(Math.round);
}

// --- minimal PNG writer (8-bit RGBA, no filtering) ---
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) raw.set(pixel(x, y, size), y * stride + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = fileURLToPath(new URL('../icons/', import.meta.url));
mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  writeFileSync(`${outDir}icon${size}.png`, png(size));
  console.log(`icons/icon${size}.png`);
}
