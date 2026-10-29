# WoW Trading Card Price Scanner – Technische Spezifikation

Verbindliche Spezifikation für alle Komponenten. Sprache der UI und der OLED-Texte: Deutsch.

## Überblick

```
 Handy (Browser, HTTPS)                 NodeMCU ESP8266 + 0,96" OLED
 ┌──────────────────────────┐  HTTPS   ┌──────────────────────────────┐
 │ Web-App (vom ESP geladen) │ <──────> │ HTTPS-Server (BearSSL, EC)   │
 │ - Live-Kamera, Dauer-Scan │  /api/*  │ Scans in LittleFS speichern  │
 │ - OCR (Tesseract.js, CDN) │          │ OLED: Splash, IP, Karteninfo │
 │ - Abgleich mit Kartendaten│          │ OTA (Web-Upload + ArduinoOTA)│
 │ - Export CSV/JSON         │          └──────────────────────────────┘
 └───────────┬──────────────┘
             │ HTTPS, CORS *
             ▼
 GitHub Pages: data/cards.json, data/prices.json, data/rates.json, data/meta.json
   ▲ täglich gebaut von GitHub Action (data-pipeline/build_data.py)
   │ Quellen: tcgcsv.com (TCGplayer-Daten, Kategorie 13 "WoW", USD), EZB-Referenzkurse
```

Warum so: Der ESP8266 hat ca. 40 KB freien RAM. Zwei TLS-Sitzungen gleichzeitig (Server zum Handy plus Client zu tcgcsv) sind zu knapp, und tcgcsv blockiert Browser-Anfragen per CORS und verlangt Abrufe von einem Backend höchstens einmal täglich. Die GitHub Action ist dieses Backend. GitHub Pages liefert mit `Access-Control-Allow-Origin: *`, das Handy kann die Daten also direkt laden.

## Repo-Struktur

```
firmware/            PlatformIO-Projekt (Arduino-Framework, Board nodemcuv2)
  platformio.ini
  src/main.cpp ...
  include/config.h
  include/web_assets.h   (GENERIERT aus webapp/ durch tools/embed_web.py)
  include/logo.h         (GENERIERT durch tools/make_logo.py)
  default_cert/          (Fallback-Zertifikat wird im CI erzeugt, nicht eingecheckt)
webapp/              index.html, app.js, style.css (kein Build-Schritt, Vanilla JS)
tools/embed_web.py   gzip + PROGMEM-Header aus webapp/
tools/make_logo.py   erzeugt 128x64-XBM-Logo (eigene Grafik, KEIN Blizzard-Logo)
data-pipeline/build_data.py
flasher/flasher.py, flasher/requirements.txt, flasher/build_exe.ps1
.github/workflows/build.yml   Firmware + Windows-EXE + Release
.github/workflows/data.yml    täglicher Datenlauf + Deploy auf GitHub Pages
docs/SPEC.md
README.md (Deutsch)
```

## 1. Firmware (ESP8266)

- PlatformIO, `platform = espressif8266`, `board = nodemcuv2`, `framework = arduino`, `board_build.filesystem = littlefs`, `board_build.ldscript = eagle.flash.4m1m.ld` (4 MB Flash, 1 MB FS, OTA-fähig).
- Libraries: `olikraus/U8g2` (SSD1306 128x64), `bblanchon/ArduinoJson@^7`.
- OLED: SSD1306 128x64, I2C-Adresse 0x3C. Diese Boards (HW-364A u.ä.) verdrahten das OLED meist mit SDA=GPIO14 (D5), SCL=GPIO12 (D6). Firmware probiert beim Start beide Belegungen (14/12 und 12/14) sowie 4/5 per I2C-Scan auf 0x3C und nimmt die erste, die antwortet. Pins zusätzlich in `config.h` überschreibbar.
- Display-Ablauf:
  1. Splash 3 s: Logo (aus `logo.h`) + Text „WoW Trading Card Price Scanner“ (umbrechen, kleiner Font).
  2. Ohne Konfiguration: „Warte auf Flasher…“ (seriell).
  3. „WLAN verbinden…“ + SSID.
  4. Dauerhaft: IP-Adresse groß, darunter `https://<ip>` und Anzahl Scans.
  5. Bei Scan (POST /api/scan): 6 s Karteninfo (Name gekürzt/umgebrochen, Set-Kürzel + Nummer, Seltenheit, Preis in Landeswährung), danach zurück zu 4.
  6. OTA läuft: Fortschrittsbalken.
