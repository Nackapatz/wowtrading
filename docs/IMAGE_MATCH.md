# Bilderkennung (sprachunabhängig)

TCGplayer liefert für WoW nur englische Namen und keine Sammlernummern. Deutsche Karten
lassen sich deshalb nicht über den Namen finden. Die Illustration ist in allen Sprachen
gleich, also wird die Karte primär über einen Bild-Fingerabdruck der Illustration erkannt.

Beide Seiten (Python-Pipeline und Browser) MÜSSEN exakt denselben Algorithmus nutzen.

## Algorithmus `artHash`

Eingabe: RGB-Bild der **ganzen Karte**, aufrecht, randlos zugeschnitten (Seitenverhältnis ca. 63:88).

1. Illustrationsbereich ausschneiden, relativ zur Kartengröße (W×H):
   `x0 = 0.10·W, x1 = 0.90·W, y0 = 0.14·H, y1 = 0.56·H` (auf ganze Pixel runden: floor für x0/y0, ceil für x1/y1).
2. Graustufen pro Pixel: `g = 0.299·R + 0.587·G + 0.114·B` (Float, 0–255).
3. Auf ein Raster von **17×16** (Breite×Höhe) verkleinern per **Flächenmittel** (Box-Filter):
   Zelle (i, j) mittelt alle Pixel mit `floor(i·w/17) ≤ x < floor((i+1)·w/17)` und
   `floor(j·h/16) ≤ y < floor((j+1)·h/16)`, wobei w, h die Größe des Ausschnitts sind.
   (Bei leerer Zelle die nächste Pixelzeile/-spalte nehmen.)
4. Kontrast normalisieren ist NICHT nötig (dHash vergleicht nur Nachbarn).
5. dHash: für jede Zeile j (0..15) und Spalte i (0..15): Bit = 1, wenn `cell[i+1][j] > cell[i][j]`, sonst 0.
   Bitreihenfolge: Zeile für Zeile, links nach rechts, ergibt 256 Bit.
6. Kodierung: 64 Hex-Zeichen (Kleinbuchstaben), MSB zuerst (erstes Bit = höchstes Bit des ersten Hex-Zeichens).

Zusätzlich ein Farbmerkmal `artColor`: Mittelwert R, G, B über den Ausschnitt, je 0–255 gerundet,
als 6 Hex-Zeichen `rrggbb`.

## Abgleich im Browser

- Kamerabild: Ausschnitt = Kartenrahmen des Overlays (63:88), dann `artHash`/`artColor` wie oben.
- Distanz = Hamming(256 Bit) + 0,25 · (|ΔR|+|ΔG|+|ΔB|)/8 (gerundet).
- Treffer, wenn beste Distanz ≤ `MATCH_MAX` (Start: 90, bis 0.1.6: 70) und Abstand zur zweitbesten **anderen Illustration**
  ≥ `MATCH_MARGIN` (Start: 8, bis 0.1.7: 12). Produkte mit identischem Hash (Nachdrucke) gelten als dieselbe
  Illustration und laufen in die vorhandene Set-Auswahl.
- Stabilität wie bisher: gleiche Illustration in 2 aufeinanderfolgenden Frames.
- Name-OCR (englisch) bleibt als Zusatz: stimmt der OCR-Name mit einem der Top-5-Bildtreffer überein
  (Ähnlichkeit ≥ 0,8), wird dieser genommen, auch wenn die Bildregeln knapp verfehlt sind.
- Schwellwerte in den Einstellungen unter „OCR-Kalibrierung“ als „Bild-Toleranz“ einstellbar; die
  Debug-Ansicht zeigt den Bildausschnitt, beste Distanz und Top-3.

## Daten

`hashes.json`: `{generatedAt, algo: "dhash17x16-v1", region: [0.10,0.14,0.90,0.56], hashes: {"<productId>": ["<64 hex>", "<rrggbb>"]}}`

- Bildquelle: `imageUrl` aus tcgcsv (`https://tcgplayer-cdn.tcgplayer.com/product/<id>_200w.jpg`).
  Für bessere Qualität `_400w.jpg` versuchen, bei Fehler `_200w.jpg`.
- Platzhalterbilder (kein Kartenbild) erkennen: Hashes, die bei mehr als 5 Produkten aus
  verschiedenen Illustrationen/Namen identisch vorkommen, verwerfen; ebenso Bilder mit
  Seitenverhältnis weit weg von 63:88 (|W/H − 0,716| > 0,08).
- Inkrementell: vorhandene `hashes.json` der bisherigen Pages-Seite laden und nur fehlende
  Produkt-IDs neu berechnen (Bilder ändern sich praktisch nie). Höflich: eigener User-Agent,
  100 ms Pause zwischen Bildabrufen, max. 6000 Bilder pro Lauf.
