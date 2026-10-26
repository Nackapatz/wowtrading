#!/usr/bin/env python3
"""Daily data pipeline for the WoW Trading Card Price Scanner.

Sources:
  * tcgcsv.com  - TCGplayer mirror, category 13 (WoW), prices in USD
  * ECB         - daily euro reference rates (eurofxref-daily.xml)
  * optional: wow_cards.db + SpectralKitten all_cards.json (carddb.py) for
    cards.json version 2 (set + collector number + stats, docs/CARD_ID.md).
    Without them cards.json falls back to version 1 (TCGplayer products only).

Output (default --out site/data, index page in the parent folder):
  cards.json, prices.json, rates.json, meta.json, index.html

The module is split into three layers:
  1. TcgClient / fetch_ecb  - network access only (requests).
  2. Pure transform functions - no I/O, covered by offline tests.
  3. run()                  - orchestration and file writing.
"""
from __future__ import annotations

import argparse
import html
import json
import logging
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional

import requests

import arthash
import carddb

log = logging.getLogger("build_data")

TCG_BASE = "https://tcgcsv.com"
TCG_CATEGORY = 13
LAST_UPDATED_URL = f"{TCG_BASE}/last-updated.txt"
GROUPS_URL = f"{TCG_BASE}/tcgplayer/{TCG_CATEGORY}/groups"
ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
DEFAULT_PAGES_DATA = "https://nackapatz.github.io/wowtrading/data/"

REQUEST_DELAY_S = 0.15
REQUEST_TIMEOUT_S = 30
MIN_GROUP_SUCCESS_RATIO = 0.5
LONG_VALUE_LIMIT = 120

# Normalised extendedData names (lower case, only a-z0-9).
LONG_TEXT_NAMES = {"cardtext", "flavortext", "flavourtext"}
NUMBER_NAMES = {"number"}
RARITY_NAMES = {"rarity"}
CARD_TYPE_NAMES = {"cardtype"}


class PipelineError(Exception):
    """A source returned unusable data."""


class CollectionAborted(PipelineError):
    """Too many groups failed; the run must not publish partial data."""


# ---------------------------------------------------------------------------
# 1. Fetch layer
# ---------------------------------------------------------------------------

def previous_hashes_url() -> str:
    """URL der bisherigen hashes.json auf GitHub Pages (für inkrementelle Bild-Hashes)."""
    base = os.environ.get("PAGES_DATA_URL", "").strip()
    if not base:
        repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
        if "/" in repo:
            owner, name = repo.split("/", 1)
            base = f"https://{owner.lower()}.github.io/{name}/data/"
        else:
            base = DEFAULT_PAGES_DATA
    return base.rstrip("/") + "/hashes.json"


def user_agent_string() -> str:
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip() or "unknown"
    return f"WoWCardPriceScanner/1.0 (+https://github.com/{repo})"


