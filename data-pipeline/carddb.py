"""Kartendatenbank für cards.json Version 2 (docs/CARD_ID.md).

Quellen (zur Laufzeit an festen Commits geladen, nie eingecheckt):
  * wow_cards.db (ouchmyothereye/wow_tcg_scanner): Name, Set, Sammlernummer, Seltenheit
  * all_cards.json (mikechambers/SpectralKitten): Typ, Kosten, Angriff, Leben, ...

Ablauf:
  1. load_db / load_sk lesen nur die benötigten Felder (sqlite3 read-only, json).
  2. join_db_sk: SK-Serie -> DB-Set per normalisiertem Namen, dann Karte per Nummer.
     Ein Paar zählt nur, wenn die Namen ähnlich sind (Schutz gegen verschobene Nummern).
  3. build_cards_v2: TCGplayer-Produkte per Set + normalisiertem Namen verknüpfen und
     sets[] / cards[] im v2-Format erzeugen.

Alle Funktionen außer den beiden Ladern sind rein und offline testbar.
"""
from __future__ import annotations

import difflib
import json
import logging
import re
import sqlite3
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence, Union

log = logging.getLogger("carddb")

CARDDB_REPO = "https://github.com/ouchmyothereye/wow_tcg_scanner"
CARDDB_COMMIT = "af55311a0c46149645cf6310217ceea90c18dfe2"
SK_REPO = "https://github.com/mikechambers/SpectralKitten"
SK_COMMIT = "76c7ec697a73a1a9462499e463e7575d79a99140"

STOPWORDS = {"the", "of", "for", "on", "and", "a"}
SYNONYMS = {"loot": "treasure"}        # SK "Molten Core Loot" == DB "Molten Core Treasure"
JACCARD_MIN = 0.6
NAME_SIMILARITY_MIN = 0.75             # DB- vs. SK-Name derselben Nummer
SET_MISMATCH_MAX = 0.5                 # mehr Namens-Abweichungen -> Set-Zuordnung verwerfen
MAX_EXAMPLES = 5

Num = Union[int, str, None]


# ---------------------------------------------------------------------------
# Normalisierung
# ---------------------------------------------------------------------------

