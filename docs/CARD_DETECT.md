# Kartenrand erkennen und Standbild auswerten

Bisher wird alle 650 ms der feste Overlay-Rahmen ausgeschnitten und ausgewertet. Echte Tests zeigen:
Die Karte liegt selten genau im Rahmen (kleiner, versetzt, leicht gedreht). Dann sitzen Bildausschnitt
und OCR-Felder daneben. Neu: Die App sucht den Kartenrand selbst, wartet bis die Karte ruhig und
scharf ist, entzerrt dieses eine Standbild auf die Karte und wertet nur das aus.

Alles läuft im Handy. Der ESP8266 bleibt unverändert.

## Modul `webapp/carddetect.js`

Wie `arthash.js`: UMD-Muster, im Browser `window.WowCardDetect`, in Node `module.exports`, ohne
Abhängigkeiten, nur reine Funktionen auf Arrays. Wird in `tools/embed_web.py` und `index.html` eingebunden.

### `detectCard(gray, w, h, opts)` → `null | { corners, score }`

- `gray`: `Uint8Array` Graustufen (w×h), zeilenweise. Der Aufrufer liefert den Suchbereich
  (Overlay-Rahmen, an jeder Seite um 12 % der Rahmenbreite erweitert, auf das Video begrenzt),
  verkleinert auf ca. 240 px Breite.
- `opts.aspect` (Standard 63/88), `opts.aspectTol` (Standard 0,08), `opts.minArea` (Standard 0,25:
  Anteil der Kartenfläche an der Fläche des Suchbereichs).
- Ergebnis: `corners` = `[[x,y] oben links, oben rechts, unten rechts, unten links]` in Pixeln
  von `gray`, `score` 0..1 (Anteil der Scanlinien mit Kantentreffer auf den Linien).

Algorithmus:
1. Leicht glätten (3×3 Box) und Sobel-Gradienten `gx`, `gy` berechnen.
2. Kantenpunkte je Seite: 40 Scanlinien senkrecht zur Seite, gleichmäßig verteilt über die mittleren 70 % der
   Seite. Jede Linie läuft von außen nach innen bis zur Bildmitte und nimmt bis zu vier lokale Maxima des
   Gradienten senkrecht zur Seite, die ≥ `T` sind und mindestens 3 px auseinander liegen. Die Karte hat einen
   dunklen Rand, der Hintergrund ist beliebig. Deshalb zählt das Vorzeichen nicht.
   `T` = max(20, 80. Perzentil des Gradientenbetrags im Bild).
3. Sequentielles RANSAC je Seite: Bis zu vier Geraden mit je mindestens 10 Inliern. Jede Gerade wird mit 60
   Zufallspaaren (fester Seed, LCG) gesucht. Inlier liegen ≤ 1,5 px von der Geraden. Danach
   Gesamtkleinstquadrate über die Inlier. Die Inlier werden entfernt, dann folgt die nächste Gerade. Je Kandidat
   gespeichert: Gerade, Inlierzahl, mittlere Position.
4. Kombinationen: Aus jeder Seite genau ein Kandidat (höchstens 4⁴ = 256). Gültig ist eine Kombination, wenn
   - alle Ecken (Schnittpunkte benachbarter Geraden) höchstens 2 px außerhalb des Bildes liegen,
   - alle Innenwinkel zwischen 75° und 105° liegen,
   - das Verhältnis Breite/Höhe (Mittel der gegenüberliegenden Seitenlängen) höchstens `aspectTol` von `aspect` abweicht,
   - die Fläche mindestens `minArea` der Suchfläche beträgt,
   - die Inlier mindestens 0,5 · 4 · 40 ausmachen (siehe Umsetzungsnotizen).
   Bewertung: Summe der Inlier × (1 − |Verhältnis − aspect| / aspectTol × 0,5). Die beste gültige Kombination gewinnt.
   Gibt es keine gültige, ist das Ergebnis `null`.
