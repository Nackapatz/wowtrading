/* artHash/artColor – Bild-Fingerabdruck der Kartenillustration (docs/IMAGE_MATCH.md).
 * MUSS bit-identisch zu data-pipeline/arthash.py sein: nur ganzzahlige Rechnung
 * (Graustufe ×1000, Mittelwertvergleich per Kreuzmultiplikation, Farbmittel kaufmännisch gerundet).
 * Läuft im Browser (window.WowArtHash) und in Node (module.exports). */
(function (root) {
  'use strict';
  var ALGO = 'dhash17x16-v1';
  var REGION = [0.10, 0.14, 0.90, 0.56];
  var GW = 17, GH = 16;

  function clamp(v, n) { return v < 0 ? 0 : v > n ? n : v; }
  function regionBox(w, h) {
    return [clamp(Math.floor(REGION[0] * w), w), clamp(Math.floor(REGION[1] * h), h),
      clamp(Math.ceil(REGION[2] * w), w), clamp(Math.ceil(REGION[3] * h), h)];
  }
  // Zellgrenzen [a, b); leere Zelle nimmt die nächste Pixelzeile/-spalte
  function cellEdges(n, cells) {
    var out = [];
    for (var i = 0; i < cells; i++) {
      var a = Math.floor(i * n / cells), b = Math.floor((i + 1) * n / cells);
      if (b <= a) { a = Math.min(a, n - 1); b = a + 1; }
      out.push([a, b]);
    }
    return out;
  }
  function hex2(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  /* px: RGB- oder RGBA-Pixel (Array/Uint8ClampedArray), zeilenweise; ch = 3 oder 4.
   * Ergebnis: { hash: 64 Hex, color: rrggbb, words: Uint32Array(8), rgb: [r,g,b] } */
  function artHash(px, w, h, ch) {
    ch = ch || 4;
    var box = regionBox(w, h), x0 = box[0], y0 = box[1], rw = box[2] - box[0], rh = box[3] - box[1];
    if (rw <= 0 || rh <= 0) throw new Error('Bild zu klein für den Illustrationsbereich');
    var xe = cellEdges(rw, GW), ye = cellEdges(rh, GH);
    var rowCells = [], i, j, x, y;
    for (y = 0; y < rh; y++) rowCells.push([]);
    for (j = 0; j < GH; j++) for (y = ye[j][0]; y < ye[j][1]; y++) rowCells[y].push(j);
    var sums = new Float64Array(GW * GH), cols = new Float64Array(GW), colOf = new Int32Array(rw);
    var sr = 0, sg = 0, sb = 0;
    // Spalte → Zelle (nur für Spalten in genau einer Zelle; leere Zellen werden unten nachgezogen)
    for (x = 0; x < rw; x++) colOf[x] = -1;
    var dup = false;
    for (i = 0; i < GW; i++) for (x = xe[i][0]; x < xe[i][1]; x++) { if (colOf[x] !== -1) dup = true; colOf[x] = i; }
    var gray = new Float64Array(rw);
    for (y = 0; y < rh; y++) {
      var p = ((y0 + y) * w + x0) * ch;
      for (x = 0; x < rw; x++, p += ch) {
        var r = px[p], g = px[p + 1], b = px[p + 2];
        sr += r; sg += g; sb += b;
        gray[x] = 299 * r + 587 * g + 114 * b;
      }
      var cells = rowCells[y];
      if (!cells.length) continue;
      if (dup) {
        for (i = 0; i < GW; i++) { var s = 0; for (x = xe[i][0]; x < xe[i][1]; x++) s += gray[x]; cols[i] = s; }
      } else {
        cols.fill(0);
        for (x = 0; x < rw; x++) if (colOf[x] >= 0) cols[colOf[x]] += gray[x];
      }
      for (var k = 0; k < cells.length; k++) { var off = cells[k] * GW; for (i = 0; i < GW; i++) sums[off + i] += cols[i]; }
    }
    var words = new Uint32Array(8), bit = 0, hex = '';
    for (j = 0; j < GH; j++) {
      var cy = ye[j][1] - ye[j][0];
      for (i = 0; i < GW - 1; i++) {
        var ca = (xe[i][1] - xe[i][0]) * cy, cb = (xe[i + 1][1] - xe[i + 1][0]) * cy;
        if (sums[j * GW + i + 1] * ca > sums[j * GW + i] * cb) words[bit >>> 5] |= (0x80000000 >>> (bit & 31));
        bit++;
      }
    }
    for (i = 0; i < 8; i++) hex += ('0000000' + words[i].toString(16)).slice(-8);
    var n = rw * rh;
    var mean = function (v) { return Math.min(255, Math.floor((2 * v + n) / (2 * n))); };
    var rgb = [mean(sr), mean(sg), mean(sb)];
    return { hash: hex, color: hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]), words: words, rgb: rgb };
  }

  // 64 Hex → Uint32Array(8)
  function hexWords(hex) {
    var out = new Uint32Array(8);
    for (var i = 0; i < 8; i++) out[i] = parseInt(hex.substr(i * 8, 8), 16) >>> 0;
    return out;
  }
  function popcount(v) {
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
  }
  // Distanz laut Spec: Hamming(256 Bit) + round(0,25 · (|ΔR|+|ΔG|+|ΔB|) / 8)
  function colorTerm(a, b) {
    return Math.round(0.25 * (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 8);
  }

  var api = { ALGO: ALGO, REGION: REGION, artHash: artHash, regionBox: regionBox, hexWords: hexWords, popcount: popcount, colorTerm: colorTerm };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WowArtHash = api;
})(this);
