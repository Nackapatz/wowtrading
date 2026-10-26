#!/usr/bin/env node
/* Prüft webapp/carddetect.js mit synthetischen Szenen (docs/CARD_DETECT.md, Abschnitt Tests):
 * Karte mit dunklem Rand auf Hintergrund mit Rauschen und Textur, gerade, verschoben, gedreht, perspektivisch,
 * heller und dunkler Hintergrund. Ecken müssen auf ≤ 2 px stimmen.
 *   node webapp/dev/carddetect_test.js
 * Node 22, keine Abhängigkeiten. Die Szenen sind ERFUNDEN und deterministisch (fester LCG). */
'use strict';
const assert = require('node:assert/strict');
const CD = require('../carddetect.js');

const W = 240, H = 320;                  // Suchbereich wie in der App (ca. 240 px breit)
const CW = 63, CH = 88;                  // Kartenmaß (Seitenverhältnis 63:88)

// Deterministischer Zufall, wie im Modul
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s; };
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Gauß-Lösung und Homographie (eigene Kopie, unabhängig vom Modul)
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    [M[k], M[p]] = [M[p], M[k]];
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / M[k][k];
      for (let j = k; j <= n; j++) M[i][j] -= f * M[k][j];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
  }
  return [...solve(A, b), 1];
}

// Kartenrand (Ecken oben links, oben rechts, unten rechts, unten links) aus Mitte, Breite, Drehung, Verzerrung oben
function cardQuad(cx, cy, w, deg = 0, shrinkTop = 0) {
  const hgt = w * CH / CW, t = deg * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t);
  return [[-w / 2 + shrinkTop, -hgt / 2], [w / 2 - shrinkTop, -hgt / 2], [w / 2, hgt / 2], [-w / 2, hgt / 2]]
    .map(([x, y]) => [cx + x * cs - y * sn, cy + x * sn + y * cs]);
}

// Kartenbild in Kartenkoordinaten: dunkler Rand, helle Fläche, Illustration und Textfelder (starke Kanten innen)
function cardLuma(u, v) {
  if (u < 3 || u > CW - 3 || v < 3 || v > CH - 3) return 28;                       // dunkler Rand
  if (u >= 6 && u <= 57 && v >= 12 && v <= 50) {                                    // Illustration: große, weiche Formen
    if (Math.hypot((u - 31) / 14, (v - 31) / 12) < 1) return 40;
    return 120 + 50 * Math.sin(u / 7) * Math.cos(v / 9);
  }
  if (u >= 6 && u <= 57 && v >= 58 && v <= 80) return (Math.floor(v / 3) % 2 === 0 && u % 9 < 6) ? 60 : 215;   // Text
  return 200;
}
// Hintergrund: Grundhelligkeit, Textur (Wellen) und Rauschen; 'noise' = weißes Rauschen
function bgLuma(kind, x, y, rnd) {
  if (kind === 'noise') return rnd() % 256;
  if (kind === 'carpet') return 110 + 10 * Math.sin(x / 4) * Math.cos(y / 5) + (rnd() % 61 - 30);   // Teppich: ±30
  const base = { mid: 140, light: 225, dark: 70, dark40: 40 }[kind];
  return base + 10 * Math.sin(x / 6) * Math.cos(y / 7) + (rnd() % 9 - 4);
}

// Szene: cards = [{ quad, luma(u, v) }], übrige Pixel = Hintergrund bg. Mehrere Karten sind erlaubt (Nachbarkarte).
function scene(cards, bg, seed = 7, w = W, h = H) {
  const maps = cards.map((c) => ({ Hm: homography(c.quad, [[0, 0], [CW, 0], [CW, CH], [0, CH]]), luma: c.luma || cardLuma }));
  const gray = new Uint8Array(w * h), rnd = lcg(seed);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let val = null;
    for (const { Hm, luma } of maps) {
      const d = Hm[6] * x + Hm[7] * y + 1;
      const u = (Hm[0] * x + Hm[1] * y + Hm[2]) / d, v = (Hm[3] * x + Hm[4] * y + Hm[5]) / d;
      if (u >= 0 && u <= CW && v >= 0 && v <= CH) { val = luma(u, v); break; }
    }
    if (val === null) val = bgLuma(bg, x, y, rnd);
    gray[y * w + x] = clamp(Math.round(val), 0, 255);
  }
  return gray;
}
const render = (quad, bg, seed = 7) => scene([{ quad }], bg, seed);
const maxErr = (got, want) => Math.max(...got.map((p, i) => Math.hypot(p[0] - want[i][0], p[1] - want[i][1])));

