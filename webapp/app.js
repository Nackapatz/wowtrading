/* WoW Preis-Scanner – Web-App (Vanilla JS, ES2020, kein Build-Schritt).
 * Spec: docs/SPEC.md, Abschnitt 2 (Web-App) und 3 (Datenformate). */
(() => {
'use strict';

/* ============================================================
 * Konstanten und Hilfsfunktionen
 * ============================================================ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u : '');
const round2 = (v) => Math.round(v * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const MAX_SCANS = 2000;
const SOURCE = 'TCGplayer via tcgcsv.com';
const LS_UI = 'wowscan.ui';
const LS_SET = 'wowscan.settings';
const LS_CAL = 'wowscan.calib';
const INSECURE_MSG = 'Die Kamera braucht eine sichere Verbindung (HTTPS). Öffne die Seite über https://<IP-des-Scanners>/ und bestätige die Zertifikatswarnung deines Browsers (z. B. „Erweitert“ → „Weiter zu … (unsicher)“). Das Zertifikat erzeugt dein Scanner selbst, deshalb warnt der Browser.';

// Land → [Name, Währung]
const COUNTRIES = [
  ['DE', 'Deutschland', 'EUR'], ['AT', 'Österreich', 'EUR'], ['CH', 'Schweiz', 'CHF'], ['US', 'USA', 'USD'], ['GB', 'Vereinigtes Königreich', 'GBP'],
  ['FR', 'Frankreich', 'EUR'], ['IT', 'Italien', 'EUR'], ['ES', 'Spanien', 'EUR'], ['NL', 'Niederlande', 'EUR'], ['BE', 'Belgien', 'EUR'],
  ['IE', 'Irland', 'EUR'], ['FI', 'Finnland', 'EUR'], ['PT', 'Portugal', 'EUR'], ['GR', 'Griechenland', 'EUR'], ['LU', 'Luxemburg', 'EUR'],
  ['SK', 'Slowakei', 'EUR'], ['SI', 'Slowenien', 'EUR'], ['EE', 'Estland', 'EUR'], ['LV', 'Lettland', 'EUR'], ['LT', 'Litauen', 'EUR'],
  ['PL', 'Polen', 'PLN'], ['CZ', 'Tschechien', 'CZK'], ['SE', 'Schweden', 'SEK'], ['DK', 'Dänemark', 'DKK'], ['NO', 'Norwegen', 'NOK'],
  ['HU', 'Ungarn', 'HUF'], ['JP', 'Japan', 'JPY'], ['CA', 'Kanada', 'CAD'], ['AU', 'Australien', 'AUD'],
];
const CUR_OF = Object.fromEntries(COUNTRIES.map(([c, , cur]) => [c, cur]));
const EURO_COMMA = new Set(['EUR', 'CHF', 'PLN', 'CZK', 'SEK', 'DKK', 'NOK', 'HUF']);
const PT_LABEL = { market: 'Marktpreis', low: 'Tiefstpreis', mid: 'Mittelpreis' };
const PT_IDX = { market: 0, low: 1, mid: 2 };

const fmtMoney = (v, cur) => (typeof v !== 'number' ? 'kein Preis'
  : new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur, maximumFractionDigits: cur === 'JPY' ? 0 : 2 }).format(v));
function fmtDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (s ? String(s) : '–');
}
function fmtUptime(sec) {
  const s = Number(sec) || 0;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}
function priceLabel(pt, cur, date) {
  return `TCGplayer-${PT_LABEL[pt] || PT_LABEL.market} (US)${cur === 'USD' ? '' : ', umgerechnet'}, Stand ${fmtDate(date)}`;
}
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
// OCR-Kalibrierung: Verschiebung der Ausschnitte in Prozent der Kartenhöhe (-10..10) + Debug-Schalter
function loadCal() {
  const c = lsGet(LS_CAL) || {};
  const clamp = (v) => Math.min(10, Math.max(-10, Math.round(Number(v) || 0)));
  return { nameOff: clamp(c.nameOff), numOff: clamp(c.numOff), debug: !!c.debug };
}
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* Speicher gesperrt: egal */ } }

/* ============================================================
 * Zustand
 * ============================================================ */
const S = {
  settings: { country: 'DE', currency: 'EUR', dataUrl: '' },
  ui: { priceType: 'market', foil: false, cond: 'NM', ...(lsGet(LS_UI) || {}) },
  cal: loadCal(),
  esp: null,
  data: null,          // { meta, cards, prices, rates }
  idx: null,           // Suchindex (vorberechnet)
  base: '',
  scans: [],           // vom ESP, neueste zuerst
  lastId: null,
  res: [],             // Suchtreffer
  sugg: [],            // Vorschläge (mittlere Sicherheit)
  dlgCard: null,
  // Scan-Schleife
  scanning: false, stream: null, worker: null, ocrP: null, busy: false, loopId: 0,
  guide: null, locked: null, others: 0, streak: 0, streakPid: null, wake: null, ac: null,
  searchTmr: 0,
};

/* ============================================================
 * Meldungen
 * ============================================================ */
const banners = new Map();
function setBanner(key, kind, text) {
  if (text) banners.set(key, { kind, text }); else banners.delete(key);
  const box = $('#banner');
  box.innerHTML = '';
  for (const b of banners.values()) {
    const d = document.createElement('div');
    d.className = 'banner ' + b.kind;
    d.textContent = b.text;
    box.append(d);
  }
  box.hidden = banners.size === 0;
}
let toastTmr = 0;
function toast(text, kind = '') {
  const t = $('#toast');
  t.className = 'toast ' + kind;
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTmr);
  toastTmr = setTimeout(() => { t.hidden = true; }, 2800);
}
function setPill(ok, text) { const p = $('#espPill'); p.className = 'pill ' + (ok ? 'ok' : 'err'); p.textContent = text; }
function setLive(text) { $('#live').textContent = text || ''; }
function camMsg(text, err = false) {
  const m = $('#camMsg');
  m.textContent = text || '';
  m.className = 'cam-msg' + (err ? ' err' : '');
  m.hidden = !text;
}

/* ============================================================
 * HTTP: ESP-API und Datendateien
 * ============================================================ */
// ESP8266 bedient nur einen Client gleichzeitig: alle API-Aufrufe laufen strikt nacheinander.
let apiQueue = Promise.resolve();
let apiInFlight = 0, apiMaxInFlight = 0;
function api(method, path, body) {
  const job = () => apiDo(method, path, body);
  const p = apiQueue.then(job, job);
  apiQueue = p.then(() => undefined, () => undefined);
  return p;
}
async function apiDo(method, path, body) {
  apiInFlight++; apiMaxInFlight = Math.max(apiMaxInFlight, apiInFlight);
  try { return await apiRequest(method, path, body); } finally { apiInFlight--; }
}
async function apiRequest(method, path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const init = { method, cache: 'no-store', signal: ctl.signal };
    if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
    const r = await fetch(path, init);
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch { /* kein JSON */ }
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return await r.json();
  } catch (e) {
    if (e.status) throw e;
    if (e.name === 'AbortError') throw new Error('Scanner antwortet nicht (Zeitüberschreitung)');
    throw new Error('Scanner nicht erreichbar. Prüfe WLAN und die Adresse https://<IP>/');
  } finally { clearTimeout(timer); }
}
async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { cache: 'no-cache', signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} bei ${new URL(url).pathname}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
function dataBase(u) {
  const t = String(u || '').trim();
  if (!t) return '';
  return new URL(t.endsWith('/') ? t : t + '/', location.href).href;
}

