#!/usr/bin/env python3
"""Erzeugt kleine Test-Fixtures aus den echten Quelldateien (nur lesend: sqlite3/json).

    python -I make_fixtures.py --db /pfad/wow_cards.db --sk /pfad/all_cards.json

Schreibt wow_cards_small.db und all_cards_small.json neben dieses Skript. Übernommen werden
nur abgeleitete Fakten (Name, Set, Nummer, Seltenheit, Werte), keine Regeltexte und keine Bilder.
"""
import argparse
import json
import sqlite3
from pathlib import Path

HERE = Path(__file__).resolve().parent

# (set_id, card_number) aus wow_cards.db
DB_PICK = {
    48: ["1", "2", "153", "163", "264"],            # Servants of the Betrayer (Roke, Hulok)
    42: ["1", "2", "3", "4", "5", "6", "361"],      # Heroes of Azeroth
    37: ["1", "2", "319"],                          # Through the Dark Portal
    53: ["1", "2", "252"],                          # The Hunt for Illidan
    40: ["147", "148", "220"],                      # War of the Elements (147/148 in SK vertauscht)
    4: ["2", "16"],                                 # Alliance Hunter (2011)
    5: ["3", "11"],                                 # Alliance Hunter (gleicher Set-Name, andere Karten)
    17: ["1"],                                      # Arena Grand Melee Event: Nummer 1 doppelt
    116: ["1 / 2"],                                 # Naxxramas Tokens: Doppelnummer
}
DB_NULL_NUMBER_SETS = {126: 1}                       # Demo Reward: Karten ohne Nummer

# (SK-Serie, card_num)
SK_PICK = {
    "Servant of the Betrayer": [1, 2, 153, 163, 264],
    "Heroes of Azeroth": [1, 2, 3, 4, 5, 6, 361],
    "The Dark Portal": [1, 2, 319],
    "Hunt for Illidan": [1, 2, 252],
    "War of the Elements": [147, 148, 220],
    "Player Crafted Item": [1],                      # keine passende DB-Serie
}
SK_FIELDS = ("card_num", "name", "cost", "attack", "health", "defense")


def make_db(src: Path, dst: Path) -> int:
    con = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    sets = con.execute("SELECT set_id, set_name, set_abbreviation, block_id FROM sets").fetchall()
    rarities = con.execute("SELECT rarity_id, name FROM rarities").fetchall()
    rows = []
    for set_id, numbers in DB_PICK.items():
        for num in numbers:
            rows += con.execute(
                "SELECT card_id, card_name, card_number, artist_id, set_id, rarity_id, year_id "
                "FROM wow_cards WHERE set_id = ? AND card_number = ? ORDER BY card_id",
                (set_id, num)).fetchall()
    for set_id, limit in DB_NULL_NUMBER_SETS.items():
        rows += con.execute(
            "SELECT card_id, card_name, card_number, artist_id, set_id, rarity_id, year_id "
            "FROM wow_cards WHERE set_id = ? AND card_number IS NULL ORDER BY card_id LIMIT ?",
            (set_id, limit)).fetchall()
    con.close()
    used = {r[4] for r in rows}
    if dst.exists():
        dst.unlink()
    out = sqlite3.connect(dst)
    out.executescript(
        "CREATE TABLE rarities (rarity_id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);"
        "CREATE TABLE sets (set_id INT, set_name TEXT, set_abbreviation TEXT, block_id INT);"
        "CREATE TABLE wow_cards (card_id INT, card_name TEXT, card_number TEXT, artist_id INT,"
        " set_id INT, rarity_id INT, year_id INT);")
    out.executemany("INSERT INTO rarities VALUES (?, ?)", rarities)
    out.executemany("INSERT INTO sets VALUES (?, ?, ?, ?)", [s for s in sets if s[0] in used])
    out.executemany("INSERT INTO wow_cards VALUES (?, ?, ?, ?, ?, ?, ?)", sorted(rows))
    out.commit()
    out.execute("VACUUM")
    out.close()
    return len(rows)


def slim(card: dict) -> dict:
    out = {k: card.get(k) for k in SK_FIELDS}
    out["series"] = {"name": card["series"]["name"]}
    for key in ("type", "race", "faction"):
        value = card.get(key)
        out[key] = {"name": value["name"]} if isinstance(value, dict) else None
    out["class_restrictions"] = [{"name": c["name"]} for c in card.get("class_restrictions") or []]
    cc = card.get("card_class")
    out["card_class"] = {"name": cc["name"]} if isinstance(cc, dict) else None
    rarity = card.get("rarity")
    out["rarity"] = {"abbreviation": rarity.get("abbreviation")} if isinstance(rarity, dict) else None
    return out


def make_sk(src: Path, dst: Path) -> int:
    with open(src, encoding="utf-8") as fh:
        cards = json.load(fh)["cards"]
    picked = [slim(c) for c in cards
              if c["card_num"] in SK_PICK.get((c.get("series") or {}).get("name"), [])]
    picked.sort(key=lambda c: (c["series"]["name"], c["card_num"]))
    dst.write_text(json.dumps({"cards": picked}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return len(picked)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, required=True)
    ap.add_argument("--sk", type=Path, required=True)
    args = ap.parse_args()
    print("DB-Karten:", make_db(args.db.resolve(), HERE / "wow_cards_small.db"))
    print("SK-Karten:", make_sk(args.sk.resolve(), HERE / "all_cards_small.json"))


if __name__ == "__main__":
    main()
