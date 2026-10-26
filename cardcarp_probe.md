# Probe report: WoW TCG card datasets (2026-10-26)

Read-only. Nothing pushed, wowtrading repo untouched (this file is untracked).

## A) cardcarp/wow
- `git clone https://github.com/cardcarp/wow` → "Repository not found".
- raw.githubusercontent.com `.../cardcarp/wow/main/data/card/standard/01-azeroth/01-heroes-of-azeroth/185-galway-steamwhistle.yml` → **HTTP 404**
- codeload.github.com `cardcarp/wow/zip/refs/heads/main` → **HTTP 404**
- `cardcarp` exists as a GitHub Organization (id 265784390) but has **0 public repos**. Repo is private/renamed/deleted → items 1-6 not possible.

## B) ouchmyothereye/wow_tcg_scanner
Last commit af55311 (2023-11-21). **No LICENSE file** (repo license API: none). README data sources: tcgplayer, wowcards.info, "WoW TCG Collection Tracker" Google Sheet by Plague_dog32. Uses Google Cloud Vision OCR.

`wow_cards.db` (SQLite, 1.2 MB):

| table | rows | schema |
|---|---|---|
| artists | 590 | artist_id INTEGER PK, name TEXT UNIQUE |
| rarities | 7 | rarity_id, name — Rare, Common, Uncommon, Epic, 400/100/500 Points |
| release_years | 8 | year_id, year (2006-2013) |
| card_variants | 10 | variant_id, description — Oversized, Foil, Extended Art, Alternate Art, Standard, Loot, Extended Art Foil, Alternate Art Foil, Extended Alternate Art, Oversized Extended Art |
| possible_card_variants | 9266 | card_id, variant_id, instance (PK all three) |
| blocks | 24 | block_id, block_name |
| sets | 129 | set_id INT, set_name TEXT, set_abbreviation TEXT, block_id INT |
| wow_cards | 7885 | card_id INT, card_name TEXT, card_number TEXT, artist_id, set_id, rarity_id, year_id |
| collection_inventory | 3792 | card_id, variant_id, instance, scan_date, ignore (author's personal collection) |

Sample rows:
- wow_cards: `(1,'Cunning','1',1,1,1,1)`, `(2,'Money','2',…)`, `(3,'Power','3',…)`, `(4,'Time','4',…)`, `(5,'A Bird in Hand','27',2,2,2,1)`
- sets: `(1,'2011 Showdown: Goblins of Anarchy (Biker)','Biker',1)`, `(2,'Alliance Death Knight','Alliance DK',2)`, `(3,'Alliance Druid',…)`, `(4,'Alliance Hunter','Alliance Hunter',3)`, `(5,'Alliance Hunter','Alliance Hunter',2)`
- possible_card_variants: `(948,1,1)`, `(993,1,1)`, `(1200,1,1)`, `(1272,1,1)`, `(1818,1,1)`

card_number is TEXT; 16 rows non-numeric like `'1 / 2'` (double-sided tokens). 5 duplicate (name,set) pairs.

Main sets (set_id, name, abbr, block, cards, max number):
```
37 Through the Dark Portal   Dark Portal  Azeroth          319/319
39 Fires of Outland          Outland      Azeroth          246/246
42 Heroes of Azeroth         Azeroth      Azeroth          361/361
34 March of the Legion       Legion       Burning Crusade  319/319
48 Servants of the Betrayer  Betrayer     Burning Crusade  264/264
53 The Hunt for Illidan      Illidan      Burning Crusade  252/252
46 Drums of War              Drums        Drums of War     268/268
36 Blood of Gladiators       Gladiators   Drums of War     208/208
35 Fields of Honor           Honor        Drums of War     208/208
47 Scourgewar                Scourgewar   Scourgewar       270/270
38 Wrathgate                 Wrathgate    Scourgewar       220/220
44 Icecrown                  Icecrown     Scourgewar       220/220
45 Worldbreaker              Worldbreaker Worldbreaker     270/270
40 War of the Elements       Elements     Worldbreaker     220/220
43 Twilight of the Dragons   Twilight     Worldbreaker     220/220
52 Throne of the Tides       Throne       Aftermath        263/263
50 Crown of the Heavens      Crown        Aftermath        198/198
49 Tomb of the Forgotten     Tomb         Aftermath        202/202
54 War of the Ancients       Ancients     Timewalkers      240/240
41 Betrayal of the Guardian  Betrayal     Timewalkers      202/202
51 Reign of Fire             Reign        Timewalkers      197/197
55 Timewalkers               Timewalkers  Timewalkers       30/30
```
Plus 107 smaller sets: class starters 2010/2011/2013, champion decks (Hogger, Jaina, Sylvanas, Elderlimb, Murkdeep), dungeon decks, raid decks/treasures/tokens (Molten Core, Onyxia, Naxx, BT, Magtheridon, Caverns, ICC, Aspects), badges, crafting, promos. Full list in the probe output.

"Betrayer" #153:
- `(6265,'Roke the Ice Baron','153',artist 299 'Kevin Chin',set 48 'Servants of the Betrayer',Rare,2008)`
- also set 41 'Betrayal of the Guardian' #153: `(6441,'Servant of Terestian','153',…,Common,'Oliver Chipping',2013)`

**German names: none.** No table has a localized column; 0 umlaut/ß hits in any text column. archive3/cards.json (9221 entries: path,num,name,block,set,dbl_sided,token,badge,crafting,treasure) is also English-only.

## C) Other public datasets (GitHub search, unauthenticated)
"wow tcg cards json": 0 hits; "world of warcraft tcg database": 0; "wowtcg": 18; "wow tcg": 27.

| repo | ★ | last push | data |
|---|---|---|---|
| mikechambers/SpectralKitten | 9 | 2012-05-02 | **src/www/api/all_cards.json (9.1 MB, 4146 cards)**. Fields: card_num, name, series{name,block}, type, rarity, cost, attack, health, defense, rules, faction, race, class_restrictions, talents, professions, formats, card_image (e.g. `SoB_153.jpg`), wowtcgdb_id. 32 series, through Twilight of the Dragons / War of the Elements (no Aftermath/Timewalkers). No license file. |
| mikechambers/WoWTCGUtility | 5 | 2010-06-13 | desktop/data/wow_tcg.csv (875 KB, 3186 cards, 27 series up to Wrathgate). Same fields as above in CSV. No license. Only "de" hits are Sparkle framework UI strings. |
| ouchmyothereye/wow_tcg_scanner | 2 | 2023-11-21 | see B; widest set coverage (129 sets, 7885 cards, incl. 2011-2013). Names + numbers + rarity + artist, no stats/rules. |
| DeMol-EE/wowtcg | 0 | 2012-11-29 | Java game + WoWTCGCrawler; no data files in tree |
| zaksuo/WowTcg | 1 | 2011-12-07 | Symfony app, French schema (TcgCarte, TcgEdition…); no data dump seen |
| Digipoulpy/WoW_TCG_Blueprint | 2 | 2025-08-03 | UE4 fan remake, 222 MB; .uasset card textures only |
| edysanchez/wowtcgOcrGetter | 2 | 2013-05-28 | tool to extract OCR text from Cryptozoic PDFs; no data |
| others (retnirp, ofsedgithub, Deepdiigger, ILikeStudyOops, oleksii-demedetskyi, keis/wowcube, jbreaka/wow-tcg-csv (empty), whiteco deckbuilder (empty)) | ≤2 | | no usable set/number data |

SpectralKitten SoB #153 entry: name "Roke the Ice Baron", Ally, Gnome, Alliance, Mage, cost 2, ATK 2, health 1, Rare, rules "Elusive / Frost allies in your party have …", image SoB_153.jpg → consistent with wow_cards.db.

**Conclusion: none of the public datasets found contain German card names.** A DE↔EN mapping would have to come from elsewhere (German Upper Deck printings existed 2006-2010; Cryptozoic stopped localizing). Collector number + set is the stable key across all sources.

## D) Validation: German card "Hulok Wegbereiter" (Tauren Druid ally, cost 2, ATK 2, health 2)

**Match: Servants of the Betrayer #163 "Hulok Trailblazer"**, Common, Horde, Tauren, Druid ally, cost 2 / ATK 2 / health 2, image `SoB_163.jpg`. Both sources agree: wow_cards.db `('Hulok Trailblazer','163','Servants of the Betrayer')`, SpectralKitten `card_num 163`. ("Wegbereiter" = Trailblazer.) The printed number is therefore **163/264**, not 153: OCR/reading misread 6→5. #153 is "Roke the Ice Baron" (Gnome Mage, cost 2 / ATK 2 / health 1, Rare).

Other name hits: "Pathfinder Fansal" (Icecrown #112, both sources). No Wayfinder.

SpectralKitten SoB #150-#170 (number, name, race, class, faction, cost/ATK/health, rarity):
```
150 Quigley Slipshade      Gnome     Rogue    A 1/2/1 C
151 Rames the Purifier     Human     Priest   A 4/4/3 C
152 Razak Ironsides        Gnome     (any)    A 7/4/8 E
153 Roke the Ice Baron     Gnome     Mage     A 2/2/1 R
154 Rysa the Earthcaller   Draenei   Shaman   A 3/1/4 C
155 Sampron the Banisher   Gnome     Warlock  A 2/2/1 R
156 Stella Forgebane       Dwarf     Rogue    A 6/5/3 C
157 Aesadonna Al'mere      Blood Elf Rogue    H 4/5/4 R
158 Alchemist Norrin'thal  Blood Elf Mage     H 3/3/3 C
159 Cerrik Blooddawn       Blood Elf Paladin  H 4/2/4 C
160 David Smythe           Undead    Warrior  H 1/1/2 C
161 Delrach the Vile       Undead    Warlock  H 7/7/6 C
162 Gok Stormhammer        Orc       Shaman   H 6/5/3 R
163 Hulok Trailblazer      Tauren    Druid    H 2/2/2 C   <-- user's card
164 Icemistress Gal'ha     Troll     Mage     H 4/3/5 R
165 Jae'va the Relentless  Blood Elf Paladin  H 7/3/7 C
166 Jessup Smythe          Undead    Rogue    H 3/3/3 C
167 Leoroxx                -         (any)    H 8/7/7 E
168 Lifemistress Tanagra   Orc       Shaman   H 6/5/5 R
169 Lilith Smythe          Undead    Priest   H 2/3/2 C
170 Matalo Trailfinder     Tauren    Hunter   H 1/1/1 U
```
All Tauren Druid cost-2 allies (SK): TDP #199 Bhenn Checks-the-Sky 2/1, TDP #205 Dayna Cousin-to-Sun 1/0, TDP #206 Debros Cousin-to-Moon 0/1, FoO #186 Snig Feralsnout 3/1, **SoB #163 Hulok Trailblazer 2/2**, FoH #129 Elder Narando 2/2, WG #139 Goru Thornmane 1/2 (ATK/health). With ATK 2 / health 2 only two candidates exist: SoB #163 and FoH #129. The set word plus the number settles it.

### Numbering agreement (names normalized to lowercase alphanumerics)
- Servants of the Betrayer: SK 264, DB 264 → **264 match, 0 mismatch**.
- Heroes of Azeroth: SK 361, DB 361 → **348 match, 13 mismatch**. All 13 are the same number with spelling differences, so numbering agrees 361/361. Mismatches (SK vs DB): 35 Beastial/Bestial Wrath, 93 Coup de Grace/Coup de Grâce (DB has broken encoding), 126 Helwin/Helwen, 154 "Lust for Battle"/"Lust for Battle - HoA", 185 Galway Streamwhistle/Steamwhistle, 243 Hur Shieldmasher/Shieldsmasher, 245 Kaal Souldreaper/Soulreaper, 249 Kulan Earthgaurd/Earthguard, 257 Rak Skyfurry/Skyfury, 258 Samuel Gray/Grey, 267 Warcheif/Warchief Thrall, 270 Wazzuli Wilemender/Wildmender, 306 Lei of Lillies/Lilies. SK has more typos; prefer DB names, SK stats.

### Set codes in SpectralKitten
No set-code field. `series` objects only have {id, name, card_count (often 0, unreliable), hasBooster, type{Core|Raid|Promo}, image "", block}. The only code-like data is the `card_image` filename prefix (HoA, TDP, FoO, MoL, SoB, HfI, DoW, BoG, FoH, SGW, WG, IC, ICC, WOE, TD, NAX, MCL, Ony, MLT, BTR, BTT, AGM, BOJ/BoJ, BC7, BCP, DMF, DKS, DWS, FWV, LKP, PCI). Note: Worldbreaker images also use prefix "IC" (bug). The series list has 36 entries (incl. Throne/Crown/Tomb/Battle of the Aspects), but cards exist for only 32 of them. SK series names differ from the official names: "Servant of the Betrayer", "The Dark Portal", "Hunt for Illidan".
The printed set word ("BETRAYER") does match **wow_cards.db `sets.set_abbreviation`** for the main sets: Azeroth, Dark Portal, Outland, Legion, Betrayer, Illidan, Drums, Gladiators, Honor, Scourgewar, Wrathgate, Icecrown, Worldbreaker, Elements, Twilight, Throne, Crown, Tomb, Reign, Ancients, Betrayal. Caveat: "Azeroth" is the abbreviation for Heroes of Azeroth only. I haven't verified that these are the exact printed words for every set.