/* ============================================================
 * IndexedDB-Cache (Schlüssel: meta.generatedAt + Basis-URL)
 * ============================================================ */
let dbP = null;
function openDb() {
  if (!dbP) dbP = new Promise((res, rej) => {
    if (!self.indexedDB) { rej(new Error('IndexedDB fehlt')); return; }
    const r = indexedDB.open('wowscan', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('data');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbP;
}
function idbTx(mode, fn) {
  return openDb().then((db) => new Promise((res, rej) => {
    const tx = db.transaction('data', mode);
    const rq = fn(tx.objectStore('data'));
    tx.oncomplete = () => res(rq ? rq.result : undefined);
    tx.onerror = tx.onabort = () => rej(tx.error || new Error('IndexedDB-Fehler'));
  }));
}
const cacheGet = (k) => idbTx('readonly', (s) => s.get(k));
const cachePut = (k, v) => idbTx('readwrite', (s) => s.put(v, k));
const cacheDel = (k) => idbTx('readwrite', (s) => s.delete(k));
const cacheKeys = () => idbTx('readonly', (s) => s.getAllKeys());
async function cleanupCache(keep) {
  for (const k of await cacheKeys()) if (k !== keep && k !== 'latest') await cacheDel(k);
}

/* ============================================================
 * Kartendaten laden
 * ============================================================ */
async function loadData(force = false) {
  let base = '';
  try { base = dataBase(S.settings.dataUrl); } catch { base = ''; }
  if (!base) {
    S.data = null; S.idx = null;
    setBanner('data', 'err', S.espOk
      ? 'Keine gültige Daten-URL. Bitte unter „Einstellungen“ eintragen.'
      : 'Scanner nicht erreichbar, die Daten-URL ist unbekannt. Prüfe WLAN und die Adresse des Scanners.');
    renderScanInfo();
    return false;
  }
  S.base = base;
  setBanner('data', '', '');
  setInfo('Lade Kartendaten …');
  let set = null, note = '';
  try {
    const meta = await getJson(base + 'meta.json');
    const key = meta.generatedAt + '|' + base;
    if (!force) set = await cacheGet(key).catch(() => null);
    if (!set) {
      setInfo('Lade cards.json, prices.json, rates.json …');
      const [cards, prices, rates] = await Promise.all(['cards.json', 'prices.json', 'rates.json'].map((f) => getJson(base + f)));
      set = { meta, cards, prices, rates };
      try { await cachePut(key, set); await cachePut('latest', key); await cleanupCache(key); } catch { /* ohne Cache weiter */ }
    }
  } catch (e) {
    const latest = await cacheGet('latest').catch(() => null);
    set = latest ? await cacheGet(latest).catch(() => null) : null;
    if (set) note = `Offline: gecachte Daten vom ${fmtDate(set.meta.generatedAt)} werden genutzt.`;
    else {
      S.data = null; S.idx = null;
      setBanner('data', 'err', `Kartendaten konnten nicht geladen werden (${e.message}). Internetverbindung prüfen. Keine gecachten Daten vorhanden.`);
      setInfo('Keine Kartendaten.');
      renderScanInfo();
      return false;
    }
  }
  S.data = set;
  buildIndex();
  setBanner('data', note ? 'warn' : '', note);
  renderAll();
  return true;
}

/* ============================================================
 * Fuzzy-Matching
 * ============================================================ */
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120).trim();
function trigrams(s) {
  const p = ' ' + s + ' ';
  const a = [];
  for (let i = 0; i < p.length - 2; i++) a.push(p.charCodeAt(i) * 65536 + p.charCodeAt(i + 1) * 256 + p.charCodeAt(i + 2));
  a.sort((x, y) => x - y);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (i === 0 || a[i] !== a[i - 1]) a[n++] = a[i];
  return Int32Array.from(a.slice(0, n));
}
function interCount(a, b) {
  let i = 0, j = 0, c = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { c++; i++; j++; } else if (a[i] < b[j]) i++; else j++;
  }
  return c;
}
const ROW_A = new Int32Array(128), ROW_B = new Int32Array(128);
// Levenshtein mit Abbruch, sobald die Distanz sicher über max liegt. Gibt max+1 bei Abbruch zurück.
function lev(a, b, max) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0 || lb === 0) return Math.max(la, lb);
  let prev = ROW_A, cur = ROW_B;
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let min = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      let v = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = prev[j] + 1; if (del < v) v = del;
      const ins = cur[j - 1] + 1; if (ins < v) v = ins;
      cur[j] = v;
      if (v < min) min = v;
    }
    if (min > max) return max + 1;
    const t = prev; prev = cur; cur = t;
  }
  return prev[lb];
}
function numKey(s) {
  const t = String(s ?? '');
  const m = /(\d{1,3})\s*\/\s*\d{1,3}/.exec(t) || /(\d{1,4})/.exec(t);
  return m ? parseInt(m[1], 10) : -1;
}
function buildIndex() {
  const t0 = performance.now();
  const cards = S.data.cards.cards || [];
  const n = cards.length;
  const names = new Array(n), lens = new Uint16Array(n), tris = new Array(n), nums = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const nm = norm(cards[i].n);
    names[i] = nm; lens[i] = nm.length; tris[i] = trigrams(nm); nums[i] = numKey(cards[i].num);
  }
  S.idx = { cards, names, lens, tris, nums, n, ms: performance.now() - t0 };
}
const MIN_SIM = 0.5;
/* Liefert die besten Kandidaten {card, score} (score 0..1). Reihenfolge: Länge → Trigramme → Levenshtein. */
function matchName(nameText, numText = '') {
  const t0 = performance.now();
  const idx = S.idx;
  const q = norm(nameText);
  if (!idx || q.length < 3) return { ranked: [], ms: 0 };
  const qt = trigrams(q), ql = q.length, nk = numKey(numText);
  const hits = [];
  for (let i = 0; i < idx.n; i++) {
    const L = idx.lens[i];
    const maxL = L > ql ? L : ql;
    const maxD = Math.floor((1 - MIN_SIM) * maxL);
    if (Math.abs(L - ql) > maxD) continue;
    const ti = idx.tris[i];
    const inter = interCount(qt, ti);
    if (inter === 0 || (2 * inter) / (qt.length + ti.length) < 0.2) continue;
    const d = lev(q, idx.names[i], maxD);
    if (d > maxD) continue;
    hits.push({ i, sim: 1 - d / maxL });
  }
  hits.sort((a, b) => b.sim - a.sim);
  const top = hits.slice(0, 12);
  // Nummer verfeinert nur bei (fast) gleichen Namens-Treffern
  if (nk >= 0 && top.length) {
    const best = top[0].sim;
    for (const h of top) if (h.sim >= best - 0.03 && idx.nums[h.i] === nk) h.sim = Math.min(1, h.sim + 0.03);
    top.sort((a, b) => b.sim - a.sim);
  }
  return { ranked: top.slice(0, 10).map((h) => ({ card: idx.cards[h.i], score: h.sim })), ms: performance.now() - t0 };
}

