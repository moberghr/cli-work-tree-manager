// Draws the source icon (512×512 PNG: a terminal prompt on a dark tile);
// `tauri icon` turns it into icon.ico / icon.png. No image deps: raw RGBA
// rows, zlib, and the PNG chunks by hand.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const N = 512;
const px = Buffer.alloc(N * N * 4);
const set = (x, y, [r, g, b, a]) => {
  const i = (y * N + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
};
const inRounded = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), N - 1 - r);
  const cy = Math.min(Math.max(y, r), N - 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
// Distance from point to segment, for the chevron strokes.
const seg = (x, y, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
};
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (!inRounded(x, y, 96)) { set(x, y, [0, 0, 0, 0]); continue; }
    const chevron = Math.min(seg(x, y, 130, 150, 250, 256), seg(x, y, 250, 256, 130, 362)) < 30;
    const cursor = x >= 280 && x <= 390 && y >= 332 && y <= 376;
    set(x, y, chevron || cursor ? [78, 201, 176, 255] : [30, 30, 30, 255]);
  }
}
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(import.meta.dirname, '..', 'src-tauri', 'icons', 'source.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out);