5. Außenrand-Verfeinerung je Seite der Gewinnerkombination: Ein weiterer Kandidat derselben Seite wird übernommen,
   wenn er höchstens 3° von der Richtung der aktuellen Geraden abweicht, weiter außen liegt, höchstens 7 % der
   Kartenbreite (oben/unten) bzw. -höhe (links/rechts) entfernt ist, mindestens 10 Inlier hat und mindestens die
   Hälfte der Inlier der aktuellen Seite. Die Karte muss
   mit ihm gültig bleiben. Gewählt wird der äußerste solche Kandidat. Die Kandidaten für diesen Schritt stammen aus
   einer niedrigeren Schwelle `max(20, 50. Perzentil)`, damit auch ein schwacher äußerer Rand gefunden wird.
6. `score` = Inlier der gewählten Geraden / Scanlinien gesamt (4 · 40 = 160).

### `warpCard(src, sw, sh, corners, dw, dh, ch)` → `Uint8ClampedArray` (RGBA, dw×dh)

Perspektivische Entzerrung: Homographie aus den 4 Ecken (in Pixeln von `src`) auf das Rechteck
`dw×dh`. Für jedes Zielpixel wird bilinear aus `src` gelesen (RGBA, `ch` = 4). Die Homographie wird
per 8×8-Gleichungssystem (Gauß mit Pivotsuche) gelöst.

### `sharpness(gray, w, h)` → Zahl

Varianz des 4-Nachbar-Laplace über das Bild (ganzzahlig summiert, als Gleitkomma zurück).

## Ablauf in `app.js`

Zustände: `search` → `steady` → `shot` → `wait-remove`.

- **Erkennung** alle 150 ms (nur wenn nicht `busy`): Suchbereich aus dem Video in ein kleines Canvas
  zeichnen (ca. 240 px breit), Graustufen, `detectCard`. Die Ecken werden in Videopixel
  zurückgerechnet und als grüne Linie (SVG-Polygon `#quad` über dem Video) angezeigt. Ohne
  Treffer bleibt der Overlay-Rahmen als Hinweis sichtbar.
- **Ruhig**: 3 aufeinanderfolgende Treffer, bei denen sich keine Ecke um mehr als 2 % der
  Kartenbreite bewegt. Status: „Karte erkannt – ruhig halten …“.
- **Foto**: aktuelles Video-Vollbild (volle Stream-Auflösung) in ein Canvas, `warpCard` auf
  800×1116 (OCR) und daraus verkleinert 400×558 (Bildabgleich, wie bisher `CARD_W/CARD_H`).
  Schärfe auf dem Kartenbild prüfen. Liegt sie unter `S.cal.sharpMin` (Start 60, einstellbar
  in der OCR-Kalibrierung), wird das Foto verworfen und es gibt zurück auf **Ruhig**
  (Status „Unscharf – ruhig halten …“).
- **Auswertung** des Standbilds: Bildabgleich auf 400×558, dann alle OCR-Felder (Nummer, Kosten,
  Angriff, Leben, Name) auf 800×1116, dann `score`. Ein Standbild ersetzt die bisherige Regel
  „2 Frames hintereinander“: Ist das Ergebnis eindeutig (`m.sure`), wird sofort erfasst.
  Sonst werden bis zu 2 weitere Standbilder derselben Karte genommen und die OCR-Rohtexte je Feld
  zusammengeführt (der erste nicht leere Wert, der zu einem Kandidaten passt, sonst der häufigste).
  Danach, wenn immer noch nicht eindeutig: Vorschläge (Top 3) wie bisher.
- **Warten auf neue Karte**: Nach Erfassen oder Vorschlägen erst weiter, wenn 2 Erkennungen
  hintereinander keinen Treffer liefern oder sich die Ecken um mehr als 15 % der Kartenbreite
  verschieben. Status: „Erfasst: … Nächste Karte auflegen.“
- **Auslöser von Hand**: Button „Foto auswerten“ unter dem Video. Er nimmt die zuletzt erkannten
  Ecken. Fehlen sie, wird der Overlay-Rahmen genommen (Verhalten wie bisher).