- Konfiguration in LittleFS `/config.json`: `ssid`, `pass`, `otaPass`, `hostname` (Default `wowscanner`), `country` (Default `DE`), `currency` (Default `EUR`), `dataUrl`. Zertifikat in `/cert.pem`, Schlüssel in `/key.pem` (EC P-256).
- OTA aktualisiert nur den Sketch-Bereich, LittleFS bleibt unberührt → WLAN und Zertifikat bleiben erhalten.
- Serielle Provisionierung (115200 Baud), Protokoll zeilenbasiert:
  - Firmware sendet beim Boot und danach alle 1 s für die ersten 5 s (bei fehlender Konfiguration dauerhaft) `WOWSCAN:READY <version>`.
  - Flasher sendet `WOWCFG <base64(json)>\n`. JSON-Felder: `ssid`, `pass`, `otaPass`, `hostname`, `country`, `currency`, `dataUrl` (optional), `cert` (PEM, optional), `key` (PEM, optional).
  - Firmware antwortet `WOWCFG:OK` oder `WOWCFG:ERR <grund>`, speichert, startet neu.
  - Nach WLAN-Verbindung: `WOWSCAN:IP <ip>`; bei Fehlschlag nach 30 s `WOWSCAN:WIFIFAIL`.
  - Base64-Zeile kann ~2 KB lang sein: Serial-RX-Puffer mit `Serial.setRxBufferSize(4096)` vergrößern.
- WLAN fehlgeschlagen: alle 30 s neu versuchen; Display zeigt „WLAN-Fehler“ + SSID. Provisionierung über Seriell bleibt jederzeit möglich.
- HTTPS-Server: `BearSSL::ESP8266WebServerSecure` auf Port 443, EC-Zertifikat aus LittleFS (`setECCert`), Fallback auf eingebautes Zertifikat aus `default_cert.h` (vom CI generiert; falls Header fehlt, Build-Fehler mit klarer Meldung – es gibt ein Skript `tools/make_default_cert.py`). Session-Cache (`BearSSL::ServerSessions`, 4–5 Einträge) für schnelle Folgeanfragen.
- HTTP-Server Port 80: alles per 301 auf `https://<ip>/` umleiten.
- mDNS: `<hostname>.local`.
- ArduinoOTA mit `otaPass` (Port 8266).
- API (alle JSON, UTF-8):
  - `GET /` → `index.html` (gzip, `Content-Encoding: gzip`), `GET /app.js`, `GET /style.css` analog. Cache-Control: `no-cache`.
  - `GET /api/status` → `{version, ip, hostname, scans, freeHeap, uptime, country, currency, dataUrl}`
  - `POST /api/scan` Body = Scan-Datensatz (siehe unten, max 2 KB). Firmware vergibt `id` (fortlaufend) und speichert als eine Zeile in `/scans.jsonl`. Antwort `{ok:true,id}`. Zeigt Karteninfo auf dem OLED.
  - `GET /api/scans` → JSON-Array, gestreamt (chunked oder per Content-Length nach Dateigröße), nicht komplett in RAM laden.
  - `PATCH /api/scans?id=N` Body `{qty}` → Menge ändern (Datei umschreiben über Temp-Datei).
  - `DELETE /api/scans?id=N` → einzelnen Eintrag löschen; `DELETE /api/scans` → alle löschen.
  - `GET /api/settings`, `POST /api/settings` Body `{country, currency, dataUrl}`.
  - `POST /api/update` multipart-Upload einer `.bin` → OTA (Header `X-OTA-Pass` muss `otaPass` entsprechen). Antwort, dann Neustart. Seit 0.1.4 nimmt der TLS-Server nur Records bis 6 KB an (mehr freier Speicher). Browser und curl schicken Uploads in 16-KB-Records, deshalb geht das Update in der Praxis über ArduinoOTA (Port 8266).
- Dauerbetrieb (seit 0.1.4, `health.cpp`): WLAN-Modem-Sleep aus. Neustart, wenn das WLAN 5 Minuten weg ist, wenn im Leerlauf der größte freie Heap-Block 1 Minute lang unter 8 KB liegt, und einmal täglich nach 10 Minuten ohne Anfrage. `/api/status` liefert zusätzlich `maxBlock`, `heapFrag`, `minHeap`, `rssi`, `wifiDrops` und `resetReason`. `POST/GET/DELETE /api/log` (seit 0.1.6): Erkennungs-Log der App, eine JSON-Zeile je Auswertung, rotiert bei 32 KB (`?old=1` liefert die vorige Datei). Web-App-Dateien haben seit 0.1.5 ein ETag (Build-Zeit): Ein Neuladen bekommt 304 ohne Inhalt. Absturz-Diagnose (seit 0.1.9): Beim Start schreibt `healthBoot()` nach einer Exception, einem Watchdog-Reset oder einem eigenen Neustart (WLAN weg, Speicher knapp, Wartung) eine JSON-Zeile nach `/crash.log` (`GET /api/crash`, ab 4 KB neu begonnen): Grund, `epc`, `exc`/`excvaddr`, Code-Adressen vom Stack (`bt`, über `custom_crash_callback` im RTC-Speicher gesichert, mit `addr2line -e firmware.elf` auflösbar) und den letzten Stand vor dem Reset (`prevUp`, `prevMinHeap`, `prevMaxBlock`, `prevIdle`, alle 10 s im RTC-Speicher). `/api/status` liefert dazu `bootInfo`, z.B. „Exception 28 @0x40212345“.
  - Limit: max. 2000 Scans; danach 507 mit Fehlermeldung.
