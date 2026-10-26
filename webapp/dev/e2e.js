#!/usr/bin/env node
/* End-to-End-Tests der Web-App mit Playwright (vorinstalliertes Chromium, kein playwright install).
 *   node webapp/dev/e2e.js
 * Startet den Mock-ESP im Prozess, testet Abgleich, Stabilitätsregel, Preise, Suche, Sammlung,
 * CSV/JSON/Text-Export, Einstellungen, Kamerastart (Fake-Device), Fehlerfälle und das Layout bei 390x844.
 * Tesseract-CDN wird blockiert (Sandbox), OCR selbst wird daher nicht getestet, nur der Abgleich über window.__wow. */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

const PORT = Number(process.env.PORT) || 8097;
process.env.PORT = String(PORT);
const { server } = require('./mock_server.js');
const { chromium } = require('playwright');

const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n').slice(0, 6).join('\n      ')); }
}

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return null;
}
async function api(method, p, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::ERR|sample\.invalid/.test(m.text())) page.errors.push('console: ' + m.text());
  });
  return page;
}
async function openApp(ctx, url) {
  const page = await newPage(ctx);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url || `http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.__wow.ready);
  return page;
}
const setRange = (page, sel, v) => page.evaluate(([q, val]) => { const el = document.querySelector(q); el.value = String(val); el.dispatchEvent(new Event('input', { bubbles: true })); }, [sel, v]);
const tab = (page, v) => page.click(`.tab[data-view="${v}"]`);
const scanCount = async () => (await api('GET', '/api/scans')).body.length;

async function main() {
  await new Promise((r) => server.listen(PORT, '0.0.0.0', r));
  await api('POST', '/__mock/reset');
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
  // Tesseract-CDN ist aus dieser Umgebung nicht erreichbar: simulieren
  await ctx.route('https://cdn.jsdelivr.net/**', (r) => r.abort());

  const page = await openApp(ctx);

  /* ---------- Start und Daten ---------- */
  await check('Start: Daten geladen (25 Beispielkarten)', async () => {
    const info = await page.textContent('#dataInfo');
    assert.match(info, /25 Karten/);
    const st = await page.evaluate(() => window.__wow.state());
    assert.equal(st.indexed, 25);
    assert.equal(st.settings.currency, 'EUR');
    assert.match(await page.textContent('#espPill'), /Scanner .* Scans/);
  });
  await check('ESP-API: höchstens eine Anfrage gleichzeitig (Warteschlange)', async () => {
    const max = await page.evaluate(() => window.__wow.apiBurst(6));
    assert.equal(max, 1);
  });
  await check('ESP-API: relative URLs und Tesseract-Pfade im Quelltext', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.equal(/['"`]\/api\//.test(src), false, 'absolute /api/-Pfade gefunden');
    assert.match(src, /tesseract\.js@5\.1\.1\/dist\/worker\.min\.js/);
    assert.match(src, /tesseract\.js-core@5\.1\.1/);
    assert.match(src, /@tesseract\.js-data\/eng@1\.0\.0\/4\.0\.0_best_int/);
  });
  await check('Start: keine Seitenfehler', async () => { assert.deepEqual(page.errors, []); });
  await page.screenshot({ path: path.join(SHOTS, '01-scan.png') });

  /* ---------- Abgleich ---------- */
  await check('Abgleich: exakter Name', async () => {
    const m = await page.evaluate(() => window.__wow.testMatch('Sample Knight of Testing', '001/120'));
    assert.equal(m.top.pid, 900001);
    assert.ok(m.top.score >= 0.99, 'score ' + m.top.score);
  });
  await check('Abgleich: OCR-Fehler (1 Zeichen) wird toleriert', async () => {
    const m = await page.evaluate(() => window.__wow.testMatch('Sample Knight of Testng', ''));
    assert.equal(m.top.pid, 900001);
    assert.ok(m.top.score >= 0.8, 'score ' + m.top.score);
  });
  await check('Abgleich: Groß/Klein, Sonderzeichen werden normalisiert', async () => {
    const m = await page.evaluate(() => window.__wow.testMatch('  SAMPLE: ember-warden!  ', ''));
    assert.equal(m.top.pid, 900002);
    assert.ok(m.top.score >= 0.99);
  });
  await check('Abgleich: Priest und Priestess werden getrennt erkannt', async () => {
    const a = await page.evaluate(() => window.__wow.testMatch('Sample Dawn Priest', '007/120'));
    const b = await page.evaluate(() => window.__wow.testMatch('Sample Dawn Priest', '008/120'));
    assert.equal(a.top.pid, 900007);
    assert.equal(b.top.pid, 900007);
    const c = await page.evaluate(() => window.__wow.testMatch('Sample Dawn Priestes', '008/120'));
    assert.equal(c.top.pid, 900008);
  });
  await check('Abgleich: Unsinn ergibt keinen Treffer', async () => {
    const m = await page.evaluate(() => window.__wow.testMatch('qwzx vbnm', ''));
    assert.equal(m.top, null);
    const e = await page.evaluate(() => window.__wow.testMatch('', ''));
    assert.equal(e.top, null);
  });
  await check('Abgleich: mittlere Sicherheit liefert Vorschläge (0,6-0,8)', async () => {
    const m = await page.evaluate(() => window.__wow.testMatch('Sample Ember', ''));
    assert.ok(m.top.score >= 0.6 && m.top.score < 0.8, 'score ' + m.top.score);
    assert.equal(m.top.pid, 900002);
  });

  /* ---------- Stabilitätsregel und Sperre ---------- */
  await check('Stabilität: 1 Frame erfasst nicht, 2 gleiche Frames erfassen genau einmal', async () => {
    const before = await scanCount();
    await page.evaluate(() => window.__wow.frame('Sample Knight of Testing', '001/120'));
    assert.equal(await scanCount(), before, 'nach 1 Frame keine Erfassung');
    await page.evaluate(() => window.__wow.frame('Sample Knight of Testing', '001/120'));
    assert.equal(await scanCount(), before + 1, 'nach 2 Frames eine Erfassung');
    await page.evaluate(() => window.__wow.frame('Sample Knight of Testing', '001/120'));
    await page.evaluate(() => window.__wow.frame('Sample Knight of Testing', '001/120'));
    assert.equal(await scanCount(), before + 1, 'Duplikat unterdrückt, solange dieselbe Karte liegt');
  });
  await check('Stabilität: Kartenwechsel nach 2 Frames ohne dieselbe Karte, dann neue Erfassung', async () => {
    const before = await scanCount();
    await page.evaluate(() => window.__wow.frame('Sample Frost Oracle', '003/120'));
    await page.evaluate(() => window.__wow.frame('Sample Frost Oracle', '003/120'));
    assert.equal(await scanCount(), before, 'nach 2 fremden Frames noch keine Erfassung (erst Entsperren)');
    await page.evaluate(() => window.__wow.frame('Sample Frost Oracle', '003/120'));
    await page.evaluate(() => window.__wow.frame('Sample Frost Oracle', '003/120'));
    assert.equal(await scanCount(), before + 1, 'andere Karte nach Wechsel erfasst');
  });
  await check('Stabilität: Kartenwechsel über leere Frames entsperrt', async () => {
    await page.evaluate(() => window.__wow.frame('', ''));
    await page.evaluate(() => window.__wow.frame('', ''));
    assert.equal(await page.evaluate(() => window.__wow.state().locked), null);
  });
  await check('Vorschläge: Top-3 antippen erfasst die gewählte Karte', async () => {
    await page.evaluate(() => window.__wow.frame('Sample Ember', ''));
    await page.waitForSelector('#suggest:not([hidden]) .chip');
    const chips = await page.$$('#chips .chip');
    assert.ok(chips.length >= 1 && chips.length <= 3);
    assert.match(await chips[0].textContent(), /Sample Ember Warden/);
    const before = await scanCount();
    await chips[0].click();
    await page.waitForTimeout(150);
    assert.equal(await scanCount(), before + 1);
    const list = (await api('GET', '/api/scans')).body;
    assert.equal(list.at(-1).productId, 900002);
    assert.equal(list.at(-1).name, 'Sample Ember Warden');
    assert.equal(await page.isHidden('#suggest'), true);
  });

  /* ---------- Preise ---------- */
  await check('Preis: Normal und Foil, Umrechnung EUR', async () => {
    const n = await page.evaluate(() => window.__wow.priceInfo(900001, false, 'market', 'EUR'));
    assert.equal(n.usd, 12.5);
    assert.equal(n.value, 11.5);                 // 12,50 * 0,92
    const f = await page.evaluate(() => window.__wow.priceInfo(900001, true, 'market', 'EUR'));
    assert.equal(f.usd, 30);
    assert.equal(f.value, 27.6);
    const low = await page.evaluate(() => window.__wow.priceInfo(900001, false, 'low', 'CHF'));
    assert.equal(low.value, 7.84);               // 9,80 * 0,80
    const usd = await page.evaluate(() => window.__wow.priceInfo(900001, false, 'market', 'USD'));
    assert.equal(usd.value, 12.5);
  });
  await check('Preis: nur ein Subtyp → dieser wird genutzt (auch bei Foil-Wunsch)', async () => {
    const a = await page.evaluate(() => window.__wow.priceInfo(900004, true, 'market', 'EUR'));
    assert.equal(a.sub, 'Normal');
    assert.equal(a.single, true);
    assert.equal(a.value, 0.09);                 // 0,10 * 0,92 = 0,092 → 0,09
    const b = await page.evaluate(() => window.__wow.priceInfo(900006, false, 'market', 'EUR'));
    assert.equal(b.sub, 'Foil');
    assert.equal(b.value, 5.52);
  });
  await check('Preis: fehlend → null (kein Preis), Produkt ohne Daten → null', async () => {
    const a = await page.evaluate(() => window.__wow.priceInfo(900003, false, 'market', 'EUR'));
    assert.equal(a.value, null);
    assert.match(a.note, /kein Preis|Preis/);
    const b = await page.evaluate(() => window.__wow.priceInfo(900024, false, 'market', 'EUR'));
    assert.equal(b.value, null);
    assert.match(b.note, /Keine Preisdaten/);
  });

  await check('Subtypen: {Normal, Holofoil} – Foil-Wunsch wählt Holofoil', async () => {
    const n = await page.evaluate(() => window.__wow.subKey(900025, false));
    assert.equal(n.sub, 'Normal');
    assert.equal(n.isFoil, false);
    assert.equal(n.value, 0.46);                 // 0,50 * 0,92
    const f = await page.evaluate(() => window.__wow.subKey(900025, true));
    assert.equal(f.sub, 'Holofoil');
    assert.equal(f.isFoil, true);
    assert.equal(f.value, 6.44);                 // 7,00 * 0,92
  });
  await check('Subtypen: Foil-Wunsch ohne Foil-Schlüssel fällt auf Normal zurück', async () => {
    const f = await page.evaluate(() => window.__wow.subKey(900001, false));
    assert.equal(f.sub, 'Normal');
    const g = await page.evaluate(() => window.__wow.subKey(900003, true));
    assert.equal(g.sub, 'Foil');                 // hat nur Foil-Schlüssel (Einzelregel)
    assert.equal(g.isFoil, true);
  });

  /* ---------- Manuelle Suche und Hinzufügen ---------- */
  await check('Suche: Live-Suche, unscharfer Fallback', async () => {
    await tab(page, 'search');
    await page.fill('#q', 'dawn');
    await page.waitForTimeout(250);
    const dawn = await page.locator('#results .row-btn .name').allTextContents();
    assert.ok(dawn.some((t) => /Dawn Priest$/.test(t)) && dawn.some((t) => /Priestess/.test(t)), 'Dawn-Treffer: ' + dawn);
    await page.fill('#q', 'Sample Knight of Testng');
    await page.waitForTimeout(250);
    assert.match(await page.textContent('#searchInfo'), /unscharfer/);
    assert.match(await page.textContent('#results .row-btn .name'), /Knight/);
    await page.fill('#q', 'xyzzy');
    await page.waitForTimeout(250);
    assert.match(await page.textContent('#searchInfo'), /Keine Treffer/);
  });
  await check('Suche: Holofoil-Produkt speichert foil=true und Holofoil-Preis', async () => {
    await page.fill('#q', 'moon holo');
    await page.waitForTimeout(250);
    await page.click('#results .row-btn');
    await page.waitForSelector('#dlg[open]');
    await page.check('#dlgFoil');
    assert.match(await page.textContent('#dlgBody'), /6,44/);
    const before = await scanCount();
    await page.click('#dlgAdd');
    await page.waitForTimeout(200);
    assert.equal(await scanCount(), before + 1);
    const rec = (await api('GET', '/api/scans')).body.at(-1);
    assert.equal(rec.name, 'Sample Moon Holo Drake');
    assert.equal(rec.foil, true);
    assert.equal(rec.priceUsd, 7);
  });
  await check('Suche: Treffer antippen → Dialog → Menge 2 → hinzufügen', async () => {
    await page.fill('#q', 'bone drake');
    await page.waitForTimeout(250);
    await page.click('#results .row-btn');
    await page.waitForSelector('#dlg[open]');
    assert.match(await page.textContent('#dlgTitle'), /Bone Drake/);
    await page.click('#dlgPlus');
    assert.equal(await page.inputValue('#dlgQty'), '2');
    const before = await scanCount();
    await page.click('#dlgAdd');
    await page.waitForTimeout(200);
    assert.equal(await scanCount(), before + 1);
    const rec = (await api('GET', '/api/scans')).body.at(-1);
    assert.equal(rec.name, 'Sample Bone Drake');
    assert.equal(rec.qty, 2);
    assert.equal(rec.currency, 'EUR');
    assert.equal(rec.priceType, 'market');
    assert.equal(rec.source, 'TCGplayer via tcgcsv.com');
    assert.equal(rec.ocrConfidence, null);
    assert.equal(rec.price, 0.55);               // 0,60 * 0,92 = 0,552
    assert.equal(rec.priceUsd, 0.6);
    assert.equal(rec.number, '045/80');
    assert.equal(rec.setCode, 'SMB');
    assert.equal(await page.isVisible('#dlg[open]'), false);
  });

  /* ---------- Sammlung ---------- */
  await page.evaluate(() => window.__wow.setView('coll'));
  await tab(page, 'coll');
  await page.waitForTimeout(300);
  await check('Sammlung: Summen, Set- und Seltenheitstabellen, Top 10', async () => {
    const totals = await page.textContent('#totals');
    assert.match(totals, /Karten gesamt/);
    assert.match(await page.textContent('#tSet'), /SAMPLE Set Alpha|SAMPLE Set Beta/);
    assert.match(await page.textContent('#tRar'), /Rare/);
    assert.ok((await page.locator('#top10 li').count()) >= 1);
    assert.match(await page.textContent('#top10 li'), /€/);
  });
  await check('Sammlung: Menge erhöhen und verringern (PATCH)', async () => {
    const item = page.locator('#scanList .item', { hasText: 'Sample Bone Drake' });
    await item.locator('[data-act="inc"]').click();
    await page.waitForTimeout(200);
    let rec = (await api('GET', '/api/scans')).body.find((r) => r.name === 'Sample Bone Drake');
    assert.equal(rec.qty, 3);
    await item.locator('[data-act="dec"]').click();
    await page.waitForTimeout(200);
    rec = (await api('GET', '/api/scans')).body.find((r) => r.name === 'Sample Bone Drake');
    assert.equal(rec.qty, 2);
  });
  await check('Sammlung: Eintrag löschen (mit Bestätigung)', async () => {
    const before = await scanCount();
    page.once('dialog', (d) => d.accept());
    await page.locator('#scanList .item', { hasText: 'Sample Ember Warden' }).locator('[data-act="del"]').click();
    await page.waitForTimeout(250);
    assert.equal(await scanCount(), before - 1);
  });
  await check('Export CSV: Semikolon, BOM, Dezimalkomma, konsistente Spaltenzahl', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnCsv')]);
    const file = path.join(os.tmpdir(), 'wow-e2e-' + Date.now() + '.csv');
    await dl.saveAs(file);
    const buf = fs.readFileSync(file);
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8-BOM');
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const lines = text.split(/\r\n/).filter(Boolean);
    const cols = lines[0].split(';').length;
    assert.equal(cols, 26, 'Spaltenanzahl Kopf');
    assert.match(lines[0], /^id;Zeitstempel;Name;/);
    for (const l of lines.slice(1)) assert.equal(l.split(';').length, cols, 'Zeile: ' + l);
    assert.match(text, /Sample Bone Drake/);
    assert.match(text, /;0,60;0,55;EUR;/, 'Dezimalkomma bei EUR');
    assert.match(text, /;Marktpreis;/);
  });
  await check('Export JSON: gültiges JSON mit Scans', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnJson')]);
    const file = path.join(os.tmpdir(), 'wow-e2e-' + Date.now() + '.json');
    await dl.saveAs(file);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(j.count, j.scans.length);
    assert.ok(j.scans.length >= 3);
    assert.equal(j.scans[0].source, 'TCGplayer via tcgcsv.com');
  });
  await check('Export Text: Kurzbericht mit Summen und Preisquelle', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnTxt')]);
    const file = path.join(os.tmpdir(), 'wow-e2e-' + Date.now() + '.txt');
    await dl.saveAs(file);
    const t = fs.readFileSync(file, 'utf8');
    assert.match(t, /Karten gesamt: \d+/);
    assert.match(t, /Preisquelle: TCGplayer-Marktpreis \(US\), umgerechnet/);
    assert.match(t, /Top 10 teuerste/);
  });
  await page.screenshot({ path: path.join(SHOTS, '03-collection.png'), fullPage: true });

  /* ---------- Einstellungen ---------- */
  await tab(page, 'set');
  await check('Einstellungen: Land CH → CHF, Preisart, Foil-Standard speichern', async () => {
    await page.selectOption('#setCountry', 'CH');
    assert.equal(await page.textContent('#setCur'), 'CHF');
    await page.selectOption('#setPT', 'low');
    await page.check('#setFoil');
    await page.selectOption('#setCond', 'LP');
    await page.click('#setForm button[type=submit]');
    await page.waitForTimeout(300);
    const s = (await api('GET', '/api/settings')).body;
    assert.equal(s.country, 'CH');
    assert.equal(s.currency, 'CHF');
    const st = await page.evaluate(() => window.__wow.state());
    assert.equal(st.ui.priceType, 'low');
    assert.equal(st.ui.foil, true);
    assert.equal(st.ui.cond, 'LP');
  });
  await check('Einstellungen wirken: neue Erfassung in CHF, Preis Tiefstpreis', async () => {
    // Vorherige Karte (Ember Warden) ist noch gesperrt: 1. Frame zählt als fremd, 2. entsperrt, 3. erfasst
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.__wow.frame('Sample Sun Hermit', '004/80'));
    const rec = (await api('GET', '/api/scans')).body.at(-1);
    assert.equal(rec.name, 'Sample Sun Hermit');
    assert.equal(rec.currency, 'CHF');
    assert.equal(rec.priceType, 'low');
    assert.equal(rec.foil, true);              // Foil-Standard, Produkt hat Foil
    assert.equal(rec.condition, 'LP');
    assert.equal(rec.priceUsd, 35);            // Foil-Tiefstpreis
    assert.equal(rec.price, 28);               // 35 * 0,80
  });
  await check('Einstellungen: Standard-Foil-Schalter spiegelt Einstellung', async () => {
    await tab(page, 'scan');
    assert.equal(await page.isChecked('#scanFoil'), true);
  });
  await tab(page, 'set');
  await page.screenshot({ path: path.join(SHOTS, '04-settings.png'), fullPage: true });
  await check('Einstellungen: Export-Währung CHF im Text-Bericht', async () => {
    const t = await page.evaluate(() => window.__wow.report());
    assert.match(t, /CHF/);
  });
  await check('Einstellungen: Datei-Sicht Scanner-Info', async () => {
    assert.match(await page.textContent('#espInfo'), /mock-1\.0\.0/);
  });

  /* ---------- Kamera (Fake-Device) ---------- */
  await tab(page, 'scan');
  await check('Kamera: Start mit Fake-Device läuft, OCR-Fehler wird angezeigt, Stopp funktioniert', async () => {
    await page.click('#btnScan');
    await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 8000 });
    assert.equal(await page.isHidden('#video'), false);
    await page.waitForSelector('#banner .banner.err', { timeout: 8000 });
    assert.match(await page.textContent('#banner'), /Texterkennung nicht verfügbar/);
    assert.equal(await page.textContent('#btnScan'), 'Scan stoppen');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, '05-camera.png') });
    await page.click('#btnScan');
    await page.waitForTimeout(200);
    assert.equal(await page.textContent('#btnScan'), 'Scan starten');
    assert.equal(await page.isHidden('#video'), true);
    assert.deepEqual(page.errors, []);
  });

  await check('Kalibrierung: Regler verschiebt Rahmen, Debug-Ansicht schaltbar', async () => {
    await tab(page, 'set');
    await setRange(page, '#calNameS', 5);
    const v = await page.evaluate(() => JSON.parse(localStorage.getItem('wowscan.calib')));
    assert.equal(v.nameOff, 5);
    await page.check('#calDbg');
    await tab(page, 'scan');
    await page.click('#btnScan');
    await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 8000 });
    await page.waitForTimeout(200);
    const top1 = await page.evaluate(() => parseFloat(document.querySelector('#boxName').style.top));
    assert.equal(await page.isVisible('#boxName'), true);
    assert.equal(await page.isVisible('#dbg'), true);
    assert.equal(await page.isVisible('#cvName'), true);
    await tab(page, 'set');
    await setRange(page, '#calNameS', -5);
    await tab(page, 'scan');
    await page.waitForTimeout(100);
    const top2 = await page.evaluate(() => parseFloat(document.querySelector('#boxName').style.top));
    assert.ok(top2 < top1, `Rahmen nicht verschoben: ${top1} → ${top2}`);
    await page.screenshot({ path: path.join(SHOTS, '06-calibration.png') });
    await tab(page, 'set');
    await page.uncheck('#calDbg');
    await tab(page, 'scan');
    assert.equal(await page.isHidden('#dbg'), true);
    await page.click('#btnScan');
    await page.waitForTimeout(150);
    await tab(page, 'set');
    await page.click('#calReset');
    assert.equal(await page.inputValue('#calNameS'), '0');
  });

  /* ---------- Layout bei 390 px ---------- */
  await check('Layout: kein horizontaler Seitenscroll in allen Ansichten (390 px)', async () => {
    for (const v of ['scan', 'search', 'coll', 'set']) {
      await tab(page, v);
      await page.waitForTimeout(120);
      const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(ov <= 0, `Ansicht ${v}: Überlauf ${ov}px`);
    }
  });
  await check('Layout: Tab-Leiste hat Touch-Ziele >= 48 px', async () => {
    const hs = await page.$$eval('.tab', (els) => els.map((e) => e.getBoundingClientRect().height));
    for (const h of hs) assert.ok(h >= 48, 'Höhe ' + h);
  });
  await tab(page, 'search');
  await page.fill('#q', 'sample');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, '02-search.png') });
  await tab(page, 'scan');

  /* ---------- Offline mit Cache ---------- */
  await check('Offline: gecachte Kartendaten werden genutzt', async () => {
    const p2 = await newPage(ctx);
    await p2.setViewportSize({ width: 390, height: 844 });
    await p2.route('**/sample-data/meta.json', (r) => r.abort());
    await p2.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await p2.evaluate(() => window.__wow.ready);
    await p2.waitForSelector('#banner .banner.warn');
    assert.match(await p2.textContent('#banner'), /Offline: gecachte Daten/);
    assert.match(await p2.textContent('#dataInfo'), /25 Karten/);
    await p2.close();
  });

  /* ---------- ESP nicht erreichbar ---------- */
  await check('ESP down: Pill zeigt Fehler, gespeicherte Daten-URL wird trotzdem genutzt', async () => {
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p3 = await newPage(ctx2);
    await p3.setViewportSize({ width: 390, height: 844 });
    await p3.addInitScript(() => localStorage.setItem('wowscan.settings', JSON.stringify({ country: 'DE', currency: 'EUR', dataUrl: location.origin + '/sample-data/' })));
    await p3.route('**/api/**', (r) => r.abort());
    await p3.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await p3.evaluate(() => window.__wow.ready);
    await p3.waitForTimeout(300);
    assert.match(await p3.textContent('#espPill'), /nicht erreichbar/);
    assert.match(await p3.textContent('#dataInfo'), /25 Karten/);
    await p3.click('.tab[data-view="coll"]');
    assert.match(await p3.textContent('#scanList'), /Noch keine Scans|Sammlung|Karten/);
    await ctx2.close();
  });
  await check('ESP down ohne gespeicherte Einstellungen: verständliche Meldung', async () => {
    const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p4 = await newPage(ctx3);
    await p4.route('**/api/**', (r) => r.abort());
    await p4.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await p4.evaluate(() => window.__wow.ready);
    await p4.waitForSelector('#banner .banner.err');
    assert.match(await p4.textContent('#banner'), /Scanner nicht erreichbar/);
    await ctx3.close();
  });

  /* ---------- Unsichere Verbindung (IP statt localhost) ---------- */
  await check('Unsicher: Kamera-Hinweis mit Zertifikats-Anleitung über http://<IP>', async () => {
    const ip = lanIp();
    if (!ip) { console.log('  (übersprungen: keine LAN-IP)'); return; }
    const ctx4 = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
    const p5 = await newPage(ctx4);
    await p5.setViewportSize({ width: 390, height: 844 });
    await p5.goto(`http://${ip}:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await p5.evaluate(() => window.__wow.ready);
    assert.equal(await p5.evaluate(() => window.isSecureContext), false);
    assert.match(await p5.textContent('#banner'), /sichere Verbindung/);
    await p5.click('#btnScan');
    assert.match(await p5.textContent('#camMsg'), /https:\/\/<IP-des-Scanners>/);
    await ctx4.close();
  });

  /* ---------- Großer Kartenbestand: Abgleichszeit ---------- */
  await check('Performance: 10.000 Karten, Abgleich im Schnitt < 50 ms', async () => {
    const ctx5 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const big = makeBigCards(10000);
    await ctx5.route('**/sample-data/cards.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: big }));
    const p6 = await openApp(ctx5);
    const st = await p6.evaluate(() => window.__wow.state());
    assert.equal(st.indexed, 10000);
    const queries = ['Sample Knight of Testing', 'Storm Hownd', 'Ancient Golem', 'Qwerty Zxcv Bnm', 'Crystal Golm', 'Night Blom', 'Lantern', 'Dawn Priestess Extra', 'Moon Archer', 'Bronze Sentinl'];
    const times = [];
    for (let i = 0; i < 3; i++) for (const q of queries) times.push(await p6.evaluate((x) => window.__wow.testMatch(x, '045/80').ms, q));
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    console.log(`  Index ${st.indexMs} ms, Abgleich Ø ${avg.toFixed(1)} ms, max ${max.toFixed(1)} ms`);
    assert.ok(avg < 50, 'Durchschnitt ' + avg);
    await ctx5.close();
  });

  /* ---------- Ende ---------- */
  await ctx.close();
  await browser.close();
}

function makeBigCards(n) {
  const A = ['Sample', 'Ember', 'Frost', 'Shadow', 'Mana', 'Dawn', 'Storm', 'Ancient', 'Ghost', 'Iron', 'Moon', 'Sun', 'Bone', 'Rune', 'Tide', 'Witch', 'Lantern', 'Thorn', 'Bronze', 'Crystal', 'Sky', 'Night', 'Golem', 'Knight', 'Archer', 'Hermit', 'Drake', 'Smith', 'Caller', 'Bloom'];
  const B = ['Warden', 'Oracle', 'Scout', 'Weaver', 'Gatekeeper', 'Priest', 'Hound', 'Lantern', 'Maiden', 'Keeper', 'Druid', 'Sentinel', 'Ranger', 'Hermit', 'Witch', 'Golem', 'Archer', 'Drake', 'Smith', 'Caller'];
  const cards = [];
  let seed = 7;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  for (let i = 0; i < n; i++) {
    const name = `${A[rnd(A.length)]} ${A[rnd(A.length)]} ${B[rnd(B.length)]} ${i}`;
    cards.push({ p: 800000 + i, n: name, g: 1, s: 'SAMPLE Big Set', sc: 'SBS', num: `${(i % 300) + 1}/300`, r: 'Common', t: 'Unit', x: {}, img: '', u: '' });
  }
  return JSON.stringify({ generatedAt: '2026-10-26T06:00:00Z', sample: true, cards });
}

main()
  .catch((e) => { failures++; console.error('FEHLER im Testablauf:', e); })
  .finally(() => {
    console.log(`\nErgebnisse: ${failures ? 'FEHLER' : 'OK'}`);
    server.close();
    process.exitCode = failures ? 1 : 0;
  });