class TcgClient:
    """Minimal client for tcgcsv.com. Pauses after every request."""

    def __init__(
        self,
        user_agent: str,
        session: Any = None,
        delay: float = REQUEST_DELAY_S,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.session = session if session is not None else requests.Session()
        self.headers = {"User-Agent": user_agent}
        self.delay = delay
        self._sleep = sleep

    def _get(self, url: str):
        try:
            resp = self.session.get(url, headers=self.headers, timeout=REQUEST_TIMEOUT_S)
        finally:
            self._sleep(self.delay)
        resp.raise_for_status()
        return resp

    def _results(self, url: str) -> list:
        data = self._get(url).json()
        if not isinstance(data, dict) or not data.get("success"):
            errors = data.get("errors") if isinstance(data, dict) else data
            raise PipelineError(f"{url}: success=false ({errors})")
        results = data.get("results")
        if not isinstance(results, list):
            raise PipelineError(f"{url}: 'results' fehlt oder ist keine Liste")
        return results

    def last_updated(self) -> str:
        return self._get(LAST_UPDATED_URL).text.strip()

    def groups(self) -> list:
        return self._results(GROUPS_URL)

    def products(self, group_id: Any) -> list:
        return self._results(f"{TCG_BASE}/tcgplayer/{TCG_CATEGORY}/{group_id}/products")

    def prices(self, group_id: Any) -> list:
        return self._results(f"{TCG_BASE}/tcgplayer/{TCG_CATEGORY}/{group_id}/prices")

    def ecb_xml(self) -> bytes:
        return self._get(ECB_URL).content


# ---------------------------------------------------------------------------
# 2. Transform functions (pure)
# ---------------------------------------------------------------------------

def _norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def _entry_keys(entry: Mapping) -> set[str]:
    return {_norm(entry.get("name")), _norm(entry.get("displayName"))} - {""}


def _find_entry(extended: Iterable[Mapping], names: set[str]) -> Optional[Mapping]:
    for entry in extended:
        if _entry_keys(entry) & names:
            return entry
    return None


def _entry_value(entry: Optional[Mapping]) -> Any:
    if entry is None:
        return None
    value = entry.get("value")
    return None if value in (None, "") else value


def is_single_card(product: Mapping) -> bool:
    """Single cards carry a Number or Rarity extendedData entry."""
    extended = product.get("extendedData") or []
    return (
        _find_entry(extended, NUMBER_NAMES) is not None
        or _find_entry(extended, RARITY_NAMES) is not None
    )


def is_long_text(entry: Mapping) -> bool:
    if _entry_keys(entry) & LONG_TEXT_NAMES:
        return True
    value = entry.get("value")
    return value is not None and len(str(value)) > LONG_VALUE_LIMIT


MAPPED_NAMES = NUMBER_NAMES | RARITY_NAMES | CARD_TYPE_NAMES


def compact_extra(extended: Iterable[Mapping]) -> dict[str, Any]:
    """extendedData without long text and without Number/Rarity/Card Type
    (those live in num/r/t), keyed by displayName (fallback name)."""
    extra: dict[str, Any] = {}
    for entry in extended:
        if is_long_text(entry) or _entry_keys(entry) & MAPPED_NAMES:
            continue
        value = entry.get("value")
        if value in (None, ""):
            continue
        key = entry.get("displayName") or entry.get("name")
        if not key:
            continue
        extra[str(key)] = value
    return extra


def build_card(product: Mapping, group: Mapping) -> dict[str, Any]:
    extended = product.get("extendedData") or []
    return {
        "p": product["productId"],
        "n": product.get("name"),
        "g": group.get("groupId"),
        "s": group.get("name"),
        "sc": group.get("abbreviation"),
        "num": _entry_value(_find_entry(extended, NUMBER_NAMES)),
        "r": _entry_value(_find_entry(extended, RARITY_NAMES)),
        "t": _entry_value(_find_entry(extended, CARD_TYPE_NAMES)),
        "x": compact_extra(extended),
        "img": product.get("imageUrl"),
        "u": product.get("url"),
    }


def _price(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def aggregate_prices(
    rows: Iterable[Mapping], card_ids: Optional[set[str]] = None
) -> dict[str, dict[str, list]]:
    """Build {productId: {subTypeName: [market, low, mid]}}.

    subTypeName is kept exactly as tcgcsv delivers it; only empty or missing
    values are skipped. Only rows for card_ids (as strings) are kept when
    given. The first row per product and subtype wins.
    """
    result: dict[str, dict[str, list]] = {}
    for row in rows:
        product_id = row.get("productId")
        if product_id is None:
            continue
        key = str(product_id)
        if card_ids is not None and key not in card_ids:
            continue
        subtype = row.get("subTypeName")
        if not subtype:
            continue
        entry = result.setdefault(key, {})
        if subtype in entry:
            continue
        entry[subtype] = [
            _price(row.get("marketPrice")),
            _price(row.get("lowPrice")),
            _price(row.get("midPrice")),
        ]
    return result


def parse_ecb(xml_bytes: bytes) -> tuple[str, dict[str, float]]:
    """Return (date, {currency: units per 1 EUR}) from the ECB daily XML."""
    root = ET.fromstring(xml_bytes)
    date: Optional[str] = None
    eur_rates: dict[str, float] = {}
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] != "Cube":
            continue
        attrs = element.attrib
        if "time" in attrs:
            date = attrs["time"]
        elif "currency" in attrs and "rate" in attrs:
            eur_rates[attrs["currency"].upper()] = float(attrs["rate"])
    if not date or not eur_rates:
        raise PipelineError("EZB-XML ohne Datum oder ohne Kurse")
    return date, eur_rates


def rates_per_usd(date: str, eur_rates: Mapping[str, float]) -> dict[str, Any]:
    """Convert ECB per-EUR rates into units of each currency per 1 USD."""
    if not eur_rates.get("USD"):
        raise PipelineError("EZB-Kurse enthalten keinen USD-Kurs")
    usd_per_eur = eur_rates["USD"]
    rates = {cur: rate / usd_per_eur for cur, rate in eur_rates.items()}
    rates["EUR"] = 1 / usd_per_eur
    rates["USD"] = 1.0
    return {
        "date": date,
        "base": "USD",
        "rates": {cur: round(val, 6) for cur, val in sorted(rates.items())},
    }


@dataclass
class Catalog:
    price_date: str
    cards: list[dict]
    prices: dict[str, dict[str, list]]
    ok_groups: int
    total_groups: int
    failed_group_ids: list

    @property
    def failed_groups(self) -> int:
        return self.total_groups - self.ok_groups


def collect_catalog(client: Any) -> Catalog:
    """Fetch all groups; skip failing groups; abort below 50 % success."""
    price_date = client.last_updated()
    groups = client.groups()
    if not groups:
        raise CollectionAborted("tcgcsv lieferte keine Gruppen")

    cards: list[dict] = []
    prices: dict[str, dict[str, list]] = {}
    failed: list = []
    ok = 0
    for group in groups:
        group_id = group.get("groupId")
        try:
            products = client.products(group_id)
            price_rows = client.prices(group_id)
            group_cards = [build_card(p, group) for p in products if is_single_card(p)]
        except Exception as exc:  # one bad group must not stop the run
            log.warning("Gruppe %s übersprungen: %s", group_id, exc)
            failed.append(group_id)
            continue
        card_ids = {str(c["p"]) for c in group_cards}
        prices.update(aggregate_prices(price_rows, card_ids))
        cards.extend(group_cards)
        ok += 1

    if ok * 2 < len(groups):
        raise CollectionAborted(
            f"nur {ok} von {len(groups)} Gruppen erfolgreich (unter 50 %), Abbruch"
        )
    return Catalog(price_date, cards, prices, ok, len(groups), failed)


def load_card_sources(
    db_path: Optional[str],
    sk_path: Optional[str],
    db_commit: str = carddb.CARDDB_COMMIT,
    sk_commit: str = carddb.SK_COMMIT,
) -> Optional[carddb.CardDb]:
    """Kartendatenbank laden; fehlt eine Quelle oder ist sie kaputt -> None (cards.json v1)."""
    missing = [name for name, path in (("--carddb", db_path), ("--skjson", sk_path))
               if not path or not Path(path).is_file()]
    if missing:
        log.warning("Kartendatenbank fehlt (%s): cards.json wird Version 1 (nur TCGplayer)",
                    ", ".join(missing))
        return None
    try:
        db = carddb.load_card_db(db_path, sk_path, db_commit, sk_commit)
    except Exception as exc:
        log.warning("Kartendatenbank unbrauchbar (%s): cards.json wird Version 1", exc)
        return None
    rep = db.report
    log.info("Kartendatenbank: %d DB-Karten, %d mit Werten, %d SK-Serien zugeordnet, nicht zugeordnet: %s",
             rep.db_cards, rep.db_with_stats, len(rep.series), ", ".join(rep.unmatched_series) or "-")
    return db


def cards_document(
    catalog: Catalog, generated_at: str, card_db: Optional[carddb.CardDb]
) -> tuple[dict[str, Any], Optional[dict[str, int]]]:
    """cards.json v2 mit Kartendatenbank, sonst v1. Fehler in v2 fallen auf v1 zurück."""
    if card_db is not None:
        try:
            sets, cards, link = carddb.build_cards_v2(card_db, catalog.cards)
            return {"generatedAt": generated_at, "version": 2, "sets": sets, "cards": cards}, link
        except Exception as exc:
            log.warning("cards.json v2 fehlgeschlagen (%s), Version 1 wird geschrieben", exc)
    return {"generatedAt": generated_at, "version": 1, "cards": catalog.cards}, None


def make_documents(
    catalog: Catalog,
    rates_doc: Mapping[str, Any],
    generated_at: str,
    card_db: Optional[carddb.CardDb] = None,
) -> dict[str, Any]:
    cards_doc, link = cards_document(catalog, generated_at, card_db)
    prices_doc = {
        "generatedAt": generated_at,
        "priceDate": catalog.price_date,
        "prices": catalog.prices,
    }
    meta_doc = {
        "generatedAt": generated_at,
        "priceDate": catalog.price_date,
        "cardCount": len(cards_doc["cards"]),
        "cardsVersion": cards_doc["version"],
        "productCount": len(catalog.cards),
        "groupCount": catalog.ok_groups,
        "failedGroups": catalog.failed_groups,
        "sources": [
            {"name": "TCGplayer-Daten via tcgcsv.com (Kategorie 13, USD)", "url": TCG_BASE},
            {"name": "EZB-Referenzkurse", "url": ECB_URL},
        ],
    }
    if link is not None:
        meta_doc["link"] = link
        meta_doc["sources"].extend(card_db.sources())
    return {
        "cards.json": cards_doc,
        "prices.json": prices_doc,
        "rates.json": dict(rates_doc),
        "meta.json": meta_doc,
    }


def render_index(generated_at: str, price_date: str, card_count: int, card_sources: bool = False) -> str:
    esc = html.escape
    card_source_item = (
        '<li>Set, Sammlernummer und Kartenwerte: abgeleitet aus '
        '<a href="https://github.com/ouchmyothereye/wow_tcg_scanner">wow_tcg_scanner</a> (wow_cards.db) und '
        '<a href="https://github.com/mikechambers/SpectralKitten">SpectralKitten</a> '
        '(nur Name, Set, Nummer und Werte, keine Rohdateien oder Bilder).</li>\n'
        if card_sources else ""
    )
    return f"""<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WoW Trading Card Price Scanner – Daten</title>
<style>
body {{ font-family: system-ui, sans-serif; max-width: 40em; margin: 2em auto; padding: 0 1em; line-height: 1.5; }}
code {{ background: #eee; padding: 0 .2em; }}
</style>
</head>
<body>
<h1>WoW Trading Card Price Scanner – Daten</h1>
<p>Diese Seite stellt die täglich aktualisierten Daten für den Scanner bereit.
Die Dateien werden von einer GitHub Action gebaut.</p>
<ul>
<li>Erstellt (UTC): {esc(generated_at)}</li>
<li>Preisstand: {esc(price_date)}</li>
<li>Karten: {card_count}</li>
</ul>
<p>Dateien: <a href="data/cards.json">cards.json</a>,
<a href="data/prices.json">prices.json</a>,
<a href="data/rates.json">rates.json</a>,
<a href="data/meta.json">meta.json</a>,
<a href="data/hashes.json">hashes.json</a> (Bild-Fingerabdrücke)</p>
<h2>Quellen</h2>
<ul>
<li>Preise: TCGplayer-Marktdaten über <a href="https://tcgcsv.com/">tcgcsv.com</a>
(Kategorie WoW, Preise in US-Dollar, einmal täglich aktualisiert).</li>
<li>Wechselkurse: <a href="https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml">EZB-Referenzkurse</a>.</li>
{card_source_item}</ul>
<p>Hinweis: inoffizielles Projekt, nicht mit Blizzard Entertainment, TCGplayer
oder der EZB verbunden. Preise sind Richtwerte ohne Gewähr.</p>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# 3. Orchestration and output
# ---------------------------------------------------------------------------

def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def write_json(path: Path, obj: Any) -> None:
    _write_atomic(path, json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


def run(
    client: Any,
    out_dir: Path,
    site_dir: Path,
    now: Optional[datetime] = None,
    images: Optional[Callable[[list, str], Mapping[str, Any]]] = None,
    card_db: Optional[carddb.CardDb] = None,
) -> dict[str, Any]:
    generated_at = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")

    ecb_date, eur_rates = parse_ecb(client.ecb_xml())
    rates_doc = rates_per_usd(ecb_date, eur_rates)

    catalog = collect_catalog(client)
    docs = make_documents(catalog, rates_doc, generated_at, card_db)
    card_count = len(docs["cards.json"]["cards"])

    out_dir = Path(out_dir)
    for name, doc in docs.items():
        write_json(out_dir / name, doc)
    _write_atomic(
        Path(site_dir) / "index.html",
        render_index(generated_at, catalog.price_date, card_count,
                     card_sources=docs["cards.json"]["version"] == 2),
    )
    hash_count = None
    if images is not None:
        # Bild-Hashes sind optional: ein Fehler darf den Datenlauf nicht stoppen.
        try:
            hashes_doc = images(catalog.cards, generated_at)
            write_json(out_dir / "hashes.json", hashes_doc)
            hash_count = len(hashes_doc.get("hashes", {}))
        except Exception as exc:
            log.warning("Bild-Hashes übersprungen: %s", exc)
    log.info(
        "Fertig: %d Karten (cards.json v%d), %d/%d Gruppen, %d Preise, USD-Kurse vom %s",
        card_count,
        docs["cards.json"]["version"],
        catalog.ok_groups,
        catalog.total_groups,
        len(catalog.prices),
        ecb_date,
    )
    return {
        "cards": card_count,
        "cards_version": docs["cards.json"]["version"],
        "link": docs["meta.json"].get("link"),
        "groups_ok": catalog.ok_groups,
        "groups_total": catalog.total_groups,
        "prices": len(catalog.prices),
        "hashes": hash_count,
    }


def make_image_hasher(user_agent: str, max_new: int) -> Callable[[list, str], dict]:
    """Bild-Hashes inkrementell: vorige hashes.json wiederverwenden, nur fehlende Produkte laden.
    Scheitert die Berechnung als Ganzes, wird die vorige Datei (falls vorhanden) weitergegeben."""
    def images(cards: list, generated_at: str) -> dict:
        session = requests.Session()
        previous = arthash.load_previous(session, previous_hashes_url(), user_agent)
        try:
            doc, stats = arthash.build_hashes_doc(
                cards, previous, arthash.ImageGetter(session, user_agent), generated_at, max_new=max_new
            )
        except Exception as exc:
            reused = arthash.previous_hashes(previous)
            if not reused:
                raise
            log.warning("Bild-Hashes fehlgeschlagen (%s), vorige Datei wird übernommen", exc)
            return {"generatedAt": previous.get("generatedAt"), "algo": arthash.ALGO,
                    "region": list(arthash.REGION), "hashes": reused}
        log.info("Bild-Hashes: %(total)d gesamt, %(reused)d übernommen, %(fetched)d geladen, "
                 "%(failed)d ohne Bild, %(skipped)d auf nächsten Lauf verschoben", stats)
        return doc
    return images


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default="site/data", help="Ausgabeordner für die JSON-Dateien")
    parser.add_argument(
        "--site-dir",
        default=None,
        help="Ordner für index.html (Standard: Elternordner von --out)",
    )
    parser.add_argument("--no-images", action="store_true", help="keine Bild-Hashes (hashes.json) berechnen")
    parser.add_argument("--max-images", type=int, default=arthash.MAX_NEW_IMAGES,
                        help="max. neu abgerufene Bilder pro Lauf")
    parser.add_argument("--carddb", default=None, help="Pfad zu wow_cards.db (für cards.json v2)")
    parser.add_argument("--skjson", default=None, help="Pfad zu SpectralKitten all_cards.json (für cards.json v2)")
    parser.add_argument("--carddb-commit", default=carddb.CARDDB_COMMIT, help="Commit von wow_tcg_scanner (für meta.json)")
    parser.add_argument("--skjson-commit", default=carddb.SK_COMMIT, help="Commit von SpectralKitten (für meta.json)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    out_dir = Path(args.out)
    site_dir = Path(args.site_dir) if args.site_dir else out_dir.parent

    client = TcgClient(user_agent=user_agent_string())
    images = None if args.no_images else make_image_hasher(user_agent_string(), args.max_images)
    card_db = load_card_sources(args.carddb, args.skjson, args.carddb_commit, args.skjson_commit)
    try:
        run(client, out_dir=out_dir, site_dir=site_dir, images=images, card_db=card_db)
    except (PipelineError, requests.RequestException) as exc:
        log.error("Datenlauf abgebrochen: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
