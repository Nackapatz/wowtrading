#!/usr/bin/env node
/* End-to-End-Tests der Web-App mit Playwright (vorinstalliertes Chromium, kein playwright install).
 *   node webapp/dev/e2e.js
 * Startet den Mock-ESP im Prozess, testet Abgleich, Stabilitätsregel, Preise, Suche, Sammlung,
 * CSV/JSON/Text-Export, Einstellungen, Kamerastart (Fake-Device), Fehlerfälle und das Layout bei 390x844.
 * Tesseract-CDN wird blockiert (Sandbox), OCR selbst wird daher nicht getestet, nur der Abgleich über window.__wow.
 * Bildabgleich: Sample-Kartenbilder (sample-data/img, erzeugt von make_sample_art.py) über window.__wow.testImage
 * und ein Fake-Kamerastream (sample-data/camera.y4m) mit einer Sample-Karte im Rahmen. */
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
const lastRec = async () => (await api('GET', '/api/scans')).body.at(-1);
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
  await check('Start: Daten geladen (26 Beispielkarten)', async () => {
    const info = await page.textContent('#dataInfo');
    assert.match(info, /30 Karten/);
    const st = await page.evaluate(() => window.__wow.state());
    assert.equal(st.indexed, 30);
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
    assert.match(src, /@tesseract\.js-data\/\$\{lang\}@1\.0\.0\/4\.0\.0_best_int/);
    assert.match(src, /lang: 'deu'/);
  });
  await check('Start: keine Seitenfehler', async () => { assert.deepEqual(page.errors, []); });
  await page.screenshot({ path: path.join(SHOTS, '01-scan.png') });

  /* ---------- Abgleich ---------- */
  // Frame mit vorgegebenen OCR-Rohtexten je Bereich; ein String steht für die Nummernleiste
  const frame = (inj, opts = {}) => page.evaluate(([x, o]) => window.__wow.frame(x, o), [typeof inj === 'string' ? { strip: inj } : inj, opts]);
  const unlock = async () => { await frame({}); await frame({}); };
  await check('Abgleich: exakter Name (eindeutige Karte)', async () => {
    const m = await page.evaluate(() => window.__wow.testMatch('Sample Frost Oracle'));
    assert.equal(m.top.pid, 900003);
    assert.deepEqual(m.top.printings, [900003]);
    assert.ok(m.top.score >= 0.99, 'score ' + m.top.score);
  });
  await check('Abgleich: OCR-Fehler (1 Zeichen) wird toleriert', async () => {
    const m = await page.evaluate(() => window.__wow.testMatch('Sample Frost Orcle'));
    assert.equal(m.top.pid, 900003);
    assert.ok(m.top.score >= 0.8, 'score ' + m.top.score);
  });
  await check('Abgleich: Groß/Klein, Sonderzeichen werden normalisiert', async () => {
    const m = await page.evaluate(() => window.__wow.testMatch('  SAMPLE: ember-warden!  '));
    assert.equal(m.top.pid, 900002);
    assert.ok(m.top.score >= 0.99);
  });
  await check('Abgleich: Priest und Priestess werden getrennt erkannt (ohne Nummer)', async () => {
    assert.equal((await page.evaluate(() => window.__wow.testMatch('Sample Dawn Priest'))).top.pid, 900007);
    assert.equal((await page.evaluate(() => window.__wow.testMatch('Sample Dawn Priestes'))).top.pid, 900008);
  });
  await check('Abgleich: Namenszusatz "(LOOT)" wird für den Abgleich entfernt', async () => {
    const a = await page.evaluate(() => window.__wow.testMatch('Sample Lucky Longshot'));
    assert.equal(a.top.pid, 900019);
    assert.equal(a.top.name, 'Sample Lucky Longshot (LOOT)');
    assert.ok(a.top.score >= 0.99, 'score ' + a.top.score);
    const b = await page.evaluate(() => window.__wow.testMatch('Sample Lucky Longshot (LOOT)'));
    assert.equal(b.top.pid, 900019);
  });
  await check('Abgleich: Nachdrucke werden als mehrere Drucke eines Namens geliefert', async () => {
    const m = await page.evaluate(() => window.__wow.testMatch('Sample Knight of Testing'));
    assert.deepEqual(m.top.printings.sort(), [900001, 900016]);
    const g = await page.evaluate(() => window.__wow.testMatch('Sample Ghost Lantern'));
    assert.deepEqual(g.top.printings.sort(), [900011, 900026], '"(Foil)"-Zusatz im selben Set');
  });
  await check('Abgleich: Unsinn ergibt keinen Treffer', async () => {
    assert.equal((await page.evaluate(() => window.__wow.testMatch('qwzx vbnm'))).top, null);
    assert.equal((await page.evaluate(() => window.__wow.testMatch(''))).top, null);
  });
  await check('Abgleich: mittlere Sicherheit liefert Vorschläge (0,6-0,8)', async () => {
    const m = await page.evaluate(() => window.__wow.testMatch('Sample Ember'));
    assert.ok(m.top.score >= 0.6 && m.top.score < 0.8, 'score ' + m.top.score);
    assert.equal(m.top.pid, 900002);
  });
  await check('Anzeige: Seltenheit C/U/R/E ausgeschrieben, andere Codes roh', async () => {
    const r = await page.evaluate(() => ['C', 'U', 'R', 'E', 'L', 'X', null].map(window.__wow.rarityName));
    assert.deepEqual(r, ['Common', 'Uncommon', 'Rare', 'Epic', 'L', 'X', '']);
  });

  /* ---------- Stabilitätsregel und Sperre ---------- */
  await check('Standbild: ein eindeutiges Bild erfasst sofort (Set-Wort + Nummer), danach gesperrt', async () => {
    const before = await scanCount();
    await frame('BETA 2/20');
    assert.equal(await scanCount(), before + 1, 'eindeutig: ein Standbild genügt');
    await frame('BETA 2/20');
    await frame('BETA 2/20');
    assert.equal(await scanCount(), before + 1, 'Duplikat unterdrückt, solange dieselbe Karte liegt');
    const rec = await lastRec();
    assert.equal(rec.productId, 900012);
    assert.equal(rec.key, 'smb-2');
    assert.equal(rec.number, '2/20');
    assert.equal(rec.total, 20);
    assert.equal(rec.setWord, 'Beta');
    assert.equal(rec.rarity, 'R');
    assert.deepEqual(rec.matchInfo, { signals: ['Nr', 'Ges'], score: 70, lead: 70 });
  });
  await check('Kartenwechsel: andere Karte wird sofort erfasst', async () => {
    const before = await scanCount();
    await frame('ALPHA 3/20');
    assert.equal(await scanCount(), before + 1, 'andere Karte erfasst');
    assert.equal((await lastRec()).productId, 900003);
    assert.equal((await lastRec()).number, '3/20');
  });
  await check('Stabilität: Kartenwechsel über leere Frames entsperrt', async () => {
    await unlock();
    assert.equal(await page.evaluate(() => window.__wow.state().locked), null);
  });
  await check('Vorschläge: antippen erfasst; Preis-Ersatz Mittelpreis wird gespeichert und beschriftet', async () => {
    // Nummer ohne Set-Wort, Gesamtzahl 20 passt zu Alpha und Beta → zwei gleich gute Kandidaten
    await frame('2/20');
    await frame('2/20');
    await page.waitForSelector('#suggest:not([hidden]) .chip');
    const chips = await page.locator('#chips .chip').allTextContents();
    assert.equal(chips.length, 2, chips.join(' | '));
    assert.match(await page.textContent('#suggTitle'), /Unsicher/);
    assert.ok(chips.every((t) => /70 P\./.test(t)), chips.join(' | '));
    const before = await scanCount();
    assert.equal(await scanCount(), before);
    await page.locator('#chips .chip', { hasText: 'Sample Ember Warden' }).click();
    await page.waitForTimeout(150);
    assert.equal(await scanCount(), before + 1);
    const rec = await lastRec();
    assert.equal(rec.productId, 900002);
    assert.equal(rec.priceType, 'mid', 'Marktpreis fehlt → Mittelpreis');
    assert.equal(rec.price, 0.64);               // 0,70 * 0,92
    const last = await page.textContent('#last');
    assert.match(last, /TCGplayer-Preis \(US\), Mittelpreis \(kein Marktpreis verfügbar\), umgerechnet/);
    assert.equal(await page.isHidden('#suggest'), true);
  });
  await check('Mehrdeutig: Nachdruck in 2 Sets → keine Auto-Erfassung, Chips „Name · Set · Preis“', async () => {
    await unlock();
    const before = await scanCount();
    for (let i = 0; i < 3; i++) await frame({ image: '/sample-data/img/900001.png' });
    assert.equal(await scanCount(), before, 'keine automatische Erfassung');
    assert.match(await page.textContent('#suggTitle'), /mehreren Sets/);
    const texts = await page.locator('#chips .chip').allTextContents();
    assert.equal(texts.length, 2);
    assert.ok(texts.some((t) => /SAMPLE Set Alpha · #1\/20 · 11,50/.test(t)) && texts.some((t) => /SAMPLE Set Beta · #6\/20 · 9,20/.test(t)), texts.join(' | '));
    await page.screenshot({ path: path.join(SHOTS, '07-reprints.png') });
    await page.locator('#chips .chip', { hasText: 'SAMPLE Set Beta' }).click();
    await page.waitForTimeout(150);
    assert.equal(await scanCount(), before + 1);
    assert.equal((await lastRec()).productId, 900016);
    for (let i = 0; i < 2; i++) await frame({ image: '/sample-data/img/900001.png' });
    assert.equal(await scanCount(), before + 1, 'nach Auswahl gesperrt');
  });
  await check('Set-Filter: nur ein Druck im gewählten Set → Auto-Erfassung; gespeichert', async () => {
    await unlock();
    await page.evaluate(() => window.__wow.setFilter('SAMPLE Set Alpha'));
    assert.equal(await page.evaluate(() => localStorage.getItem('wowscan.setFilter')), '"SAMPLE Set Alpha"');
    assert.match(await page.textContent('#dataInfo'), /Set-Filter: SAMPLE Set Alpha/);
    const before = await scanCount();
    await frame({ image: '/sample-data/img/900001.png' });
    assert.equal(await scanCount(), before + 1);
    assert.equal((await lastRec()).productId, 900001);
    const m = await page.evaluate(() => window.__wow.testMatch('Sample Iron Maiden'));
    assert.ok(!m.top || m.top.printings.every((p) => p !== 900012), 'Beta-Karte darf im Alpha-Filter nicht passen');
  });
  await check('Set-Filter: zwei Drucke im selben Set → weiter Auswahl nötig', async () => {
    await unlock();
    await page.evaluate(() => window.__wow.setFilter('SAMPLE Set Beta'));
    const before = await scanCount();
    for (let i = 0; i < 3; i++) await frame({ image: '/sample-data/img/900011.png' });
    assert.equal(await scanCount(), before);
    assert.equal(await page.locator('#chips .chip').count(), 2);
  });
  await check('Set-Filter: manuelle Suche auf Set beschränkt', async () => {
    await tab(page, 'search');
    await page.fill('#q', 'knight');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#results .row-btn').count(), 1);
    assert.match(await page.textContent('#results'), /SAMPLE Set Beta/);
    assert.match(await page.textContent('#searchInfo'), /nur Set/);
    await page.evaluate(() => window.__wow.setFilter(''));
    await page.fill('#q', 'knight ');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#results .row-btn').count(), 2);
    await tab(page, 'scan');
  });

  /* ---------- Bildabgleich (deutsche Karten: Illustration statt Name) ---------- */
  const img = (pid) => `/sample-data/img/${pid}.png`;
  const testImage = (pid, opts = {}) => page.evaluate(([u, o]) => window.__wow.testImage(u, o), [typeof pid === 'number' ? img(pid) : pid, opts]);
  await check('Bild: hashes.json geladen, Nachdrucke zu Gruppen zusammengefasst, Infozeile', async () => {
    const st = await page.evaluate(() => window.__wow.artState());
    assert.deepEqual(st, { groups: 24, products: 28, imgMax: 90 });
    assert.match(await page.textContent('#dataInfo'), /Erkennung: Set\+Nummer, Werte, Bild \(28\), Name/);
  });
  await check('Bild: artHash im Browser identisch zu Python (hashes.json)', async () => {
    const doc = await (await fetch(`http://127.0.0.1:${PORT}/sample-data/hashes.json`)).json();
    for (const pid of ['900001', '900003', '900011', '900020']) {
      const h = await page.evaluate((u) => window.__wow.hashImage(u), img(pid));
      assert.deepEqual([h.hash, h.color], doc.hashes[pid], 'Produkt ' + pid);
    }
  });
  await check('Bild: Kartenbild wird eindeutig erkannt (< 30 ms, ohne OCR)', async () => {
    for (const pid of [900003, 900002, 900019, 900008]) {
      const r = await testImage(pid, { feed: false });
      assert.equal(r.ok, true, `Produkt ${pid}: ${JSON.stringify(r)}`);
      assert.equal(r.best.pid, pid);
      assert.equal(r.via, 'Bild');
      assert.ok(r.best.d <= 20, 'Distanz ' + r.best.d);
      assert.ok(r.margin >= 8, 'Abstand ' + r.margin);
      assert.ok(r.ms < 30, 'Zeit ' + r.ms);
    }
  });
  await check('Bild: ein eindeutiges Standbild erfasst sofort, danach gesperrt', async () => {
    await unlock();
    const before = await scanCount();
    await testImage(900003);
    assert.equal(await scanCount(), before + 1, 'eindeutig: ein Standbild genügt');
    const rec = await lastRec();
    assert.equal(rec.productId, 900003);
    assert.ok(rec.ocr == null, 'keine OCR-Konfidenz bei Bildtreffer');
    await testImage(900003);
    assert.equal(await scanCount(), before + 1, 'gesperrt, solange die Karte liegt');
  });
  await check('Bild: Abweichungen (Helligkeit, Unschärfe, Versatz, Skalierung) werden toleriert', async () => {
    const cases = [{ filter: 'brightness(1.2)' }, { filter: 'brightness(0.8) contrast(1.1)' }, { filter: 'blur(1.5px)' }, { shift: 6 }, { scale: 0.97 }, { filter: 'saturate(0.7) blur(1px)', shift: -4, scale: 1.02 }];
    for (const c of cases) {
      const r = await testImage(900005, { ...c, feed: false });
      assert.equal(r.best.pid, 900005, JSON.stringify(c));
      assert.equal(r.ok, true, `${JSON.stringify(c)}: d=${r.best.d}, Abstand ${r.margin}`);
    }
  });
  await check('Bild: Nachdruck (gleiche Illustration) → keine Auto-Erfassung, Chips mit beiden Sets', async () => {
    await unlock();
    const before = await scanCount();
    const r = await testImage(900001);
    assert.equal(r.ok, true);
    assert.deepEqual(r.best.printings.sort(), [900001, 900016]);
    await testImage(900001);
    await testImage(900001);
    assert.equal(await scanCount(), before);
    assert.match(await page.textContent('#suggTitle'), /mehreren Sets/);
    const texts = await page.locator('#chips .chip').allTextContents();
    assert.equal(texts.length, 2);
    assert.ok(texts.some((t) => /SAMPLE Set Alpha/.test(t)) && texts.some((t) => /SAMPLE Set Beta/.test(t)), texts.join(' | '));
    assert.ok(texts.every((t) => /\d+ P\./.test(t)), texts.join(' | '));
    await page.screenshot({ path: path.join(SHOTS, '08-image-reprints.png') });
  });
  await check('Bild: Set-Filter löst Nachdruck auf → Auto-Erfassung', async () => {
    await unlock();
    await page.evaluate(() => window.__wow.setFilter('SAMPLE Set Beta'));
    const before = await scanCount();
    await testImage(900001);
    assert.equal(await scanCount(), before + 1);
    assert.equal((await lastRec()).productId, 900016);
    await page.evaluate(() => window.__wow.setFilter(''));
  });
  await check('Bild: fremdes Bild → keine Erfassung', async () => {
    await unlock();
    const before = await scanCount();
    const noise = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 200; c.height = 279;
      const x = c.getContext('2d'), d = x.createImageData(200, 279);
      let s = 99;
      for (let i = 0; i < d.data.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d.data[i] = i % 4 === 3 ? 255 : (s >> 16) & 255; }
      x.putImageData(d, 0, 0);
      return c.toDataURL('image/png');
    });
    for (let i = 0; i < 3; i++) {
      const r = await testImage(noise);
      assert.equal(r.ok, false);
      assert.ok(r.best.d > 70, 'Distanz ' + r.best.d);
    }
    assert.equal(await scanCount(), before);
  });
  await check('Bild: Bild-Toleranz-Regler wird gespeichert und wirkt', async () => {
    await tab(page, 'set');
    await setRange(page, '#calImgS', 40);
    assert.equal(await page.textContent('#calImgV'), '40');
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('wowscan.calib2')))).imgMax, 40);
    assert.equal((await page.evaluate(() => window.__wow.artState())).imgMax, 40);
    await tab(page, 'scan');
    const r = await testImage(900005, { filter: 'blur(3px) brightness(1.3)', feed: false });
    await tab(page, 'set');
    await setRange(page, '#calImgS', 110);
    const r2 = await testImage(900005, { filter: 'blur(3px) brightness(1.3)', feed: false });
    assert.ok(r2.ok, 'Toleranz 110: ' + JSON.stringify(r2.best));
    assert.equal(r.ok, r.best.d <= 40 && r.margin >= 8, 'Grenze 40 wird angewandt');
    await page.click('#calReset');
    assert.equal(await page.inputValue('#calImgS'), '90');
    await tab(page, 'scan');
  });

  await check('Kalibrierung: Schärfe-Grenze wird gespeichert (wowscan.calib2), Standard 60', async () => {
    await tab(page, 'set');
    assert.equal(await page.inputValue('#calSharpS'), '60');
    await setRange(page, '#calSharpS', 90);
    assert.equal(await page.textContent('#calSharpV'), '90');
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('wowscan.calib2')))).sharpMin, 90);
    await page.click('#calReset');
    assert.equal(await page.inputValue('#calSharpS'), '60');
    await tab(page, 'scan');
  });

  /* ---------- Kombinierte Erkennung (docs/CARD_ID.md) ---------- */
  const HULOK = { strip: 'BETRAYER 163/264', cost: '2', atk: '2', hp: '2', name: 'Hulok Wegbereiter' };
  await check('Kombiniert: Set+Nummer exakt + Werte + deutscher Name → Erfassung mit allen Feldern, Name gelernt', async () => {
    await unlock();
    const before = await scanCount();
    const r = await frame(HULOK);
    assert.equal(r.cand[0].k, 'sotb-163');
    assert.equal(r.cand[0].pts, 125, r.cand[0].sig);   // 60 + 10 + 3·10 + Eigenname „Hulok“ 25
    assert.equal(r.cand[1].k, 'p900032', 'Variante (LOOT) gleich gut, Grundprodukt gewählt');
    assert.equal(r.sure, true);
    assert.equal(await scanCount(), before + 1, 'eindeutig: ein Standbild erfasst');
    const rec = await lastRec();
    assert.equal(rec.key, 'sotb-163');
    assert.equal(rec.productId, 900031);
    assert.equal(rec.name, 'Hulok Trailblazer');
    assert.equal(rec.nameDe, 'Hulok Wegbereiter');
    assert.equal(rec.number, '163/264');
    assert.equal(rec.total, 264);
    assert.equal(rec.setWord, 'Betrayer');
    assert.equal(rec.set, 'Servants of the Betrayer');
    assert.deepEqual([rec.cost, rec.atk, rec.hp, rec.health], [2, 2, 2, 2]);
    assert.deepEqual([rec.type, rec.faction, rec.race, rec.cls], ['Ally', 'Horde', 'Tauren', 'Druid']);
    assert.deepEqual(rec.matchInfo, { signals: ['Nr', 'Tok', 'Ges', 'cost', 'atk', 'hp', 'Basis'], score: 125, lead: 65 });   // Eigenname „Hulok“ +25; vor Roke: 40 + 10 + 10 + 10 − 10
    assert.equal(rec.price, 0.23);                 // 0,25 USD · 0,92
    assert.deepEqual(await page.evaluate(() => window.__wow.learned()), { 'Hulok Wegbereiter': 'sotb-163' });
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('wowscan.learnedNames'))), { 'Hulok Wegbereiter': 'sotb-163' });
    const last = await page.textContent('#last');
    assert.match(last, /Hulok Wegbereiter \(Hulok Trailblazer\)/);
    assert.match(last, /Servants of the Betrayer · #163\/264 · Common/);
    assert.match(last, /Ally · Kosten 2 · 2\/2 · Tauren · Druid · Horde/);
    assert.match(await page.textContent('#recent'), /Hulok Wegbereiter \(Hulok Trailblazer\)/);
    assert.match(await page.textContent('#dataInfo'), /1 deutsche gelernt/);
    await page.locator('#last').screenshot({ path: path.join(SHOTS, '10-combined.png') });
  });
  await check('Variante: Grundprodukt automatisch, „Variante ändern“ tauscht den Eintrag (löschen + neu anlegen)', async () => {
    const before = await scanCount();
    const old = await lastRec();
    assert.equal(old.key, 'sotb-163');
    const chip = page.locator('#last [data-var]');
    assert.equal(await chip.count(), 1);
    assert.match(await chip.textContent(), /Variante ändern: Hulok Trailblazer \(LOOT\)/);
    await chip.click();
    await page.waitForFunction(() => document.querySelector('#last h3').textContent.includes('(LOOT)'));
    await page.waitForTimeout(150);
    assert.equal(await scanCount(), before, 'ersetzt, nicht zusätzlich');
    const scans = (await api('GET', '/api/scans')).body;
    assert.ok(!scans.some((x) => x.id === old.id), 'alter Eintrag gelöscht');
    const rec = scans.at(-1);
    assert.equal(rec.key, 'p900032');
    assert.equal(rec.productId, 900032);
    assert.equal(rec.name, 'Hulok Trailblazer (LOOT)');
    assert.equal(rec.nameDe, 'Hulok Wegbereiter');
    assert.equal(rec.number, '163/264');
    assert.equal(rec.qty, old.qty);
    assert.equal(rec.price, 2.76);                 // 3,00 USD · 0,92
    assert.ok(rec.matchInfo.signals.includes('Variante'));
    assert.match(await page.textContent('#last'), /Hulok Wegbereiter \(Hulok Trailblazer \(LOOT\)\)/);
    // zurück zum Grundprodukt
    await page.locator('#last [data-var]').click();
    await page.waitForFunction(() => !document.querySelector('#last h3').textContent.includes('(LOOT)'));
    assert.equal((await lastRec()).key, 'sotb-163');
    assert.equal(await scanCount(), before);
    assert.deepEqual(await page.evaluate(() => window.__wow.learned()), { 'Hulok Wegbereiter': 'sotb-163' });
  });
  await check('Speichern: Aussetzer des Scanners wird wiederholt, ohne Doppel-Eintrag', async () => {
    const before = await scanCount();
    await api('POST', '/__mock/fail', { scan: ['drop'] });
    const id1 = await page.evaluate(() => window.__wow.capture('sotb-163'));
    assert.ok(id1, 'drop: zweiter Versuch speichert');
    assert.equal(await scanCount(), before + 1);
    await api('POST', '/__mock/fail', { scan: ['lost'] });
    const id2 = await page.evaluate(() => window.__wow.capture('sotb-163'));
    assert.equal(await scanCount(), before + 2, 'lost: gespeichert, Wiederholung erkannt');
    assert.equal(id2, (await lastRec()).id);
    assert.equal((await lastRec()).cid, undefined, 'cid wird nicht gespeichert');
  });
  await check('Kombiniert: Schrägstrich als „1“ gelesen, Nummer im Flavor-Text', async () => {
    for (const t of ['BETRAYER1531/264', 'RBETRAYERI1531//264', 'BETRAYER153/1264']) {
      const r = await frame({ strip: t }, { feed: false });
      assert.equal(r.cand[0] && r.cand[0].k, 'sotb-153', t + ': ' + JSON.stringify(r.cand));
      assert.match(r.cand[0].sig, /^Nr Ges/, t);
    }
    const f = await frame({ strip: 'Her Brenne nden dag 153/264' }, { feed: false });
    assert.match(f.cand[0].sig, /^Nr~/, 'Flavor ohne Set-Wort: ' + JSON.stringify(f.cand));
    assert.equal(f.sure, false);
  });
  await check('Kombiniert: Nummernleiste ohne „/“ zählt nur als unsicheres „Nr?“ bei passendem Set-Wort', async () => {
    const r = await frame({ strip: 'BEIRAYER15314264' }, { feed: false });
    const c = r.cand.find((x) => x.k === 'sotb-153');
    assert.ok(c, JSON.stringify(r.cand));
    assert.equal(c.pts, 25); assert.equal(c.sig, 'Nr?');
    const r4 = await frame({ strip: 'J RBETRAYER 153 LL SEs' }, { feed: false });
    assert.deepEqual(r4.cand.map((x) => [x.k, x.sig]), [['sotb-153', 'Nr?']], 'ganze Zahl ohne Gesamtzahl, nicht 1/53');
    assert.equal(r.sure, false);
    const r3 = await frame({ strip: 'A RUBETRAYER153// 264' }, { feed: false });
    assert.equal(r3.cand[0] && r3.cand[0].k, 'sotb-153', '„//“ mit Leerzeichen: ' + JSON.stringify(r3.cand));
    assert.match(r3.cand[0].sig, /^Nr Ges/);
    const r2 = await frame({ strip: 'XQZWVK15314264' }, { feed: false });
    assert.equal(r2.cand.length, 0, 'ohne Set-Wort kein Kandidat');
  });
  await check('Kombiniert: Eigenname im deutschen Namen widerspricht der Nummer → nur Vorschlag', async () => {
    await unlock();
    const r = await frame({ strip: 'BETRAYER 153/264', name: 'Der wilde Hound' }, { feed: false });
    assert.equal(r.cand[0].k, 'sotb-153', JSON.stringify(r.cand));
    assert.ok(r.cand.some((c) => /Tok/.test(c.sig) && c.name === 'Sample Storm Hound'), JSON.stringify(r.cand));
    assert.equal(r.sure, false);
  });
  await check('Abgeschnittener Eigenname („Trailbl“) zählt unscharf als Tok~', async () => {
    await unlock();
    const r = await frame({ name: 'Der Trailbl' }, { feed: false });
    assert.ok(r.cand.some((c) => /Tok~/.test(c.sig) && c.name === 'Hulok Trailblazer'), JSON.stringify(r.cand));
    assert.equal(r.sure, false);
  });
  await check('Kombiniert: unsichere Nummer + Eigenname auf dieselbe Karte → Erfassung trotz eines verlesenen Werts', async () => {
    await unlock();
    const r = await frame({ strip: 'J RBETRAYER 163 LL', name: 'Der Hulok', hp: '5' }, { feed: false });
    assert.equal(r.cand[0].k, 'sotb-163', JSON.stringify(r.cand));
    assert.match(r.cand[0].sig, /Nr\? Tok .*!hp.*2×/);
    assert.equal(r.sure, true);
    await unlock();
  });
  await check('Kombiniert: OCR liest 153 statt 163, Werte sprechen für 163 → Gleichstand, nur Vorschläge', async () => {
    // Werte-OCR ist unzuverlässig (Log 29.10.): ein falscher Wert kostet nur 10, kann eine exakte Nummer also nicht überstimmen
    await unlock();
    const before = await scanCount();
    const misread = { strip: 'BETRAYER 153/264', cost: '2', atk: '2', hp: '2' };
    const r = await frame(misread, { feed: false });
    const pts = Object.fromEntries(r.cand.map((c) => [c.k, c.pts]));
    assert.equal(pts['sotb-153'], 80, 'Roke: 60 + 10 + 10 + 10 − 10');
    assert.equal(pts['sotb-163'], 80, 'Hulok: 40 (Ziffernkorrektur 5→6) + 10 + 3·10');
    assert.equal(r.sure, false);
    await frame(misread);
    assert.equal(await scanCount(), before, 'nicht eindeutig: nichts erfasst');
    await unlock();
  });
  await check('Kombiniert: gelernter deutscher Name (+40) löst den Nummern-Lesefehler', async () => {
    await unlock();
    const before = await scanCount();
    const f = { strip: 'BETRAYER 153/264', cost: '2', atk: '2', hp: '2', name: 'Hulok Wegbereitcr' };   // OCR-Fehler im Namen
    const r = await frame(f, { feed: false });
    assert.equal(r.cand[0].k, 'sotb-163');
    assert.equal(r.cand[0].pts, 145, r.cand[0].sig);   // 40 + 10 + 30 + 40 + Eigenname 25
    assert.match(r.cand[0].sig, /DE/);
    assert.equal(r.sure, true);
    await frame(f);
    assert.equal(await scanCount(), before + 1);
    await frame(f);
    assert.equal(await scanCount(), before + 1, 'gesperrt, solange die Karte liegt');
    assert.equal((await lastRec()).key, 'sotb-163');
    assert.equal(Object.keys(await page.evaluate(() => window.__wow.learned())).length, 1, 'unscharf erkannter Name wird nicht doppelt gelernt');
  });
  await check('Kombiniert: Set-Wort unscharf; nur Gesamtzahl ohne Set-Wort löst das Set auf; gleiche Gesamtzahl → Vorschläge', async () => {
    const a = await frame('BETRAYFR 153/264', { feed: false });
    assert.equal(a.cand[0].k, 'sotb-153');
    assert.equal(a.sure, true);
    const b = await frame('153/264', { feed: false });
    assert.equal(b.cand[0].k, 'sotb-153');
    assert.equal(b.cand[0].pts, 70);
    assert.equal(b.sure, true);
    const c = await frame('7/20', { feed: false });
    assert.deepEqual(c.cand.slice(0, 2).map((x) => x.k).sort(), ['sma-7', 'smb-7']);
    assert.deepEqual(c.cand.slice(0, 2).map((x) => x.pts), [70, 70]);
    assert.ok(c.cand.slice(2).every((x) => x.pts === 50), 'Ziffernkorrektur 7→1: 40 + 10');
    assert.equal(c.sure, false);
    const d = await frame('ALPHA 7/20', { feed: false });
    assert.equal(d.cand[0].k, 'sma-7');
    assert.equal(d.sure, true);
    await unlock();
    const before = await scanCount();
    await frame('153/264');
    assert.equal(await scanCount(), before + 1);
    assert.equal((await lastRec()).name, 'Roke the Ice Baron');
  });
  await check('Kombiniert: Karte ohne TCGplayer-Produkt wird erkannt und mit „kein Preis“ gespeichert', async () => {
    await unlock();
    const before = await scanCount();
    await frame('BETRAYER 200/264');
    assert.equal(await scanCount(), before + 1);
    const rec = await lastRec();
    assert.equal(rec.key, 'sotb-200');
    assert.equal(rec.productId, null);
    assert.equal(rec.price, null);
    assert.equal(rec.priceUsd, null);
    assert.equal(rec.number, '200/264');
    const last = await page.textContent('#last');
    assert.match(last, /kein Preis/);
    assert.match(last, /Kein TCGplayer-Produkt/);
  });
  await check('Kombiniert: Export enthält nameDe, Schlüssel und Erkennung', async () => {
    const csv = await page.evaluate(() => window.__wow.csv());
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    const head = lines[0].split(';');
    for (const h of ['Name (deutsch)', 'Schlüssel', 'Rasse', 'Erkennung']) assert.ok(head.includes(h), h);
    const row = lines.find((l) => l.includes('Hulok Wegbereiter'));
    assert.ok(row, 'Zeile mit deutschem Namen');
    assert.match(row, /sotb-163/);
    assert.match(row, /Nr Tok Ges cost atk hp Basis( Variante)* = 125/);
    const js = JSON.parse(await page.evaluate(() => window.__wow.json()));
    assert.ok(js.scans.some((x) => x.nameDe === 'Hulok Wegbereiter' && x.key === 'sotb-163'));
  });
  await check('Gelernte Namen: Export als JSON-Datei, Import führt zusammen', async () => {
    await tab(page, 'set');
    assert.match(await page.textContent('#learnInfo'), /1 gelernte/);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnLearnExp')]);
    const data = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    assert.deepEqual(data, { version: 1, names: { 'Hulok Wegbereiter': 'sotb-163' } });
    await page.setInputFiles('#learnFile', { name: 'namen.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, names: { 'Roke der Eisbaron': 'sotb-153' } })) });
    await page.waitForFunction(() => Object.keys(window.__wow.learned()).length === 2);
    assert.match(await page.textContent('#learnInfo'), /2 gelernte/);
    assert.match(await page.evaluate(() => window.__wow.importLearned('kein json')), /fehlgeschlagen/);
    await tab(page, 'scan');
    const r = await frame({ name: 'Roke der Eisbaron', cost: '2', atk: '2', hp: '1' }, { feed: false });
    assert.equal(r.cand[0].k, 'sotb-153');
    assert.equal(r.cand[0].pts, 70, r.cand[0].sig);   // gelernter Name 40 + 3·10
    assert.equal(r.sure, true);
    await unlock();
    const before = await scanCount();
    await frame({ name: 'Roke der Eisbaron', cost: '2', atk: '2', hp: '1' });
    assert.equal(await scanCount(), before + 1, 'gelernter Name + Werte erfassen');
    assert.equal((await lastRec()).key, 'sotb-153');
  });
  await check('Namenszusatz: "Sample Lucky Longshot" erfasst die (LOOT)-Karte, voller Name angezeigt', async () => {
    await unlock();
    const before = await scanCount();
    await frame('LOOT 1/12');
    assert.equal(await scanCount(), before + 1);
    const rec = await lastRec();
    assert.equal(rec.name, 'Sample Lucky Longshot (LOOT)');
    assert.equal(rec.priceType, 'mid');
    assert.equal(rec.price, 55.2);               // 60,00 * 0,92
    const recent = await page.textContent('#recent');
    assert.match(recent, /Sample Lucky Longshot \(LOOT\)/);
    assert.doesNotMatch(recent, /#null|#undefined|· ·/);
    assert.match(await page.textContent('#last'), /SAMPLE Loot Promos · #1\/12 · L/);
  });

  /* ---------- Preise ---------- */
  await check('Preis: Normal und Foil, Umrechnung EUR', async () => {
    const n = await page.evaluate(() => window.__wow.priceInfo(900001, false, 'market', 'EUR'));
    assert.equal(n.usd, 12.5);
    assert.equal(n.value, 11.5);                 // 12,50 * 0,92
    const f = await page.evaluate(() => window.__wow.priceInfo(900001, true, 'market', 'EUR'));
    assert.equal(f.value, 27.6);
    const low = await page.evaluate(() => window.__wow.priceInfo(900001, false, 'low', 'CHF'));
    assert.equal(low.value, 7.84);               // 9,80 * 0,80
    assert.equal((await page.evaluate(() => window.__wow.priceInfo(900001, false, 'market', 'USD'))).value, 12.5);
  });
  await check('Preis-Ersatz: Markt → Mittel → Tiefst, gewählte Art zuerst', async () => {
    const pi = (pid, pt) => page.evaluate(([a, b]) => window.__wow.priceInfo(a, false, b, 'EUR'), [pid, pt]);
    let r = await pi(900002, 'market');
    assert.deepEqual([r.pt, r.fallback, r.value], ['mid', true, 0.64]);
    r = await pi(900009, 'market');
    assert.deepEqual([r.pt, r.value], ['mid', 5.05]);               // 5,49 * 0,92
    r = await pi(900005, 'market');
    assert.deepEqual([r.pt, r.value], ['low', 36.8]);               // nur Tiefstpreis
    r = await pi(900005, 'mid');
    assert.deepEqual([r.pt, r.wanted, r.value], ['low', 'mid', 36.8]);
    r = await pi(900013, 'low');
    assert.deepEqual([r.pt, r.fallback, r.value], ['low', false, 25.29]); // 27,49 * 0,92
    r = await pi(900001, 'mid');
    assert.deepEqual([r.pt, r.fallback, r.value], ['mid', false, 10.12]); // 11,00 * 0,92
  });
  await check('Preis: nur ein Subtyp → dieser wird genutzt (auch bei Foil-Wunsch)', async () => {
    const a = await page.evaluate(() => window.__wow.priceInfo(900004, true, 'market', 'EUR'));
    assert.equal(a.sub, 'Normal');
    assert.equal(a.single, true);
    assert.equal(a.value, 0.09);
    const b = await page.evaluate(() => window.__wow.priceInfo(900006, false, 'market', 'EUR'));
    assert.equal(b.sub, 'Foil');
    assert.equal(b.value, 5.52);
  });
  await check('Preis: alle drei null → kein Preis; Produkt ohne Daten → kein Preis', async () => {
    const a = await page.evaluate(() => window.__wow.priceInfo(900003, false, 'market', 'EUR'));
    assert.equal(a.value, null);
    assert.match(a.note, /kein Preis/);
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
    assert.equal(g.sub, 'Foil');                 // Normal komplett null, Foil vorhanden
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
  await check('Suche: Dialog beschriftet Preis-Ersatz und zeigt keine leere Nummer', async () => {
    await page.fill('#q', 'ember');
    await page.waitForTimeout(250);
    await page.click('#results .row-btn');
    await page.waitForSelector('#dlg[open]');
    const body = await page.textContent('#dlgBody');
    assert.match(body, /TCGplayer-Preis \(US\), Mittelpreis \(kein Marktpreis verfügbar\), umgerechnet, Stand 25\.10\.2026/);
    assert.match(body, /SAMPLE Set Alpha · #2\/20 · Uncommon · Ally · Kosten 3 · 2\/3/);
    assert.doesNotMatch(body, /#null|#undefined|· ·/);
    await page.click('#dlg button[value=cancel]');
    await page.fill('#q', 'crystal golem');
    await page.waitForTimeout(250);
    assert.match(await page.textContent('#results'), /SAMPLE Set Alpha · #13\/20 · Rare/);
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
    assert.equal(rec.number, '5/20', 'Nummer aus cards.json v2');
    assert.equal(rec.setCode, 'Beta');
    assert.equal(rec.type, 'Ally');
    assert.equal(rec.nameDe, null, 'über die Suche: kein deutscher Name');
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
  await check('Letzte Erfassung: Nachdruck in anderem Set wählbar („Anderer Druck“)', async () => {
    await tab(page, 'scan');
    await page.evaluate(() => window.__wow.capture('sma-9'));
    const chip = page.locator('#last [data-var="smb-7"]');
    await chip.waitFor();
    assert.match(await chip.textContent(), /Anderer Druck: .*7/);
    await chip.click();
    await page.waitForFunction(() => document.querySelector('#last h3') && !!document.querySelector('#last [data-var="sma-9"]'));
    assert.equal((await lastRec()).key, 'smb-7');
  });
  await check('Sammlung: Löschen einer Fehl-Erfassung vergisst den dabei gelernten Namen', async () => {
    await page.evaluate(() => window.__wow.capture('sotb-153', 'Falscher Name'));
    assert.equal((await page.evaluate(() => window.__wow.learned()))['Falscher Name'], 'sotb-153');
    await tab(page, 'coll');
    page.once('dialog', (d) => d.accept());
    await page.locator('#scanList .item', { hasText: 'Roke the Ice Baron' }).first().locator('[data-act="del"]').click();
    await page.waitForTimeout(250);
    assert.equal((await page.evaluate(() => window.__wow.learned()))['Falscher Name'], undefined);
    assert.equal((await page.evaluate(() => window.__wow.learned()))['Hulok Wegbereiter'], 'sotb-163', 'andere Namen bleiben');
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
    assert.equal(cols, 30, 'Spaltenanzahl Kopf');
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
    assert.match(t, /Preisquelle: TCGplayer-Preis \(US\)/);
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
    // Vorherige Karte ist noch gesperrt; eine andere Karte wird im ersten Standbild erfasst
    await page.evaluate(() => window.__wow.frame({ strip: 'BETA 4/20' }));
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
  await check('Kamera: Start mit Fake-Device läuft, OCR-Rückfall-Fehler als Warnung, Stopp funktioniert', async () => {
    await page.click('#btnScan');
    await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 8000 });
    assert.equal(await page.isHidden('#video'), false);
    assert.equal(await page.isVisible('#boxArt'), true);
    // Das Testbild der Fake-Kamera ist keine Karte → Bildabgleich unsicher → OCR-Rückfall lädt (CDN blockiert)
    await page.waitForSelector('#banner .banner.warn', { timeout: 8000 });
    assert.match(await page.textContent('#banner'), /Texterkennung nicht verfügbar.*Bildabgleich läuft weiter/);
    assert.equal(await page.textContent('#btnScan'), 'Scan stoppen');
    assert.equal(await page.isEnabled('#btnShot'), true, '„Foto auswerten“ aktiv während des Scans');
    assert.equal(await page.evaluate(() => document.querySelector('#quad').hasAttribute('hidden')), true, 'ohne Karte kein Polygon');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, '05-camera.png') });
    await page.click('#btnScan');
    await page.waitForTimeout(200);
    assert.equal(await page.textContent('#btnScan'), 'Scan starten');
    assert.equal(await page.isDisabled('#btnShot'), true, '„Foto auswerten“ aus, wenn die Kamera aus ist');
    assert.equal(await page.isHidden('#video'), true);
    assert.deepEqual(page.errors, []);
  });

  await check('Kalibrierung: Regler verschiebt Rahmen, Debug-Ansicht schaltbar', async () => {
    await tab(page, 'set');
    await page.selectOption('#calReg', 'name');
    await setRange(page, '#calYS', 5);
    const v = await page.evaluate(() => JSON.parse(localStorage.getItem('wowscan.calib2')));
    assert.deepEqual(v.off.name, [0, 5]);
    await page.selectOption('#calReg', 'hp');
    await setRange(page, '#calXS', -3);
    assert.deepEqual((await page.evaluate(() => JSON.parse(localStorage.getItem('wowscan.calib2')))).off.hp, [-3, 0]);
    assert.equal(await page.textContent('#calXV'), '-3');
    await page.check('#calDbg');
    await tab(page, 'scan');
    await page.click('#btnScan');
    await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 8000 });
    await page.waitForTimeout(200);
    const top1 = await page.evaluate(() => parseFloat(document.querySelector('#box-name').style.top));
    for (const r of ['name', 'strip', 'cost', 'atk', 'hp']) assert.equal(await page.isVisible('#box-' + r), true, r);
    assert.equal(await page.isVisible('#dbg'), true);
    assert.equal(await page.isVisible('#cv-strip'), true);
    await page.evaluate(() => window.__wow.testImage('/sample-data/img/900003.png', { feed: false }));
    assert.equal(await page.isVisible('#cvArt'), true);
    assert.ok(await page.evaluate(() => document.querySelector('#cvArt').width) > 100);
    const dt = await page.textContent('#dbgTxt');
    assert.match(dt, /Bild: Treffer · beste Distanz \d+/);
    assert.match(dt, /1\. Sample Frost Oracle.*\n  2\. .*\n  3\. /);
    await page.evaluate(() => window.__wow.frame({ strip: 'BETRAYER 163/264', cost: '2', hp: '2' }, { feed: false }));
    assert.equal(await page.textContent('#raw-strip'), '„BETRAYER 163/264“');
    assert.equal(await page.textContent('#raw-cost'), '„2“');
    assert.match(await page.textContent('#dbgTxt'), /1\. Hulok Trailblazer · Servants of the Betrayer #163\/264: Nr Ges cost hp Basis = 90/);
    await tab(page, 'set');
    await page.selectOption('#calReg', 'name');
    await setRange(page, '#calYS', -5);
    await tab(page, 'scan');
    await page.waitForTimeout(100);
    const top2 = await page.evaluate(() => parseFloat(document.querySelector('#box-name').style.top));
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
    assert.equal(await page.inputValue('#calYS'), '0');
    assert.deepEqual((await page.evaluate(() => JSON.parse(localStorage.getItem('wowscan.calib2')))).off.hp, [0, 0]);
  });


  /* ---------- Fake-Kamera mit Kartenbild (Y4M): Erkennung, Polygon, Foto ---------- */
  // camera.y4m: Karte im Overlay-Rahmen. camera-offset.y4m: kleiner, versetzt, um 4° gedreht, texturierter Hintergrund.
  const camCase = (file, pid, label, shotName) => check(`Kamera (${label}): Karte erkannt, Polygon sichtbar, über ein Foto erfasst`, async () => {
    const y4m = path.join(__dirname, 'sample-data', file);
    const b2 = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + y4m] });
    try {
      const c2 = await b2.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
      await c2.route('https://cdn.jsdelivr.net/**', (r) => r.abort());
      const p = await openApp(c2);
      await p.evaluate(() => window.__wow.setFilter(''));
      const before = await scanCount();
      await p.click('#btnScan');
      await p.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 8000 });
      // Erkennung: grünes Viereck mit vier Ecken über dem Video, innerhalb des Kamerabilds
      await p.waitForFunction(() => { const q = document.querySelector('#quad'); return !q.hasAttribute('hidden') && q.querySelector('polygon').getAttribute('points').split(' ').length === 4; }, null, { timeout: 8000 });
      assert.equal(await p.isVisible('#quad'), true);
      const box = await p.evaluate(() => {
        const r = document.querySelector('#quad polygon').getBoundingClientRect(), c = document.querySelector('#cam').getBoundingClientRect();
        return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height, cw: c.width, ch: c.height };
      });
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= box.cw && box.y + box.h <= box.ch, 'Polygon im Kamerabild: ' + JSON.stringify(box));
      assert.ok(box.w > 100 && box.h > 150, 'Polygon-Größe: ' + JSON.stringify(box));
      // Foto: Erfassung über den Standbild-Pfad (Bildabgleich), Schärfe ausreichend
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && (await scanCount()) === before) await p.waitForTimeout(250);
      assert.equal(await scanCount(), before + 1, 'keine Erfassung über die Kamera');
      const rec = await lastRec();
      assert.equal(rec.productId, pid);
      assert.ok(rec.matchInfo.signals.includes('Bild'), 'Erfassung über das Bild: ' + rec.matchInfo.signals);
      assert.match(await p.textContent('#live'), /Erfasst: /);
      assert.ok((await p.evaluate(() => window.__wow.state().sharp)) >= 60, 'Schärfe des Fotos');
      await p.screenshot({ path: path.join(SHOTS, shotName) });
      // Karte bleibt im Bild: gesperrt (wait-remove), keine Doppelerfassung
      await p.waitForTimeout(1200);
      assert.equal(await scanCount(), before + 1, 'Karte bleibt im Bild → gesperrt, keine Doppelerfassung');
      assert.equal(await p.evaluate(() => window.__wow.state().cardState), 'wait-remove');
      // Auslöser von Hand: „Foto auswerten“ wertet die Karte erneut aus
      await p.click('#btnShot');
      const d2 = Date.now() + 8000;
      while (Date.now() < d2 && (await scanCount()) === before + 1) await p.waitForTimeout(250);
      assert.equal(await scanCount(), before + 2, 'Foto auswerten erfasst');
      const dup = await lastRec();
      await api('DELETE', `/api/scans?id=${dup.id}`);   // Testdublette wieder entfernen
      await p.click('#btnScan');
      assert.deepEqual(p.errors, []);
    } finally { await b2.close(); }
  });
  await camCase('camera.y4m', 900003, 'Karte im Rahmen', '09-camera-card.png');
  await camCase('camera-offset.y4m', 900005, 'versetzt, gedreht', '11-camera-offset.png');
  await check('Kamera (unbekannte Karte): Standbilder werden zusammengeführt, kein Treffer, gesperrt', async () => {
    const b4 = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + path.join(__dirname, 'sample-data', 'camera-unknown.y4m')] });
    try {
      const c4 = await b4.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
      await c4.route('https://cdn.jsdelivr.net/**', (r) => r.abort());
      const p = await openApp(c4);
      const before = await scanCount();
      await p.click('#btnScan');
      // Karte gefunden, Foto gemacht (Schärfe-Wert liegt vor), kein Treffer
      await p.waitForFunction(() => /Nicht erkannt/.test(document.querySelector('#live').textContent), null, { timeout: 10000 });
      await p.waitForTimeout(1000);
      assert.equal(await scanCount(), before, 'unbekannte Karte wird nicht erfasst');
      assert.equal(await p.evaluate(() => window.__wow.state().cardState), 'wait-remove', 'gesperrt, bis die Karte weg ist');
      assert.ok((await p.evaluate(() => window.__wow.state().sharp)) >= 60, 'Foto wurde geschärft geprüft');
      assert.equal(await p.isHidden('#suggest'), true, 'keine Vorschläge');
      await p.click('#btnScan');
      assert.deepEqual(p.errors, []);
    } finally { await b4.close(); }
  });
  // Galerie-Foto (Upload über das versteckte Dateifeld): ohne Kamera und mit Kamera
  const galPath = (f) => path.join(__dirname, 'sample-data', f);
  const waitCount = async (want, ms) => { const d = Date.now() + ms; while (Date.now() < d && (await scanCount()) !== want) await new Promise((r) => setTimeout(r, 250)); return scanCount(); };
  await check('Galerie (Kamera aus): Foto hochladen → Karte erfasst, ohne Kamera', async () => {
    const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    try {
      const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
      await c.route('https://cdn.jsdelivr.net/**', (r) => r.abort());
      const p = await openApp(c);
      await p.evaluate(() => window.__wow.setFilter(''));
      const before = await scanCount();
      await p.setInputFiles('#galFile', galPath('photo-card.jpg'));
      assert.equal(await waitCount(before + 1, 15000), before + 1, 'Foto aus der Galerie nicht erfasst');
      const rec = await lastRec();
      assert.equal(rec.productId, 900003, 'falsche Karte: ' + rec.productId);
      await api('DELETE', `/api/scans?id=${rec.id}`);   // Testdublette wieder entfernen
      // Erkennungs-Log: eine Zeile mit Quelle, Ergebnis, Bildabgleich und Kandidaten
      let log = [];
      for (let i = 0; i < 20 && !log.length; i++) {
        const t = await (await fetch(`http://127.0.0.1:${PORT}/api/log`)).text();
        log = t.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.src === 'gal');
        if (!log.length) await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(log.length, 'kein Erkennungs-Log angekommen');
      const e = log[log.length - 1];
      assert.equal(e.st, 'captured');
      assert.ok(e.art && typeof e.art.d === 'number', 'Bildabgleich fehlt im Log');
      assert.ok(Array.isArray(e.cand) && e.cand.length >= 1 && typeof e.ms === 'number', 'Kandidaten/Zeit fehlen im Log');
      assert.deepEqual(p.errors, []);
    } finally { await b.close(); }
  });
  await check('Galerie (Kamera an, andere Karte im Bild): Foto erfasst, Live-Erkennung erfasst nicht doppelt', async () => {
    const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + galPath('camera-unknown.y4m')] });
    try {
      const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
      await c.route('https://cdn.jsdelivr.net/**', (r) => r.abort());
      const p = await openApp(c);
      await p.evaluate(() => window.__wow.setFilter(''));
      await p.click('#btnScan');
      await p.waitForFunction(() => /Nicht erkannt/.test(document.querySelector('#live').textContent), null, { timeout: 12000 });
      const before = await scanCount();
      await p.setInputFiles('#galFile', galPath('photo-card.jpg'));
      assert.equal(await waitCount(before + 1, 15000), before + 1, 'Foto bei laufender Kamera nicht erfasst');
      await p.waitForTimeout(2500);
      assert.equal(await scanCount(), before + 1, 'Live-Erkennung hat dieselbe oder eine andere Karte doppelt erfasst');
      const rec = await lastRec();
      assert.equal(rec.productId, 900003);
      await api('DELETE', `/api/scans?id=${rec.id}`);
      await p.click('#btnScan');
      assert.deepEqual(p.errors, []);
    } finally { await b.close(); }
  });
  await check('Firmware-Seite: Stylesheet und Skripte inline, eine einzige Anfrage', async () => {
    // tools/embed_web.py baut index.html mit allen Dateien inline, weil der ESP nur eine TLS-Verbindung bedient
    const root = path.join(__dirname, '..', '..');
    const html = require('node:child_process').execFileSync('python3', ['-c',
      'import sys; sys.path.insert(0, "tools"); import embed_web; sys.stdout.write(embed_web.inline_assets(open("webapp/index.html", encoding="utf-8").read()))'],
      { cwd: root, encoding: 'utf8' });
    assert.ok(!/src="(app|arthash|carddetect)\.js"|href="style\.css"/.test(html), 'keine externen Dateien mehr');
    const b = await chromium.launch();
    try {
      const c = await b.newContext();
      const asked = [];
      await c.route(`http://127.0.0.1:${PORT}/`, (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
      await c.route(/\/(app|arthash|carddetect)\.js$|\/style\.css$/, (r) => { asked.push(r.request().url()); r.abort(); });
      await c.route('https://cdn.jsdelivr.net/**', (r) => r.abort());
      const p = await openApp(c);
      assert.deepEqual(asked, []);
      assert.equal(await p.evaluate(() => typeof window.WowCardDetect + typeof window.WowArtHash), 'objectobject');
      assert.notEqual(await p.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)');
      assert.deepEqual(p.errors, []);
    } finally { await b.close(); }
  });
  await check('Galerie (kein Kartenrand): Meldung erscheint, nichts wird erfasst', async () => {
    const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    try {
      const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
      await c.route('https://cdn.jsdelivr.net/**', (r) => r.abort());
      const p = await openApp(c);
      const before = await scanCount();
      await p.setInputFiles('#galFile', galPath('photo-nocard.jpg'));
      await p.waitForFunction(() => /Kartenrand im Foto nicht gefunden/.test(document.querySelector('#toast').textContent), null, { timeout: 15000 });
      await p.waitForTimeout(1000);
      assert.equal(await scanCount(), before, 'ohne Kartenrand darf nichts erfasst werden');
      assert.deepEqual(p.errors, []);
    } finally { await b.close(); }
  });
  await check('Galerie (bereits zugeschnittene Karte): ganzes Bild wird als Karte erfasst', async () => {
    const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    try {
      const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
      await c.route('https://cdn.jsdelivr.net/**', (r) => r.abort());
      const p = await openApp(c);
      await p.evaluate(() => window.__wow.setFilter(''));
      const before = await scanCount();
      await p.setInputFiles('#galFile', path.join(__dirname, 'sample-data', 'img', '900003.png'));
      assert.equal(await waitCount(before + 1, 15000), before + 1, 'zugeschnittene Karte nicht erfasst');
      const rec = await lastRec();
      assert.equal(rec.productId, 900003, 'falsche Karte: ' + rec.productId);
      await api('DELETE', `/api/scans?id=${rec.id}`);
      assert.deepEqual(p.errors, []);
    } finally { await b.close(); }
  });
  // Blitz: nur bei Browsern, die torch melden. Im Fake-Device nicht vorhanden → Button versteckt.
  await check('Blitz: im Fake-Device ohne Lampe bleibt der Button versteckt', async () => {
    const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + galPath('camera.y4m')] });
    try {
      const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
      await c.route('https://cdn.jsdelivr.net/**', (r) => r.abort());
      const p = await openApp(c);
      await p.click('#btnScan');
      await p.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 8000 });
      await p.waitForTimeout(500);
      assert.equal(await p.isHidden('#btnTorch'), true, 'Blitz-Button sichtbar ohne torch-Fähigkeit');
      assert.deepEqual(p.errors, []);
      await p.click('#btnScan');
    } finally { await b.close(); }
  });
  await check('Blitz: Toggle ruft torch an und aus, Scan stoppen schaltet aus', async () => {
    const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + galPath('camera.y4m')] });
    try {
      const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
      await c.addInitScript(() => {
        window.__torch = [];
        const proto = MediaStreamTrack.prototype;
        proto.getCapabilities = function () { return { torch: true }; };
        proto.applyConstraints = function (cons) { window.__torch.push(cons); return Promise.resolve(); };
      });
      await c.route('https://cdn.jsdelivr.net/**', (r) => r.abort());
      const p = await openApp(c);
      await p.click('#btnScan');
      await p.waitForFunction(() => !document.querySelector('#btnTorch').hidden, null, { timeout: 8000 });
      const last = () => p.evaluate(() => window.__torch.at(-1));
      await p.click('#btnTorch');
      await p.waitForFunction(() => document.querySelector('#btnTorch').getAttribute('aria-pressed') === 'true', null, { timeout: 4000 });
      assert.deepEqual(await last(), { advanced: [{ torch: true }] }, 'Einschalten');
      await p.click('#btnTorch');
      await p.waitForFunction(() => document.querySelector('#btnTorch').getAttribute('aria-pressed') === 'false', null, { timeout: 4000 });
      assert.deepEqual(await last(), { advanced: [{ torch: false }] }, 'Ausschalten');
      await p.click('#btnTorch');
      await p.waitForFunction(() => document.querySelector('#btnTorch').getAttribute('aria-pressed') === 'true', null, { timeout: 4000 });
      await p.click('#btnScan');   // Scan stoppen
      assert.deepEqual(await last(), { advanced: [{ torch: false }] }, 'Scan stoppen schaltet die Lampe aus');
      assert.equal(await p.isHidden('#btnTorch'), true, 'Button nach dem Stoppen versteckt');
      assert.deepEqual(p.errors, []);
    } finally { await b.close(); }
  });
  await check('Standbilder zusammenführen: erster passender Rohtext je Feld, sonst der häufigste', async () => {
    const r = await page.evaluate(() => window.__wow.mergeRaw([
      { strip: 'BETRAYER 15 3/264', cost: '7' }, { strip: 'BETRAYER 163/264', cost: '2', atk: '2', hp: '2' }, { strip: 'BETRAYER 163/264', cost: '2', atk: '9', hp: '2' },
    ], ['sotb-163']));
    assert.equal(r.strip, 'BETRAYER 163/264', 'erster Wert, der zur Karte passt');
    assert.equal(r.cost, '2', '„7“ passt nicht zur Karte');
    assert.equal(r.atk, '2', 'erster passender Wert vor „9“');
    assert.equal(r.hp, '2');
    const h = await page.evaluate(() => window.__wow.mergeRaw([{ cost: '5' }, { cost: '6' }, { cost: '6' }], []));
    assert.equal(h.cost, '6', 'ohne Passung: häufigster Wert');
    assert.equal(h.name, '');
  });
  await check('Kamera: Schärfe-Grenze über der Schärfe des Fotos → Foto wird verworfen, keine Erfassung', async () => {
    const b3 = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + path.join(__dirname, 'sample-data', 'camera.y4m')] });
    try {
      const c3 = await b3.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
      await c3.route('https://cdn.jsdelivr.net/**', (r) => r.abort());
      const p = await newPage(c3);
      await p.setViewportSize({ width: 390, height: 844 });
      await p.addInitScript(() => localStorage.setItem('wowscan.calib2', JSON.stringify({ sharpMin: 200 })));
      await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
      await p.evaluate(() => window.__wow.ready);
      const before = await scanCount();
      await p.click('#btnScan');
      await p.waitForFunction(() => /Unscharf/.test(document.querySelector('#live').textContent), null, { timeout: 8000 });
      await p.waitForTimeout(800);
      assert.equal(await scanCount(), before, 'unscharfes Foto erfasst');
      assert.ok((await p.evaluate(() => window.__wow.state().sharp)) < 200, 'Schärfe liegt unter der Grenze');
      assert.equal(await p.evaluate(() => window.__wow.state().cardState), 'steady', 'zurück auf Ruhig');
      await p.click('#btnScan');
    } finally { await b3.close(); }
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
    assert.match(await p2.textContent('#dataInfo'), /30 Karten/);
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
    assert.match(await p3.textContent('#dataInfo'), /30 Karten/);
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


  /* ---------- cards.json Version 1 (ohne sets, Nummer als Text) ---------- */
  await check('Kompatibilität: cards.json v1 wird weiter geladen', async () => {
    const c7 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const v1 = fs.readFileSync(path.join(__dirname, 'sample-data', 'cards-v1.json'), 'utf8');
    await c7.route('**/sample-data/cards.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: v1 }));
    await c7.route('https://cdn.jsdelivr.net/**', (r) => r.abort());
    const p = await openApp(c7);
    assert.match(await p.textContent('#dataInfo'), /26 Karten/);
    assert.match(await p.textContent('#dataInfo'), /Set\+Nummer noch nicht verfügbar \(Kartendatenbank fehlt\)/);
    assert.equal((await p.evaluate(() => window.__wow.state())).indexed, 26);
    const img = await p.evaluate(() => window.__wow.testImage('/sample-data/img/900003.png', { feed: false }));
    assert.equal(img.ok, true);
    assert.equal(img.cand[0].k, 'p900003');
    const n = await p.evaluate(() => window.__wow.frame({ strip: 'SMA 12/100' }, { feed: false }));
    assert.equal(n.cand[0].pid, 900022, 'v1-Nummer "12/100" und Set-Kürzel SMA');
    assert.equal(n.sure, true);
    assert.equal((await p.evaluate(() => window.__wow.testMatch('Sample Knight of Testing'))).top.printings.length, 2);
    assert.deepEqual(p.errors, []);
    await c7.close();
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
    // Kombinierte Bewertung (Nummer, Werte, Name) auf dem großen Bestand
    const fms = await p6.evaluate(async () => {
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) await window.__wow.frame({ strip: `SBS ${(i % 300) + 1}/300`, cost: '2', atk: '3', hp: '1', name: 'Storm Hownd' }, { feed: false });
      return (performance.now() - t0) / 20;
    });
    console.log(`  Kombinierte Bewertung Ø ${fms.toFixed(1)} ms je Frame`);
    assert.ok(fms < 30, 'Frame ' + fms);
    await ctx5.close();
  });


  await check('Performance: 10.000 Bild-Hashes, Bildabgleich im Schnitt < 30 ms', async () => {
    const ctx6 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-data', 'cards.json'), 'utf8')).cards;
    const big = JSON.parse(makeBigCards(10000));
    big.cards.push(...sample);
    const hdoc = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-data', 'hashes.json'), 'utf8'));
    const sha = (t) => require('node:crypto').createHash('sha256').update(t).digest('hex');
    for (let i = 0; i < 10000; i++) hdoc.hashes[String(800000 + i)] = [sha('h' + i), sha('c' + i).slice(0, 6)];
    await ctx6.route('**/sample-data/cards.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(big) }));
    await ctx6.route('**/sample-data/hashes.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hdoc) }));
    const p7 = await openApp(ctx6);
    const st = await p7.evaluate(() => window.__wow.artState());
    assert.ok(st.groups >= 10022, 'Gruppen ' + st.groups);
    const times = [];
    for (let i = 0; i < 3; i++) for (const pid of [900003, 900005, 900019, 900020]) {
      const r = await p7.evaluate((u) => window.__wow.testImage(u, { feed: false }), `/sample-data/img/${pid}.png`);
      assert.equal(r.best.pid, pid);
      assert.equal(r.ok, true, `Produkt ${pid}: Abstand ${r.margin}`);
      times.push(r.ms);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`  Bildabgleich (Hash + 10.022 Gruppen) Ø ${avg.toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms`);
    assert.ok(avg < 30, 'Durchschnitt ' + avg);
    await ctx6.close();
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