/* ============================================================
 * Preise
 * ============================================================ */
// Subtyp wählen: Foil-Wunsch → erster /foil/i-Schlüssel; sonst "Normal", sonst erster Nicht-Foil-Schlüssel; einziger Schlüssel gilt immer.
function pickSub(keys, foil) {
  if (!keys.length) return null;
  if (keys.length === 1) return keys[0];
  if (foil) { const f = keys.find((k) => /foil/i.test(k)); if (f) return f; }
  if (keys.includes('Normal')) return 'Normal';
  return keys.find((k) => !/foil/i.test(k)) ?? keys[0];
}
function priceInfo(card, foil, pt = S.ui.priceType, cur = S.settings.currency) {
  const pe = S.data && S.data.prices && S.data.prices.prices ? S.data.prices.prices[card.p] : null;
  const keys = pe ? Object.keys(pe) : [];
  const sub = pickSub(keys, foil);
  const arr = pe && sub != null ? pe[sub] : null;
  const raw = Array.isArray(arr) ? arr[PT_IDX[pt]] : null;
  const usd = typeof raw === 'number' && isFinite(raw) ? raw : null;
  let value = null, note = '';
  if (usd != null) {
    const rate = cur === 'USD' ? 1 : (S.data && S.data.rates && S.data.rates.rates ? S.data.rates.rates[cur] : undefined);
    if (typeof rate === 'number') value = round2(usd * rate);
    else note = `kein Umrechnungskurs für ${cur}`;
  } else {
    note = pe ? `kein Preis für ${sub}-Druck` : 'Keine Preisdaten für dieses Produkt';
  }
  return {
    sub, single: keys.length === 1, isFoil: sub != null && /foil/i.test(sub), usd, value, pt, cur, note,
    date: (S.data && S.data.prices && S.data.prices.priceDate) || (S.data && S.data.meta && S.data.meta.priceDate) || '',
  };
}
function priceBlockHtml(pi) {
  if (pi.value == null) return `<div class="price none">kein Preis</div><div class="src">${esc(pi.note)}</div>`;
  return `<div class="price num">${esc(fmtMoney(pi.value, pi.cur))}</div><div class="src">${esc(priceLabel(pi.pt, pi.cur, pi.date))}</div>`;
}
function priceShort(r) {
  return typeof r.price === 'number' ? esc(fmtMoney(r.price, r.currency)) : 'kein Preis';
}

/* Scan-Datensatz (Feldnamen exakt nach Spec, Abschnitt 1) */
function buildRecord(card, { foil, cond, qty = 1, ocr = null }) {
  const pi = priceInfo(card, foil);
  const x = card.x || {};
  return {
    ts: new Date().toISOString(),
    productId: card.p, name: card.n, set: card.s, setCode: card.sc, number: card.num, rarity: card.r, type: card.t,
    cardClass: x.Class ?? null, faction: x.Faction ?? null, cost: x.Cost ?? null, atk: x.ATK ?? null, health: x.Health ?? null,
    foil: pi.sub != null ? pi.isFoil : !!foil,
    condition: cond, qty,
    priceUsd: pi.usd, price: pi.value, currency: pi.cur, priceType: pi.pt,
    priceDate: pi.date || null, source: SOURCE,
    url: safeUrl(card.u) || null, imageUrl: safeUrl(card.img) || null,
    ocrConfidence: ocr,
  };
}

/* ============================================================
 * Scan-Erfassung
 * ============================================================ */
async function captureCard(card, opts = {}) {
  const foil = opts.foil ?? S.ui.foil;
  const cond = opts.cond ?? S.ui.cond;
  if (S.scans.length >= MAX_SCANS) { toast('Speicher voll: maximal 2000 Scans. Bitte Einträge löschen.', 'err'); return null; }
  const rec = buildRecord(card, { foil, cond, qty: opts.qty || 1, ocr: opts.ocr ?? null });
  try {
    const res = await api('POST', 'api/scan', rec);
    rec.id = res.id;
    S.scans.unshift(rec);
    S.lastId = rec.id;
    feedback(rec);
    renderAll();
    return rec;
  } catch (e) {
    const msg = e.status === 507 ? 'Speicher des Scanners voll (max. 2000 Scans).' : e.message;
    toast(`Speichern fehlgeschlagen: ${msg}`, 'err');
    return null;
  }
}
function feedback(rec) {
  try { navigator.vibrate && navigator.vibrate(60); } catch { /* ok */ }
  beep();
  toast(`Erfasst: ${rec.name}${typeof rec.price === 'number' ? ' · ' + fmtMoney(rec.price, rec.currency) : ' · kein Preis'}`);
}
function beep() {
  try {
    const AC = self.AudioContext || self.webkitAudioContext;
    if (!AC) return;
    S.ac = S.ac || new AC();
    const o = S.ac.createOscillator(), g = S.ac.createGain();
    o.frequency.value = 880; g.gain.value = 0.15;
    o.connect(g); g.connect(S.ac.destination);
    o.start(); o.stop(S.ac.currentTime + 0.12);
  } catch { /* Ton ist optional */ }
}

/* ============================================================
 * OCR (Tesseract.js, ein Worker, lazy)
 * ============================================================ */
function loadScript(src) {
  return new Promise((res, rej) => {
    if (self.Tesseract) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => (self.Tesseract ? res() : rej(new Error('Bibliothek leer')));
    s.onerror = () => rej(new Error('CDN nicht erreichbar'));
    document.head.append(s);
  });
}
function ensureOcr() {
  if (S.worker) return Promise.resolve(S.worker);
  if (!S.ocrP) {
    S.ocrP = loadScript(TESS_URL)
      .then(() => self.Tesseract.createWorker('eng', 1, {
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
        corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
        langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
      }))
      .then((w) => { S.worker = w; return w; })
      .catch((e) => { S.ocrP = null; throw new Error(e.message); });
  }
  return S.ocrP;
}
// Kartenrahmen in Videokoordinaten (S.guide), Zuschnitt + Graustufen/Kontrast in Canvas
const NAME_BOX = { x: 0.06, y: 0.08, w: 0.88, h: 0.14 };
const NUM_BOX = { x: 0.08, y: 0.86, w: 0.84, h: 0.10 };
const boxY = (box, off) => Math.min(Math.max(box.y + off / 100, 0), 1 - box.h);
function cropTo(cv, box, off, targetW) {
  const g = S.guide;
  const sw = g.w * box.w, sh = g.h * box.h;
  const sx = g.x + g.w * box.x, sy = g.y + g.h * boxY(box, off);
  const video = $('#video');
  const w = Math.round(targetW), h = Math.max(24, Math.round(targetW * sh / sw));
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  const im = ctx.getImageData(0, 0, w, h), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    let v = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    v = (v - 128) * 1.6 + 128;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(im, 0, 0);
  return cv;
}
const cvName = $('#cvName'), cvNum = $('#cvNum');
async function scanFrame() {
  if (!S.guide || !S.worker) return;
  cropTo(cvName, NAME_BOX, S.cal.nameOff, 900);
  cropTo(cvNum, NUM_BOX, S.cal.numOff, 700);
  const w = S.worker;
  // Sequenziell: erst Name (ohne Whitelist), dann Nummer (Whitelist 0-9 und /)
  await w.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '' });
  const a = await w.recognize(cvName);
  await w.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789/' });
  const b = await w.recognize(cvNum);
  const name = String((a.data && a.data.text) || '').replace(/\s+/g, ' ').trim();
  const num = String((b.data && b.data.text) || '').trim();
  const conf = (a.data && a.data.confidence) || 0;
  const m = matchName(name, num);
  S.dbg = { name, num, conf, top: m.ranked[0] || null };
  renderDbg();
  await onFrame(m, name, num, conf);
}
function renderDbg() {
  $('#dbg').hidden = !S.cal.debug;
  if (!S.cal.debug || !S.dbg) return;
  const d = S.dbg;
  $('#dbgTxt').textContent = `Name roh: "${d.name}" (Konfidenz ${Math.round(d.conf)})\n`
    + `Nummer roh: "${d.num}"\n`
    + `Treffer: ${d.top ? `${d.top.card.n} (${Math.round(d.top.score * 100)} %)` : '–'}`;
}

