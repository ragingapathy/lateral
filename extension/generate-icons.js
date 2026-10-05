#!/usr/bin/env node
/**
 * Generates icon-16.png, icon-48.png, icon-128.png for the Lateral extension.
 * Uses only Node.js built-ins (zlib, fs, path). Run once: node generate-icons.js
 */
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 (required by PNG spec) ───────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeB = Buffer.from(type, 'ascii');
  const lenB  = Buffer.alloc(4); lenB.writeUInt32BE(data.length, 0);
  const crcB  = Buffer.alloc(4); crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
  return Buffer.concat([lenB, typeB, data, crcB]);
}

// ── PNG builder (RGBA, filter=None per row) ────────────────────────────────
function makePNG(size, pixelFn) {
  const stride = 1 + size * 4;       // 1 filter byte + 4 bytes per pixel
  const raw    = Buffer.alloc(stride * size, 0);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;             // filter type: None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x + 0.5, y + 0.5, size);
      const off = y * stride + 1 + x * 4;
      raw[off] = r; raw[off+1] = g; raw[off+2] = b; raw[off+3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;         // bit depth 8, colour type RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Geometry helper ────────────────────────────────────────────────────────
function inRoundedRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  if (px < x0+r && py < y0+r) return (px-x0-r)**2 + (py-y0-r)**2 <= r*r;
  if (px > x1-r && py < y0+r) return (px-x1+r)**2 + (py-y0-r)**2 <= r*r;
  if (px < x0+r && py > y1-r) return (px-x0-r)**2 + (py-y1+r)**2 <= r*r;
  if (px > x1-r && py > y1-r) return (px-x1+r)**2 + (py-y1+r)**2 <= r*r;
  return true;
}

// ── Icon design: indigo rounded square + white "L" ─────────────────────────
// Matches Lateral's #4338ca (indigo-700) accent colour.
function lateralIcon(px, py, sz) {
  const pad = sz * 0.07;
  const r   = sz * 0.22;
  if (!inRoundedRect(px, py, pad, pad, sz - pad, sz - pad, r)) return [0, 0, 0, 0];

  // "L" shape — vertical stroke + horizontal bar
  const lx  = sz * 0.25;   // left edge
  const ly  = sz * 0.16;   // top edge
  const lw  = sz * 0.18;   // vertical stroke width
  const lh  = sz * 0.66;   // total L height
  const lbh = sz * 0.18;   // horizontal bar height
  const lbw = sz * 0.56;   // horizontal bar width

  const inVert  = px >= lx       && px < lx + lw  && py >= ly && py < ly + lh;
  const inHoriz = px >= lx       && px < lx + lbw && py >= ly + lh - lbh && py < ly + lh;

  if (inVert || inHoriz) return [255, 255, 255, 255]; // white letter
  return [67, 56, 202, 255];                          // indigo-700 background
}

// ── Write icons ────────────────────────────────────────────────────────────
for (const size of [16, 48, 128]) {
  const outPath = path.join(__dirname, `icon-${size}.png`);
  fs.writeFileSync(outPath, makePNG(size, lateralIcon));
  console.log(`✓  icon-${size}.png  (${fs.statSync(outPath).size} bytes)`);
}
console.log('\nIcons ready. Load the extension at chrome://extensions → Load unpacked.');