def _ascii_lower(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    return text.encode("ascii", "ignore").decode("ascii").lower()


def norm_name(value: Any) -> str:
    """Kartenname: Zusätze in Klammern weg, „Lich King, The“ -> „The Lich King“,
    Kleinbuchstaben, nur a-z0-9."""
    text = re.sub(r"\([^)]*\)", "", _ascii_lower(value)).strip()
    text = re.sub(r"^(.*),\s*(the|a|an)$", r"\2 \1", text)
    return re.sub(r"[^a-z0-9]", "", text)


def has_suffix(value: Any) -> bool:
    return bool(re.search(r"\([^)]*\)", str(value or "")))


def set_tokens(value: Any) -> list[str]:
    """Set-Name als Tokens: ohne Füllwörter, Plural-s und Apostrophe, mit Synonymen."""
    text = _ascii_lower(value).replace("'", "")
    tokens = []
    for tok in re.findall(r"[a-z0-9]+", text):
        if tok in STOPWORDS:
            continue
        tok = SYNONYMS.get(tok, tok)
        if len(tok) > 3 and tok.endswith("s") and not tok.endswith("ss"):
            tok = tok[:-1]
        tokens.append(tok)
    return tokens


def set_key(value: Any) -> str:
    return "".join(set_tokens(value))


def names_similar(a: Any, b: Any) -> bool:
    na, nb = norm_name(a), norm_name(b)
    if not na or not nb:
        return False
    return na == nb or difflib.SequenceMatcher(None, na, nb).ratio() >= NAME_SIMILARITY_MIN


def parse_number(raw: Any) -> Num:
    """'163' -> 163; '1 / 2' -> '1/2'; leer -> None."""
    if raw is None:
        return None
    text = re.sub(r"\s+", "", str(raw))
    if not text:
        return None
    return int(text) if text.isdigit() else text


def _number_ints(num: Num) -> list[int]:
    if num is None:
        return []
    if isinstance(num, int):
        return [num]
    return [int(d) for d in re.findall(r"\d+", num)]


# ---------------------------------------------------------------------------
# Datentypen und Lader
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class DbSet:
    id: int
    name: str
    word: Optional[str]
    tot: Optional[int]


@dataclass(frozen=True)
class DbCard:
    card_id: int
    name: str
    num: Num
    set_id: int
    rarity: Optional[str]


@dataclass(frozen=True)
class SkCard:
    series: str
    num: int
    name: str
    t: Optional[str] = None
    cost: Optional[int] = None
    atk: Optional[int] = None
    hp: Optional[int] = None
    df: Optional[int] = None
    fac: Optional[str] = None
    race: Optional[str] = None
    cls: Optional[str] = None
    rarity: Optional[str] = None


def make_sets(rows: Iterable[tuple], cards: Sequence[DbCard]) -> list[DbSet]:
    """rows: (set_id, set_name, set_abbreviation). tot = höchste Sammlernummer im Set."""
    tot: dict[int, int] = {}
    for card in cards:
        for n in _number_ints(card.num):
            tot[card.set_id] = max(tot.get(card.set_id, 0), n)
    return [
        DbSet(int(sid), str(name or ""), (str(word).strip() or None) if word else None, tot.get(int(sid)))
        for sid, name, word in rows
    ]


def load_db(path: Union[str, Path]) -> tuple[list[DbSet], list[DbCard]]:
    uri = Path(path).resolve().as_uri() + "?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    try:
        card_rows = con.execute(
            "SELECT w.card_id, w.card_name, w.card_number, w.set_id, r.name "
            "FROM wow_cards w LEFT JOIN rarities r ON r.rarity_id = w.rarity_id "
            "WHERE w.set_id IS NOT NULL AND w.card_name IS NOT NULL "
            "ORDER BY w.set_id, w.card_id"
        ).fetchall()
        set_rows = con.execute(
            "SELECT set_id, set_name, set_abbreviation FROM sets "
            "WHERE set_id IS NOT NULL ORDER BY set_id"
        ).fetchall()
    finally:
        con.close()
    cards = [
        DbCard(int(cid), str(name).strip(), parse_number(number), int(sid), rarity)
        for cid, name, number, sid, rarity in card_rows
    ]
    return make_sets(set_rows, cards), cards


def _int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _sub(obj: Any, key: str = "name") -> Optional[str]:
    if isinstance(obj, Mapping):
        value = obj.get(key)
        return str(value) if value not in (None, "") else None
    return None


def sk_card(raw: Mapping) -> Optional[SkCard]:
    series = _sub(raw.get("series"))
    num = _int(raw.get("card_num"))
    if not series or num is None:
        return None
    classes = [n for n in (_sub(c) for c in raw.get("class_restrictions") or []) if n]
    cls = "/".join(classes) if classes else _sub(raw.get("card_class"))
    return SkCard(
        series=series,
        num=num,
        name=str(raw.get("name") or ""),
        t=_sub(raw.get("type")),
        cost=_int(raw.get("cost")),
        atk=_int(raw.get("attack")),
        hp=_int(raw.get("health")),
        df=_int(raw.get("defense")),
        fac=_sub(raw.get("faction")),
        race=_sub(raw.get("race")),
        cls=cls,
        rarity=_sub(raw.get("rarity"), "abbreviation"),
    )


def load_sk(path: Union[str, Path]) -> list[SkCard]:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    raw_cards = data.get("cards") if isinstance(data, Mapping) else None
    if not isinstance(raw_cards, list):
        raise ValueError("all_cards.json: 'cards' fehlt oder ist keine Liste")
    return [c for c in (sk_card(r) for r in raw_cards if isinstance(r, Mapping)) if c]


# ---------------------------------------------------------------------------
# Set-Zuordnung
# ---------------------------------------------------------------------------

def _jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def match_sets(name: Any, sets: Sequence[DbSet]) -> list[DbSet]:
    """Beste DB-Sets zu einem fremden Set-Namen: exakt, dann enthält, dann Token-Jaccard ≥ 0,6.
    Gleichstände der besten Stufe werden alle zurückgegeben."""
    key = set_key(name)
    if not key:
        return []
    exact = [s for s in sets if set_key(s.name) == key]
    if exact:
        return exact
    contains = [s for s in sets if (k := set_key(s.name)) and (key in k or k in key)]
    if contains:
        return contains
    tokens = set(set_tokens(name))
    best, out = 0.0, []
    for s in sets:
        j = _jaccard(tokens, set(set_tokens(s.name)))
        if j > best:
            best, out = j, [s]
        elif j == best and j > 0:
            out.append(s)
    return out if best >= JACCARD_MIN else []


def pick_set_by_size(candidates: Sequence[DbSet], size: Optional[int]) -> Optional[DbSet]:
    """Eindeutiges Set wählen; bei Gleichstand das mit passender Kartenzahl."""
    if len(candidates) == 1:
        return candidates[0]
    if not candidates or size is None:
        return None
    with_tot = [s for s in candidates if s.tot is not None]
    exact = [s for s in with_tot if s.tot == size]
    if len(exact) == 1:
        return exact[0]
    if not with_tot:
        return None
    best = min(abs(s.tot - size) for s in with_tot)
    closest = [s for s in with_tot if abs(s.tot - size) == best]
    return closest[0] if len(closest) == 1 else None


# ---------------------------------------------------------------------------
# DB <-> SpectralKitten
# ---------------------------------------------------------------------------

@dataclass
class SeriesReport:
    series: str
    db_set: Optional[str]
    sk_cards: int
    matched: int = 0
    by_name: int = 0          # Nummer weicht ab, aber Name im selben Set eindeutig
    mismatched: int = 0
    missing_in_db: int = 0
    rejected: bool = False
    examples: list = field(default_factory=list)


@dataclass
class JoinReport:
    series: list[SeriesReport]
    unmatched_series: list[str]
    db_cards: int
    db_with_stats: int


def join_db_sk(
    sets: Sequence[DbSet], cards: Sequence[DbCard], sk_cards: Iterable[SkCard]
) -> tuple[dict[int, SkCard], JoinReport]:
    """card_id -> SkCard. Pro SK-Serie ein DB-Set; Karte per Nummer, nur bei ähnlichem Namen.
    Passt der Name zur Nummer nicht, wird die Karte im selben Set per Namen gesucht
    (vertauschte Nummern zwischen den Quellen)."""
    by_series: dict[str, list[SkCard]] = defaultdict(list)
    for sk in sk_cards:
        by_series[sk.series].append(sk)
    by_set_num: dict[tuple[int, int], list[DbCard]] = defaultdict(list)
    by_set_name: dict[tuple[int, str], list[DbCard]] = defaultdict(list)
    for card in cards:
        if isinstance(card.num, int):
            by_set_num[(card.set_id, card.num)].append(card)
        by_set_name[(card.set_id, norm_name(card.name))].append(card)

    stats: dict[int, SkCard] = {}
    reports: list[SeriesReport] = []
    unmatched: list[str] = []
    for series in sorted(by_series):
        sk_list = by_series[series]
        db_set = pick_set_by_size(match_sets(series, sets), max(c.num for c in sk_list))
        if db_set is None:
            unmatched.append(series)
            continue
        rep = SeriesReport(series, db_set.name, len(sk_list))
        pairs: list[tuple[DbCard, SkCard]] = []
        unresolved: list[tuple[SkCard, Optional[DbCard]]] = []
        for sk in sk_list:
            hits = by_set_num.get((db_set.id, sk.num), [])
            if len(hits) == 1 and names_similar(hits[0].name, sk.name):
                rep.matched += 1
                pairs.append((hits[0], sk))
            else:
                unresolved.append((sk, hits[0] if len(hits) == 1 else None))
        paired = {db_card.card_id for db_card, _ in pairs}
        for sk, number_hit in unresolved:
            hits = by_set_name.get((db_set.id, norm_name(sk.name)), [])
            if len(hits) == 1 and hits[0].card_id not in paired:
                rep.by_name += 1
                paired.add(hits[0].card_id)
                pairs.append((hits[0], sk))
            elif number_hit is None:
                rep.missing_in_db += 1
            else:
                rep.mismatched += 1
                if len(rep.examples) < MAX_EXAMPLES:
                    rep.examples.append(f"#{sk.num} DB '{number_hit.name}' / SK '{sk.name}'")
        compared = rep.matched + rep.by_name + rep.mismatched
        if compared == 0 or rep.mismatched > SET_MISMATCH_MAX * compared:
            rep.rejected = True
            log.warning("SK-Serie '%s' -> DB-Set '%s' verworfen (%d von %d Namen abweichend)",
                        series, db_set.name, rep.mismatched, compared)
        else:
            for db_card, sk in pairs:
                stats.setdefault(db_card.card_id, sk)
        reports.append(rep)
    return stats, JoinReport(reports, unmatched, len(cards), len(stats))


@dataclass
class CardDb:
    sets: list[DbSet]
    cards: list[DbCard]
    stats: dict[int, SkCard]
    report: JoinReport
    db_commit: str = CARDDB_COMMIT
    sk_commit: str = SK_COMMIT

    def sources(self) -> list[dict[str, str]]:
        return [
            {"name": "Kartendaten wow_cards.db (ouchmyothereye/wow_tcg_scanner)",
             "url": CARDDB_REPO, "commit": self.db_commit},
            {"name": "Kartenwerte all_cards.json (mikechambers/SpectralKitten)",
             "url": SK_REPO, "commit": self.sk_commit},
        ]


def load_card_db(
    db_path: Union[str, Path],
    sk_path: Union[str, Path],
    db_commit: str = CARDDB_COMMIT,
    sk_commit: str = SK_COMMIT,
) -> CardDb:
    sets, cards = load_db(db_path)
    stats, report = join_db_sk(sets, cards, load_sk(sk_path))
    return CardDb(sets, cards, stats, report, db_commit, sk_commit)


# ---------------------------------------------------------------------------
# cards.json Version 2
# ---------------------------------------------------------------------------

def _num_key(num: Num) -> str:
    return str(num)


def _db_entry(card: DbCard, card_set: DbSet, sk: Optional[SkCard], key: str) -> dict[str, Any]:
    return {
        "k": key,
        "p": None,
        "n": card.name,
        "s": card_set.name,
        "sc": card_set.word,
        "si": card_set.id,
        "num": card.num,
        "tot": card_set.tot,
        "r": card.rarity,
        "t": sk.t if sk else None,
        "cost": sk.cost if sk else None,
        "atk": sk.atk if sk else None,
        "hp": sk.hp if sk else None,
        "def": sk.df if sk else None,
        "fac": sk.fac if sk else None,
        "race": sk.race if sk else None,
        "cls": sk.cls if sk else None,
        "img": None,
        "u": None,
    }


def _tcg_entry(product: Mapping) -> dict[str, Any]:
    return {
        "k": f"p{product['p']}",
        "p": product["p"],
        "n": product.get("n"),
        "s": product.get("s"),
        "sc": product.get("sc"),
        "si": None,
        "num": product.get("num"),
        "tot": None,
        "r": product.get("r"),
        "t": product.get("t"),
        "cost": None, "atk": None, "hp": None, "def": None,
        "fac": None, "race": None, "cls": None,
        "img": product.get("img"),
        "u": product.get("u"),
    }


def _attach_product(entry: dict, product: Mapping) -> None:
    entry["p"] = product["p"]
    entry["img"] = product.get("img")
    entry["u"] = product.get("u")
    if entry["r"] is None:
        entry["r"] = product.get("r")


def _spelling_variant(a: str, b: str) -> bool:
    """Gleicher Name mit höchstens 2 Tippfehlern (normierte Namen ab 8 Zeichen, gleicher Anfang)."""
    if a == b or min(len(a), len(b)) < 8 or abs(len(a) - len(b)) > 2 or a[0] != b[0]:
        return False
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1] <= 2