/* Stabilitätsregel: gleiche Karte in 2 aufeinanderfolgenden Frames (>= 0,8) erfassen;
 * danach gesperrt, bis 2 Frames lang keine bzw. eine andere Karte erkannt wurde. */
async function onFrame(m, name, num, conf) {
  const c = m.ranked[0];
  const sc = c ? c.score : 0;
  const pct = Math.round(sc * 100);
  if (S.locked !== null) {
    if (c && c.card.p === S.locked && sc >= 0.6) { S.others = 0; setLive(`Erfasst: ${c.card.n}. Nächste Karte auflegen.`); return; }
    if (++S.others < 2) return;
    S.locked = null; S.others = 0;
  }
  if (c && sc >= 0.8) {
    if (S.streakPid === c.card.p) S.streak++;
    else { S.streakPid = c.card.p; S.streak = 1; }
    hideSuggest();
    if (S.streak >= 2) {
      S.streak = 0; S.streakPid = null;
      S.locked = c.card.p; S.others = 0;
      setLive(`Erkannt: ${c.card.n}`);
      const rec = await captureCard(c.card, { ocr: Math.round(conf) });
      if (!rec) S.locked = null;
      return;
    }
    setLive(`Erkannt: ${c.card.n} (${pct} %), Bestätigung …`);
    return;
  }
  S.streak = 0; S.streakPid = null;
  if (c && sc >= 0.6) {
    setLive(`Unsicher: ${pct} % – bitte Vorschlag wählen`);
    showSuggest(m.ranked.filter((r) => r.score >= 0.6).slice(0, 3));
  } else {
    hideSuggest();
    setLive(name ? `Gelesen: „${name}“` : 'Suche Karte …');
  }
}

function showSuggest(list) {
  S.sugg = list;
  $('#chips').innerHTML = list.map((r, i) => `<button class="chip" type="button" data-si="${i}">
      ${esc(r.card.n)}<b>${Math.round(r.score * 100)} %</b>
      <small>${esc(r.card.s)} · #${esc(r.card.num)} · ${esc(priceShort({ price: priceInfo(r.card, S.ui.foil).value, currency: S.settings.currency }))}</small></button>`).join('');
  $('#suggest').hidden = list.length === 0;
}
function hideSuggest() { $('#suggest').hidden = true; S.sugg = []; }

function layoutGuide() {
  const cam = $('#cam'), video = $('#video'), g = $('#guide');
  const cw = cam.clientWidth, ch = cam.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
  if (!cw || !ch || !vw || !vh) return;
  const gh = Math.min(ch * 0.74, cw * 0.9 * 88 / 63), gw = gh * 63 / 88;
  const gx = (cw - gw) / 2, gy = (ch - gh) / 2;
  Object.assign(g.style, { left: gx + 'px', top: gy + 'px', width: gw + 'px', height: gh + 'px' });
  // object-fit: cover → Abbildung Container ↔ Video
  const s = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
  S.guide = { x: (gx - ox) / s, y: (gy - oy) / s, w: gw / s, h: gh / s };
  placeBox($('#boxName'), NAME_BOX, S.cal.nameOff, gx, gy, gw, gh);
  placeBox($('#boxNum'), NUM_BOX, S.cal.numOff, gx, gy, gw, gh);
}
function placeBox(el, box, off, gx, gy, gw, gh) {
  Object.assign(el.style, { left: gx + gw * box.x + 'px', top: gy + gh * boxY(box, off) + 'px', width: gw * box.w + 'px', height: gh * box.h + 'px' });
}

function camErrText(e) {
  switch (e && e.name) {
    case 'NotAllowedError': case 'SecurityError':
      return 'Kamerazugriff verweigert. Erlaube die Kamera für diese Seite in den Browser-Einstellungen und lade die Seite neu.';
    case 'NotFoundError': case 'OverconstrainedError':
      return 'Keine passende Kamera gefunden.';
    case 'NotReadableError':
      return 'Die Kamera ist belegt. Schließe andere Apps oder Tabs, die die Kamera nutzen.';
    default:
      return `Kamera konnte nicht gestartet werden (${(e && e.message) || e}).`;
  }
}
function camEnvError() {
  if (!window.isSecureContext) return INSECURE_MSG;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'Dieser Browser kann keine Kamera nutzen. Bitte Chrome (Android) oder Safari (iOS) verwenden.';
  return null;
}
async function keepAwake(on) {
  try {
    if (on && navigator.wakeLock) S.wake = await navigator.wakeLock.request('screen');
    else if (!on && S.wake) { await S.wake.release(); S.wake = null; }
  } catch { /* optional */ }
}

