#!/usr/bin/env node
/* Prüft, dass webapp/arthash.js für die gemeinsamen Testbilder exakt dieselben Werte liefert
 * wie data-pipeline/arthash.py (data-pipeline/fixtures/expected.json).
 *   node webapp/dev/arthash_test.js
 * Node 22, keine Abhängigkeiten: kleiner PNG-Dekoder (8 Bit, RGB/RGBA/Grau, ohne Interlacing) über zlib. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const AH = require('../arthash.js');

const FIX = path.resolve(__dirname, '..', '..', 'data-pipeline', 'fixtures');
const SAMPLE = path.join(__dirname, 'sample-data');

function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'keine PNG-Datei');
  let off = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, palette = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), kind = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'PLTE') palette = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`nicht unterstützt: Tiefe ${depth}, Interlace ${interlace}`);
  const chIn = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!chIn) throw new Error('Farbtyp ' + type);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * chIn, out = new Uint8Array(w * h * 3), prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const a = x >= chIn ? cur[x - chIn] : 0, b = prev[x], c = x >= chIn ? prev[x - chIn] : 0;
      let v = raw[p++];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3, i = x * chIn;
      if (type === 2 || type === 6) { out[o] = cur[i]; out[o + 1] = cur[i + 1]; out[o + 2] = cur[i + 2]; }
      else if (type === 3) { const k = cur[i] * 3; out[o] = palette[k]; out[o + 1] = palette[k + 1]; out[o + 2] = palette[k + 2]; }
      else { out[o] = out[o + 1] = out[o + 2] = cur[i]; }
    }
    prev.set(cur);
  }
  return { w, h, px: out };
}

let fails = 0, count = 0;
function check(name, fn) {
  count++;
  try { fn(); console.log('PASS  ' + name); } catch (e) { fails++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
check('Algorithmus-Version und Region wie in Python', () => {
  assert.equal(AH.ALGO, expected.algo);
  assert.deepEqual(AH.REGION, expected.region);
});
for (const [file, exp] of Object.entries(expected.images)) {
  check(`Fixture ${file}: artHash/artColor identisch zu Python`, () => {
    const img = decodePng(fs.readFileSync(path.join(FIX, file)));
    assert.deepEqual([img.w, img.h], [exp.w, exp.h]);
    const r = AH.artHash(img.px, img.w, img.h, 3);
    assert.equal(r.hash, exp.hash);
    assert.equal(r.color, exp.color);
    // RGBA-Eingang (wie Canvas-ImageData) muss dasselbe ergeben
    const rgba = new Uint8ClampedArray(img.w * img.h * 4);
    for (let i = 0, j = 0; i < img.px.length; i += 3, j += 4) { rgba[j] = img.px[i]; rgba[j + 1] = img.px[i + 1]; rgba[j + 2] = img.px[i + 2]; rgba[j + 3] = 255; }
    assert.equal(AH.artHash(rgba, img.w, img.h, 4).hash, exp.hash);
  });
}
check('Sample-Karten: hashes.json passt zu den Sample-Bildern', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'hashes.json'), 'utf8'));
  assert.equal(doc.algo, AH.ALGO);
  let n = 0;
  for (const [pid, [hash, color]] of Object.entries(doc.hashes)) {
    const img = decodePng(fs.readFileSync(path.join(SAMPLE, 'img', pid + '.png')));
    const r = AH.artHash(img.px, img.w, img.h, 3);
    assert.equal(r.hash, hash, 'Produkt ' + pid);
    assert.equal(r.color, color, 'Produkt ' + pid);
    n++;
  }
  assert.ok(n >= 20, 'zu wenige Sample-Hashes: ' + n);
});
check('Hilfsfunktionen: hexWords, popcount, colorTerm', () => {
  const w = AH.hexWords('f'.repeat(64));
  assert.equal(w.length, 8);
  assert.equal(w[0], 0xffffffff);
  assert.equal(AH.popcount(0xffffffff), 32);
  assert.equal(AH.popcount(0x80000001), 2);
  assert.equal(AH.colorTerm([0, 0, 0], [32, 32, 32]), 3);   // 0,25 · 96 / 8 = 3
  assert.equal(AH.colorTerm([10, 10, 10], [10, 10, 10]), 0);
});
check('Bitreihenfolge: steigender Verlauf = alle Bits 1, fallender = 0', () => {
  const w = 200, h = 279, inc = new Uint8Array(w * h * 3), dec = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 3, a = Math.floor(x * 255 / 199), b = Math.floor((199 - x) * 255 / 199);
    inc[o] = inc[o + 1] = inc[o + 2] = a; dec[o] = dec[o + 1] = dec[o + 2] = b;
  }
  assert.equal(AH.artHash(inc, w, h, 3).hash, 'f'.repeat(64));
  assert.equal(AH.artHash(dec, w, h, 3).hash, '0'.repeat(64));
});
check('Geschwindigkeit: artHash 200x279 < 5 ms', () => {
  const w = 200, h = 279, px = new Uint8ClampedArray(w * h * 4).map((_, i) => (i * 7919) & 255);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) AH.artHash(px, w, h, 4);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
  console.log(`      ${ms.toFixed(2)} ms je Hash`);
  assert.ok(ms < 5);
});
console.log(`\n${count - fails}/${count} bestanden`);
process.exitCode = fails ? 1 : 0;
