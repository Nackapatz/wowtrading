# Kartenrand erkennen und Standbild auswerten

Bisher wird alle 650 ms der feste Overlay-Rahmen ausgeschnitten und ausgewertet. Echte Tests zeigen:
Die Karte liegt selten genau im Rahmen (kleiner, versetzt, leicht gedreht). Dann sitzen Bildausschnitt
und OCR-Felder daneben. Neu: Die App sucht den Kartenrand selbst, wartet bis die Karte ruhig und
scharf ist, entzerrt dieses eine Standbild auf die Karte und wertet nur das aus.

Alles läuft im Handy. Der ESP8266 bleibt unverändert.

## Modul `webapp/carddetect.js`

Wie `arthash.js`: UMD-Muster, im Browser `window.WowCardDetect`, in Node `module.exports`, ohne
Abhängigkeiten, nur reine Funktionen auf Arrays. Wird in `index.html` eingebunden; `tools/embed_web.py` setzt die Datei für die Firmware inline ein.

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

## Anpassungen nach dem Erkennungs-Log (Firmware 0.1.7)

Das Erkennungs-Log (`/api/log`) vom 28.10. zeigte bei echten Scans:
- Die Wartezeit bis zum Foto lag zwischen 1 und 22 s, ohne ein einziges unscharfes Foto. „Ruhig“ heißt deshalb jetzt 2 Treffer in Folge mit höchstens 4 % Bewegung statt 3 Treffern mit 2 %. Die Schärfeprüfung bleibt.
- Das schmale Nummernband traf bei leicht versetztem Rand die Flavor-Zeile. Jetzt wird ein hohes Band (y 0,895–0,99) mehrzeilig gelesen (PSM 6), und das Muster „Wort 123/456“ wird im ganzen Text gesucht.
- Verlesene Set-Wörter wie „DARKARORTALS“: Passt kein Wort mit höchstens 2 Fehlern, entscheiden die Gesamtzahl und unter mehreren Sets mit dieser Gesamtzahl die Buchstabenpaar-Ähnlichkeit. Ein sicheres Wort (höchstens 1 Fehler, mindestens 5 Buchstaben) schlägt eine verlesene Gesamtzahl.
- Quests und Orte haben keine Kostenzahl. Die OCR las dort Grafik als Ziffer, und die richtige Karte bekam −30. Kosten werden bei Helden, Quests und Orten nicht verglichen.
- Die Bilderkennung hatte bei Kamerafotos die richtige Karte vorne, mit Distanz 79–87 und Abstand 13–19 zur nächsten Illustration. Die Grenze 70 verwarf diese Treffer. Der Grenzwert `MATCH_MAX` ist jetzt 90. Gespeicherte Werte aus älteren Versionen werden einmalig ersetzt (`imgV` 2). Zufallstreffer lagen bei d 97/98 mit Abstand 2–4 und bleiben ausgeschlossen.
- Bildpunkte richten sich nach dem Abstand statt nach der absoluten Distanz. Der beste Treffer erhält +30 bei einem Abstand von mindestens 12, sonst +10. Weitere Treffer erhalten max(0, 10 − (d − bestes d)).
- Der Abzug für einen widersprechenden Wert bleibt bei −30. Mit −15 würde eine exakt gelesene falsche Nummer mit einem falschen Wert eine korrigierte Ziffer mit drei passenden Werten nicht mehr sicher schlagen (Test „153 statt 163“).

## Anpassungen nach dem zweiten Log (Firmware 0.1.8)

Mit 0.1.7 wurden die drei Quest-Karten jedes Mal über das Bild erfasst (Wartezeit 0,2 bis 1,1 s). Offen blieben:
- Das hohe Nummernband las bei Verbündeten nur die letzte Flavor-Zeile. Das schmale Band (y 0,925, PSM 7) ist wieder der erste Versuch. Nur wenn darin kein „Wort 123/456“ steht, wird das hohe Band mehrzeilig gelesen (`STRIP_WIDE`).
- Ya'za the Vandal: Das Bild war richtig, aber mit Abstand 9. Echte Treffer lagen in beiden Logs bei einem Abstand von mindestens 9, Zufallstreffer bei höchstens 4. `MATCH_MARGIN` ist jetzt 8.
- Die Kosten-OCR (ein Zeichen im Kreis) las oft falsch, zum Beispiel 7 statt 4 und bei derselben Karte einmal 4, einmal 1, einmal 2. Falsche Kosten kosten −15 statt −30 und sperren einen eindeutigen Bildtreffer nicht mehr. Angriff und Leben bleiben bei −30.
- Doppelte Erfassung derselben Karte im Abstand von 7 s: „entfernt“ gilt erst nach 4 Frames ohne Karte (600 ms) statt 2.
- Ein Kartenbild ohne jeden Bildtreffer (Abstand 1 bis 4 bei allen Versuchen) bleibt auf Nummer und Name angewiesen.

