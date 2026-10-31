# Kartenidentifikation: Set + Nummer, Werte, Bild, Name

Deutsche und englische WoW-Karten haben dasselbe Set und dieselbe Sammlernummer. Die
Nummer ist deshalb der sprachunabhängige Hauptschlüssel. TCGplayer liefert nur englische
Namen, Set und Seltenheit, aber keine Nummern. Zwei öffentliche Datensätze ergänzen das:

| Quelle | Inhalt | Stand |
|---|---|---|
| `ouchmyothereye/wow_tcg_scanner` → `wow_cards.db` (SQLite) | 7.885 Karten, 129 Sets: Name, Set, `card_number` (1..N, lückenlos), Seltenheit, Künstler; `sets.set_abbreviation` = Set-Wort, das auf der Karte gedruckt ist (z.B. „Betrayer“) | Commit af55311a0c46149645cf6310217ceea90c18dfe2 |
| `mikechambers/SpectralKitten` → `src/www/api/all_cards.json` | 4.146 Karten (bis War of the Elements/Twilight): `card_num`, `cost`, `attack`, `health`, `defense`, `type.name`, `race.name`, `faction.name`, `class_restrictions[].name`, `series.name` | Commit 76c7ec697a73a1a9462499e463e7575d79a99140 |

Beide Repos haben keine Lizenzdatei. Die Pipeline lädt sie zur Laufzeit (git clone, fester
Commit) und veröffentlicht nur abgeleitete Fakten (Name, Set, Nummer, Werte), keine Rohdateien
und keine Bilder. Nummerierung geprüft: Servants of the Betrayer 264/264 und Heroes of Azeroth
361/361 stimmen zwischen beiden Quellen überein. Namen aus `wow_cards.db` (weniger Tippfehler),
Werte aus SpectralKitten.

Beispiel: deutsche Karte „Hulok Wegbereiter“, unten „BETRAYER 163/264“ → Servants of the
Betrayer #163 „Hulok Trailblazer“, Verbündeter, Horde, Tauren Druide, Kosten 2 / Angriff 2 / Leben 2.

## Datenformat (`cards.json`, Version 2)

`{generatedAt, version: 2, sets: [...], cards: [...]}`

`sets[]`: `{id, n: setName, w: setWord (set_abbreviation), tot: Anzahl Karten (max card_number), g: [tcgplayer groupIds]}`

`cards[]` (kurze Keys, null wenn unbekannt):
- `k`: eindeutiger Schlüssel `"<setId>-<num>"` oder bei reinen TCGplayer-Produkten ohne DB-Treffer `"p<productId>"`
- `p`: TCGplayer productId oder null (Karte ohne Preis)
- `n`: englischer Name, `s`: Set-Name, `sc`: Set-Kürzel/Set-Wort, `si`: Set-id, `num`: Sammlernummer, `tot`: Gesamtzahl im Set
- `r`: Seltenheit, `t`: Typ (Ally, Hero, Ability, …), `cost`, `atk`, `hp`, `def`, `fac`, `race`, `cls` (Klassen, mit „/“ verbunden)
- `img`, `u`: wie bisher (nur bei TCGplayer-Produkten)

Verknüpfung TCGplayer ↔ DB: normalisierter Name (Kleinbuchstaben, nur a-z0-9, Zusätze in Klammern
wie „(LOOT)“ entfernt) plus Set: TCGplayer-Gruppenname ↔ DB-`set_name` per normalisierter
Ähnlichkeit (exakt, dann enthält, dann Token-Jaccard ≥ 0,6). Bei mehreren Treffern im selben Set
bleibt die Karte unverknüpft und wird geloggt. Die Pipeline schreibt die Quote (verknüpft / DB-Karten /
TCGplayer-Produkte) in `meta.json`.

### Umsetzung (`data-pipeline/carddb.py`) – Präzisierungen

