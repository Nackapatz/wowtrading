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
const LS_CAL = 'wowscan.calib2';   // neue OCR-Bereiche (CARD_ID.md): alte Offsets verfallen
const LS_FLT = 'wowscan.setFilter';
const LS_LEARN = 'wowscan.learnedNames';
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
const PT_ORDER = ['market', 'mid', 'low'];
const MATCH_MAX = 70;      // Bild: Start-Grenzwert der Distanz (docs/IMAGE_MATCH.md), per „Bild-Toleranz“ einstellbar
const MATCH_MARGIN = 12;   // Bild: Mindestabstand zur nächstbesten anderen Illustration
const SHARP_MIN = 60;      // Foto: Schärfe-Grenze (Laplace-Varianz, 400×558), per „Schärfe-Grenze“ einstellbar
const HI_W = 800, HI_H = 1116;   // Foto: entzerrte Karte für die OCR (Bildabgleich nutzt 400×558)
const DET_W = 240, DET_MS = 150; // Erkennung: Breite des Suchbildes, Takt in ms
const RARITY = { C: 'Common', U: 'Uncommon', R: 'Rare', E: 'Epic' }; // andere Codes roh anzeigen, nicht raten
const rarityName = (r) => RARITY[r] || (r == null ? '' : String(r));
const setName = (s, sc) => s || sc || '';
// Anzeigezeile: Set · #Nummer · Seltenheit (leere Teile entfallen)
const metaLine = (...parts) => parts.filter((x) => x != null && x !== '').join(' · ');
const numPart = (n) => (n ? '#' + n : '');
const dispName = (r) => (r.nameDe ? `${r.nameDe} (${r.name})` : r.name);
// Werte „Kosten 2 · 2/2“ (Angriff/Leben), fehlende Teile entfallen
const statLine = (r) => metaLine(r.cost != null ? 'Kosten ' + r.cost : '', r.atk != null || r.hp != null ? `${r.atk ?? '–'}/${r.hp ?? r.health ?? '–'}` : '');

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
function ptText(pt, wanted) {
  const t = PT_LABEL[pt] || PT_LABEL.market;
  return wanted && wanted !== pt ? `${t} (kein ${PT_LABEL[wanted]} verfügbar)` : t;
}
function priceLabel(pt, cur, date, wanted) {
  return `TCGplayer-Preis (US), ${ptText(pt, wanted)}${cur === 'USD' ? '' : ', umgerechnet'}, Stand ${fmtDate(date)}`;
}
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
// Kalibrierung: je Bereich Verschiebung [x, y] in % der Kartenbreite/-höhe (-10..10), Bild-Toleranz, Debug
const CAL_REGS = ['name', 'strip', 'cost', 'atk', 'hp'];
function loadCal() {
  const c = lsGet(LS_CAL) || {};
  const cl = (v) => Math.min(10, Math.max(-10, Math.round(Number(v) || 0)));
  const img = Number(c.imgMax), o = c.off || { name: [0, c.nameOff], strip: [0, c.numOff] };   // altes Format übernehmen
  const off = {};
  for (const r of CAL_REGS) off[r] = [cl(o[r] && o[r][0]), cl(o[r] && o[r][1])];
  const sh = Number(c.sharpMin);
  return { off, debug: !!c.debug, log: c.log !== false, imgMax: img >= 40 && img <= 110 ? Math.round(img) : MATCH_MAX,
    sharpMin: sh >= 10 && sh <= 200 ? Math.round(sh) : SHARP_MIN };
}
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* Speicher gesperrt: egal */ } }

/* ============================================================
 * Zustand
 * ============================================================ */