def build_cards_v2(
    db: CardDb, products: Sequence[Mapping]
) -> tuple[list[dict], list[dict], dict[str, int]]:
    """products: TCGplayer-Einzelkarten wie in cards.json v1 (p, n, g, s, sc, r, t, img, u).
    Liefert (sets, cards, link_stats)."""
    sets_by_id = {s.id: s for s in db.sets}

    # DB-Karten mit eindeutigen Schlüsseln
    entries: dict[int, dict] = {}
    used_keys: set[str] = set()
    for card in db.cards:
        card_set = sets_by_id.get(card.set_id)
        if card_set is None:
            continue
        key = f"{card.set_id}-{_num_key(card.num)}" if card.num is not None else f"{card.set_id}-c{card.card_id}"
        if key in used_keys:
            key = f"{key}-c{card.card_id}"
        used_keys.add(key)
        entries[card.card_id] = _db_entry(card, card_set, db.stats.get(card.card_id), key)

    name_index: dict[tuple[int, str], list[int]] = defaultdict(list)
    for card in db.cards:
        if card.card_id in entries:
            name_index[(card.set_id, norm_name(card.name))].append(card.card_id)

    # TCGplayer-Gruppen -> DB-Sets
    group_sets: dict[Any, list[DbSet]] = {}
    set_groups: dict[int, set] = defaultdict(set)
    for product in products:
        gid = product.get("g")
        if gid in group_sets:
            continue
        group_sets[gid] = match_sets(product.get("s"), db.sets)
        for s in group_sets[gid]:
            set_groups[s.id].add(gid)
        if not group_sets[gid]:
            log.info("TCGplayer-Gruppe %s '%s' ohne DB-Set", gid, product.get("s"))

    # Produkte verknüpfen; Namen ohne Klammerzusatz zuerst (Basisprodukt vor "(LOOT)")
    extra: list[dict] = []
    unnamed: list[Mapping] = []
    linked = ambiguous = 0
    ordered = sorted(products, key=lambda p: (has_suffix(p.get("n")), str(p.get("p"))))
    for product in ordered:
        name = norm_name(product.get("n"))
        hits = [cid for s in group_sets.get(product.get("g"), [])
                for cid in name_index.get((s.id, name), [])]
        if len(hits) == 1:
            linked += 1
            entry = entries[hits[0]]
            if entry["p"] is None:
                _attach_product(entry, product)
            else:  # weiteres Produkt derselben Karte, z.B. "(LOOT)": eigener Eintrag, Produktname
                dup = dict(entry, k=f"p{product['p']}", n=product.get("n") or entry["n"])
                _attach_product(dup, product)
                extra.append(dup)
            continue
        if len(hits) > 1:
            ambiguous += 1
            log.info("Produkt %s '%s' mehrdeutig (%d DB-Karten), unverknüpft",
                     product.get("p"), product.get("n"), len(hits))
            extra.append(_tcg_entry(product))
        else:
            unnamed.append(product)

    # Zweiter Durchgang: Schreibweise weicht ab („Najan Spiritbinder“ in der DB, „Spiritbender“ bei TCGplayer).
    # Nur auf DB-Karten ohne Produkt, nur bei genau einem Kandidaten, und nur wenn kein anderes Produkt dieselbe Karte will.
    names_by_set: dict[int, list[tuple[str, list[int]]]] = defaultdict(list)
    for (sid, n), cids in name_index.items():
        names_by_set[sid].append((n, cids))
    claims: dict[int, list[Mapping]] = defaultdict(list)
    for product in unnamed:
        name = norm_name(product.get("n"))
        cands = {cid for s in group_sets.get(product.get("g"), []) for n, cids in names_by_set[s.id]
                 if _spelling_variant(name, n) for cid in cids if entries[cid]["p"] is None}
        if len(cands) == 1:
            claims[next(iter(cands))].append(product)
    fuzzy_linked = set()
    for cid, prods in claims.items():
        prods = sorted(prods, key=lambda p: (has_suffix(p.get("n")), str(p.get("p"))))
        if sum(not has_suffix(p.get("n")) for p in prods) > 1:
            continue  # zwei verschiedene Produkte für eine Karte: lieber unverknüpft
        entry = entries[cid]
        log.info("Produkt %s '%s' per Schreibweise mit DB-Karte '%s' verknüpft",
                 prods[0].get("p"), prods[0].get("n"), entry["n"])
        _attach_product(entry, prods[0])
        for product in prods[1:]:  # "(LOOT)" usw. wie oben als eigener Eintrag
            dup = dict(entry, k=f"p{product['p']}", n=product.get("n") or entry["n"])
            _attach_product(dup, product)
            extra.append(dup)
        fuzzy_linked.update(p["p"] for p in prods)
    linked += len(fuzzy_linked)
    extra.extend(_tcg_entry(p) for p in unnamed if p["p"] not in fuzzy_linked)

    sets_out = [
        {"id": s.id, "n": s.name, "w": s.word, "tot": s.tot, "g": sorted(set_groups.get(s.id, ()), key=str)}
        for s in db.sets
    ]
    link = {
        "linked": linked,
        "dbCards": len(entries),
        "tcgProducts": len(products),
        "unlinked": len(products) - linked,
        "ambiguous": ambiguous,
        "dbWithStats": sum(1 for cid in entries if cid in db.stats),
    }
    return sets_out, list(entries.values()) + extra, link