async function startScan() {
  if (S.scanning) return;
  const env = camEnvError();
  if (env) { camMsg(env, true); return; }
  const video = $('#video');
  camMsg('Kamera wird gestartet …');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (e) { camMsg(camErrText(e), true); return; }
  S.stream = stream;
  video.srcObject = stream;
  video.hidden = false;
  camMsg('');
  try { await video.play(); } catch { /* Autoplay: playsinline + muted */ }
  await Promise.race([
    new Promise((r) => { if (video.videoWidth) r(); else video.addEventListener('loadedmetadata', r, { once: true }); }),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
  S.scanning = true;
  $('#btnScan').textContent = 'Scan stoppen';
  $('#btnScan').setAttribute('aria-pressed', 'true');
  $('#guide').hidden = false;
  $('#boxName').hidden = false; $('#boxNum').hidden = false;
  layoutGuide();
  renderDbg();
  keepAwake(true);
  setLive('Lade Texterkennung (einmalig, ca. 2 MB) …');
  try {
    await ensureOcr();
    setBanner('ocr', '', '');
  } catch (e) {
    setLive('');
    setBanner('ocr', 'err', `Texterkennung nicht verfügbar (${e.message}). Die Kamera läuft weiter; Karten lassen sich über die Suche erfassen.`);
    return;
  }
  if (!S.scanning) return;
  setLive('Suche Karte …');
  startLoop();
}
function startLoop() {
  const id = ++S.loopId;
  const step = async () => {
    if (!S.scanning || id !== S.loopId) return;
    if (!S.busy && S.worker && $('#video').videoWidth) {
      S.busy = true;
      try { await scanFrame(); } catch (e) { console.warn('Frame-Fehler', e); }
      finally { S.busy = false; }
    }
    if (S.scanning && id === S.loopId) setTimeout(step, 650);
  };
  step();
}
function stopScan() {
  S.scanning = false;
  S.loopId++;
  S.locked = null; S.streak = 0; S.streakPid = null;
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
  const v = $('#video');
  v.srcObject = null; v.hidden = true;
  $('#guide').hidden = true;
  $('#boxName').hidden = true; $('#boxNum').hidden = true;
  $('#btnScan').textContent = 'Scan starten';
  $('#btnScan').setAttribute('aria-pressed', 'false');
  setLive('');
  hideSuggest();
  camMsg('Kamera aus. Tippe auf „Scan starten“, um die Kartenerkennung zu starten.');
  keepAwake(false);
}

/* ============================================================
 * Sammlung: Änderungen, Summen, Export
 * ============================================================ */
async function setQty(id, qty) {
  const rec = id != null ? S.scans.find((r) => r.id === id) : null;
  if (!rec || qty < 1 || qty > 999) return;
  const old = rec.qty;
  rec.qty = qty;
  renderAll();
  try { await api('PATCH', `api/scans?id=${id}`, { qty }); }
  catch (e) { rec.qty = old; renderAll(); toast(`Menge nicht gespeichert: ${e.message}`, 'err'); }
}
async function deleteScan(id) {
  const rec = S.scans.find((r) => r.id === id);
  if (!rec || !confirm(`„${rec.name}“ aus der Sammlung löschen?`)) return;
  try {
    await api('DELETE', `api/scans?id=${id}`);
    S.scans = S.scans.filter((r) => r.id !== id);
    if (S.lastId === id) S.lastId = null;
    renderAll();
    toast('Gelöscht.');
  } catch (e) { toast(`Löschen fehlgeschlagen: ${e.message}`, 'err'); }
}
async function clearAll() {
  if (!S.scans.length || !confirm(`Alle ${S.scans.length} Einträge auf dem Scanner löschen? Das kann nicht rückgängig gemacht werden.`)) return;
  try {
    await api('DELETE', 'api/scans');
    S.scans = []; S.lastId = null;
    renderAll();
    toast('Alle Scans gelöscht.');
  } catch (e) { toast(`Löschen fehlgeschlagen: ${e.message}`, 'err'); }
}
async function refreshScans() {
  try {
    const arr = await api('GET', 'api/scans');
    S.scans = (Array.isArray(arr) ? arr : []).sort((a, b) => b.id - a.id);
    setPill(true, `Scanner online · ${S.scans.length} Scans`);
    S.espOk = true;
  } catch (e) {
    setPill(false, 'Scanner nicht erreichbar');
    toast(e.message, 'err');
  }
}

// Wert in der aktuellen Währung: gespeicherter Preis, sonst USD-Preis mit aktuellem Kurs.
function valueOf(rec) {
  const cur = S.settings.currency;
  if (rec.currency === cur && typeof rec.price === 'number') return rec.price;
  if (typeof rec.priceUsd === 'number') {
    const r = cur === 'USD' ? 1 : (S.data && S.data.rates && S.data.rates.rates ? S.data.rates.rates[cur] : undefined);
    if (typeof r === 'number') return round2(rec.priceUsd * r);
  }
  return null;
}
function summarize(list) {
  const out = { count: 0, total: 0, noPrice: 0, bySet: new Map(), byRar: new Map(), priced: [] };
  const add = (map, key, label, q, v) => {
    const g = map.get(key) || { label, q: 0, v: 0, np: 0 };
    g.q += q;
    if (v == null) g.np += q; else g.v += v;
    map.set(key, g);
  };
  for (const r of list) {
    const q = r.qty || 1, unit = valueOf(r), tot = unit == null ? null : unit * q;
    out.count += q;
    if (tot == null) out.noPrice += q; else out.total += tot;
    add(out.bySet, r.setCode || r.set || '?', r.set || r.setCode || '?', q, tot);
    add(out.byRar, r.rarity || '–', r.rarity || '–', q, tot);
    if (unit != null) out.priced.push({ r, unit });
  }
  out.total = round2(out.total);
  out.priced.sort((a, b) => b.unit - a.unit);
  return out;
}
function groupRows(map) {
  return [...map.values()].sort((a, b) => b.v - a.v || b.q - a.q).map((g) => `<tr>
    <td>${esc(g.label)}${g.np ? `<br><small class="muted">${g.np} ohne Preis</small>` : ''}</td>
    <td class="num">${g.q}</td>
    <td class="num">${esc(fmtMoney(round2(g.v), S.settings.currency))}</td></tr>`).join('')
    || '<tr><td colspan="3" class="muted">Keine Daten</td></tr>';
}
function renderColl() {
  const cur = S.settings.currency;
  const sm = summarize(S.scans);
  $('#totals').innerHTML = `
    <div class="stat"><div class="big num">${sm.count}</div><div class="lbl">Karten gesamt (${S.scans.length} Einträge)</div></div>
    <div class="stat"><div class="big num">${esc(fmtMoney(sm.total, cur))}</div><div class="lbl">Gesamtwert in ${esc(cur)}</div></div>
    <div class="stat wide"><div class="lbl">Preisart: ${esc(PT_LABEL[S.ui.priceType])}. Quelle: ${esc(priceLabel(S.ui.priceType, cur, S.data && S.data.prices ? S.data.prices.priceDate : ''))}.${sm.noPrice ? ` ${sm.noPrice} Karte(n) ohne Preis, nicht gezählt.` : ''}</div></div>`;
  $('#tSet').innerHTML = groupRows(sm.bySet);
  $('#tRar').innerHTML = groupRows(sm.byRar);
  $('#top10').innerHTML = sm.priced.slice(0, 10).map(({ r, unit }) => `<li>${esc(r.name)} <span class="muted">${esc(r.set)} · #${esc(r.number)}${r.foil ? ' · Foil' : ''}</span> – <strong>${esc(fmtMoney(unit, cur))}</strong></li>`).join('')
    || '<li class="muted">Noch keine bepreisten Karten.</li>';
  $('#scanList').innerHTML = S.scans.map((r) => itemHtml(r, true)).join('')
    || '<li class="muted">Noch keine Scans. Erfasse Karten im Tab „Scannen“ oder über die Suche.</li>';
}

const CSV_HEAD = ['id', 'Zeitstempel', 'Name', 'Set', 'Set-Kürzel', 'Nummer', 'Seltenheit', 'Typ', 'Klasse', 'Fraktion', 'Kosten', 'ATK', 'Leben',
  'Foil', 'Zustand', 'Menge', 'Preis USD', 'Preis', 'Währung', 'Preisart', 'Preisdatum', 'Quelle', 'URL', 'Bild-URL', 'OCR-Konfidenz', 'Wert gesamt'];
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvNum(v, comma) {
  if (typeof v !== 'number' || !isFinite(v)) return '';
  const s = v.toFixed(2);
  return comma ? s.replace('.', ',') : s;
}
function makeCsv(list) {
  const lines = [CSV_HEAD.join(';')];
  for (const r of list) {
    const comma = EURO_COMMA.has(r.currency);
    const total = typeof r.price === 'number' ? csvNum(r.price * (r.qty || 1), comma) : '';
    lines.push([
      r.id, r.ts, r.name, r.set, r.setCode, r.number, r.rarity, r.type, r.cardClass, r.faction, r.cost, r.atk, r.health,
      r.foil ? 'ja' : 'nein', r.condition, r.qty, csvNum(r.priceUsd, comma), csvNum(r.price, comma), r.currency,
      PT_LABEL[r.priceType] || r.priceType, r.priceDate, r.source, r.url, r.imageUrl, r.ocrConfidence, total,
    ].map(csvCell).join(';'));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
function makeJson(list) {
  return JSON.stringify({ exportedAt: new Date().toISOString(), currency: S.settings.currency, source: SOURCE, count: list.length, scans: list }, null, 2);
}
function makeReport() {
  const cur = S.settings.currency;
  const sm = summarize(S.scans);
  const L = [
    'WoW Preis-Scanner – Sammlungsbericht',
    `Erstellt: ${new Date().toLocaleString('de-DE')}`,
    '',
    `Karten gesamt: ${sm.count} (${S.scans.length} Einträge)`,
    `Gesamtwert: ${fmtMoney(sm.total, cur)}`,
  ];
  if (sm.noPrice) L.push(`Ohne Preis: ${sm.noPrice} Karte(n), nicht gezählt`);
  L.push(`Preisquelle: ${priceLabel(S.ui.priceType, cur, S.data && S.data.prices ? S.data.prices.priceDate : '')}`, '');
  const block = (title, map) => {
    L.push(title);
    for (const g of [...map.values()].sort((a, b) => b.v - a.v)) L.push(`  ${g.label}: ${g.q} Stk., ${fmtMoney(round2(g.v), cur)}`);
    L.push('');
  };
  block('Pro Set:', sm.bySet);
  block('Pro Seltenheit:', sm.byRar);
  L.push('Top 10 teuerste (Einzelpreis):');
  sm.priced.slice(0, 10).forEach(({ r, unit }, i) => L.push(`  ${i + 1}. ${r.name} (${r.set} #${r.number}${r.foil ? ', Foil' : ''}) – ${fmtMoney(unit, cur)}`));
  return L.join('\n') + '\n';
}
function deliver(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function exportFile(kind) {
  if (!S.scans.length) { toast('Keine Scans zum Exportieren.', 'err'); return; }
  const d = today();
  if (kind === 'csv') deliver(new Blob([makeCsv(S.scans)], { type: 'text/csv;charset=utf-8' }), `wow-sammlung-${d}.csv`);
  if (kind === 'json') deliver(new Blob([makeJson(S.scans)], { type: 'application/json;charset=utf-8' }), `wow-sammlung-${d}.json`);
  if (kind === 'txt') deliver(new Blob([makeReport()], { type: 'text/plain;charset=utf-8' }), `wow-bericht-${d}.txt`);
}
async function shareReport() {
  const text = makeReport();
  const title = 'WoW Preis-Scanner – Bericht';
  try {
    const file = new File([text], `wow-bericht-${today()}.txt`, { type: 'text/plain' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ title, files: [file] });
    else await navigator.share({ title, text });
  } catch (e) {
    if (e.name !== 'AbortError') toast('Teilen nicht möglich: ' + e.message, 'err');
  }
}

/* ============================================================
 * Listen, Ansichten
 * ============================================================ */
function itemHtml(r, coll) {
  const img = safeUrl(r.imageUrl);
  return `<li class="item" data-id="${r.id}">
    ${img ? `<img class="thumb" src="${esc(img)}" alt="" loading="lazy">` : '<div class="thumb" aria-hidden="true"></div>'}
    <div>
      <div class="name">${esc(r.name)}</div>
      <div class="sub">${esc(r.set)} · #${esc(r.number)} · ${esc(r.rarity)}${r.foil ? ' · Foil' : ''} · ${esc(r.condition)}</div>
      ${coll
        ? `<div class="qty"><button class="btn sm" type="button" data-act="dec" data-id="${r.id}" aria-label="Menge verringern">&minus;</button><output aria-label="Menge">${r.qty}</output><button class="btn sm" type="button" data-act="inc" data-id="${r.id}" aria-label="Menge erhöhen">+</button></div>`
        : `<div class="sub">Menge ${r.qty}</div>`}
    </div>
    <div class="amt ${typeof r.price === 'number' ? '' : 'none'}">${priceShort(r)}
      ${typeof r.price === 'number' ? '<div class="sub">je Karte</div>' : ''}
      ${coll ? `<div><button class="btn danger del" type="button" data-act="del" data-id="${r.id}">Löschen</button></div>` : ''}
    </div>
  </li>`;
}
function renderScan() {
  const el = $('#last');
  const rec = S.scans.find((r) => r.id === S.lastId);
  if (!rec) { el.hidden = true; el.innerHTML = ''; return; }
  const img = safeUrl(rec.imageUrl);
  const pi = { value: typeof rec.price === 'number' ? rec.price : null, cur: rec.currency, pt: rec.priceType, date: rec.priceDate, note: rec.priceUsd == null ? 'Keine Preisdaten für dieses Produkt' : 'Kein Umrechnungskurs' };
  el.hidden = false;
  el.innerHTML = `
    ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '<div class="thumb" aria-hidden="true"></div>'}
    <div>
      <h3>${esc(rec.name)}</h3>
      <div class="sub">${esc(rec.set)} · #${esc(rec.number)} · ${esc(rec.rarity)}</div>
      <div>${rec.foil ? '<span class="badge">Foil</span>' : ''}<span class="badge">${esc(rec.condition)}</span><span class="badge">Menge ${rec.qty}</span></div>
      ${priceBlockHtml(pi)}
    </div>
    <div class="row-actions"><button class="btn primary" type="button" data-act="plus1">+1 (Menge erhöhen)</button></div>`;
}
function renderRecent() {
  $('#recent').innerHTML = S.scans.slice(0, 5).map((r) => itemHtml(r, false)).join('')
    || '<li class="muted">Noch nichts erfasst.</li>';
}
function renderScanInfo() {
  if (!S.data) { setInfo('Keine Kartendaten geladen.'); return; }
  const n = S.data.cards.cards ? S.data.cards.cards.length : 0;
  const date = (S.data.prices && S.data.prices.priceDate) || S.data.meta.priceDate;
  setInfo(`${n} Karten · Preise Stand ${fmtDate(date)} · Währung ${S.settings.currency} · Abgleich gegen englische Namen`);
}
function setInfo(t) { $('#dataInfo').textContent = t; }
function renderEspInfo() {
  const e = S.esp;
  $('#espInfo').innerHTML = e
    ? [['Version', e.version], ['IP', e.ip], ['Hostname', e.hostname ? e.hostname + '.local' : '–'], ['Scans', e.scans],
      ['Freier Speicher', e.freeHeap != null ? e.freeHeap + ' B' : '–'], ['Laufzeit', fmtUptime(e.uptime)],
      ['Land / Währung', `${e.country} / ${e.currency}`]]
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')
    : '<dt>Status</dt><dd>Scanner nicht erreichbar</dd>';
}
function renderAll() {
  renderScan();
  renderRecent();
  renderColl();
  renderScanInfo();
}
function showView(name) {
  for (const v of ['scan', 'search', 'coll', 'set']) $('#v-' + v).hidden = v !== name;
  $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === name)));
  if (name === 'scan') requestAnimationFrame(layoutGuide);
  if (name === 'coll') refreshScans().then(renderAll);
  if (name === 'set') { renderSettings(); refreshStatus(); }
  window.scrollTo(0, 0);
}

/* ============================================================
 * Manuelle Suche und Detail-Dialog
 * ============================================================ */
function runSearch() {
  const q = $('#q').value;
  const info = $('#searchInfo'), list = $('#results');
  if (!S.idx) { info.textContent = 'Kartendaten werden geladen …'; list.innerHTML = ''; return; }
  const toks = norm(q).split(' ').filter(Boolean).map((t) => (/^\d+$/.test(t) ? String(parseInt(t, 10)) : t));
  if (!toks.length) {
    info.textContent = q.trim() ? 'Bitte Buchstaben oder Zahlen eingeben.' : 'Tippe einen Kartennamen ein.';
    list.innerHTML = ''; S.res = [];
    return;
  }
  const { cards, names, nums } = S.idx;
  const out = [];
  for (let i = 0; i < names.length && out.length < 40; i++) {
    const nm = names[i];
    if (toks.every((t) => nm.includes(t) || (/^\d+$/.test(t) && String(nums[i]) === t))) out.push({ card: cards[i], score: 1 });
  }
  let fuzzy = false;
  if (out.length < 3) {
    for (const r of matchName(q).ranked) if (!out.some((o) => o.card === r.card)) { out.push(r); fuzzy = true; }
  }
  S.res = out.slice(0, 40);
  info.textContent = S.res.length ? `${S.res.length} Treffer${fuzzy ? ' (inkl. unscharfer Treffer)' : ''}` : 'Keine Treffer.';
  list.innerHTML = S.res.map((r, i) => {
    const img = safeUrl(r.card.img);
    const pi = priceInfo(r.card, S.ui.foil);
    return `<li><button class="row-btn" type="button" data-ridx="${i}">
      ${img ? `<img class="thumb" src="${esc(img)}" alt="" loading="lazy">` : '<div class="thumb" aria-hidden="true"></div>'}
      <div><div class="name">${esc(r.card.n)}</div><div class="sub">${esc(r.card.s)} · #${esc(r.card.num)} · ${esc(r.card.r)}</div></div>
      <div class="amt ${pi.value == null ? 'none' : ''}">${pi.value == null ? 'kein Preis' : esc(fmtMoney(pi.value, pi.cur))}</div>
    </button></li>`;
  }).join('');
}
function renderDlgBody() {
  const card = S.dlgCard;
  if (!card) return;
  const foil = $('#dlgFoil').checked;
  const pi = priceInfo(card, foil);
  const extra = pi.single ? `<div class="src">Für dieses Produkt gibt es nur den Druck „${esc(pi.sub)}“; der Preis gilt dafür.</div>` : '';
  $('#dlgBody').innerHTML = `<div class="sub">${esc(card.s)} · #${esc(card.num)} · ${esc(card.r)} · ${esc(card.t || '')}</div>
    ${priceBlockHtml(pi)}${extra}`;
}
function openDetail(card) {
  S.dlgCard = card;
  $('#dlgTitle').textContent = card.n;
  $('#dlgFoil').checked = S.ui.foil;
  $('#dlgQty').value = 1;
  $('#dlgCond').value = S.ui.cond;
  renderDlgBody();
  $('#dlg').showModal();
}

/* ============================================================
 * Einstellungen
 * ============================================================ */
function renderCountrySelect() {
  $('#setCountry').innerHTML = COUNTRIES.map(([c, n]) => `<option value="${c}">${esc(n)} (${c})</option>`).join('');
}
function renderSettings() {
  $('#setCountry').value = S.settings.country;
  if (!$('#setCountry').value) $('#setCountry').value = 'DE';
  $('#setCur').textContent = CUR_OF[$('#setCountry').value] || S.settings.currency;
  $('#setPT').value = S.ui.priceType;
  $('#setFoil').checked = !!S.ui.foil;
  $('#setCond').value = S.ui.cond;
  $('#setDataUrl').value = S.settings.dataUrl || '';
  renderCal();
  renderEspInfo();
}
function renderCal() {
  $('#calNameS').value = S.cal.nameOff; $('#calNameV').textContent = S.cal.nameOff;
  $('#calNumS').value = S.cal.numOff; $('#calNumV').textContent = S.cal.numOff;
  $('#calDbg').checked = S.cal.debug;
}
function saveCal() { lsSet(LS_CAL, S.cal); }
function syncScanFoil() { $('#scanFoil').checked = !!S.ui.foil; }
async function loadSettings() {
  try {
    const s = await api('GET', 'api/settings');
    S.settings = { country: s.country || 'DE', currency: s.currency || CUR_OF[s.country] || 'EUR', dataUrl: s.dataUrl || '' };
    lsSet(LS_SET, S.settings);
    S.espOk = true;
  } catch {
    const cached = lsGet(LS_SET);
    if (cached) S.settings = cached;
  }
}
async function refreshStatus() {
  try {
    S.esp = await api('GET', 'api/status');
    setPill(true, `Scanner ${S.esp.ip} · ${S.esp.scans} Scans`);
    S.espOk = true;
  } catch (e) {
    S.esp = null;
    setPill(false, 'Scanner nicht erreichbar');
  }
  renderEspInfo();
}
async function saveSettings(ev) {
  ev.preventDefault();
  const country = $('#setCountry').value;
  const dataUrl = $('#setDataUrl').value.trim();
  let abs = '';
  try { abs = dataBase(dataUrl); } catch { abs = ''; }
  if (dataUrl && !abs) { toast('Daten-URL ist ungültig.', 'err'); return; }
  const prevUrl = S.settings.dataUrl;
  S.ui = { priceType: $('#setPT').value, foil: $('#setFoil').checked, cond: $('#setCond').value };
  lsSet(LS_UI, S.ui);
  syncScanFoil();
  const next = { country, currency: CUR_OF[country] || 'EUR', dataUrl };
  try {
    await api('POST', 'api/settings', next);
    toast('Einstellungen gespeichert.');
  } catch (e) {
    toast(`Am Scanner nicht gespeichert: ${e.message}. Lokal übernommen.`, 'err');
  }
  S.settings = next;
  lsSet(LS_SET, next);
  renderSettings();
  if (dataUrl !== prevUrl) await loadData(false);
  else renderAll();
}

/* ============================================================
 * Ereignisse
 * ============================================================ */
function bindUi() {
  $$('.tab').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#btnScan').addEventListener('click', () => (S.scanning ? stopScan() : startScan()));
  $('#scanFoil').addEventListener('change', (e) => { S.ui.foil = e.target.checked; lsSet(LS_UI, S.ui); });
  $('#chips').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-si]');
    if (!b) return;
    const r = S.sugg[Number(b.dataset.si)];
    hideSuggest();
    if (!r) return;
    S.locked = r.card.p; S.others = 0; S.streak = 0; S.streakPid = null;
    const rec = await captureCard(r.card, { ocr: null });
    if (!rec) S.locked = null;
  });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, id = Number(b.dataset.id);
    const rec = S.scans.find((r) => r.id === id);
    if (act === 'plus1') { const last = S.scans.find((r) => r.id === S.lastId); if (last) setQty(last.id, last.qty + 1); }
    else if (act === 'inc' && rec) setQty(id, rec.qty + 1);
    else if (act === 'dec' && rec) setQty(id, rec.qty - 1);
    else if (act === 'del') deleteScan(id);
  });
  $('#q').addEventListener('input', () => { clearTimeout(S.searchTmr); S.searchTmr = setTimeout(runSearch, 120); });
  $('#results').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ridx]');
    if (b) { const r = S.res[Number(b.dataset.ridx)]; if (r) openDetail(r.card); }
  });
  $('#dlgFoil').addEventListener('change', renderDlgBody);
  $('#dlgMinus').addEventListener('click', () => { const q = $('#dlgQty'); q.value = Math.max(1, Number(q.value) - 1); });
  $('#dlgPlus').addEventListener('click', () => { const q = $('#dlgQty'); q.value = Math.min(99, Number(q.value) + 1); });
  $('#dlgAdd').addEventListener('click', async () => {
    const qty = Math.min(99, Math.max(1, Math.floor(Number($('#dlgQty').value)) || 1));
    const card = S.dlgCard;
    $('#dlg').close();
    if (card) await captureCard(card, { foil: $('#dlgFoil').checked, cond: $('#dlgCond').value, qty });
  });
  $('#btnCsv').addEventListener('click', () => exportFile('csv'));
  $('#btnJson').addEventListener('click', () => exportFile('json'));
  $('#btnTxt').addEventListener('click', () => exportFile('txt'));
  $('#btnShare').addEventListener('click', shareReport);
  $('#btnRefresh').addEventListener('click', async () => { await refreshScans(); renderAll(); });
  $('#btnClear').addEventListener('click', clearAll);
  $('#setCountry').addEventListener('change', (e) => { $('#setCur').textContent = CUR_OF[e.target.value] || '–'; });
  $('#setForm').addEventListener('submit', saveSettings);
  $('#btnReloadData').addEventListener('click', () => loadData(true));
  $('#calNameS').addEventListener('input', (e) => { S.cal.nameOff = Number(e.target.value); $('#calNameV').textContent = S.cal.nameOff; saveCal(); layoutGuide(); });
  $('#calNumS').addEventListener('input', (e) => { S.cal.numOff = Number(e.target.value); $('#calNumV').textContent = S.cal.numOff; saveCal(); layoutGuide(); });
  $('#calDbg').addEventListener('change', (e) => { S.cal.debug = e.target.checked; saveCal(); renderDbg(); });
  $('#calReset').addEventListener('click', () => { S.cal.nameOff = 0; S.cal.numOff = 0; saveCal(); renderCal(); layoutGuide(); });
  // Bilder ohne Erfolg unsichtbar machen, Platz im Raster bleibt erhalten (kein Inline-Handler)
  document.addEventListener('error', (e) => { if (e.target && e.target.tagName === 'IMG') e.target.style.visibility = 'hidden'; }, true);
  $('#video').addEventListener('resize', layoutGuide);
  window.addEventListener('resize', layoutGuide);
  window.addEventListener('online', () => { refreshStatus(); if (!S.data) loadData(); });
  window.addEventListener('offline', () => setBanner('net', 'warn', 'Keine Internetverbindung. Gecachte Kartendaten bleiben nutzbar.'));
  window.addEventListener('online', () => setBanner('net', '', ''));
  if (navigator.share) $('#btnShare').hidden = false;
}