const S = {
  settings: { country: 'DE', currency: 'EUR', dataUrl: '' },
  ui: { priceType: 'market', foil: false, cond: 'NM', ...(lsGet(LS_UI) || {}) },
  cal: loadCal(),
  setFilter: String(lsGet(LS_FLT) || ''),
  lastWanted: null,
  suggKey: '',
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
  learned: lsGet(LS_LEARN) || {},   // gelernte deutsche Namen → k
  scanning: false, stream: null, workers: {}, ocrP: {}, busy: false, loopId: 0,
  guide: null, locked: null, miss: 0, cd: newCd(), wake: null, ac: null,
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
  // Die Sammlung kann einige hundert Einträge haben: dafür mehr Zeit lassen
  const timer = setTimeout(() => ctl.abort(), method === 'GET' && path === 'api/scans' ? 30000 : 8000);
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
      const [cards, prices, rates, hashes] = await Promise.all([
        ...['cards.json', 'prices.json', 'rates.json'].map((f) => getJson(base + f)),
        getJson(base + 'hashes.json').catch(() => null),   // optional: Bild-Fingerabdrücke
      ]);
      set = { meta, cards, prices, rates, hashes };
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
  buildArtIndex();
  renderSetFilter();
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
// Namenszusätze am Ende wie "(LOOT)" oder "(Foil)" entfernen – nur für den Abgleich, Anzeige bleibt voll.
function stripSuffix(n) {
  const full = String(n ?? '');
  let t = full, prev;
  do { prev = t; t = t.replace(/\s*\([^()]*\)\s*$/, ''); } while (t !== prev && t);
  return t || full;
}
const baseKey = (card) => norm(stripSuffix(card.n));
// cards.json v1 (x: extendedData, num als Text) und v2 (k, num/tot, Werte) auf ein Format bringen
const intOr = (v) => (v == null || v === '' || isNaN(+v) ? null : +v);
function normCard(c) {
  const v1 = c.k == null;
  if (v1) c.k = 'p' + c.p;
  if (c.p === undefined) c.p = null;
  if (typeof c.num === 'string' && !v1) { c.numTxt = c.num; c.num = null; }   // v2: „1/2“ (Vorder-/Rückseite) bleibt Text
  if (typeof c.num === 'string') {
    const m = /^\s*(\d+)\s*(?:\/\s*(\d+))?/.exec(c.num);
    c.num = m ? +m[1] : null;
    if (m && m[2] && c.tot == null) c.tot = +m[2];
  }
  const x = c.x || {};
  if (c.cost === undefined) c.cost = intOr(x.Cost);
  if (c.atk === undefined) c.atk = intOr(x.ATK);
  if (c.hp === undefined) c.hp = intOr(x.Health);
  if (c.fac === undefined) c.fac = x.Faction ?? null;
  if (c.race === undefined) c.race = x.Race ?? null;
  if (c.cls === undefined) c.cls = x.Class ?? null;
  return c;
}
const numStr = (c) => (c.num == null ? c.numTxt || null : c.tot ? `${c.num}/${c.tot}` : String(c.num));
function buildIndex() {
  const t0 = performance.now();
  const doc = S.data.cards, cards = (doc.cards || []).map(normCard);
  const n = cards.length;
  const names = new Array(n), byBase = new Map(), sets = new Set(), byNum = new Map(), byK = new Map(), setMap = new Map();
  for (const s of doc.sets || []) setMap.set(s.id, { key: s.id, n: s.n, w0: s.w || '', w: norm(s.w).replace(/ /g, ''), w2: norm(s.w).split(' ').pop(), tot: s.tot || null });
  for (let i = 0; i < n; i++) {
    const c = cards[i], sk = c.si ?? c.s;
    names[i] = norm(c.n);
    byK.set(c.k, c);
    if (!setMap.has(sk)) setMap.set(sk, { key: sk, n: c.s, w0: c.sc || '', w: norm(c.sc).replace(/ /g, ''), tot: null });
    const st = setMap.get(sk);
    if (c.tot && !st.tot) st.tot = c.tot;
    c.sw = st.w0 || c.sc || null;
    if (c.num != null) { const key = sk + '|' + c.num; if (!byNum.has(key)) byNum.set(key, []); byNum.get(key).push(i); }
    const b = baseKey(cards[i]);
    let a = byBase.get(b);
    if (!a) byBase.set(b, (a = []));
    a.push(i);
    if (cards[i].s) sets.add(cards[i].s);
  }
  const bases = [...byBase.keys()], m = bases.length;
  const lens = new Uint16Array(m), tris = new Array(m), members = new Array(m);
  for (let k = 0; k < m; k++) { lens[k] = bases[k].length; tris[k] = trigrams(bases[k]); members[k] = byBase.get(bases[k]); }
  S.idx = { cards, names, bases, lens, tris, members, n, m, byNum, byK, setList: [...setMap.values()], sets: [...sets].sort((a, b) => a.localeCompare(b, 'de')), ms: performance.now() - t0 };
  if (S.setFilter && !S.idx.sets.includes(S.setFilter)) { S.setFilter = ''; lsSet(LS_FLT, ''); }
}
const MIN_SIM = 0.5;
/* Abgleich gegen eindeutige Grundnamen (ohne Zusatz). Liefert [{base, score, cards (Drucke, ggf. nach Set gefiltert), card}].
 * Reihenfolge: Länge → Trigramme → Levenshtein. */
function matchName(nameText) {
  const t0 = performance.now();
  const idx = S.idx;
  const q = norm(stripSuffix(nameText));
  if (!idx || q.length < 3) return { ranked: [], ms: 0 };
  const qt = trigrams(q), ql = q.length, flt = S.setFilter;
  const hits = [];
  for (let k = 0; k < idx.m; k++) {
    const L = idx.lens[k];
    const maxL = L > ql ? L : ql;
    const maxD = Math.floor((1 - MIN_SIM) * maxL);
    if (Math.abs(L - ql) > maxD) continue;
    const ti = idx.tris[k];
    const inter = interCount(qt, ti);
    if (inter === 0 || (2 * inter) / (qt.length + ti.length) < 0.2) continue;
    let mem = idx.members[k];
    if (flt) { mem = mem.filter((i) => idx.cards[i].s === flt); if (!mem.length) continue; }
    const d = lev(q, idx.bases[k], maxD);
    if (d > maxD) continue;
    hits.push({ k, sim: 1 - d / maxL, mem });
  }
  hits.sort((a, b) => b.sim - a.sim);
  return {
    ranked: hits.slice(0, 10).map((h) => ({ base: idx.bases[h.k], score: h.sim, cards: h.mem.map((i) => idx.cards[i]), card: idx.cards[h.mem[0]] })),
    ms: performance.now() - t0,
  };
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
// Preisart: gewählte zuerst, dann Ersatz in der Reihenfolge Markt → Mittel → Tiefst.
function priceInfo(card, foil, pt = S.ui.priceType, cur = S.settings.currency) {
  const pe = S.data && S.data.prices && S.data.prices.prices ? S.data.prices.prices[card.p] : null;
  const keys = pe ? Object.keys(pe) : [];
  const sub = pickSub(keys, foil);
  const arr = pe && sub != null ? pe[sub] : null;
  let usd = null, used = pt;
  if (Array.isArray(arr)) {
    for (const t of [pt, ...PT_ORDER.filter((x) => x !== pt)]) {
      const v = arr[PT_IDX[t]];
      if (typeof v === 'number' && isFinite(v)) { usd = v; used = t; break; }
    }
  }
  let value = null, note = '';
  if (usd != null) {
    const rate = cur === 'USD' ? 1 : (S.data && S.data.rates && S.data.rates.rates ? S.data.rates.rates[cur] : undefined);
    if (typeof rate === 'number') value = round2(usd * rate);
    else note = `kein Umrechnungskurs für ${cur}`;
  } else {
    note = pe ? `kein Preis für ${sub}-Druck` : card.p == null ? 'Kein TCGplayer-Produkt zu dieser Karte' : 'Keine Preisdaten für dieses Produkt';
  }
  return {
    sub, single: keys.length === 1, isFoil: sub != null && /foil/i.test(sub), usd, value, pt: used, wanted: pt,
    fallback: usd != null && used !== pt, cur, note,
    date: (S.data && S.data.prices && S.data.prices.priceDate) || (S.data && S.data.meta && S.data.meta.priceDate) || '',
  };
}
function priceBlockHtml(pi) {
  if (pi.value == null) return `<div class="price none">kein Preis</div><div class="src">${esc(pi.note)}</div>`;
  return `<div class="price num">${esc(fmtMoney(pi.value, pi.cur))}</div><div class="src">${esc(priceLabel(pi.pt, pi.cur, pi.date, pi.wanted))}</div>`;
}
function priceShort(r) {
  return typeof r.price === 'number' ? esc(fmtMoney(r.price, r.currency)) : 'kein Preis';
}

/* Scan-Datensatz (Feldnamen exakt nach Spec, Abschnitt 1) */
function buildRecord(card, { foil, cond, qty = 1, ocr = null, number = null, nameDe = null, matchInfo = null }) {
  const pi = priceInfo(card, foil);
  return {
    ts: new Date().toISOString(),
    productId: card.p ?? null, key: card.k, name: card.n, nameDe: nameDe || null, set: card.s, setCode: card.sc || null, setWord: card.sw || null,
    number: numStr(card) || number || null, total: card.tot ?? null, rarity: card.r ?? null, type: card.t ?? null,
    cardClass: card.cls ?? null, cls: card.cls ?? null, faction: card.fac ?? null, race: card.race ?? null,
    cost: card.cost ?? null, atk: card.atk ?? null, health: card.hp ?? null, hp: card.hp ?? null, matchInfo,
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
  const rec = buildRecord(card, { foil, cond, qty: opts.qty || 1, ocr: opts.ocr ?? null, number: opts.number || null, nameDe: opts.nameDe ? cleanDe(opts.nameDe) : null, matchInfo: opts.matchInfo || null });
  try {
    const res = await api('POST', 'api/scan', rec);
    rec.id = res.id;
    S.lastWanted = { id: rec.id, wanted: S.ui.priceType };
    S.scans.unshift(rec);
    S.lastId = rec.id;
    if (rec.nameDe) learn(rec.nameDe, card.k);
    setPill(true, `Scanner online · ${S.scans.length} Scans`);
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
  toast(`Erfasst: ${dispName(rec)}${typeof rec.price === 'number' ? ' · ' + fmtMoney(rec.price, rec.currency) : ' · kein Preis'}`);
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
 * OCR (Tesseract.js, je Sprache höchstens ein Worker, lazy): eng für Nummer/Werte, deu für den Namen
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
const TESS = 'https://cdn.jsdelivr.net/npm/';
function ensureOcr(lang) {
  if (S.workers[lang]) return Promise.resolve(S.workers[lang]);
  if (!S.ocrP[lang]) {
    S.ocrP[lang] = loadScript(TESS_URL)
      .then(() => self.Tesseract.createWorker(lang, 1, {
        workerPath: TESS + 'tesseract.js@5.1.1/dist/worker.min.js',
        corePath: TESS + 'tesseract.js-core@5.1.1',
        langPath: `${TESS}@tesseract.js-data/${lang}@1.0.0/4.0.0_best_int`,
      }))
      .then((w) => { S.workers[lang] = w; w.psm = ''; return w; })
      .catch((e) => { S.ocrP[lang] = null; S.ocrFailed = true; throw new Error(e.message); });
  }
  return S.ocrP[lang];
}
// Worker der Sprache, falls geladen; sonst Laden anstoßen und null liefern (der Frame läuft ohne OCR weiter).
function ocrUsable(lang = 'eng') {
  if (S.workers[lang]) return S.workers[lang];
  if (!S.ocrFailed && !S.ocrP[lang]) {
    ensureOcr(lang).then(() => setBanner('ocr', '', ''), (e) => setBanner('ocr', S.art ? 'warn' : 'err',
      `Texterkennung nicht verfügbar (${e.message}). ${S.art ? 'Der Bildabgleich läuft weiter.' : 'Ohne Bilddaten ist keine automatische Erkennung möglich; Karten lassen sich über die Suche erfassen.'}`));
  }
  return null;
}
/* Bereiche relativ zur Karte (Breite/Höhe), kalibrierbar per Verschiebung in % (S.cal.off[r] = [dx, dy]). */
const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const REG = {
  name: { l: 'Name', x: 0.18, y: 0.025, w: 0.64, h: 0.065, lang: 'deu', psm: '7', wl: '', tw: 900 },
  strip: { l: 'Nummer', x: 0.18, y: 0.925, w: 0.55, h: 0.05, lang: 'eng', psm: '7', wl: AZ + AZ.toLowerCase() + '0123456789/ ', tw: 900 },
  cost: { l: 'Kosten', x: 0.07, y: 0.025, w: 0.16, h: 0.10, lang: 'eng', psm: '10', wl: '0123456789', tw: 120 },
  atk: { l: 'Angriff', x: 0.05, y: 0.86, w: 0.16, h: 0.11, lang: 'eng', psm: '10', wl: '0123456789', tw: 120 },
  hp: { l: 'Leben', x: 0.83, y: 0.86, w: 0.15, h: 0.11, lang: 'eng', psm: '10', wl: '0123456789', tw: 120 },
};
const REGS = Object.keys(REG);
const ART_BOX = { x: 0.10, y: 0.14, w: 0.80, h: 0.42 };   // = REGION von artHash
const CARD_W = 400, CARD_H = 558;                          // Kartenrahmen in Pixeln (wie _400w-Bilder)
const clamp01 = (v, w) => Math.min(Math.max(v, 0), 1 - w);
function regBox(r) {
  const R = REG[r], o = S.cal.off[r] || [0, 0];
  return { x: clamp01(R.x + o[0] / 100, R.w), y: clamp01(R.y + o[1] / 100, R.h), w: R.w, h: R.h };
}
// Ausschnitt aus dem Karten-Canvas: Graustufen, Kontrast, dunkler Grund wird invertiert (helle Ziffern in Kreisen)
function cropFrom(src, cv, box, targetW) {
  const sw = src.width * box.w, sh = src.height * box.h;
  const w = Math.round(targetW), h = Math.max(24, Math.round(targetW * sh / sw));
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, src.width * box.x, src.height * box.y, sw, sh, 0, 0, w, h);
  const im = ctx.getImageData(0, 0, w, h), d = im.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
  const inv = sum / (d.length / 4) < 110;
  for (let i = 0; i < d.length; i += 4) {
    let v = (d[i] - 128) * 1.6 + 128;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    d[i] = d[i + 1] = d[i + 2] = inv ? 255 - v : v;
  }
  ctx.putImageData(im, 0, 0);
  return cv;
}
const regCv = (r) => $('#cv-' + r);
async function ocrRegion(cv, r) {
  const R = REG[r], w = ocrUsable(R.lang);
  if (!w) return null;
  cropFrom(cv, regCv(r), regBox(r), R.tw);
  const key = R.psm + '|' + R.wl;
  if (w.psm !== key) { await w.setParameters({ tessedit_pageseg_mode: R.psm, tessedit_char_whitelist: R.wl }); w.psm = key; }
  const a = await w.recognize(regCv(r));
  return String((a.data && a.data.text) || '').replace(/\s+/g, ' ').trim();
}
let cvCard = null;
function cardCanvas() {
  if (!cvCard) { cvCard = document.createElement('canvas'); cvCard.width = CARD_W; cvCard.height = CARD_H; }
  return cvCard;
}
/* Bildindex: Produkte mit identischem Hash = dieselbe Illustration (Nachdrucke) → eine Gruppe. */
function buildArtIndex() {
  S.art = null;
  const doc = S.data && S.data.hashes, AH = self.WowArtHash;
  if (!AH || !doc || doc.algo !== AH.ALGO || !doc.hashes || !S.idx) return;
  const pidIdx = new Map();
  S.idx.cards.forEach((c, i) => pidIdx.set(String(c.p), i));
  const groups = new Map();
  for (const pid of Object.keys(doc.hashes)) {
    const e = doc.hashes[pid], i = pidIdx.get(pid);
    if (i == null || !Array.isArray(e) || !/^[0-9a-f]{64}$/.test(e[0]) || !/^[0-9a-f]{6}$/.test(e[1])) continue;
    let g = groups.get(e[0]);
    if (!g) groups.set(e[0], (g = { hash: e[0], color: e[1], mem: [] }));
    g.mem.push(i);
  }
  const list = [...groups.values()], n = list.length;
  const words = new Uint32Array(n * 8), rgb = new Uint8Array(n * 3), members = new Array(n);
  list.forEach((g, k) => {
    words.set(AH.hexWords(g.hash), k * 8);
    const c = parseInt(g.color, 16);
    rgb[k * 3] = (c >> 16) & 255; rgb[k * 3 + 1] = (c >> 8) & 255; rgb[k * 3 + 2] = c & 255;
    members[k] = g.mem;
  });
  S.art = { n, words, rgb, members, count: list.reduce((a, g) => a + g.mem.length, 0) };
}
// Distanz = Hamming(256 Bit) + round(0,25·(|ΔR|+|ΔG|+|ΔB|)/8); Treffer bei ≤ Grenze und Abstand ≥ MATCH_MARGIN.
function matchArt(a) {
  const A = S.art, q = a.words, flt = S.setFilter, cards = S.idx.cards, top = [];
  const r0 = a.rgb[0], g0 = a.rgb[1], b0 = a.rgb[2];
  for (let k = 0; k < A.n; k++) {
    let mem = A.members[k];
    if (flt) { mem = mem.filter((i) => cards[i].s === flt); if (!mem.length) continue; }
    const o = k * 8;
    let h = 0;
    for (let w = 0; w < 8; w++) {
      let v = (A.words[o + w] ^ q[w]) >>> 0;
      v -= (v >>> 1) & 0x55555555;
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
      h += Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
    }
    const d = h + Math.round(0.25 * (Math.abs(A.rgb[k * 3] - r0) + Math.abs(A.rgb[k * 3 + 1] - g0) + Math.abs(A.rgb[k * 3 + 2] - b0)) / 8);
    if (top.length < 6 || d < top[top.length - 1].d) {
      let p = top.length < 6 ? top.length : 5;
      while (p > 0 && top[p - 1].d > d) { top[p] = top[p - 1]; p--; }
      top[p] = { d, mem };
      if (top.length > 6) top.length = 6;
    }
  }
  const best = top[0], second = top[1];
  const margin = best && second ? second.d - best.d : null;
  return {
    ok: !!best && best.d <= S.cal.imgMax && (margin == null || margin >= MATCH_MARGIN),
    best: best ? best.d : null, margin,
    top: top.slice(0, 5).map((t) => ({ d: t.d, cards: t.mem.map((i) => cards[i]) })),
  };
}

/* ============================================================
 * Kombinierte Erkennung (docs/CARD_ID.md): Set+Nummer, Gesamtzahl, Werte, Bild, Name
 * ============================================================ */
const CAP_PTS = 70, CAP_LEAD = 20, SUGG_MIN = 20;
const SWAP = { 5: '6', 6: '5', 1: '7', 7: '1', 0: '8', 8: '0' };   // häufige OCR-Verwechslungen
function numVariants(n) {
  const s = String(n), out = [];
  for (let i = 0; i < s.length; i++) if (SWAP[s[i]]) out.push(+(s.slice(0, i) + SWAP[s[i]] + s.slice(i + 1)));
  return out;
}
function parseStrip(t) {
  const m = /([A-Za-z]{3,})?\s*(\d{1,3})\s*\/\s*(\d{2,3})/.exec(String(t || ''));
  return m ? { word: m[1] || '', num: +m[2], tot: +m[3] } : null;
}
// Set-Wort unscharf (Levenshtein ≤ 2), ohne Treffer über die Gesamtzahl
function findSets(st) {
  const L = S.idx.setList, w = norm(st.word).replace(/ /g, '');
  let best = 3, out = [];
  if (w.length >= 3) for (const s of L) {
    if (!s.w) continue;
    const d = Math.min(lev(w, s.w, 2), s.w2 && s.w2.length >= 4 ? lev(w, s.w2, 2) : 9);   // mehrteilige Set-Wörter: letztes Wort reicht
    if (d < best) { best = d; out = [s]; } else if (d === best) out.push(s);
  }
  return out.length ? out : L.filter((s) => s.tot === st.tot);
}
const statNum = (t) => { const m = /\d{1,2}/.exec(t || ''); return m ? +m[0] : null; };
const cleanDe = (t) => String(t || '').replace(/[^A-Za-zÄÖÜäöüß' -]+/g, ' ').replace(/\s+/g, ' ').trim();
// Gleiche Karte, anderes Produkt: gleiches Set, gleiche Nummer, gleicher Grundname
const sameCard = (a, b) => a.s === b.s && numStr(a) != null && numStr(a) === numStr(b) && baseKey(a) === baseKey(b);
const variantsOf = (card) => (S.idx ? S.idx.cards.filter((c) => c !== card && sameCard(c, card)) : []);

/* Gelernte deutsche Namen: { "Hulok Wegbereiter": "<k>" } in localStorage, Abgleich normalisiert/unscharf */
function learnedMap() {
  if (!S.learnN) S.learnN = new Map(Object.entries(S.learned).map(([de, k]) => [norm(de), k]));
  return S.learnN;
}
function learnedK(de) {
  const q = norm(de), M = learnedMap();
  if (q.length < 3) return null;
  if (M.has(q)) return M.get(q);
  for (const [n, k] of M) if (lev(q, n, Math.floor(q.length * 0.15)) <= Math.floor(q.length * 0.15)) return k;
  return null;
}
const learnedDe = (k) => Object.keys(S.learned).find((de) => S.learned[de] === k) || null;
function learn(de, k) {
  de = cleanDe(de);
  if (norm(de).length < 3 || !k || learnedK(de) === k) return;   // schon (auch unscharf) bekannt
  for (const x of Object.keys(S.learned)) if (norm(x) === norm(de)) delete S.learned[x];
  S.learned[de] = k; S.learnN = null;
  lsSet(LS_LEARN, S.learned);
}

/* Punkte je Kandidat: Nr exakt 60 (Ziffernkorrektur 40), Gesamtzahl +10, Wert +10/−30,
 * Bild +max(0, 30 − d/3), gelernter Name +40, englischer Name ≥ 0,8 +20. */
function score(res, raw) {
  const C = new Map(), idx = S.idx, flt = S.setFilter;
  const add = (card, pts, tag) => {
    if (flt && card.s !== flt) return null;
    let c = C.get(card.k);
    if (!c) C.set(card.k, (c = { card, pts: 0, sig: [] }));
    c.pts += pts; c.sig.push(tag);
    return c;
  };
  const st = parseStrip(raw.strip);
  if (st) for (const s of findSets(st)) {
    for (const i of idx.byNum.get(s.key + '|' + st.num) || []) add(idx.cards[i], 60, 'Nr');
    for (const v of numVariants(st.num)) for (const i of idx.byNum.get(s.key + '|' + v) || []) add(idx.cards[i], 40, 'Nr~');
  }
  if (res) for (const t of res.top) {
    if (t.d > S.cal.imgMax) continue;
    for (const card of t.cards) {
      const c = add(card, Math.max(0, 30 - t.d / 3), 'Bild');
      if (c) { c.d = t.d; c.imgSure = res.ok && t === res.top[0] && t.cards.every((x) => x === card || sameCard(x, card)); }
    }
  }
  const de = cleanDe(raw.name);
  if (de.length >= 3) {
    const k = learnedK(de), card = k && idx.byK.get(k);
    if (card) add(card, 40, 'DE');
    for (const r of matchName(de).ranked) if (r.score >= 0.8) for (const card of r.cards) add(card, 20, 'EN');
  }
  const sv = { cost: statNum(raw.cost), atk: statNum(raw.atk), hp: statNum(raw.hp) };
  for (const c of C.values()) {
    if (st && c.card.tot === st.tot) { c.pts += 10; c.sig.push('Ges'); }
    // Werte wie in SpectralKitten (0 = oft nicht aufgedruckt): Angriff/Leben nur bei Verbündeten, Kosten nicht bei Helden
    const t = c.card.t || '', ally = !t || /ally/i.test(t);
    for (const f in sv) {
      const v = sv[f], cv = c.card[f];
      if (v == null || cv == null || (f === 'cost' ? /hero/i.test(t) : !ally)) continue;
      if (v === cv) { c.pts += 10; c.sig.push(f); } else { c.pts -= 30; c.contra = true; c.sig.push('!' + f); }
    }
  }
  let ranked = [...C.values()].sort((a, b) => b.pts - a.pts), top = ranked[0], others = ranked.slice(1);
  // Gleichstand Grundprodukt ↔ Variante derselben Karte („… (LOOT)“, gleiche Nummer): Grundprodukt wählen
  if (top) {
    const grp = ranked.filter((x) => (x === top || sameCard(x.card, top.card)) && top.pts - x.pts <= 5);
    const base = grp.length > 1 && grp.find((x) => x.card.n === stripSuffix(x.card.n));
    if (base) {
      top = base; base.sig.push('Basis');
      others = ranked.filter((x) => !grp.includes(x));
      ranked = [base, ...grp.filter((x) => x !== base), ...others];
    }
  }
  const lead = top ? top.pts - (others[0] ? others[0].pts : 0) : 0;
  // Erfassen: ≥ 70 Punkte und ≥ 20 Vorsprung; oder eindeutiger Bildtreffer (IMAGE_MATCH) ohne Widerspruch
  const sure = !!top && ((top.pts >= CAP_PTS && lead >= CAP_LEAD) || (!!top.imgSure && !top.contra && lead > 0));
  return { ranked, sure, lead, st, de };
}
const sigText = (c) => `${c.sig.join(' ')} = ${Math.round(c.pts)}`;

/* Auswertung eines Bildes: Bildabgleich auf cv (400×558), OCR auf src (Hi-Res 800×1116). OCR nur solange nicht eindeutig:
 * Nummer, dann Werte, dann Name (deu). inj: OCR-Rohtexte je Bereich (Tests), ersetzt die OCR. */
async function evalCard(cv, src, inj) {
  const t0 = performance.now();
  let res = null;
  if (S.art && cv) {
    const im = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height);
    res = matchArt(self.WowArtHash.artHash(im.data, cv.width, cv.height, 4));
  }
  const ms = performance.now() - t0;
  S.dbgArt = { res, ms };
  if (S.cal.debug && cv) drawArtDebug(cv);
  const raw = {}, ocrMs = {};
  let m;
  if (inj) { for (const r of REGS) raw[r] = inj[r] || ''; m = score(res, raw); }
  else {
    const read = async (r) => { const t = performance.now(); raw[r] = (await ocrRegion(src, r)) || ''; ocrMs[r] = Math.round(performance.now() - t); };
    m = score(res, raw);
    if (!m.sure && ocrUsable('eng')) {
      await read('strip'); m = score(res, raw);
      if (!m.sure) { await read('cost'); await read('atk'); await read('hp'); m = score(res, raw); }
    }
    if (!m.sure && ocrUsable('deu')) { await read('name'); m = score(res, raw); }
  }
  return { res, raw, m, ms, ocrMs };
}
/* Erkennungs-Log (Einstellung „Erkennungs-Log an den Scanner senden“): eine Zeile je Auswertung an POST /api/log.
 * src: cam | gal; x: { st, m, res, raw, ocrMs, ms, artMs, shots, wait, blur, sharp } */
function logEval(src, x) {
  if (!S.cal.log || !S.espOk) return;
  const cut = (v, n = 60) => String(v == null ? '' : v).slice(0, n), a = x.res, m = x.m, num = (v) => (v == null ? null : Math.round(v));
  const entry = {
    t: new Date().toISOString(), src, st: x.st, ms: num(x.ms), artMs: num(x.artMs), shots: x.shots || 1,
    wait: num(x.wait), blur: x.blur || 0, sharp: num(x.sharp),
    art: a ? { d: a.best ?? null, mg: a.margin ?? null, ok: !!a.ok, top: a.top && a.top[0] ? cut(a.top[0].cards[0].n) : null } : null,
    ocr: Object.fromEntries(Object.entries(x.raw || {}).map(([k, v]) => [k, cut(v)])), ocrMs: x.ocrMs || {},
    cand: m.ranked.slice(0, 3).map((c) => [cut(c.card.n), cut(c.card.sc || c.card.s, 24), c.card.num ?? null, Math.round(c.pts), cut(c.sig.join(' '), 80)]),
    lead: Math.round(m.lead || 0),
  };
  api('POST', 'api/log', entry).catch(() => { /* Log ist optional */ });
}
// Testpfad (window.__wow.frame, testImage): eine Auswertung; bei eindeutigem Ergebnis sofort erfasst
async function processCard(cv, feed = true, inj = null, hi = null) {
  const e = await evalCard(cv, hi || cv, inj);
  S.dbg = { raw: e.raw, m: e.m };
  renderDbg();
  const ctx = {
    nameDe: e.m.de || null, number: e.m.st ? `${e.m.st.num}/${e.m.st.tot}` : null,
    readName: inj || !cv ? null : async () => { const t = cleanDe(await ocrRegion(hi || cv, 'name')); return t || null; },
  };
  if (feed) await frameDecide(e.m, ctx);
  return summary(e);
}
function summary(e) {
  const { res, m, ms } = e;
  const out = (c) => ({ k: c.card.k, pid: c.card.p, name: c.card.n, pts: Math.round(c.pts), sig: c.sig.join(' ') });
  return {
    ok: !!(res && res.ok), sure: m.sure, via: m.ranked[0] ? m.ranked[0].sig.join(' ') : '', lead: Math.round(m.lead), ms,
    best: res && res.top[0] ? { pid: res.top[0].cards[0].p, d: res.top[0].d, printings: res.top[0].cards.map((c) => c.p) } : null,
    top: res ? res.top.map((t) => ({ pid: t.cards[0].p, d: t.d })) : [], margin: res ? res.margin : null,
    cand: m.ranked.slice(0, 5).map(out),
  };
}
/* Entscheidung über eine Auswertung: eindeutig → erfassen, sonst Vorschläge (Top 3).
 * Liefert 'captured' | 'failed' | 'sugg' | 'none'. */
async function decide(m, ctx) {
  const c = m.ranked[0];
  if (m.sure) {
    hideSuggest();
    S.locked = c.card.k; S.miss = 0;
    setLive(`Erkannt: ${c.card.n}`);
    let de = ctx.nameDe;
    if (!de && ctx.readName) de = await ctx.readName().catch(() => null);
    const rec = await captureCard(c.card, { nameDe: de, number: ctx.number, matchInfo: { signals: c.sig, score: Math.round(c.pts), lead: Math.round(m.lead) } });
    if (!rec) { S.locked = null; return 'failed'; }
    return 'captured';
  }
  const list = m.ranked.filter((r) => r.pts >= SUGG_MIN).slice(0, 3);
  if (list.length) {
    const multi = list.length > 1 && list.every((r) => baseKey(r.card) === baseKey(c.card));
    setLive(multi ? `${stripSuffix(c.card.n)}: ${list.length} Drucke – bitte Set wählen` : `Unsicher (${Math.round(c.pts)} P.) – bitte Vorschlag wählen`);
    showSuggest(list, multi ? 'Diese Karte gibt es in mehreren Sets. Tippe den richtigen Druck an:' : 'Unsicher erkannt. Tippe die richtige Karte an:', ctx);
    return 'sugg';
  }
  hideSuggest();
  setLive(ctx.nameDe ? `Gelesen: „${ctx.nameDe}“` : 'Suche Karte …');
  return 'none';
}
// Testpfad-Sperre: gleiche Karte → nichts tun; andere Karte → sofort neu; ohne Karte zweimal → frei
async function frameDecide(m, ctx) {
  if (S.locked !== null) {
    const top = m.ranked[0];
    if (top && top.pts >= SUGG_MIN && top.card.k === S.locked) { S.miss = 0; setLive(`Erfasst: ${top.card.n}. Nächste Karte auflegen.`); return; }
    if ((!top || top.pts < SUGG_MIN) && ++S.miss < 2) return;
    S.locked = null; S.miss = 0;
  }
  await decide(m, ctx);
}
// Weitere Standbilder derselben Karte: OCR-Rohtexte aller Felder
async function readAll(src) {
  const raw = {};
  for (const r of REGS) if (ocrUsable(REG[r].lang)) raw[r] = (await ocrRegion(src, r)) || '';
  return raw;
}
// Passt ein Rohtext zu einem der Kandidaten?
function fits(r, v, card) {
  if (r === 'strip') { const st = parseStrip(v); return !!st && card.num === st.num; }
  if (r === 'name') { const t = cleanDe(v); return t.length >= 3 && (learnedK(t) === card.k || matchName(t).ranked.some((x) => x.score >= 0.8 && x.cards.includes(card))); }
  return statNum(v) === card[r];   // cost, atk, hp
}
// Je Feld: erster nicht leerer Wert, der zu einem Kandidaten passt; sonst der häufigste
function mergeRaw(raws, cards) {
  const out = {};
  for (const r of REGS) {
    const vals = raws.map((x) => (x[r] || '').trim()).filter(Boolean);
    const hit = vals.find((v) => cards.some((c) => fits(r, v, c)));
    if (hit !== undefined) { out[r] = hit; continue; }
    const cnt = new Map();
    for (const v of vals) cnt.set(v, (cnt.get(v) || 0) + 1);
    out[r] = [...cnt].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }
  return out;
}
function drawArtDebug(src) {
  const c = $('#cvArt'), b = self.WowArtHash.regionBox(src.width, src.height);
  c.width = b[2] - b[0]; c.height = b[3] - b[1];
  c.getContext('2d').drawImage(src, b[0], b[1], c.width, c.height, 0, 0, c.width, c.height);
}
function renderDbg() {
  $('#dbg').hidden = !S.cal.debug;
  if (!S.cal.debug) return;
  const L = [], a = S.dbgArt, d = S.dbg, sh = S.dbgShot;
  L.push(`Erkennung: ${S.cd.state} · score ${S.cd.score ?? '–'}${sh ? ` · Foto: Schärfe ${Math.round(sh.sharp)} (Grenze ${S.cal.sharpMin})` : ''}`);
  if (a && a.res) {
    const r = a.res;
    L.push(`Bild: ${r.ok ? 'Treffer' : 'nicht eindeutig'} · beste Distanz ${r.best ?? '–'} (Grenze ${S.cal.imgMax}) · Abstand ${r.margin ?? '–'} (nötig ${MATCH_MARGIN}) · ${a.ms.toFixed(1)} ms`);
    r.top.slice(0, 3).forEach((t, i) => L.push(`  ${i + 1}. ${t.cards[0].n} · ${setName(t.cards[0].s, t.cards[0].sc)}${t.cards.length > 1 ? ` (+${t.cards.length - 1} Druck/e)` : ''}: ${t.d}`));
  } else if (a) L.push('Bild: keine Bilddaten');
  if (d) {
    for (const r of REGS) { const el = $('#raw-' + r); if (el) el.textContent = d.raw[r] == null ? '–' : `„${d.raw[r]}“`; }
    L.push(`Kandidaten (Erfassen ab ${CAP_PTS} P. und ${CAP_LEAD} Vorsprung): ${d.m.sure ? 'eindeutig' : 'unsicher'}`);
    d.m.ranked.slice(0, 3).forEach((c, i) => L.push(`  ${i + 1}. ${c.card.n} · ${setName(c.card.s, c.card.sc)} ${numPart(numStr(c.card))}: ${sigText(c)}`));
  }
  $('#dbgTxt').textContent = L.join('\n');
}

/* Erkennung im Kamerabild (docs/CARD_DETECT.md): search → steady → shot → wait-remove.
 * Alle 150 ms wird der Kartenrand gesucht (tick). Drei ruhige Treffer in Folge (Ecken bewegen sich
 * höchstens 2 % der Kartenbreite) → Foto. Nach Erfassen oder Vorschlägen (wait-remove) erst weiter, wenn
 * zwei Erkennungen in Folge nichts finden oder sich die Ecken um mehr als 15 % verschieben. */
function newCd() { return { state: 'search', stable: 0, ref: null, last: null, lockC: null, score: null, t0: null, blur: 0 }; }
const cardW = (c) => (Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]) + Math.hypot(c[2][0] - c[3][0], c[2][1] - c[3][1])) / 2;
const moved = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
const guideCorners = () => { const g = S.guide; return [[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]]; };
// Graustufen aus RGBA (Rec.601-Gewichte, gerundet)
function grayOf(px, n) {
  const g = new Uint8Array(n);
  for (let i = 0; i < n; i++) g[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114 + 500) / 1000 | 0;
  return g;
}
let cvDet = null, cvFull = null, cvHi = null;
function hiCanvas() {
  if (!cvHi) { cvHi = document.createElement('canvas'); cvHi.width = HI_W; cvHi.height = HI_H; }
  return cvHi;
}
// Kartenrand im Suchbereich (Overlay-Rahmen, an jeder Seite 12 % der Rahmenbreite erweitert, auf das Video begrenzt)
function detect() {
  const vid = $('#video'), g = S.guide, vw = vid.videoWidth, vh = vid.videoHeight;
  if (!g || !vw || !vh) return null;
  const e = 0.12 * g.w;
  const x0 = Math.max(0, Math.floor(g.x - e)), y0 = Math.max(0, Math.floor(g.y - e));
  const x1 = Math.min(vw, Math.ceil(g.x + g.w + e)), y1 = Math.min(vh, Math.ceil(g.y + g.h + e));
  const sw = DET_W, sh = Math.max(16, Math.round(DET_W * (y1 - y0) / (x1 - x0)));
  if (!cvDet) cvDet = document.createElement('canvas');
  cvDet.width = sw; cvDet.height = sh;
  const ctx = cvDet.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(vid, x0, y0, x1 - x0, y1 - y0, 0, 0, sw, sh);
  const r = self.WowCardDetect.detectCard(grayOf(ctx.getImageData(0, 0, sw, sh).data, sw * sh), sw, sh);
  if (!r) return null;
  const kx = (x1 - x0) / sw, ky = (y1 - y0) / sh;
  return { corners: r.corners.map(([x, y]) => [x0 + x * kx, y0 + y * ky]), score: r.score };
}
// Foto: volles Videobild, entzerrt auf 800×1116 (OCR) und 400×558 (Bildabgleich). Schärfe auf dem 400er-Bild.
function takeShot(corners) {
  const vid = $('#video'), vw = vid.videoWidth, vh = vid.videoHeight;
  if (!cvFull) cvFull = document.createElement('canvas');
  cvFull.width = vw; cvFull.height = vh;
  cvFull.getContext('2d', { willReadFrequently: true }).drawImage(vid, 0, 0, vw, vh);
  return warpFromCanvas(cvFull, corners);
}
// Entzerrt die Karte aus einem Bild (Video-Standbild oder Galeriefoto) wie beim Standbild
function warpFromCanvas(src, corners) {
  const vw = src.width, vh = src.height;
  const px = self.WowCardDetect.warpCard(src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, vw, vh).data, vw, vh, corners, HI_W, HI_H, 4);
  if (!px) return null;
  const hi = hiCanvas();
  hi.getContext('2d').putImageData(new ImageData(px, HI_W, HI_H), 0, 0);
  const cv = cardCanvas(), cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(hi, 0, 0, CARD_W, CARD_H);
  const sharp = self.WowCardDetect.sharpness(grayOf(cx.getImageData(0, 0, CARD_W, CARD_H).data, CARD_W * CARD_H), CARD_W, CARD_H);
  return { cv, hi, sharp };
}
/* Foto aus der Galerie (docs/CARD_DETECT.md, Abschnitt „Foto aus der Galerie“). Funktioniert auch ohne Kamera. */
const PHOTO_MSG = 'Kartenrand im Foto nicht gefunden. Bitte die Karte formatfüllend und gerade fotografieren.';
// Bild laden: createImageBitmap mit Ausrichtung aus dem Bild, sonst Image + Object-URL. Länge höchstens 2000 px.
async function loadPhotoCanvas(file) {
  let src = null, url = null;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { src = null; }
  if (!src) { url = URL.createObjectURL(file); src = await loadImage(url); }
  try {
    const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
    const k = Math.min(1, 2000 / Math.max(w0, h0));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w0 * k)); cv.height = Math.max(1, Math.round(h0 * k));
    cv.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, cv.width, cv.height);
    return cv;
  } finally {
    if (src.close) src.close();
    if (url) URL.revokeObjectURL(url);
  }
}
// Kartenrand im Foto: ganzes Bild (Graustufen auf ca. 360 px), sonst mittlerer 70-%-Ausschnitt, sonst das ganze Bild
// als Karte, wenn es ungefähr Kartenformat hat. Liefert Ecken in Pixeln des Fotos oder null.
function findPhotoCard(cv) {
  const W0 = cv.width, H0 = cv.height, s = Math.min(1, 360 / Math.max(W0, H0));
  const sw = Math.max(16, Math.round(W0 * s)), sh = Math.max(16, Math.round(H0 * s));
  const small = document.createElement('canvas');
  small.width = sw; small.height = sh;
  small.getContext('2d', { willReadFrequently: true }).drawImage(cv, 0, 0, sw, sh);
  const area = (x0, y0, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(small, x0, y0, w, h, 0, 0, w, h);
    const r = self.WowCardDetect.detectCard(grayOf(ctx.getImageData(0, 0, w, h).data, w * h), w, h, { minArea: 0.08 });
    return r ? r.corners.map(([x, y]) => [(x0 + x) * W0 / sw, (y0 + y) * H0 / sh]) : null;
  };
  const WHOLE = [[0, 0], [W0, 0], [W0, H0], [0, H0]];
  const cardFormat = Math.abs(W0 / H0 - 63 / 88) <= 0.08;
  // Zugeschnittenes Kartenbild: Der gefundene Rand liegt am Bildrand (bis 4 %), dann ist das ganze Bild die Karte
  const atEdge = (p) => (p[0] <= 0.04 * W0 || p[0] >= 0.96 * W0) && (p[1] <= 0.04 * H0 || p[1] >= 0.96 * H0);
  const full = area(0, 0, sw, sh);
  if (full) return cardFormat && full.every(atEdge) ? WHOLE : full;
  const mid = area(Math.round(sw * 0.15), Math.round(sh * 0.15), Math.round(sw * 0.7), Math.round(sh * 0.7));
  if (mid) return mid;
  if (cardFormat) return WHOLE;
  return null;
}
// Auf den Live-Scan warten, bis er gerade nichts auswertet, dann selbst sperren
async function acquireBusy() {
  while (S.busy) await new Promise((r) => setTimeout(r, 30));
  S.busy = true;
}
async function scanPhoto(file) {
  await acquireBusy();
  try {
    setLive('Foto wird ausgewertet …');
    const cv = await loadPhotoCanvas(file);
    const corners = findPhotoCard(cv);
    if (!corners) { toast(PHOTO_MSG, 'err'); setLive(PHOTO_MSG); return; }
    const s1 = warpFromCanvas(cv, corners);
    if (!s1) { toast('Karte konnte nicht entzerrt werden.', 'err'); setLive(''); return; }
    S.dbgShot = { sharp: s1.sharp };   // nur anzeigen, Galeriefotos werden nicht wegen Unschärfe verworfen
    if (S.cal.debug) drawCardDebug(s1.cv);
    const t0 = performance.now();
    const e = await evalCard(s1.cv, s1.hi, null);
    S.dbg = { raw: e.raw, m: e.m };
    renderDbg();
    const ctx = {
      nameDe: e.m.de || null, number: e.m.st ? `${e.m.st.num}/${e.m.st.tot}` : null,
      readName: async () => { const t = cleanDe(await ocrRegion(s1.hi, 'name')); return t || null; },
    };
    const st = await decide(e.m, ctx);
    logEval('gal', { st, m: e.m, res: e.res, raw: e.raw, ocrMs: e.ocrMs, ms: performance.now() - t0, artMs: e.ms, sharp: s1.sharp });
    if (st === 'captured') setLive(`Erfasst: ${e.m.ranked[0].card.n}. Nächstes Foto oder Karte auflegen.`);
    else if (st === 'none') setLive('Nicht erkannt. Nächstes Foto wählen.');
    // Sperre: Live-Erkennung erfasst dieselbe Karte nicht sofort erneut. Sie gilt, solange die Karte im Kamerabild liegt.
    const keep = st === 'captured' ? e.m.ranked[0].card.k : '?';
    if (S.scanning && S.cd.last) { S.locked = keep; S.miss = 0; S.cd.lockC = S.cd.last; S.cd.state = 'wait-remove'; }
    else { S.locked = null; S.miss = 0; }
  } catch (err) {
    toast(`Foto konnte nicht ausgewertet werden: ${err.message}`, 'err');
  } finally { S.busy = false; }
}