- Scan-Datensatz (Feldnamen exakt so): `id, ts (ISO-8601, vom Handy), productId, name, set, setCode, number, rarity, type, cardClass, faction, cost, atk, health, foil (bool), condition, qty, priceUsd, price, currency, priceType ("market"|"low"|"mid"), priceDate, source ("TCGplayer via tcgcsv.com"), url, imageUrl, ocrConfidence`.
- Watchdog beachten: `yield()` in langen Schleifen; keine Strings > wenige KB im RAM.

## 2. Web-App (webapp/)

- Vanilla JS, eine Seite, mobil zuerst, Dark-Theme mit WoW-artigen Akzentfarben (Gold/Braun), keine Blizzard-Assets.
- Tesseract.js v5 vom CDN `https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js`, Sprache `eng` (Kartennamen sind englisch; deutsche Kartenausgaben gab es auch – Hinweis in der UI, dass der Abgleich gegen englische Namen läuft).
- Ablauf:
  1. Start: `GET /api/status` und Settings; Kartendaten von `dataUrl` laden (`meta.json`, `cards.json`, `prices.json`, `rates.json`), in IndexedDB cachen (neu laden, wenn `meta.generatedAt` neuer). Fortschrittsanzeige.
  2. „Scan starten“: `getUserMedia({video:{facingMode:'environment', width:{ideal:1920}}})`. Overlay mit Kartenrahmen (Seitenverhältnis 63:88).
  3. Dauer-Scan-Schleife (Kamera läuft durch): alle ~700 ms einen Frame aus dem Rahmen ausschneiden, Graustufe + Kontrast, zwei Regionen OCRen: Namenszeile (oberer Bereich) und unterer Streifen (Sammlernummer `\d{1,3}/\d{1,3}`). Nur ein OCR-Job gleichzeitig (Worker wiederverwenden).
  4. Abgleich: normalisierte Namen (Kleinbuchstaben, nur a-z0-9 und Leerzeichen), Levenshtein-Ähnlichkeit gegen alle `cards.json`-Namen; Nummer verfeinert bei mehreren Treffern (gleiche Nummer → Bonus). Treffer gilt bei Score ≥ 0,8 und gleicher Karte in 2 aufeinanderfolgenden Frames.
  5. Erfassung: Vibration + kurzer Ton + Toast mit Name/Preis; POST `/api/scan`; Karte erscheint oben in der Liste. Danach dieselbe Karte erst wieder erfassen, wenn 2 Frames lang keine/andere Karte erkannt wurde (Karte gewechselt) – oder per Button „+1“.
  6. Unsicher (0,6–0,8): Vorschlagsleiste mit Top-3 zum Antippen statt automatischer Erfassung.
  7. Manuelle Suche: Textfeld mit Live-Suche in `cards.json` als Fallback.
- Einstellungen: Land (DE, AT, CH, US, GB, FR, IT, ES, NL, PL, …) → Währung automatisch (EUR/CHF/USD/GBP/PLN/…), Preisart (Marktpreis/Tiefstpreis/Mittelpreis), Foil-Standard, Zustand (NM/LP/MP/HP – nur Information, Preis ist TCGplayer-Marktpreis), dataUrl. Speichern per `POST /api/settings`.
- Preis: `priceUsd` aus `prices.json` (nach `productId` + `foil` → subTypeName), Umrechnung `priceUsd * rates[currency]` (rates = Einheiten Zielwährung pro 1 USD, aus EZB-Kursen berechnet). Immer sichtbar beschriften: „TCGplayer-Marktpreis (US), umgerechnet, Stand <priceDate>“. Fehlt ein Preis: „kein Preis“ – nichts erfinden.
- Sammlungsansicht: Liste aller Scans (vom ESP), Menge ändern, löschen, Summen: Anzahl Karten, Gesamtwert, Wert pro Set, pro Seltenheit, Top-10 teuerste.
- Export: CSV (Semikolon, UTF-8 mit BOM, Dezimalkomma bei EUR für Excel DE), JSON, und Kurzbericht als Text (Zusammenfassung zum Teilen). Download per Blob; zusätzlich Web Share API, wenn verfügbar.
- Fehlerfälle: keine Kamera/kein HTTPS → klare Meldung mit Anleitung (Zertifikat akzeptieren); keine Internetverbindung fürs Laden der Daten → Meldung, gecachte Daten nutzen.
- Größe: alle Web-App-Dateien zusammen gzip < 56 KB (Flash hat Platz; erhöht für die Kartenrand-Erkennung).