- **Set-Namen normalisiert**: Kleinbuchstaben, Apostrophe weg, Füllwörter (the, of, for, on, and, a)
  weg, Plural-s weg, Synonym „loot“ = „treasure“. So passen die SpectralKitten-Namen „Servant of the
  Betrayer“, „The Dark Portal“, „Hunt for Illidan“, „Molten Core Loot“ zu den DB-Sets. Bei mehreren
  Kandidaten derselben Stufe gewinnt beim DB↔SK-Abgleich das Set, dessen `tot` zur höchsten SK-Nummer
  passt (z.B. „Icecrown Citadel“ → „Assault on Icecrown Citadel Treasure“). Beim TCGplayer-Abgleich zählen
  alle gleichrangigen Sets (z.B. zwei „Alliance Hunter“); ein Name, der dort mehrfach vorkommt, bleibt unverknüpft.
- **DB↔SK pro Karte**: Set + Nummer, aber nur wenn die Namen ähnlich sind (normalisiert gleich oder
  Ähnlichkeit ≥ 0,75; „Lich King, The“ = „The Lich King“). Sonst wird im selben Set per Namen gesucht
  (in War of the Elements sind #147/#148 zwischen den Quellen vertauscht). Weicht mehr als die Hälfte
  der Namen eines Sets ab, wird die Set-Zuordnung verworfen.
- **Werte** wie in SpectralKitten, auch 0 (z.B. Helden: `cost` 0; Verbündete: `def` 0). 0 heißt also
  oft „nicht aufgedruckt“; die App sollte `atk`/`hp` nur bei Verbündeten vergleichen. `cls`: Namen aus
  `class_restrictions` mit „/“ verbunden (neutrale Karten: alle 11), bei Helden `card_class`.
  `r`: Seltenheit aus der DB (Rare, Common, …), sonst von TCGplayer.
- **Schlüssel `k`**: Nummer doppelt im Set → zweite Karte `"<setId>-<num>-c<card_id>"`; Karte ohne Nummer →
  `"<setId>-c<card_id>"`. Doppelnummern wie „1 / 2“ (Token-Vorder-/Rückseite) bleiben Text: `num` „1/2“.
  `tot` = höchste Nummer im Set (auch aus „a / b“); Sets ohne Nummern: `tot` null.
- **Mehrere Produkte zur selben DB-Karte** (z.B. „Hulok Trailblazer“ und „Hulok Trailblazer (LOOT)“): das
  Produkt ohne Klammerzusatz bekommt den DB-Eintrag, jedes weitere einen eigenen Eintrag mit
  `k` = `"p<productId>"`, allen DB-Feldern (Set, Nummer, Werte) und dem Produktnamen als `n`.
- **TCGplayer-Produkte ohne DB-Treffer**: `si`, `num`, `tot`, Werte null; `s`/`sc` von der TCGplayer-Gruppe.
- `prices.json` und `hashes.json` bleiben nach productId geschlüsselt.
- **`meta.json`** zusätzlich: `cardsVersion`, `productCount` (TCGplayer-Einzelkarten),
  `link: {linked, dbCards, tcgProducts, unlinked, ambiguous, dbWithStats}` und beide Quellen mit `commit`.
- **Rückfall**: Fehlt eine Quelle oder ist sie unlesbar, schreibt die Pipeline mit Warnung `cards.json`
  Version 1 (`version: 1`, nur TCGplayer-Produkte wie bisher). Der Deploy schlägt dafür nie fehl.
- **CI** (`data.yml`): beide Repos per `git init` + `git fetch --depth 1 --filter=blob:none origin <sha>`,
  nur die eine Datei wird ausgecheckt; Pfade über `--carddb` / `--skjson`, Commits über
  `--carddb-commit` / `--skjson-commit`.
- Abgleich mit den vollen Dateien (Stand der Commits oben): 4.108 von 7.885 DB-Karten bekommen Werte;
  28 von 32 SK-Serien zugeordnet (offen: Badge of Justice, BlizzCon '07 Promo, Lich King Promo, Player
  Crafted Item = 37 Karten); einzige Abweichung: Onyxia #2 „Coordinated Attack“ (DB) / „Coordinated
  Assault“ (SK), ohne Werte. Ohne TCGplayer-Produkte ist `cards.json` v2 ca. 1,9 MB bzw. 160 KB gzip.

## Erkennung im Handy (kombiniert)

Pro Frame (Bild zuerst, OCR nur so oft wie nötig, max. 1 OCR-Lauf gleichzeitig):

1. **Nummernleiste** (unten, ca. x 0,18–0,70, y 0,955–0,995 der Karte; kalibrierbar): OCR mit Whitelist
   `A-Za-z0-9/ `, Muster `([A-Za-z]{3,})?\s*(\d{1,3})\s*/\s*(\d{2,3})`. Set-Wort unscharf gegen `sets[].w`
   (Levenshtein ≤ 2 nach Normalisierung), Gesamtzahl `tot` als Bestätigung bzw. zur Auflösung, wenn das
   Wort fehlt. Häufige OCR-Verwechslungen bei Ziffern berücksichtigen (5↔6, 1↔7, 0↔8): Kandidaten mit
   einer vertauschten Ziffer bekommen weniger Punkte.
2. **Werte**: Kosten (oben links, Kreis), Angriff (unten links), Leben (unten rechts); OCR je Feld
   einzeln, Whitelist `0123456789`, PSM 10. Regionen kalibrierbar.
3. **Bild**: artHash wie in `IMAGE_MATCH.md` (nur Karten mit `p`, also mit TCGplayer-Bild).
4. **Name**: OCR der Namensleiste mit `deu`, Rohtext wird als `nameDe` gespeichert. Erst gegen die
   lokal gelernten Zuordnungen (deutscher Name → `k`, in localStorage, mit Export/Import als JSON),
   dann gegen englische Namen.

Punkte je Kandidat:

| Signal | Punkte |
|---|---|
| Set + Nummer exakt | 60 |
| Set + Nummer mit Ziffernkorrektur (eine Ziffer 5↔6, 1↔7, 0↔8) | 40 |
| Gesamtzahl passt | +10 |
| je übereinstimmender Wert (Kosten nicht bei Helden; Angriff/Leben nur bei Verbündeten) | +10 |
| je widersprechender Wert | −30 (Kosten −15) |
| Bildtreffer (Distanz d ≤ Toleranz) | bester: +30 bei Abstand ≥ 8, sonst +10; weitere: + max(0, 10 − (d − bestes d)) |
| gelernter deutscher Name | +40 |
| englischer Name ≥ 0,8 | +20 |

Damit korrigieren die Werte eine falsch gelesene Ziffer: „BETRAYER 153/264“ mit 2/2/2 ergibt
Roke (#153, 2/2/1) 60 + 10 + 20 − 30 = 60 und Hulok (#163, 2/2/2) 40 + 10 + 30 = 80 → Hulok.
Gelernter Name + drei passende Werte = 70.

Erfassen bei ≥ 70 Punkten und ≥ 20 Vorsprung vor dem nächsten anderen Kandidaten, in 2 Frames
hintereinander. Zusätzlich (Verhalten aus `IMAGE_MATCH.md`): ein eindeutiger Bildtreffer (d ≤ Toleranz,
Abstand zur nächsten Illustration ≥ 8, nur ein Druck bzw. nur Varianten derselben Karte) erfasst auch
ohne OCR, wenn kein Wert widerspricht und der Kandidat allein vorne liegt. Sonst Vorschläge (Top 3).
Nach jeder bestätigten Erfassung wird `nameDe → k` gelernt.

**Varianten**: Liegen Grundprodukt und Varianten derselben Karte (gleiches Set, gleiche Nummer, gleicher
Name ohne Klammerzusatz, z.B. „Hulok Trailblazer“ / „Hulok Trailblazer (LOOT)“) höchstens 5 Punkte
auseinander vorne, wird das Grundprodukt (ohne Zusatz) gewählt; der Vorsprung zählt gegen den nächsten
Kandidaten, der keine Variante ist. In der Ergebnis-Karte tauscht „Variante ändern“ den Eintrag
(die API kann nur die Menge ändern: löschen und als anderes Produkt neu anlegen).

Der Datensatz enthält Karten ohne TCGplayer-Produkt: die werden erkannt und gespeichert,
der Preis ist dann „kein Preis“.