/* Blitz: nur wenn der Browser torch meldet (Android Chrome). iPhone-Safari: Button bleibt versteckt. */
function setupTorch(stream) {
  let track = null, caps = null;
  try { track = stream.getVideoTracks()[0] || null; caps = track && track.getCapabilities ? track.getCapabilities() : null; } catch { caps = null; }
  S.torch = false;
  S.torchTrack = caps && caps.torch ? track : null;
  $('#btnTorch').hidden = !S.torchTrack;
  $('#btnTorch').setAttribute('aria-pressed', 'false');
}
async function setTorch(on) {
  const t = S.torchTrack;
  if (!t) return;
  try { await t.applyConstraints({ advanced: [{ torch: on }] }); S.torch = on; }
  catch (e) { S.torch = false; toast(`Blitz nicht möglich (${(e && e.message) || e}).`, 'err'); }
  $('#btnTorch').setAttribute('aria-pressed', String(S.torch));
}
function torchOff() {
  const t = S.torchTrack;
  if (t && S.torch) { try { t.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {}); } catch { /* ignorieren */ } }
  S.torch = false; S.torchTrack = null;
  $('#btnTorch').hidden = true;
  $('#btnTorch').setAttribute('aria-pressed', 'false');
}
function unlock() {
  S.locked = null; S.miss = 0;
  S.cd.lockC = null; S.cd.stable = 0; S.cd.ref = null; S.cd.state = 'search'; S.cd.t0 = null; S.cd.blur = 0;
}
function drawCardDebug(src) {
  const c = $('#cvCard');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
}
// Ein Foto auswerten: Schärfe, Bildabgleich, OCR (ggf. zwei weitere Standbilder), dann erfassen oder vorschlagen
async function shotAt(corners) {
  const t0 = performance.now();
  S.cd.state = 'shot';
  setLive('Auswerten …');
  const s1 = takeShot(corners);
  if (!s1) { S.cd.state = 'steady'; return; }
  S.dbgShot = { sharp: s1.sharp };
  if (s1.sharp < S.cal.sharpMin) {
    S.cd.state = 'steady';
    S.cd.blur++;
    setLive('Unscharf – ruhig halten …');
    renderDbg();
    return;
  }
  if (S.cal.debug) drawCardDebug(s1.cv);
  const e = await evalCard(s1.cv, s1.hi, null);
  let m = e.m, raw = e.raw, shots = 1;
  if (!m.sure) {
    const cands = e.m.ranked.slice(0, 3).map((c) => c.card), raws = [e.raw];
    for (let i = 0; i < 2 && !m.sure; i++) {
      const d = detect();
      if (!d || moved(d.corners, corners) > 0.02 * cardW(corners)) break;   // Karte liegt nicht mehr ruhig
      const s = takeShot(d.corners);
      if (!s || s.sharp < S.cal.sharpMin) continue;
      raws.push(await readAll(s.hi));
      shots++;
      raw = mergeRaw(raws, cands);
      m = score(e.res, raw);
    }
  }
  S.dbg = { raw, m };
  renderDbg();
  const ctx = {
    nameDe: m.de || null, number: m.st ? `${m.st.num}/${m.st.tot}` : null,
    readName: async () => { const t = cleanDe(await ocrRegion(s1.hi, 'name')); return t || null; },
  };
  const st = await decide(m, ctx);
  logEval('cam', { st, m, res: e.res, raw, ocrMs: e.ocrMs, ms: performance.now() - t0, artMs: e.ms, shots,
    wait: S.cd.t0 != null ? t0 - S.cd.t0 : null, blur: S.cd.blur, sharp: s1.sharp });
  if (st === 'captured') setLive(`Erfasst: ${m.ranked[0].card.n}. Nächste Karte auflegen.`);
  else {
    S.locked = '?';   // Vorschläge, Fehlschlag oder unbekannte Karte: erst weiter, wenn die Karte weg ist
    if (st === 'none') setLive('Nicht erkannt. Nächste Karte auflegen.');
  }
  S.miss = 0; S.cd.lockC = corners; S.cd.state = 'wait-remove';
}
// Ein Erkennungsschritt (alle 150 ms)
async function tick() {
  const det = detect();
  S.cd.last = det ? det.corners : null;
  S.cd.score = det ? round2(det.score) : null;
  drawQuad(det ? det.corners : null);
  if (S.locked !== null) {                                   // wait-remove
    if (det) {
      if (S.cd.lockC && moved(det.corners, S.cd.lockC) > 0.15 * cardW(S.cd.lockC)) unlock();
      else S.miss = 0;
    } else if (++S.miss >= 2) unlock();
    return;
  }
  if (!det) { S.cd.state = 'search'; S.cd.stable = 0; S.cd.ref = null; S.cd.t0 = null; S.cd.blur = 0; setLive('Karte in den Rahmen legen …'); return; }
  if (S.cd.t0 == null) S.cd.t0 = performance.now();   // Log: Zeit von der ersten Erkennung bis zum Foto
  S.cd.stable = S.cd.ref && moved(det.corners, S.cd.ref) <= 0.02 * cardW(det.corners) ? S.cd.stable + 1 : 1;
  S.cd.ref = det.corners;
  if (S.cd.stable < 3) { S.cd.state = 'search'; setLive('Karte erkannt – ruhig halten …'); return; }
  S.cd.state = 'steady';
  await shotAt(det.corners);
}
// Grünes Viereck über dem Video: Ecken in Videopixeln → Kamerafläche (object-fit: cover wie layoutGuide)
function drawQuad(c) {
  const q = $('#quad');
  if (!c) { q.setAttribute('hidden', ''); return; }   // SVG hat kein hidden-Attribut als Eigenschaft
  const cam = $('#cam'), vid = $('#video'), cw = cam.clientWidth, ch = cam.clientHeight;
  const s = Math.max(cw / vid.videoWidth, ch / vid.videoHeight);
  const ox = (cw - vid.videoWidth * s) / 2, oy = (ch - vid.videoHeight * s) / 2;
  q.querySelector('polygon').setAttribute('points', c.map(([x, y]) => `${(ox + x * s).toFixed(1)},${(oy + y * s).toFixed(1)}`).join(' '));
  q.removeAttribute('hidden');
}
// Button „Foto auswerten“: zuletzt erkannte Ecken, sonst der Overlay-Rahmen
async function shotNow() {
  if (S.busy || !S.scanning || !S.guide) return;
  S.busy = true;
  try {
    const c = S.cd.last || guideCorners();
    unlock();
    await shotAt(c);
  } catch (e) { toast(`Auswertung fehlgeschlagen: ${e.message}`, 'err'); }
  finally { S.busy = false; }
}
// Vorschläge „Name · Set · Preis“; unverändert gebliebene Liste nicht neu zeichnen (Antippen bleibt stabil).
function showSuggest(list, title, ctx = {}) {
  const key = list.map((r) => r.card.k).join(',');
  S.sugg = list; S.suggCtx = ctx;
  $('#suggTitle').textContent = title;
  if (key !== S.suggKey || $('#suggest').hidden) {
    S.suggKey = key;
    $('#chips').innerHTML = list.map((r, i) => {
      const pi = priceInfo(r.card, S.ui.foil);
      return `<button class="chip" type="button" data-si="${i}">${esc(r.card.n)}<b>${Math.round(r.pts)} P.</b>
      <small>${esc(metaLine(setName(r.card.s, r.card.sc), numPart(numStr(r.card)), pi.value == null ? 'kein Preis' : fmtMoney(pi.value, pi.cur) + (pi.fallback ? ' (' + PT_LABEL[pi.pt] + ')' : '')))}</small></button>`;
    }).join('');
  }
  $('#suggest').hidden = list.length === 0;
}
function hideSuggest() { $('#suggest').hidden = true; S.sugg = []; S.suggKey = ''; }
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
  for (const r of REGS) placeBox($('#box-' + r), regBox(r), gx, gy, gw, gh);
  placeBox($('#boxArt'), ART_BOX, gx, gy, gw, gh);
}
function placeBox(el, b, gx, gy, gw, gh) {
  Object.assign(el.style, { left: gx + gw * b.x + 'px', top: gy + gh * b.y + 'px', width: gw * b.w + 'px', height: gh * b.h + 'px' });
}
const showBoxes = (on) => $$('#cam .cal-box').forEach((el) => { el.hidden = !on; });

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
  setupTorch(stream);
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
  $('#btnShot').disabled = false;
  S.cd = newCd();
  $('#guide').hidden = false;
  showBoxes(true);
  layoutGuide();
  renderDbg();
  keepAwake(true);
  S.ocrFailed = false;
  setBanner('ocr', '', '');
  ocrUsable('eng');   // Nummer und Werte: Texterkennung im Hintergrund laden
  if (!S.art) setLive('Lade Texterkennung (einmalig) …');
  else setLive('Karte in den Rahmen legen …');
  startLoop();
}
function startLoop() {
  const id = ++S.loopId;
  const step = async () => {
    if (!S.scanning || id !== S.loopId) return;
    if (!S.busy && $('#video').videoWidth && S.guide) {
      S.busy = true;
      try { await tick(); } catch (e) { console.warn('Erkennung', e); }
      finally { S.busy = false; }
    }
    if (S.scanning && id === S.loopId) setTimeout(step, DET_MS);
  };
  step();
}
function stopScan() {
  S.scanning = false;
  S.loopId++;
  S.locked = null; S.miss = 0; S.cd = newCd();
  torchOff();
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
  const v = $('#video');
  v.srcObject = null; v.hidden = true;
  $('#guide').hidden = true;
  showBoxes(false);
  $('#btnScan').textContent = 'Scan starten';
  $('#btnScan').setAttribute('aria-pressed', 'false');
  $('#btnShot').disabled = true;
  drawQuad(null);
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
    add(out.byRar, r.rarity || '–', rarityName(r.rarity) || '–', q, tot);
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
function sourceSummary() {
  const cur = S.settings.currency;
  return `TCGplayer-Preis (US), gewählt: ${PT_LABEL[S.ui.priceType]} (fehlt er, Ersatz Markt → Mittel → Tiefst; je Eintrag gespeichert)${cur === 'USD' ? '' : ', umgerechnet'}, Stand ${fmtDate(S.data && S.data.prices ? S.data.prices.priceDate : '')}`;
}
function renderColl() {
  const cur = S.settings.currency;
  const sm = summarize(S.scans);
  $('#totals').innerHTML = `
    <div class="stat"><div class="big num">${sm.count}</div><div class="lbl">Karten gesamt (${S.scans.length} Einträge)</div></div>
    <div class="stat"><div class="big num">${esc(fmtMoney(sm.total, cur))}</div><div class="lbl">Gesamtwert in ${esc(cur)}</div></div>
    <div class="stat wide"><div class="lbl">Quelle: ${esc(sourceSummary())}.${sm.noPrice ? ` ${sm.noPrice} Karte(n) ohne Preis, nicht gezählt.` : ''}</div></div>`;
  $('#tSet').innerHTML = groupRows(sm.bySet);
  $('#tRar').innerHTML = groupRows(sm.byRar);
  $('#top10').innerHTML = sm.priced.slice(0, 10).map(({ r, unit }) => `<li>${esc(dispName(r))} <span class="muted">${esc(metaLine(setName(r.set, r.setCode), numPart(r.number), r.foil ? 'Foil' : ''))}</span> – <strong>${esc(fmtMoney(unit, cur))}</strong></li>`).join('')
    || '<li class="muted">Noch keine bepreisten Karten.</li>';
  $('#scanList').innerHTML = S.scans.map((r) => itemHtml(r, true)).join('')
    || '<li class="muted">Noch keine Scans. Erfasse Karten im Tab „Scannen“ oder über die Suche.</li>';
}

const CSV_HEAD = ['id', 'Zeitstempel', 'Name', 'Name (deutsch)', 'Schlüssel', 'Set', 'Set-Kürzel', 'Nummer', 'Seltenheit', 'Typ', 'Klasse', 'Fraktion', 'Kosten', 'ATK', 'Leben',
  'Rasse', 'Foil', 'Zustand', 'Menge', 'Preis USD', 'Preis', 'Währung', 'Preisart', 'Preisdatum', 'Quelle', 'URL', 'Bild-URL', 'OCR-Konfidenz', 'Erkennung', 'Wert gesamt'];
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
      r.id, r.ts, r.name, r.nameDe, r.key, r.set, r.setCode, r.number, rarityName(r.rarity), r.type, r.cls ?? r.cardClass, r.faction, r.cost, r.atk, r.hp ?? r.health,
      r.race, r.foil ? 'ja' : 'nein', r.condition, r.qty, csvNum(r.priceUsd, comma), csvNum(r.price, comma), r.currency,
      PT_LABEL[r.priceType] || r.priceType, r.priceDate, r.source, r.url, r.imageUrl, r.ocrConfidence,
      r.matchInfo ? `${(r.matchInfo.signals || []).join(' ')} = ${r.matchInfo.score}` : '', total,
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
  L.push(`Preisquelle: ${sourceSummary()}`, '');
  const block = (title, map) => {
    L.push(title);
    for (const g of [...map.values()].sort((a, b) => b.v - a.v)) L.push(`  ${g.label}: ${g.q} Stk., ${fmtMoney(round2(g.v), cur)}`);
    L.push('');
  };
  block('Pro Set:', sm.bySet);
  block('Pro Seltenheit:', sm.byRar);
  L.push('Top 10 teuerste (Einzelpreis):');
  sm.priced.slice(0, 10).forEach(({ r, unit }, i) => L.push(`  ${i + 1}. ${dispName(r)} (${metaLine(setName(r.set, r.setCode), numPart(r.number), r.foil ? 'Foil' : '')}) – ${fmtMoney(unit, cur)}`));
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
      <div class="name">${esc(dispName(r))}</div>
      <div class="sub">${esc(metaLine(setName(r.set, r.setCode), numPart(r.number), rarityName(r.rarity), statLine(r), r.foil ? 'Foil' : '', r.condition))}</div>
      ${coll
        ? `<div class="qty"><button class="btn sm" type="button" data-act="dec" data-id="${r.id}" aria-label="Menge verringern">&minus;</button><output aria-label="Menge">${r.qty}</output><button class="btn sm" type="button" data-act="inc" data-id="${r.id}" aria-label="Menge erhöhen">+</button></div>`
        : `<div class="sub">Menge ${r.qty}</div>`}
    </div>
    <div class="amt ${typeof r.price === 'number' ? '' : 'none'}">${priceShort(r)}
      ${typeof r.price === 'number' ? `<div class="sub">je Karte${r.priceType && r.priceType !== 'market' ? ' · ' + esc(PT_LABEL[r.priceType] || r.priceType) : ''}</div>` : ''}
      ${coll ? `<div><button class="btn danger del" type="button" data-act="del" data-id="${r.id}">Löschen</button></div>` : ''}
    </div>
  </li>`;
}
function renderScan() {
  const el = $('#last');
  const rec = S.scans.find((r) => r.id === S.lastId);
  if (!rec) { el.hidden = true; el.innerHTML = ''; return; }
  const img = safeUrl(rec.imageUrl);
  const wanted = S.lastWanted && S.lastWanted.id === rec.id ? S.lastWanted.wanted : rec.priceType;
  const pi = { value: typeof rec.price === 'number' ? rec.price : null, cur: rec.currency, pt: rec.priceType, wanted, date: rec.priceDate, note: rec.priceUsd != null ? 'Kein Umrechnungskurs' : rec.productId == null ? 'Kein TCGplayer-Produkt zu dieser Karte' : 'Keine Preisdaten für dieses Produkt' };
  el.hidden = false;
  el.innerHTML = `
    ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '<div class="thumb" aria-hidden="true"></div>'}
    <div>
      <h3>${esc(dispName(rec))}</h3>
      <div class="sub">${esc(metaLine(setName(rec.set, rec.setCode), numPart(rec.number), rarityName(rec.rarity)))}</div>
      <div class="sub">${esc(metaLine(rec.type, statLine(rec), rec.race, rec.cls || rec.cardClass, rec.faction))}</div>
      <div>${rec.foil ? '<span class="badge">Foil</span>' : ''}<span class="badge">${esc(rec.condition)}</span><span class="badge">Menge ${rec.qty}</span></div>
      ${priceBlockHtml(pi)}
    </div>
    <div class="row-actions"><button class="btn primary" type="button" data-act="plus1">+1 (Menge erhöhen)</button>
    ${variantsFor(rec).map((c) => `<button class="chip sm" type="button" data-var="${esc(c.k)}">Variante ändern: ${esc(c.n)}</button>`).join('')}</div>`;
}
function variantsFor(rec) {
  const card = S.idx && rec.key ? S.idx.byK.get(rec.key) : null;
  return card ? variantsOf(card).slice(0, 4) : [];
}
// Variante wechseln: die API kann nur die Menge ändern → Eintrag löschen und als anderes Produkt neu anlegen
async function switchVariant(k) {
  const rec = S.scans.find((r) => r.id === S.lastId), card = S.idx && S.idx.byK.get(k);
  if (!rec || !card) return;
  try { await api('DELETE', `api/scans?id=${rec.id}`); } catch (e) { toast(`Wechsel fehlgeschlagen: ${e.message}`, 'err'); return; }
  S.scans = S.scans.filter((r) => r.id !== rec.id);
  if (S.locked === rec.key) S.locked = k;
  const mi = rec.matchInfo ? { ...rec.matchInfo, signals: [...(rec.matchInfo.signals || []), 'Variante'] } : { signals: ['Variante'] };
  await captureCard(card, { foil: rec.foil, cond: rec.condition, qty: rec.qty, nameDe: rec.nameDe, number: rec.number, matchInfo: mi });
}
function renderRecent() {
  $('#recent').innerHTML = S.scans.slice(0, 5).map((r) => itemHtml(r, false)).join('')
    || '<li class="muted">Noch nichts erfasst.</li>';
}
function renderScanInfo() {
  if (!S.data) { setInfo('Keine Kartendaten geladen.'); return; }
  const n = S.data.cards.cards ? S.data.cards.cards.length : 0;
  const date = (S.data.prices && S.data.prices.priceDate) || S.data.meta.priceDate;
  const v2 = (S.data.cards.version || 1) >= 2;   // cards.json Version 1: keine Sammlernummern
  setInfo(`${n} Karten · Preise Stand ${fmtDate(date)} · Währung ${S.settings.currency}${S.setFilter ? ' · Set-Filter: ' + S.setFilter : ''} · Erkennung: ${v2 ? 'Set+Nummer' : 'Set+Nummer noch nicht verfügbar (Kartendatenbank fehlt)'}, Werte, ${S.art ? `Bild (${S.art.count})` : 'ohne Bild'}, Name (${Object.keys(S.learned).length} deutsche gelernt) · Namen englisch`);
}
function renderSetFilter() {
  const sel = $('#setFilter');
  sel.innerHTML = '<option value="">Alle Sets</option>' + (S.idx ? S.idx.sets : []).map((x) => `<option>${esc(x)}</option>`).join('');
  sel.value = S.setFilter;
}
function setInfo(t) { $('#dataInfo').textContent = t; }
function renderEspInfo() {
  const e = S.esp;
  $('#espInfo').innerHTML = e
    ? [['Version', e.version], ['IP', e.ip], ['Hostname', e.hostname ? e.hostname + '.local' : '–'], ['Scans', e.scans],
      ['Freier Speicher', e.freeHeap != null ? e.freeHeap + ' B' + (e.maxBlock != null ? ` (größter Block ${e.maxBlock} B, Minimum ${e.minHeap} B)` : '') : '–'], ['Laufzeit', fmtUptime(e.uptime)],
      ...(e.rssi != null ? [['WLAN-Signal', `${e.rssi} dBm · ${e.wifiDrops} Abbrüche`], ['Letzter Neustart', e.resetReason || '–']] : []),
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
  const toks = norm(q).split(' ').filter(Boolean);
  if (!toks.length) {
    info.textContent = q.trim() ? 'Bitte Buchstaben oder Zahlen eingeben.' : 'Tippe einen Kartennamen ein.';
    list.innerHTML = ''; S.res = [];
    return;
  }
  const { cards, names } = S.idx, flt = S.setFilter;
  const out = [];
  for (let i = 0; i < names.length && out.length < 40; i++) {
    if (flt && cards[i].s !== flt) continue;
    const nm = names[i];
    if (toks.every((t) => nm.includes(t))) out.push({ card: cards[i], score: 1 });
  }
  let fuzzy = false;
  if (out.length < 3) {
    for (const r of matchName(q).ranked) for (const card of r.cards) if (!out.some((o) => o.card === card)) { out.push({ card, score: r.score }); fuzzy = true; }
  }
  S.res = out.slice(0, 40);
  info.textContent = (S.res.length ? `${S.res.length} Treffer${fuzzy ? ' (inkl. unscharfer Treffer)' : ''}` : 'Keine Treffer.') + (flt ? ` · nur Set „${flt}“` : '');
  list.innerHTML = S.res.map((r, i) => {
    const img = safeUrl(r.card.img);
    const pi = priceInfo(r.card, S.ui.foil);
    return `<li><button class="row-btn" type="button" data-ridx="${i}">
      ${img ? `<img class="thumb" src="${esc(img)}" alt="" loading="lazy">` : '<div class="thumb" aria-hidden="true"></div>'}
      <div><div class="name">${esc(r.card.n)}</div><div class="sub">${esc(metaLine(setName(r.card.s, r.card.sc), numPart(numStr(r.card)), rarityName(r.card.r), statLine(r.card)))}</div></div>
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
  $('#dlgBody').innerHTML = `<div class="sub">${esc(metaLine(setName(card.s, card.sc), numPart(numStr(card)), rarityName(card.r), card.t, statLine(card)))}</div>
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
  $('#calImgS').value = S.cal.imgMax; $('#calImgV').textContent = S.cal.imgMax;
  $('#calSharpS').value = S.cal.sharpMin; $('#calSharpV').textContent = S.cal.sharpMin;
  const o = S.cal.off[$('#calReg').value];
  $('#calXS').value = o[0]; $('#calXV').textContent = o[0];
  $('#calYS').value = o[1]; $('#calYV').textContent = o[1];
  $('#learnInfo').textContent = `${Object.keys(S.learned).length} gelernte Zuordnungen`;
  $('#calDbg').checked = S.cal.debug;
  $('#calLog').checked = S.cal.log;
}
function saveCal() { lsSet(LS_CAL, S.cal); }
// Import gelernter Namen: { names: {de: k} } oder direkt {de: k}; wird zusammengeführt
function importLearned(text) {
  let n = 0;
  try {
    const j = JSON.parse(text), src = j && typeof j.names === 'object' ? j.names : j;
    for (const [de, k] of Object.entries(src || {})) if (typeof k === 'string' && k) { learn(de, k); n++; }
  } catch { return 'Import fehlgeschlagen: keine gültige JSON-Datei.'; }
  renderCal(); renderScanInfo();
  return `${n} Zuordnungen importiert.`;
}
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
  $('#btnShot').addEventListener('click', shotNow);
  $('#btnGallery').addEventListener('click', () => $('#galFile').click());
  $('#galFile').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) scanPhoto(f); });
  $('#btnTorch').addEventListener('click', () => setTorch(!S.torch));
  $('#scanFoil').addEventListener('change', (e) => { S.ui.foil = e.target.checked; lsSet(LS_UI, S.ui); });
  $('#last').addEventListener('click', (e) => { const b = e.target.closest('[data-var]'); if (b) switchVariant(b.dataset.var); });
  $('#chips').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-si]');
    if (!b) return;
    const r = S.sugg[Number(b.dataset.si)];
    hideSuggest();
    if (!r) return;
    const ctx = S.suggCtx || {};
    S.locked = r.card.k; S.miss = 0;
    const rec = await captureCard(r.card, { nameDe: ctx.nameDe, number: ctx.number, matchInfo: { signals: [...r.sig, 'Auswahl'], score: Math.round(r.pts) } });
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
  $('#setFilter').addEventListener('change', (e) => {
    S.setFilter = e.target.value; lsSet(LS_FLT, S.setFilter);
    unlock(); hideSuggest();
    renderScanInfo();
    if ($('#q').value) runSearch();
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
  $('#calReg').addEventListener('change', renderCal);
  ['X', 'Y'].forEach((a, i) => $(`#cal${a}S`).addEventListener('input', (e) => {
    S.cal.off[$('#calReg').value][i] = Number(e.target.value); saveCal(); renderCal(); layoutGuide();
  }));
  $('#btnLearnExp').addEventListener('click', () => deliver(new Blob([JSON.stringify({ version: 1, names: S.learned }, null, 2)], { type: 'application/json' }), `wow-deutsche-namen-${today()}.json`));
  $('#btnLearnImp').addEventListener('click', () => $('#learnFile').click());
  $('#learnFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) toast(importLearned(await f.text()));
  });
  $('#calDbg').addEventListener('change', (e) => { S.cal.debug = e.target.checked; saveCal(); renderDbg(); });
  $('#calLog').addEventListener('change', (e) => { S.cal.log = e.target.checked; saveCal(); });
  $('#calImgS').addEventListener('input', (e) => { S.cal.imgMax = Number(e.target.value); $('#calImgV').textContent = S.cal.imgMax; saveCal(); });
  $('#calSharpS').addEventListener('input', (e) => { S.cal.sharpMin = Number(e.target.value); $('#calSharpV').textContent = S.cal.sharpMin; saveCal(); });
  $('#calReset').addEventListener('click', () => { for (const r of CAL_REGS) S.cal.off[r] = [0, 0]; S.cal.imgMax = MATCH_MAX; S.cal.sharpMin = SHARP_MIN; saveCal(); renderCal(); layoutGuide(); });
  // Bilder ohne Erfolg unsichtbar machen, Platz im Raster bleibt erhalten (kein Inline-Handler)
  document.addEventListener('error', (e) => { if (e.target && e.target.tagName === 'IMG') e.target.style.visibility = 'hidden'; }, true);
  $('#video').addEventListener('resize', layoutGuide);
  window.addEventListener('resize', layoutGuide);
  window.addEventListener('online', () => { refreshStatus(); if (!S.data) loadData(); });
  window.addEventListener('offline', () => setBanner('net', 'warn', 'Keine Internetverbindung. Gecachte Kartendaten bleiben nutzbar.'));
  window.addEventListener('online', () => setBanner('net', '', ''));
  if (navigator.share) $('#btnShare').hidden = false;
}