- Die Debug-Ansicht zeigt zusätzlich das entzerrte Kartenbild, den Schärfewert und den Erkennungs-`score`.
- Die bisherige Dauerschleife (`startLoop` / `scanFrame` mit 650 ms) entfällt. `processCard(cv, …)`
  bleibt als Kern erhalten, bekommt aber das Hi-Res-Canvas für die OCR.
- `window.__wow.testImage` und der bestehende E2E-Pfad müssen weiter funktionieren.

## OCR-Felder (relativ zur ganzen Karte, an echten Fotos nachgemessen)

| Feld | x | y | w | h | vorher |
|---|---|---|---|---|---|
| name | 0.18 | 0.025 | 0.64 | 0.065 | 0.20/0.05/0.65/0.06 |
| strip (Nummer) | 0.18 | 0.925 | 0.55 | 0.05 | 0.18/0.955/0.52/0.04 |
| cost | 0.07 | 0.025 | 0.16 | 0.10 | 0.03/0.04/0.13/0.08 |
| atk | 0.05 | 0.86 | 0.16 | 0.11 | 0.03/0.88/0.12/0.09 |
| hp | 0.83 | 0.86 | 0.15 | 0.11 | 0.85/0.88/0.12/0.09 |

Gespeicherte Kalibrier-Offsets (`wowscan.calib`) gelten relativ zu den neuen Werten. Weil sich die
Basis ändert, wird der Schlüssel auf `wowscan.calib2` umgestellt (alte Offsets verfallen).

## Datenstand im Status

Ist `cards.json` noch Version 1 (keine Nummern), steht im Status statt „Set+Nummer“:
„Set+Nummer noch nicht verfügbar (Kartendatenbank fehlt)“. Ohne `hashes.json` wie bisher „ohne Bild“.

## Foto aus der Galerie und Blitz

### Foto aus der Galerie

- Button „Foto aus Galerie“ im Scan-Tab neben „Foto auswerten“. Er funktioniert auch ohne Kamera.
- Dahinter ein verstecktes `<input type="file" accept="image/*">` ohne `capture`-Attribut, damit iOS und Android die
  Galerie anbieten.
- Laden mit `createImageBitmap(file, { imageOrientation: 'from-image' })`. Schlägt das fehl, verwendet die App
  `Image` mit einer Object-URL. Die lange Seite wird auf höchstens 2000 px verkleinert.
- Kartenrand suchen (`findPhotoCard`): Graustufen auf ca. 360 px lange Seite, `detectCard` mit `minArea` 0,08.
  1. ganzes Bild. Liegen alle gefundenen Ecken bis 4 % am Bildrand und hat das Bild Kartenformat, ist das ganze Bild
     die Karte (ein zugeschnittenes Kartenbild hat keinen äußeren Rand, den der Detektor finden könnte),
  2. kein Treffer: mittlerer 70-%-Ausschnitt,
  3. kein Treffer, aber das Bild hat ungefähr Kartenformat (|Breite/Höhe − 63/88| ≤ 0,08): das ganze Bild ist die Karte.
  Sonst die Meldung „Kartenrand im Foto nicht gefunden. Bitte die Karte formatfüllend und gerade fotografieren.“
- Danach derselbe Weg wie beim Standbild: Entzerren auf 800×1116 (OCR) und 400×558 (Bildabgleich), Schärfe nur
  anzeigen (Galeriefotos werden nicht wegen Unschärfe verworfen), `evalCard`, `decide`. Also erfassen oder Vorschläge.
- Läuft der Live-Scan, hält das Foto ihn über `S.busy` an und wartet auf die laufende Auswertung. Danach bleibt die
  Live-Erkennung für die Karte gesperrt, solange sie im Kamerabild liegt. Sonst würde sie dieselbe Karte sofort
  erneut erfassen. Ist die Kamera aus, bleibt keine Sperre zurück.
- Die Debug-Ansicht zeigt wie beim Standbild die entzerrte Karte und die Rohtexte.

### Blitz