## Anpassungen nach dem dritten Log (Firmware 0.1.10)

- Fehl-Erfassung „Skullflame Shield“ statt „Falana of the Glen“ nur über das Bild bei d 88 und Abstand 8. Ab d > 85 war danach ein Abstand von 12 nötig (in 0.1.11 verschärft, siehe unten). Darunter bleibt 8, das deckt die echten Treffer Retainer's Blade (d 84/8) und Jessup Smythe (d 81/9) ab.
- Die Fehl-Erfassung lernte „Falana aus dem Tal“ → Skullflame Shield. Namen werden nur noch gelernt, wenn Nummer, Name oder ein Bildtreffer mit Abstand ≥ 12 dafür spricht. Wird ein Scan gelöscht, vergisst die App den dabei gelernten Namen, solange keine andere Erfassung derselben Karte mit diesem Namen übrig ist.
- Nummernleisten ohne „/“ („BEIRAVER13514268“, „RBERRAYER135T 263“) gelten als unsicher: nur bei einem Set-Wort mit höchstens 2 Fehlern (bei passender Gesamtzahl 3 Fehler oder Buchstabenpaar-Ähnlichkeit ≥ 0,45) und nur „Nr?“ mit 30 Punkten, ohne Gesamtzahl-Bonus. Allein löst das keine Erfassung aus.
- Bei Falana lag die Hash-Distanz zum eigenen Bild in 10 von 11 Fotos bei 134 bis 155, also schlechter als zufällig (~128). Ursache offen (Spiegelung, falscher Rahmen oder andere Bildversion).

## Anpassungen nach dem vierten Log (Firmware 0.1.11)

- Zweite Fehl-Erfassung nur über das Bild: „Abomination Knuckles“ bei d 85 / Abstand 10 statt „The Ring of Blood: The Final Challenge“. Der nötige Abstand steigt jetzt in Stufen: 8 bis d 80, 12 bis d 85, 15 darüber. Echte Treffer in diesem Bereich (d 81–85 mit Abstand 8–11) werden damit zu Vorschlägen.
- Ein reiner Bildtreffer mit d > 75 liest zur Kontrolle die Nummernleiste. Nennt sie höchstens 3 Sets und ist das Set des Bildtreffers nicht dabei, erfasst das Bild nicht allein („!Set“).
- Eine Schärfe-Grenze für reine Bildtreffer wurde verworfen: Echte Erfassungen hatten Schärfe 140–430, genau wie der Fehltreffer (177).
- „246// 264“: doppelter Schrägstrich und bis zu drei Trennzeichen sind erlaubt.
- Nachdrucke in anderen Sets (z.B. Starter-Deck) sind bei der letzten Erfassung als „Anderer Druck“ wählbar, weil der Bildabgleich oft das Original wählt.
- Einstellungen: Laden wird zweimal wiederholt, ein leeres Feld „Daten-URL“ überschreibt die URL des Scanners nicht mehr.

## Anpassungen nach dem fünften Log (Firmware 0.1.12)

- Eigennamen: Deutsche Karten behalten Namen wie „Rokdar“, „Finkle“ oder „Sha'kar“. Wörter ab 5 Buchstaben aus den englischen Namen, die in höchstens 12 Karten vorkommen, bilden einen Index. Steht ein solches Wort im gelesenen deutschen Namen, gibt das +25 („Tok“). Zeigt der Eigenname auf eine andere Karte als den besten Kandidaten, wird nicht automatisch erfasst (Log: Rokdar gelesen, „Nr Ges“ aus Flavor-Text ergab Warmaul Champion). Eine Erfassung nur über die Nummer liest dafür vorher den Namen.
- Nummer ohne „/“ und Bild zeigen auf dieselbe Karte (Bild-Abstand ≥ 8, kein Widerspruch): zwei unabhängige Hinweise, das erfasst („Nr?+Bild“, z.B. Dr. Boom! mit d 88 / 13 und „RBEFAAVER 250 264“).
- Verlesene Set-Wörter ohne „/“: Sets mit Gesamtzahl ±10 und ähnlichem Wort (Buchstabenpaare ≥ 0,35, bei genau einem Set mit exakt dieser Gesamtzahl ≥ 0,2).

## Anpassungen nach dem sechsten Log (Firmware 0.1.13)