function buildRegionUi() {
  const ref = $('#camMsg');
  for (const r of REGS) {
    const d = document.createElement('div');
    d.id = 'box-' + r; d.className = 'cal-box'; d.hidden = true; d.setAttribute('aria-hidden', 'true');
    d.innerHTML = `<span>${REG[r].l}</span>`;
    ref.before(d);
  }
  $('#dbgReg').innerHTML = REGS.map((r) => `<figure class="${REG[r].w > 0.3 ? 'wide' : ''}"><canvas id="cv-${r}" width="10" height="10"></canvas><figcaption>${REG[r].l}: <span id="raw-${r}">–</span></figcaption></figure>`).join('');
  $('#calReg').innerHTML = CAL_REGS.map((r) => `<option value="${r}">${REG[r].l}</option>`).join('');
}
async function boot() {
  buildRegionUi();
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
function loadImage(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Bild nicht ladbar: ' + url)); i.src = url; });
}
const bootP = boot();
window.__wow = {
  ready: bootP,
  // Bild wie den Kartenrahmen eines Kamerabilds auswerten. opts: feed (Erfassungslogik), filter (Canvas-Filter), shift (px), scale
  async testImage(url, opts = {}) {
    const img = await loadImage(url);
    const cv = document.createElement('canvas');
    cv.width = CARD_W; cv.height = CARD_H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, CARD_W, CARD_H);
    if (opts.filter) ctx.filter = opts.filter;
    const sc = opts.scale || 1, sh = opts.shift || 0;
    ctx.drawImage(img, sh + (CARD_W - CARD_W * sc) / 2, sh + (CARD_H - CARD_H * sc) / 2, CARD_W * sc, CARD_H * sc);
    return processCard(cv, opts.feed !== false);
  },
  // artHash eines Bildes in Originalgröße (Abgleich Browser ↔ Python)
  async hashImage(url) {
    const img = await loadImage(url);
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const r = self.WowArtHash.artHash(ctx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height, 4);
    return { hash: r.hash, color: r.color };
  },
  artState: () => (S.art ? { groups: S.art.n, products: S.art.count, imgMax: S.cal.imgMax } : null),
  testMatch(nameText) {
    const m = matchName(nameText);
    const out = (r) => ({ base: r.base, name: r.card.n, pid: r.card.p, score: round3(r.score), printings: r.cards.map((c) => c.p) });
    return { top: m.ranked[0] ? out(m.ranked[0]) : null, ranked: m.ranked.map(out), ms: round3(m.ms) };
  },
  // Führt einen OCR-Frame-Auswertungsschritt aus (ohne Kamera), für Tests der Stabilitätsregel.
  // Ein Frame mit vorgegebenen OCR-Rohtexten je Bereich (name, strip, cost, atk, hp), optional mit Kartenbild (image)
  async frame(inj = {}, opts = {}) {
    let cv = null;
    if (inj.image) {
      const img = await loadImage(inj.image);
      cv = document.createElement('canvas'); cv.width = CARD_W; cv.height = CARD_H;
      cv.getContext('2d').drawImage(img, 0, 0, CARD_W, CARD_H);
    }
    return processCard(cv, opts.feed !== false, inj);
  },
  // Zusammenführen mehrerer Standbilder (Tests): raws = Rohtexte je Standbild, keys = Kandidaten (k)
  mergeRaw: (raws, keys) => mergeRaw(raws, keys.map((k) => S.idx.byK.get(k)).filter(Boolean)),
  learned: () => ({ ...S.learned }),
  importLearned,
  regions: () => Object.fromEntries(REGS.map((r) => [r, regBox(r)])),
  setFilter(v) { const sel = $('#setFilter'); sel.value = v; sel.dispatchEvent(new Event('change')); },
  card: (k) => (S.idx ? S.idx.byK.get(k) || null : null),
  priceInfo(pid, foil, pt, cur) {
    const card = S.idx && S.idx.cards.find((c) => c.p === pid);
    return card ? priceInfo(card, foil, pt, cur) : null;
  },
  state: () => ({
    settings: S.settings, ui: S.ui, indexed: S.idx ? S.idx.n : 0, indexMs: S.idx ? round3(S.idx.ms) : null,
    scans: S.scans.length, locked: S.locked, base: S.base, cardState: S.cd.state,
    sharp: S.dbgShot ? round3(S.dbgShot.sharp) : null,
  }),
  setView: showView,
  // Testhilfe: n gleichzeitige API-Aufrufe; liefert die größte Zahl gleichzeitig offener Anfragen
  async apiBurst(n) {
    apiMaxInFlight = 0;
    await Promise.all(Array.from({ length: n }, () => api('GET', 'api/status').catch(() => null)));
    return apiMaxInFlight;
  },
  subKey(pid, foil) { const c = S.idx && S.idx.cards.find((x) => x.p === pid); const i = c ? priceInfo(c, foil) : null; return i ? { sub: i.sub, isFoil: i.isFoil, value: i.value } : null; },
  rarityName,
  csv: () => makeCsv(S.scans),
  json: () => makeJson(S.scans),
  report: () => makeReport(),
  setSearch(q) { $('#q').value = q; runSearch(); },
  openFirstResult() { const r = S.res[0]; if (r) openDetail(r.card); },
};
})();
