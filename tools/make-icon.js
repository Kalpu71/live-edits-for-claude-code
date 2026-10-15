// Draws media/icon.png (128x128): a dark editor tile with code lines, a red line
// being replaced, a green line being typed and a caret. Plain Node, no dependencies.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 128;
const SS = 4; // supersampling for smooth edges

/** Rounded rectangles, drawn in order: [x, y, w, h, radius, [r, g, b, a]] */
const shapes = [
  [4, 4, 120, 120, 26, [31, 36, 48, 255]], // tile
  [20, 26, 56, 10, 5, [120, 130, 150, 255]], // code line
  [14, 46, 100, 18, 6, [235, 80, 80, 90]], // red highlight row
  [22, 50, 64, 10, 5, [235, 110, 110, 255]], // old text
  [14, 70, 100, 18, 6, [60, 200, 120, 90]], // green highlight row
  [22, 74, 46, 10, 5, [235, 240, 245, 255]], // new text typed so far
  [72, 68, 5, 22, 2, [255, 255, 255, 255]], // caret
  [20, 96, 40, 10, 5, [120, 130, 150, 255]], // code line
  [64, 96, 30, 10, 5, [90, 140, 220, 255]], // code token
];

function inside(px, py, [x, y, w, h, r]) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        let c = [0, 0, 0, 0];
        for (const s of shapes) {
          if (!inside(px, py, s)) continue;
          const a = s[5][3] / 255;
          c = [0, 1, 2].map((i) => s[5][i] * a + c[i] * (1 - a)).concat(a + c[3] * (1 - a));
        }
        acc = acc.map((v, i) => v + (i < 3 ? c[i] * c[3] : c[3]));
      }
    }
    const n = SS * SS;
    const alpha = acc[3] / n;
    const o = (y * SIZE + x) * 4;
    for (let i = 0; i < 3; i++) rgba[o + i] = alpha ? Math.round(acc[i] / n / alpha) : 0;
    rgba[o + 3] = Math.round(alpha * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = path.join(__dirname, "..", "media", "icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