- Nach `getUserMedia` prüft die App `track.getCapabilities()`. Nur wenn `torch` gemeldet wird, erscheint der Schalter
  „Blitz“ (`aria-pressed`). Er schaltet mit `applyConstraints({ advanced: [{ torch }] })`. Ein Fehler erscheint als Meldung.
- Bei „Scan stoppen“ geht die Lampe aus und der Schalter verschwindet.
- Browser ohne Lampensteuerung (nach Kenntnisstand iPhone-Safari) zeigen keinen Schalter und keine Fehlermeldung.

## Tests

- `webapp/dev/carddetect_test.js` (Node, 17 Prüfungen): synthetische Bilder (Hintergrund mit Rauschen und Textur,
  dunkle Karte mit hellem Innenbereich): gerade, verschoben, um 4° gedreht, perspektivisch verzerrt,
  heller und dunkler Hintergrund. Die Ecken müssen auf ≤ 2 px stimmen. Leeres Rauschbild →
  `null`. Falsches Seitenverhältnis (quadratisch) → `null`. Zu kleine Karte → `null`. `warpCard` liefert für ein
  achsparalleles Rechteck dieselben Pixel wie ein einfacher Zuschnitt (±2 pro Kanal). `sharpness`: unscharf < scharf.
- Robustheit für echte Fotos, alle Ecken am äußeren Kartenrand auf ≤ 2 px:
  - (a) Nachbarkarte rechts mit Lücke 10 % der Kartenbreite,
  - (b) dunkler Hintergrund 40, schwarzer Rand 15, helle Innenlinie, außen nur 25 Graustufen Kontrast,
  - (c) dunkler Hintergrund 70 mit dichtem Schachbrett-Motiv (4 Zelleneinheiten der Karte),
  - (d) Teppichhintergrund mit Rauschen ±30 bleibt erkennbar.
- Laufzeit: `detectCard` auf 240×330 px braucht im Mittel etwa 5,6 ms je Aufruf (Node 22, 20 Läufe nach einem Warm-up).
  Ziel: unter 15 ms.
- Randprüfung (nicht in der Testdatei, nur Parameterlauf): Nachbarlücke 5 % → 1,00 px, 10 % → 0,81 px, 15 % → 0,70 px. Teppich-Seeds
  1–6 → 0,67 bis 0,93 px. Schachbrett-Verschiebung 0–2 px → 0,59 bis 0,72 px.
- Galerie (`carddetect_test.js`): kleine, gedrehte Karte (etwa 40 % der Bildhöhe, Fläche ca. 8,5 %) auf glattem
  Hintergrund mit `minArea` 0,08. Zuerst das ganze Bild, dann der mittlere Ausschnitt. Ecken ≤ 2 px.
- E2E Galerie: Upload über `setInputFiles` ohne Kamera und mit Kamera (`camera-unknown.y4m`), Erfassung von
  `photo-card.jpg` (Karte 900003). Ohne Kartenrand (`photo-nocard.jpg`) erscheint die Meldung, nichts wird erfasst.
  Eine zugeschnittene Karte (`img/900003.png`) wird als ganze Karte erfasst. `900001` ist nicht geeignet, denn zu
  seiner Illustration gibt es einen Nachdruck (900016). Der Abgleich ist dann mehrdeutig, und die App bietet Vorschläge an. Bei laufender Kamera wird die Karte
  nur einmal erfasst.
- E2E Blitz: Im Fake-Device bleibt der Schalter versteckt. Mit einem Init-Skript, das `getCapabilities` →
  `{ torch: true }` und `applyConstraints` als Spy setzt, erscheint er. Ein Klick ruft `torch: true` auf, der
  nächste `torch: false`. „Scan stoppen“ schaltet aus und versteckt den Schalter.
- Testbilder: `make_sample_art.py` erzeugt `sample-data/photo-card.jpg` (1600×1200, Karte ca. 35 % der Bildhöhe,
  6° gedreht, Holztisch, Nachbarkarte am rechten Rand) und `photo-nocard.jpg` (nur Holz).