- „RBETRAVER 243 LL“ ergab 2/43 und gab fremden Sets „Nr?“. Die Nummer muss jetzt eine ganze Zahl sein, zusammengeklebte Ziffern („13514268“) werden nach drei Ziffern getrennt, und ohne Gesamtzahl gibt es keine. „Nr?“ zählt 25 und liegt damit unter einem Bildtreffer (30).
- Zwei unabhängige schwache Hinweise auf dieselbe Karte erfassen: unsichere Nummer („Nr?“), Eigenname („Tok“) und der beste Bildtreffer mit Abstand ≥ 5 (Zufall lag bei ≤ 4). Höchstens ein verlesener Wert ist dabei erlaubt, und die Nummernleiste darf kein anderes Set nennen („2×“). Fälle aus dem Log: Scholar Krosiss, Cerrik Blooddawn.
- Werte-OCR: 1 ↔ 7 (Kostenkreis) und 1 ↔ 11 (Lebensschild) gelten weder als Treffer noch als Widerspruch.
- Eigennamen ab 6 Buchstaben werden unscharf verglichen (≤ 2 Fehler, gleicher Anfangsbuchstabe), z.B. „Krasise“ → Krosiss.

## Anpassungen nach dem siebten Log (Firmware 0.1.14)

Mit 0.1.13: alle 9 „2×“-Erfassungen richtig, aber 4 Fehl-Erfassungen über die Nummer und eine Karte (Miner Steelwhiskers) nie erkannt.
- Schrägstrich als „1“ gelesen: „1441/264“ → 144, „144/1264“ → 264. Vierstellige Teile werden gekürzt, eine Nummer über der Gesamtzahl verworfen.
- Steht neben der Nummer Flavor-Text und passt kein Set-Wort, zählt die Nummer nur als „Nr~“ (40) und erfasst nicht allein (Log: „…Brenne… 39/264“ ergab Form of the Serpent).
- Werte-OCR: Lesungen über 12 („52“, „25“) zählen nur mit der letzten Ziffer. Ein falscher Wert kostet −10 statt −15/−30, die Sperre greift erst bei zwei falschen Werten. Folge: Eine exakte Nummer mit einem falschen Wert und eine korrigierte Ziffer mit passenden Werten stehen gleich, das gibt Vorschläge statt einer Erfassung.
- Unscharfe Eigennamen („Tok~“) zählen nur +10, ohne Veto und nicht als Hinweis für „2×“ (Log: „Stahlbart“ → „Stalwart“).
- Ein gelernter deutscher Name, der zu einer anderen Karte gehört, verhindert die automatische Erfassung wie ein Eigenname.
- Offen: Das TCGplayer-Bild von Miner Steelwhiskers (21288) hat zur Karte keine Ähnlichkeit (Hamming 119–141).

## Anpassungen nach dem achten Log (Firmware 0.1.15/0.1.16)

- Unscharfe Eigennamen: Pro gelesenem Wort zählen nur die nächsten Treffer. Ein abgeschnittener Name, dessen Anfang mit höchstens einem Fehler passt, gilt als 1,5 Fehler (Log: „Callst“ ergab Caller statt Calister).
- Firmware: Der HTTPS-Server hält höchstens 3 statt 5 wartende Verbindungen. Im Log fiel der freie Speicher bei mehreren gleichzeitigen Verbindungen auf 5,8 KB und die Seite war etwa 2 Minuten nicht erreichbar.
- 0.1.16: Die Firmware liefert die Seite als eine Datei mit Stylesheet und Skripten inline aus. Bei fünf gleichzeitigen Verbindungen (wie ein Browser sie öffnet) wurden mit 0.1.15 einzelne Dateien abgewiesen.

## Anpassungen nach dem neunten Log (Firmware 0.1.17/0.1.18)

Mit 0.1.16: 43 Erfassungen, eine falsch (Chew Toy statt Retainer Cara).
- Schrägstrich als „7“ gelesen: „2037/264“ ergab 37 statt 203. Endet eine vierstellige Nummer auf 1 oder 7, fällt diese Ziffer weg. Eine andere überzählige Ziffer wird vorne gestrichen, die Nummer zählt dann nur als „Nr~“.
- Eigennamen nach Seltenheit: Ein Wort aus höchstens 2 verschiedenen Namen gibt „Tok“ +25, aus 3–5 Namen +15, sonst +10 (beides als „Tok~“, ohne Veto). Nachdrucke zählen als ein Name. Log: „Kavai der Wanderer“ schlug Rexxar the Wanderer vor.
- Wird ein Eigenname exakt gefunden, entfällt der unscharfe Vergleich (Log: „Wächter Ravella“ → Watcher).
- Nur eine Nummer ohne Gesamtzahl braucht mindestens 2 Ziffern und keinen Buchstaben direkt dahinter (Log: „peTRaver2s“ ergab Nr. 2).
- 0.1.18: Apostrophe gehören zum Eigennamen („Vesh'ral“ → veshral; vorher zwei zu kurze Wörter, deshalb wurde Warlord Goretooth über die Nummer erfasst). Eine einstellige Nummer direkt hinter Buchstaben, die wie Ziffern aussehen (Z, S, O, B), zählt nur als „Nr~“, zusammen mit der gelesenen Variante: „RZEROTHIZS 4/361“ → 4 oder 254 (Log: Graccus statt Grunzer von Orgrimmar).