## 3. Daten-Pipeline (data-pipeline/build_data.py)

- Python 3.11, nur `requests`. User-Agent `WoWCardPriceScanner/1.0 (+https://github.com/<repo>)`. 150 ms Pause zwischen Anfragen. Vorher `https://tcgcsv.com/last-updated.txt` lesen.
- `GET https://tcgcsv.com/tcgplayer/13/groups` → alle Sets. Für jede Gruppe `.../13/{groupId}/products` und `.../13/{groupId}/prices`.
- Nur Einzelkarten aufnehmen (Produkte mit `extendedData`-Eintrag `Number` oder `Rarity`; Booster/Decks/Boxen ausschließen).
- `cards.json`: `{generatedAt, cards:[{p:productId, n:name, g:groupId, s:setName, sc:setAbbrev, num, r:rarity, t:cardType, x: {weitere extendedData kompakt: Class, Faction, Cost, ATK, Health, Race, Talent, Professions, ...}, img:imageUrl, u:url}]}` – kurze Keys für kleine Datei. CardText weglassen (Größe).
- `prices.json`: `{generatedAt, priceDate, prices:{"<productId>":{"Normal":[market,low,mid],"Foil":[...]}}}` – Werte als Zahl oder null.
- `rates.json`: EZB `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml` parsen → Kurse pro 1 USD für alle EZB-Währungen plus EUR; `{date, base:"USD", rates:{EUR:..., CHF:..., ...}}`.
- `meta.json`: `{generatedAt, priceDate, cardCount, groupCount, sources:[...]}`.
- Ausgabe in `site/data/`. Ein Fehler bei einer Gruppe → loggen und weiter; Abbruch, wenn < 50 % der Gruppen klappen.

## 4. Flasher (flasher/)

- Python 3.11, tkinter-GUI, `esptool` (als Modul `esptool.main([...])`), `pyserial`, `cryptography`. Paketiert mit PyInstaller `--onefile --windowed` zu `WoWScannerFlasher.exe`, Firmware `firmware.bin` als eingebettete Datei (`--add-data`).
- GUI (Deutsch): COM-Port-Auswahl (mit „Aktualisieren“, CH340 automatisch vorauswählen), WLAN-Name, WLAN-Passwort (versteckt, „anzeigen“), OTA-Passwort (Vorschlag zufällig generiert), Land (Dropdown, Default DE), Hostname. Buttons: „Flashen + Einrichten“, „Nur WLAN/Einstellungen ändern“ (ohne Flashen). Log-Fenster, Fortschrittsbalken, am Ende große Anzeige der IP + Button „Im Browser öffnen“ + Hinweis zur Zertifikatswarnung.
- Ablauf „Flashen + Einrichten“: EC-P-256-Schlüssel + selbst signiertes Zertifikat erzeugen (CN=hostname, SAN: DNS hostname.local, 10 Jahre). `esptool --chip esp8266 --port X --baud 460800 erase_flash` dann `write_flash 0x0 firmware.bin` (bei Fehler auf 115200 zurückfallen). Dann Port öffnen 115200, auf `WOWSCAN:READY` warten (max 15 s, ggf. per DTR/RTS resetten), `WOWCFG <base64>` senden, auf `WOWCFG:OK`, dann auf `WOWSCAN:IP` (max 45 s).
- Lange Aktionen in Thread, GUI bleibt bedienbar.
- `flasher/build_exe.ps1` für lokalen Bau; CI baut auf `windows-latest`.

## 5. CI (.github/workflows)

- `build.yml` (push, PR, tag `v*`, manuell): Job `firmware` (ubuntu): Python, PlatformIO installieren, `tools/make_logo.py`, `tools/embed_web.py`, `tools/make_default_cert.py`, `pio run -d firmware`, Artefakt `firmware.bin`. Job `flasher` (windows-latest, needs firmware): PyInstaller-Build, Artefakt `WoWScannerFlasher.exe` (+ `firmware.bin` für OTA). Bei Tag: GitHub Release mit beiden Dateien.
- `data.yml` (täglich 06:00 UTC + manuell): `build_data.py` → `site/`, Deploy per `actions/upload-pages-artifact` + `actions/deploy-pages`.
- `dataUrl`-Default: `https://<owner>.github.io/<repo>/data/` – im Firmware-Build per Build-Flag `-DDATA_URL=...` aus `github.repository_owner` / Repo-Name gesetzt.