- E2E: Der Fake-Kamerastream (`camera.y4m`) zeigt eine Sample-Karte. Sie muss erkannt, als Polygon
  angezeigt und über den Standbild-Pfad erfasst werden. Zusätzlich wird ein y4m mit kleinerer,
  versetzter und leicht gedrehter Karte erzeugt (`make_sample_art.py` erweitern), und auch diese
  muss erkannt und erfasst werden.

## Umsetzungsnotizen

Umgesetzt in `webapp/carddetect.js`, `webapp/app.js`, `webapp/dev/carddetect_test.js` und `webapp/dev/e2e.js`.
Abweichungen und Präzisierungen, jeweils mit Grund:

- **Geradenausgleich**: Die Ausgleichsgerade minimiert die senkrechten Abstände der Inlier (Gesamtkleinstquadrate),
  nicht die y-Abweichung. Sonst wird die Lage von fast senkrechten Seiten instabil.
- **`aspectTol`**: als absolute Abweichung des Verhältnisses Breite/Höhe von `aspect` gelesen (0,08 entspricht etwa
  ±11 % bei 0,716). Die Spezifikation nennt keine Einheit.
- **Schärfe** wird auf dem 400×558-Bild gemessen, nicht auf dem 800×1116-Bild. So passt die Grenze 60 zur Größe, mit
  der auch der Bildabgleich arbeitet.
- **Zustandswechsel**: Der dritte ruhige Treffer löst sofort ein Foto aus. Ist das Foto unscharf, geht es auf
  „steady“ zurück, und das nächste ruhige Bild löst eine neue Aufnahme aus. Verschiebt sich die Karte oder fehlt
  sie, geht es auf „search“. Nach Erfassung, Vorschlägen oder einem Fehlschlag bleibt die Erkennung gesperrt, bis
  die Karte weg ist. Sonst würde eine nicht erkannte Karte im 150-ms-Takt immer wieder ausgewertet.
- **Weitere Standbilder** (bis zu zwei) entstehen aus einer frischen Erkennung auf dem aktuellen Videobild. Liegt die
  Karte nicht mehr ruhig (mehr als 2 % Verschiebung), wird das Standbild nicht genommen. Die Kandidaten für das
  Zusammenführen stammen aus dem ersten Standbild.
- **Testpfad** (`window.__wow.frame`, `testImage`): Die 2-Frame-Regel entfällt auch hier. Eine eindeutige Karte wird
  sofort erfasst. Solange dieselbe Karte liegt, wird nichts erneut erfasst. Eine andere Karte gibt die Sperre frei und
  wird sofort erfasst. Zwei Auswertungen ohne Karte geben die Sperre ebenfalls frei.
- **Auslöser „Foto auswerten“** hebt zuerst die Sperre auf. Sonst ließe sich dieselbe Karte nicht erneut auswerten.
- **Testdaten**: Der Hintergrund von `camera.y4m` ist von (25,25,25) auf (118,112,104) geändert. Auf dem alten
  Hintergrund ist der dunkle Kartenrand kaum vom Hintergrund zu unterscheiden (Kontrast etwa 5), die Erkennung
  kann ihn dort nicht finden. `camera-offset.y4m` ist neu (kleiner, versetzt, 4° gedreht, Wellenmuster),
  `camera-unknown.y4m` zeigt eine Karte ohne Datenbankeintrag (kein Treffer, Standbilder werden zusammengeführt).
- **Synthetische Testkarte**: Die Illustration der Testkarte ist weich gezeichnet. Mit einem 4-Pixel-Schachbrett
  dominierte das Kunstfeld die Schwelle, und der Fall „dunkler Hintergrund“ fand den inneren statt des äußeren
  Randes. Der neue Fall (c) mit Schachbrett prüft genau das. Mit der Schwelle nach Spezifikation (80. Perzentil) lag
  T bei 220, der äußere Rand nur bei etwa 121. Deshalb nimmt die Außenrand-Verfeinerung (Schritt 5) ihre Kandidaten
  aus der niedrigeren Schwelle (50. Perzentil). Das ist eine Abweichung von Schritt 2 (siehe unten).