let fails = 0, count = 0;
function check(name, fn) {
  count++;
  try { fn(); console.log('PASS  ' + name); } catch (e) { fails++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n').slice(0, 4).join('\n      ')); }
}

// Szenen: gerade, verschoben, gedreht, perspektivisch, heller und dunkler Hintergrund
const cases = [
  ['gerade, mittig, mittlerer Hintergrund', cardQuad(120, 160, 150), 'mid'],
  ['verschoben (Mitte links oben)', cardQuad(102, 146, 140), 'mid'],
  ['um 4° gedreht', cardQuad(124, 158, 146, 4), 'mid'],
  ['perspektivisch verzerrt (oben schmaler, leicht gedreht)', cardQuad(120, 160, 150, -3, 9), 'mid'],
  ['heller Hintergrund', cardQuad(120, 160, 150), 'light'],
  ['dunkler Hintergrund', cardQuad(120, 160, 150), 'dark'],
];
for (const [name, quad, bg] of cases) {
  check(`Erkennung ${name}: Ecken ≤ 2 px`, () => {
    const r = CD.detectCard(render(quad, bg), W, H);
    assert.ok(r, 'keine Karte erkannt');
    const e = maxErr(r.corners, quad);
    assert.ok(e <= 2, `größte Abweichung ${e.toFixed(2)} px: ${JSON.stringify(r.corners.map((p) => p.map((v) => +v.toFixed(1))))}`);
    assert.ok(r.score > 0.5, 'score ' + r.score.toFixed(2));
  });
}
check('Erkennung ist reproduzierbar (gleiche Eingabe, gleiche Ecken)', () => {
  const g = render(cases[2][1], 'mid');
  assert.deepEqual(CD.detectCard(g, W, H), CD.detectCard(g, W, H));
});
check('Leeres Rauschbild → null', () => {
  const g = new Uint8Array(W * H), rnd = lcg(99);
  for (let i = 0; i < g.length; i++) g[i] = rnd() % 256;
  assert.equal(CD.detectCard(g, W, H), null, 'weißes Rauschen');
  assert.equal(CD.detectCard(new Uint8Array(W * H).fill(140), W, H), null, 'einfarbig');
});
check('Falsches Seitenverhältnis (quadratisch) → null', () => {
  assert.ok(CD.detectCard(render(cardQuad(120, 160, 150), 'mid'), W, H), 'Kontrolle: rechteckige Karte wird gefunden');
  const sq = [[45, 85], [195, 85], [195, 235], [45, 235]];           // 150 × 150
  assert.equal(CD.detectCard(render(sq, 'mid'), W, H), null);
});
check('Zu kleine Karte (unter minArea) → null', () => {
  assert.equal(CD.detectCard(render(cardQuad(120, 160, 60), 'mid'), W, H), null);
});

// Robustheit für echte Fotos. Alle Szenen: Ecken müssen am ÄUSSEREN Kartenrand auf ≤ 2 px stimmen.
function expectCorners(name, img, quad, w = W, h = H) {
  check(name, () => {
    const r = CD.detectCard(img, w, h);
    assert.ok(r, 'keine Karte erkannt');
    const e = maxErr(r.corners, quad);
    assert.ok(e <= 2, `größte Abweichung ${e.toFixed(2)} px: ${JSON.stringify(r.corners.map((p) => p.map((v) => +v.toFixed(1))))}`);
  });
}
// (a) zweite Karte rechts daneben, Lücke ca. 10 % der Kartenbreite
{
  const w = 120, main = cardQuad(100, 160, w), gap = 0.10 * w;
  const nb = cardQuad(100 + w + gap + w / 2, 160, w);
  expectCorners('(a) Nachbarkarte rechts (Lücke 10 %): Ecken am äußeren Rand', scene([{ quad: main }, { quad: nb }], 'mid'), main);
}
// (b) dunkler Hintergrund 40, schwarzer Rand 15, helle Innenlinie, außen nur 25 Graustufen Kontrast
{
  const frame = (u, v) => {
    if (u < 3 || u > CW - 3 || v < 3 || v > CH - 3) return 15;             // schwarzer Rand
    if (u < 4.5 || u > CW - 4.5 || v < 4.5 || v > CH - 4.5) return 200;    // helle Innenlinie
    return cardLuma(u, v);
  };
  const q = cardQuad(120, 160, 150);
  expectCorners('(b) dunkler Hintergrund 40, schwarzer Rand 15, helle Innenlinie', scene([{ quad: q, luma: frame }], 'dark40'), q);
}
// (c) dunkler Hintergrund 70 mit dichtem Schachbrett-Motiv (früher Fehlfall)
{
  const checker = (u, v) => {
    if (u >= 6 && u <= 57 && v >= 12 && v <= 50) return ((Math.floor(u / 2) + Math.floor(v / 2)) % 2) ? 225 : 50;
    return cardLuma(u, v);
  };
  const q = cardQuad(120, 160, 150);
  expectCorners('(c) dunkler Hintergrund 70, Schachbrett-Motiv', scene([{ quad: q, luma: checker }], 'dark'), q);
}
// (d) Teppich-Textur mit Rauschen ±30 bleibt erkennbar
{
  const q = cardQuad(120, 160, 150);
  expectCorners('(d) Teppichhintergrund mit Rauschen ±30', scene([{ quad: q }], 'carpet'), q);
}

// warpCard: achsparalleles Rechteck = einfacher Zuschnitt (±2 pro Kanal)
check('warpCard: achsparalleles Rechteck liefert denselben Zuschnitt (±2 je Kanal)', () => {
  const sw = 50, sh = 60, src = new Uint8ClampedArray(sw * sh * 4), rnd = lcg(5);
  for (let i = 0; i < src.length; i++) src[i] = rnd() % 256;
  const x0 = 7, y0 = 9, x1 = 38, y1 = 47;
  const out = CD.warpCard(src, sw, sh, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], x1 - x0 + 1, y1 - y0 + 1, 4);
  assert.ok(out && out.length === (x1 - x0 + 1) * (y1 - y0 + 1) * 4);
  for (let y = 0; y <= y1 - y0; y++) for (let x = 0; x <= x1 - x0; x++) {
    for (let c = 0; c < 3; c++) {
      const want = src[((y0 + y) * sw + x0 + x) * 4 + c], got = out[(y * (x1 - x0 + 1) + x) * 4 + c];
      assert.ok(Math.abs(want - got) <= 2, `Pixel ${x},${y} Kanal ${c}: ${got} statt ${want}`);
    }
  }
});
check('warpCard: entzerrte Karte hat dunklen Rand und helle Mitte', () => {
  const quad = cardQuad(124, 158, 146, 4);
  const g = render(quad, 'mid');
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g[i]; rgba[i * 4 + 3] = 255; }
  const dw = 100, dh = 142, out = CD.warpCard(rgba, W, H, quad, dw, dh, 4);
  const at = (x, y) => out[(y * dw + x) * 4];
  assert.ok(at(1, 70) < 60, 'linker Rand dunkel: ' + at(1, 70));
  assert.ok(at(dw - 2, 70) < 60, 'rechter Rand dunkel: ' + at(dw - 2, 70));
  assert.ok(at(dw >> 1, 87) > 150, 'helle Fläche zwischen Illustration und Text: ' + at(dw >> 1, 87));
});

// sharpness: unscharf < scharf
check('sharpness: unscharfes Bild < scharfes Bild', () => {
  const sharp = render(cardQuad(120, 160, 150), 'mid');
  const blur = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = clamp(x + dx, 0, W - 1), yy = clamp(y + dy, 0, H - 1);
      s += sharp[yy * W + xx]; n++;
    }
    blur[y * W + x] = Math.round(s / n);
  }
  const a = CD.sharpness(sharp, W, H), b = CD.sharpness(blur, W, H);
  assert.ok(b < a, `unscharf ${b.toFixed(1)} ist nicht kleiner als scharf ${a.toFixed(1)}`);
  assert.ok(b * 4 < a, `Unterschied zu klein: ${b.toFixed(1)} / ${a.toFixed(1)}`);
  assert.equal(CD.sharpness(new Uint8Array(W * H).fill(128), W, H), 0, 'einfarbig = 0');
});

console.log(`\n${count - fails}/${count} bestanden`);
process.exitCode = fails ? 1 : 0;