async function boot() {
  bindUi();
  renderCountrySelect();
  syncScanFoil();
  if (!window.isSecureContext) setBanner('env', 'warn', INSECURE_MSG);
  await loadSettings();
  await refreshStatus();
  await refreshScans();
  renderAll();
  await loadData(false);
  setPill(S.espOk, S.espOk ? `Scanner ${S.esp ? S.esp.ip : ''} · ${S.scans.length} Scans` : 'Scanner nicht erreichbar');
}

/* ============================================================
 * Testhilfe (nur für Tests/Diagnose): window.__wow
 * ============================================================ */
const round3 = (v) => Math.round(v * 1000) / 1000;
const bootP = boot();
window.__wow = {
  ready: bootP,
  testMatch(nameText, numText = '') {
    const m = matchName(nameText, numText);
    return {
      top: m.ranked[0] ? { name: m.ranked[0].card.n, pid: m.ranked[0].card.p, score: round3(m.ranked[0].score) } : null,
      ranked: m.ranked.map((r) => ({ name: r.card.n, pid: r.card.p, num: r.card.num, score: round3(r.score) })),
      ms: round3(m.ms),
    };
  },
  // Führt einen OCR-Frame-Auswertungsschritt aus (ohne Kamera), für Tests der Stabilitätsregel.
  frame(nameText, numText = '', conf = 80) { return onFrame(matchName(nameText, numText), nameText, numText, conf); },
  priceInfo(pid, foil, pt, cur) {
    const card = S.idx && S.idx.cards.find((c) => c.p === pid);
    return card ? priceInfo(card, foil, pt, cur) : null;
  },
  state: () => ({
    settings: S.settings, ui: S.ui, indexed: S.idx ? S.idx.n : 0, indexMs: S.idx ? round3(S.idx.ms) : null,
    scans: S.scans.length, locked: S.locked, base: S.base,
  }),
  setView: showView,
  // Testhilfe: n gleichzeitige API-Aufrufe; liefert die größte Zahl gleichzeitig offener Anfragen
  async apiBurst(n) {
    apiMaxInFlight = 0;
    await Promise.all(Array.from({ length: n }, () => api('GET', 'api/status').catch(() => null)));
    return apiMaxInFlight;
  },
  subKey(pid, foil) { const c = S.idx && S.idx.cards.find((x) => x.p === pid); const i = c ? priceInfo(c, foil) : null; return i ? { sub: i.sub, isFoil: i.isFoil, value: i.value } : null; },
  csv: () => makeCsv(S.scans),
  json: () => makeJson(S.scans),
  report: () => makeReport(),
  setSearch(q) { $('#q').value = q; runSearch(); },
  openFirstResult() { const r = S.res[0]; if (r) openDetail(r.card); },
};
})();
