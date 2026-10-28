#!/usr/bin/env node
/* Mock-ESP für die Web-App-Entwicklung (Node 22, keine Abhängigkeiten).
 *
 *   node webapp/dev/mock_server.js            → http://127.0.0.1:8080
 *   PORT=9000 node webapp/dev/mock_server.js
 *
 * Liefert webapp/ (index.html, app.js, style.css) und webapp/dev/sample-data/ unter /sample-data/.
 * Implementiert die /api/*-Endpunkte aus docs/SPEC.md (Abschnitt 1) im Speicher.
 * Die Sample-Daten sind ERFUNDEN (siehe meta.json: "sample": true).
 *
 * Zusatz nur für Tests: POST /__mock/reset setzt Scans und Einstellungen zurück. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const WEBAPP = path.resolve(__dirname, '..');
const SAMPLE = path.join(__dirname, 'sample-data');
const PORT = Number(process.env.PORT) || 8080;
const MAX_BODY = 2048;          // Spec: POST /api/scan max. 2 KB
const MAX_SCANS = 2000;         // Spec: danach 507

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const START = Date.now();

function freshState() {
  return {
    scans: [],
    nextId: 1,
    settings: { country: 'DE', currency: 'EUR', dataUrl: null }, // dataUrl wird pro Anfrage aus dem Host gesetzt
  };
}
let state = freshState();

const send = (res, code, obj, extra = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...extra });
  res.end(body);
};
const sendErr = (res, code, msg) => send(res, code, { ok: false, error: msg });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('zu groß'), { status: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req, limit = MAX_BODY) {
  const txt = await readBody(req, limit);
  try { return JSON.parse(txt || 'null'); } catch { throw Object.assign(new Error('ungültiges JSON'), { status: 400 }); }
}

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    res.end(buf);
  });
}
function safeJoin(root, rel) {
  const p = path.normalize(path.join(root, rel));
  return p.startsWith(root + path.sep) ? p : null;
}

async function api(req, res, url) {
  const q = url.searchParams;
  const id = Number(q.get('id'));
  const hostUrl = `http://${req.headers.host || '127.0.0.1:' + PORT}`;
  if (state.settings.dataUrl === null) state.settings.dataUrl = `${hostUrl}/sample-data/`;

  if (req.method === 'GET' && url.pathname === '/api/status') {
    return send(res, 200, {
      version: 'mock-1.0.0', ip: '127.0.0.1', hostname: 'wowscanner-mock', scans: state.scans.length,
      freeHeap: 30000, maxBlock: 21000, heapFrag: 12, minHeap: 15000, rssi: -58, wifiDrops: 0, resetReason: 'Software/System restart', uptime: Math.floor((Date.now() - START) / 1000),
      country: state.settings.country, currency: state.settings.currency, dataUrl: state.settings.dataUrl,
    });
  }
  if (url.pathname === '/api/scans') {
    if (req.method === 'GET') return send(res, 200, state.scans);
    if (req.method === 'DELETE' && !q.has('id')) { state.scans = []; return send(res, 200, { ok: true }); }
    if (req.method === 'DELETE') {
      const i = state.scans.findIndex((s) => s.id === id);
      if (i < 0) return sendErr(res, 404, 'Scan nicht gefunden');
      state.scans.splice(i, 1);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PATCH') {
      const s = state.scans.find((x) => x.id === id);
      if (!s) return sendErr(res, 404, 'Scan nicht gefunden');
      const b = await readJson(req);
      const qty = Number(b && b.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 999) return sendErr(res, 400, 'qty ungültig');
      s.qty = qty;
      return send(res, 200, { ok: true, id, qty });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/scan') {
    let rec;
    try { rec = await readJson(req, MAX_BODY); }
    catch (e) { return sendErr(res, e.status || 400, e.message); }
    if (!rec || typeof rec !== 'object') return sendErr(res, 400, 'Body fehlt');
    if (state.scans.length >= MAX_SCANS) return sendErr(res, 507, 'Speicher voll (max. 2000 Scans)');
    const id2 = state.nextId++;
    state.scans.push({ ...rec, id: id2 });
    return send(res, 200, { ok: true, id: id2 });
  }
  if (url.pathname === '/api/settings') {
    if (req.method === 'GET') return send(res, 200, state.settings);
    if (req.method === 'POST') {
      let b;
      try { b = await readJson(req); } catch (e) { return sendErr(res, e.status || 400, e.message); }
      if (!b || typeof b.country !== 'string' || typeof b.currency !== 'string') return sendErr(res, 400, 'country/currency fehlt');
      state.settings = { country: b.country, currency: b.currency, dataUrl: typeof b.dataUrl === 'string' ? b.dataUrl : state.settings.dataUrl };
      return send(res, 200, { ok: true });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/update') {
    return sendErr(res, 501, 'OTA im Mock nicht unterstützt');
  }
  if (req.method === 'POST' && url.pathname === '/__mock/reset') {
    state = freshState();
    return send(res, 200, { ok: true });
  }
  return sendErr(res, 404, 'Unbekannter Endpunkt');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/') || url.pathname === '/__mock/reset') return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (url.pathname.startsWith('/sample-data/')) {
      const f = safeJoin(SAMPLE, decodeURIComponent(url.pathname.slice('/sample-data/'.length)));
      if (!f) { res.writeHead(403); return res.end(); }
      return serveFile(res, f);
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    if (rel.startsWith('dev/') || rel.includes('..')) { res.writeHead(404); return res.end('404'); }
    const f = safeJoin(WEBAPP, rel);
    if (!f) { res.writeHead(403); return res.end(); }
    return serveFile(res, f);
  } catch (e) {
    if (!res.headersSent) sendErr(res, 500, String(e && e.message || e));
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Mock-ESP läuft: http://127.0.0.1:${PORT}/  (Sample-Daten: /sample-data/)`);
  });
}
module.exports = { server, PORT };
