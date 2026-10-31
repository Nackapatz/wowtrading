/* Kartenrand erkennen, Karte entzerren, Schärfe messen (docs/CARD_DETECT.md).
 * MUSS nur reine Arrays-Rechnung sein, keine Abhängigkeiten. Läuft im Browser (window.WowCardDetect)
 * und in Node (module.exports). Zufall nur als fester LCG, damit Ergebnisse reproduzierbar sind. */
(function (root) {
  'use strict';
  var SCAN = 40;                  // Scanlinien je Seite
  var PTS_LINE = 4;               // Kantenpunkte je Scanlinie (lokale Maxima von außen nach innen)
  var MIN_GAP = 3;                // Mindestabstand zweier Kantenpunkte einer Scanlinie (px)
  var RANSAC_IT = 60;             // RANSAC-Durchläufe je Kandidat
  var INLIER_PX = 1.5;            // Inlier-Abstand zur Geraden
  var MIN_INLIERS = 10;           // Kandidat braucht mindestens so viele Inlier
  var MAX_CAND = 4;               // Kandidaten je Seite (sequentielles RANSAC)
  var REFINE = 0.07;              // Außenrand: höchstens 7 % der Kartenbreite (oben/unten) bzw. -höhe (links/rechts)
  var PARALLEL = 3 * Math.PI / 180;
  var T_MIN = 20, T_PCT = 0.8;    // Kantenschwelle: max(20, 80. Perzentil des Gradientenbetrags)
  var REF_SUPPORT = 0.5;          // Außenrand-Kandidat braucht mindestens so viele Inlier wie die aktuelle Seite (Hälfte)
  var REF_PCT = 0.5;              // Außenrand-Kandidaten: niedrigere Schwelle (max(20, 50. Perzentil)), damit ein schwacher äußerer Rand gefunden wird
  var MIN_SCORE = 0.5;            // Mindestanteil belegter Scanlinien (Inlier / 4·SCAN); Rauschen liegt bei ~0,3
  var SIDE_LO = 0.15, SIDE_HI = 0.85;   // Scanlinien über die mittleren 70 % der Seite

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lcg(seed) {
    var s = seed >>> 0;
    return function () { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s; };
  }

  // 3×3-Mittel, dann Sobel. Ränder (2 Pixel) bleiben 0.
  function gradients(gray, w, h) {
    var n = w * h, sm = new Float32Array(n), gx = new Float32Array(n), gy = new Float32Array(n), x, y, i;
    for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
      i = y * w + x;
      sm[i] = (gray[i - w - 1] + gray[i - w] + gray[i - w + 1] + gray[i - 1] + gray[i] + gray[i + 1] +
        gray[i + w - 1] + gray[i + w] + gray[i + w + 1]) / 9;
    }
    for (y = 2; y < h - 2; y++) for (x = 2; x < w - 2; x++) {
      i = y * w + x;
      gx[i] = sm[i - w + 1] + 2 * sm[i + 1] + sm[i + w + 1] - sm[i - w - 1] - 2 * sm[i - 1] - sm[i + w - 1];
      gy[i] = sm[i + w - 1] + 2 * sm[i + w] + sm[i + w + 1] - sm[i - w - 1] - 2 * sm[i - w] - sm[i - w + 1];
    }
    return { gx: gx, gy: gy };
  }
  // Perzentil des Gradientenbetrags (Histogramm, ganzzahlig gerundet)
  function percentile(g, w, h, frac) {
    var hist = new Uint32Array(2048), n = 0, x, y, i, m;
    for (y = 2; y < h - 2; y++) for (x = 2; x < w - 2; x++) {
      i = y * w + x;
      m = Math.sqrt(g.gx[i] * g.gx[i] + g.gy[i] * g.gy[i]);
      hist[Math.min(2047, Math.round(m))]++;
      n++;
    }
    var target = frac * n, acc = 0;
    for (var b = 0; b < 2048; b++) { acc += hist[b]; if (acc >= target) return b; }
    return 2047;
  }

  // Kantenpunkte einer Seite. side: 0 oben, 1 rechts, 2 unten, 3 links.
  // Je Scanlinie von außen nach innen bis zu 4 lokale Maxima ≥ T, untereinander mindestens 3 px entfernt.
  function sidePoints(comp, w, h, side, T) {
    var horiz = side === 1 || side === 3;           // Seite links/rechts → Scanlinie waagerecht
    var len = horiz ? h : w, depth = horiz ? w : h;
    var outer = side === 0 || side === 3;
    var dir = outer ? 1 : -1;
    var mid = Math.floor(depth / 2);
    var start = outer ? 3 : depth - 4;
    var step = horiz ? 1 : w;
    var pts = [], k, p, v, i0, c0, ca, cb, n, last;
    for (k = 0; k < SCAN; k++) {
      p = Math.round((SIDE_LO + (SIDE_HI - SIDE_LO) * k / (SCAN - 1)) * (len - 1));
      n = 0; last = -1e9;
      for (v = start; dir > 0 ? v <= mid : v >= mid; v += dir) {
        i0 = horiz ? p * w + v : v * w + p;
        c0 = Math.abs(comp[i0]); ca = Math.abs(comp[i0 - dir * step]); cb = Math.abs(comp[i0 + dir * step]);
        if (c0 >= T && c0 >= ca && c0 > cb && Math.abs(v - last) >= MIN_GAP) {
          pts.push(horiz ? [v, p] : [p, v]);
          last = v;
          if (++n === PTS_LINE) break;
        }
      }
    }
    return pts;
  }

  // Ausgleichsgerade n·(x,y) = c mit |n| = 1 (Gesamtkleinstquadrate über die Inlier)
  function refit(pts, line) {
    var sel = [], i, m = 0, mx = 0, my = 0;
    for (i = 0; i < pts.length; i++) {
      if (Math.abs(line[0] * pts[i][0] + line[1] * pts[i][1] - line[2]) <= INLIER_PX) sel.push(pts[i]);
    }
    m = sel.length;
    if (m < 2) return null;
    for (i = 0; i < m; i++) { mx += sel[i][0]; my += sel[i][1]; }
    mx /= m; my /= m;
    var sxx = 0, sxy = 0, syy = 0;
    for (i = 0; i < m; i++) {
      var dx = sel[i][0] - mx, dy = sel[i][1] - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    var lmin = ((sxx + syy) - Math.sqrt((sxx - syy) * (sxx - syy) + 4 * sxy * sxy)) / 2;
    var a, b, L;
    if (Math.abs(sxy) < 1e-12) { a = sxx <= syy ? 1 : 0; b = 1 - a; }   // Achsenparallel
    else { a = sxy; b = lmin - sxx; L = Math.hypot(a, b); a /= L; b /= L; }
    return { line: [a, b, a * mx + b * my], inliers: sel };
  }
  // RANSAC: RANSAC_IT zufällige Punktpaare, beste Gerade, dann Ausgleich über die Inlier
  function ransacLine(pts, rnd) {
    var n = pts.length, best = null, bestCount = 0, k, i, j, q, a, b, c, cnt;
    if (n < 2) return null;
    for (k = 0; k < RANSAC_IT; k++) {
      i = rnd() % n; j = rnd() % n;
      if (i === j) continue;
      var dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1], L = Math.hypot(dx, dy);
      if (L < 1e-6) continue;
      a = -dy / L; b = dx / L; c = a * pts[i][0] + b * pts[i][1];
      cnt = 0;
      for (q = 0; q < n; q++) if (Math.abs(a * pts[q][0] + b * pts[q][1] - c) <= INLIER_PX) cnt++;
      if (cnt > bestCount) { bestCount = cnt; best = [a, b, c]; }
    }
    return best ? refit(pts, best) : null;
  }
  // Sequentielles RANSAC: Gerade finden, ihre Inlier entfernen, wiederholen. Höchstens MAX_CAND kandidaten mit ≥ MIN_INLIERS.
  // Jeder Kandidat: Linie, Inlier-Zahl, mittlere Position (mx, my).
  function fitSide(pts, rnd) {
    var out = [], pool = pts, c, f, i, m, mx, my, L;
    for (c = 0; c < MAX_CAND && pool.length >= MIN_INLIERS; c++) {
      f = ransacLine(pool, rnd);
      if (!f || f.inliers.length < MIN_INLIERS) break;
      m = f.inliers.length; mx = 0; my = 0;
      for (i = 0; i < m; i++) { mx += f.inliers[i][0]; my += f.inliers[i][1]; }
      out.push({ line: f.line, n: m, mx: mx / m, my: my / m });
      L = f.line;
      pool = pool.filter(function (p) { return Math.abs(L[0] * p[0] + L[1] * p[1] - L[2]) > INLIER_PX; });
    }
    return out;
  }

  // Schnittpunkt zweier Geraden (Cramer), null bei Parallelität
  function cross(l1, l2) {
    var det = l1[0] * l2[1] - l2[0] * l1[1];
    if (Math.abs(det) < 1e-9) return null;
    return [(l1[2] * l2[1] - l2[2] * l1[1]) / det, (l1[0] * l2[2] - l2[0] * l1[2]) / det];
  }
  // Innenwinkel bei p zwischen p→a und p→b, in Grad (NaN bei Nullvektor)
  function angleDeg(p, a, b) {
    var ux = a[0] - p[0], uy = a[1] - p[1], vx = b[0] - p[0], vy = b[1] - p[1];
    var c = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
    return Math.acos(clamp(c, -1, 1)) * 180 / Math.PI;
  }
  function area(c) {
    var s = 0;
    for (var i = 0; i < 4; i++) { var a = c[i], b = c[(i + 1) % 4]; s += a[0] * b[1] - b[0] * a[1]; }
    return Math.abs(s) / 2;
  }

  // Ecken aus vier Geraden (Seiten oben, rechts, unten, links): TL, TR, BR, BL
  function cornersOf(L) { return [cross(L[0], L[3]), cross(L[0], L[1]), cross(L[2], L[1]), cross(L[2], L[3])]; }
  function dims(q) {
    return [(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) + Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1])) / 2,
      (Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])) / 2];
  }
  // Gerade ist parallel (Winkel der Normalen < 3°)
  function parallel(l1, l2) {
    var d = Math.abs(Math.atan2(l1[1], l1[0]) - Math.atan2(l2[1], l2[0])) % Math.PI;
    return Math.min(d, Math.PI - d) < PARALLEL;
  }
  // Gültige Karte? Ecken im Bild (höchstens 2 px außerhalb), Innenwinkel 75°–105°, Seitenverhältnis, Fläche.
  // Liefert das Seitenverhältnis oder null.
  function quadRatio(c, w, h, aspect, aspectTol, minArea) {
    var i, p;
    for (i = 0; i < 4; i++) {
      p = c[i];
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) return null;
      if (p[0] < -2 || p[0] > w + 1 || p[1] < -2 || p[1] > h + 1) return null;
    }
    var ang = [angleDeg(c[0], c[1], c[3]), angleDeg(c[1], c[0], c[2]), angleDeg(c[2], c[1], c[3]), angleDeg(c[3], c[2], c[0])];
    for (i = 0; i < 4; i++) if (!(ang[i] >= 75 && ang[i] <= 105)) return null;
    var d = dims(c);
    if (!(d[1] > 0)) return null;
    var ratio = d[0] / d[1];
    if (Math.abs(ratio - aspect) > aspectTol) return null;
    if (area(c) / (w * h) < minArea) return null;
    return ratio;
  }

  /* gray: Uint8Array w×h (Graustufen, zeilenweise). opts: aspect (63/88), aspectTol (0,08), minArea (0,25).
   * Ablauf: Kantenpunkte je Seite, sequentielles RANSAC (bis 4 Kandidaten je Seite), beste gültige Kombination
   * (Bewertung: Summe der Inlier × (1 − |Verhältnis − aspect| / aspectTol × 0,5)), dann Außenrand-Verfeinerung.
   * Ergebnis: { corners: [[x,y] oben links, oben rechts, unten rechts, unten links], score } oder null. */
  function detectCard(gray, w, h, opts) {
    opts = opts || {};
    var aspect = opts.aspect || 63 / 88;
    var aspectTol = opts.aspectTol != null ? opts.aspectTol : 0.08;
    var minArea = opts.minArea != null ? opts.minArea : 0.25;
    if (!gray || w < 16 || h < 16) return null;
    var g = gradients(gray, w, h);
    var T = Math.max(T_MIN, percentile(g, w, h, T_PCT));
    var rnd = lcg(1), cand = [], s, a, b, c, d, k, r, v, best = null;
    for (s = 0; s < 4; s++) {
      var cs = fitSide(sidePoints(s % 2 === 0 ? g.gy : g.gx, w, h, s, T), rnd);
      if (!cs.length) return null;
      cand.push(cs);
    }
    // Alle Kombinationen (höchstens 4⁴ = 256): beste gültige gewinnt
    for (a = 0; a < cand[0].length; a++) for (b = 0; b < cand[1].length; b++)
      for (c = 0; c < cand[2].length; c++) for (d = 0; d < cand[3].length; d++) {
        var pick = [cand[0][a], cand[1][b], cand[2][c], cand[3][d]];
        if ((pick[0].n + pick[1].n + pick[2].n + pick[3].n) / (4 * SCAN) < MIN_SCORE) continue;
        r = quadRatio(cornersOf(pick.map(function (p) { return p.line; })), w, h, aspect, aspectTol, minArea);
        if (r == null) continue;
        v = (pick[0].n + pick[1].n + pick[2].n + pick[3].n) * (1 - Math.abs(r - aspect) / aspectTol * 0.5);
        if (!best || v > best.v) best = { v: v, pick: pick };
      }
    if (!best) return null;
    // Außenrand: je Seite der Gewinnerkombination der äußerste parallele Kandidat, der die Karte gültig lässt
    var pk = best.pick.slice(), q = cornersOf(pk.map(function (p) { return p.line; })), dm = dims(q);
    var OUT = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    var TR = Math.max(T_MIN, percentile(g, w, h, REF_PCT)), rcand = [];
    for (s = 0; s < 4; s++) rcand.push(fitSide(sidePoints(s % 2 === 0 ? g.gy : g.gx, w, h, s, TR), rnd));
    for (s = 0; s < 4; s++) {
      var cur = pk[s], lim = REFINE * (s % 2 === 0 ? dm[0] : dm[1]), bestK = null, bestOff = 0;
      for (k = 0; k < rcand[s].length; k++) {
        var kc = rcand[s][k];
        if (kc === cur || kc.n < REF_SUPPORT * cur.n || !parallel(kc.line, cur.line)) continue;
        var off = (kc.mx - cur.mx) * OUT[s][0] + (kc.my - cur.my) * OUT[s][1];
        if (off <= 0 || off > lim || off <= bestOff) continue;
        var trial = pk.slice(); trial[s] = kc;
        if (quadRatio(cornersOf(trial.map(function (p) { return p.line; })), w, h, aspect, aspectTol, minArea) == null) continue;
        bestK = kc; bestOff = off;
      }
      if (bestK) pk[s] = bestK;
    }
    var total = pk[0].n + pk[1].n + pk[2].n + pk[3].n;
    return { corners: cornersOf(pk.map(function (p) { return p.line; })), score: total / (4 * SCAN) };
  }

  // Gauß mit Spaltenpivotsuche; null bei singulärem System
  function solve(A, b) {
    var n = b.length, M = A.map(function (r, i) { return r.concat([b[i]]); }), i, j, k, p, t, f, s;
    for (k = 0; k < n; k++) {
      p = k;
      for (i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
      t = M[k]; M[k] = M[p]; M[p] = t;
      if (Math.abs(M[k][k]) < 1e-12) return null;
      for (i = k + 1; i < n; i++) {
        f = M[i][k] / M[k][k];
        for (j = k; j <= n; j++) M[i][j] -= f * M[k][j];
      }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      s = M[i][n];
      for (j = i + 1; j < n; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return x;
  }
  // Homographie H (9 Werte, H[8] = 1) mit H·src = dst für vier Punktpaare
  function homography(src, dst) {
    var A = [], b = [], i, x, y, X, Y;
    for (i = 0; i < 4; i++) {
      x = src[i][0]; y = src[i][1]; X = dst[i][0]; Y = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
    }
    var h = solve(A, b);
    return h ? h.concat([1]) : null;
  }

  /* Perspektivische Entzerrung: corners (Pixel von src, gleiche Reihenfolge wie detectCard) auf dw×dh.
   * src: RGBA- oder RGB-Pixel (ch Werte je Pixel), bilinear gelesen. Ergebnis: Uint8ClampedArray RGBA (dw×dh), null bei Fehler. */
  function warpCard(src, sw, sh, corners, dw, dh, ch) {
    ch = ch || 4;
    var H = homography([[0, 0], [dw - 1, 0], [dw - 1, dh - 1], [0, dh - 1]], corners);
    if (!H) return null;
    var out = new Uint8ClampedArray(dw * dh * 4), x, y, o = 0, c;
    for (y = 0; y < dh; y++) for (x = 0; x < dw; x++, o += 4) {
      var d = H[6] * x + H[7] * y + 1;
      var u = clamp((H[0] * x + H[1] * y + H[2]) / d, 0, sw - 1);
      var v = clamp((H[3] * x + H[4] * y + H[5]) / d, 0, sh - 1);
      var x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      var fx = u - x0, fy = v - y0;
      var i00 = (y0 * sw + x0) * ch, i10 = (y0 * sw + x1) * ch, i01 = (y1 * sw + x0) * ch, i11 = (y1 * sw + x1) * ch;
      for (c = 0; c < 3; c++) {
        var top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        var bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
    return out;
  }

  /* Schärfe: Varianz des 4-Nachbar-Laplace über das Bild (Ränder ausgenommen). */
  function sharpness(gray, w, h) {
    var s1 = 0, s2 = 0, n = 0, x, y, i, L;
    for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
      i = y * w + x;
      L = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      s1 += L; s2 += L * L; n++;
    }
    if (!n) return 0;
    var m = s1 / n;
    return s2 / n - m * m;
  }

  var api = { detectCard: detectCard, warpCard: warpCard, sharpness: sharpness };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WowCardDetect = api;
})(this);