- **Mindestanteil Inlier** (neu, Schritt 4): Eine Kombination braucht Inlier auf mindestens 50 % der Scanlinien
  (Score ≥ 0,5). Rauschbilder (12 Seeds, 240×320) erreichen mit den übrigen Regeln sonst gültige Vierecke mit Score
  0,27 bis 0,34. Der Abstand zu den Testszenen (dort ab etwa 0,6) ist nicht groß. Die Scanlinien laufen über den
  ganzen Suchbereich. Füllt die Karte nur einen Teil davon, sinkt der Score. Das Testbild `camera-offset.y4m` hat im
  App-Ausschnitt 0,68 und im ganzen Bild nur 0,54. Ein kleinerer Schwellwert wäre nötig, falls kleine Karten im
  Suchbereich fehlen.
- **Sequentielles RANSAC** (Schritt 3): Bis zu vier Kandidaten je Seite statt einer besten Geraden. So können ein
  Nachbarkartenrand oder ein innerer Rand eine Seite nicht mehr allein festlegen. Die Auswahl entscheidet die
  Kombinationsbewertung.
- **Halbe Unterstützung für Verfeinerung** (neu, Schritt 5): Mit der niedrigeren Schwelle entstehen auf dem Teppich
  und auf Kunst Zufallslinien mit 10 bis 11 Inliern, die dann bis 14 px nach außen springen. Auf dem Testbild
  `camera-offset.y4m` wanderte so die rechte Kante um etwa 14 px, und die Erfassung schlug fehl. Der Außenrand-Kandidat
  braucht deshalb mindestens die Hälfte der Inlier der aktuellen Seite. Danach stimmen die Ecken dieses Bildes mit der
  Erkennung ohne Verfeinerung überein.
- **Nachbarkarten**: Mit einer Lücke von 5 bis 15 % (Parameterlauf oben) bleibt der Fehler unter 1,1 px. Der Nachbarrand
  liegt außerhalb der Verfeinerungsreichweite oder hat zu wenig Unterstützung. Lücken unter 5 % sind nicht geprüft.
- **Kalibrier-Regler** „Schärfe-Grenze“ steht im Abschnitt „Erkennungs-Kalibrierung“ (so heißt er in der Oberfläche).

Offen:

- Eine Nachbarkarte mit sehr kleiner Lücke (unter 5 % der Kartenbreite) ist nicht getestet. Die Verfeinerung könnte
  dann den Nachbarrand wählen.
- Die Schwelle nach Spezifikation (80. Perzentil) bleibt für die Hauptsuche. Auf Bildern mit sehr unruhigem Kunstfeld
  kann ein Rand trotzdem fehlen, wenn er nicht im Verfeinerungsschritt liegt. Die Verfeinerung nutzt nur Kandidaten
  innerhalb 7 % der Kartenbreite bzw. -höhe vom inneren Rand.
- Die gzip-Gesamtgröße liegt bei 46,6 KB (46.550 Byte). Das liegt über dem 45-KB-Ziel und über dem 40-KB-Richtwert
  in `tools/embed_web.py`. Der Richtwert ist unverändert, deshalb meldet das Skript eine Warnung. Die Größe ist ein
  Punkt für die nächste Runde.
- Echte Fotos sind nicht getestet. Die Prüfungen laufen mit synthetischen Szenen.
- Galerie: Auf 360 px Breite liegt der Score einer kleinen Karte nahe am Mindestwert. Deshalb gibt es den zweiten
  Durchlauf mit dem mittleren Ausschnitt. Bei per Pixel verrauschtem Teppich (±30 bei 360 px) fand der Detektor die
  kleine Karte nur ungenau (4 bis 7 px) oder gar nicht. Echte Fotos sind dort anders, denn sie werden von 1600 px
  herunterskaliert. Das ist nicht gemessen.
- Blitz: Die Unterstützung auf Android-Chrome ist nicht am Gerät geprüft, nur mit dem Spy. Auf iPhone-Safari fehlt
  die Lampensteuerung nach Kenntnisstand, das ist nicht geprüft.
