"""Bild-Fingerabdruck der Kartenillustration (docs/IMAGE_MATCH.md).

artHash/artColor MUSS bit-identisch zu webapp/arthash.js sein. Darum rechnet diese
Implementierung nur mit ganzen Zahlen:

- Graustufe ×1000 als ganze Zahl: 299·R + 587·G + 114·B (gleiche Ordnung wie 0,299/0,587/0,114).
- Zellenmittel werden nicht dividiert; der dHash-Vergleich `mittel(a) > mittel(b)` erfolgt
  exakt über Kreuzmultiplikation `summe(a)·anzahl(b) > summe(b)·anzahl(a)`.
- Farbmittel wird kaufmännisch gerundet (x,5 → aufrunden), wie Math.round in JS – nicht
  Pythons round() (Banker's Rounding).

Das Ergebnis entspricht der Spezifikation (Gleitkomma-Mittel), ist aber unabhängig von
Summationsreihenfolge und Rundungsfehlern in beiden Sprachen reproduzierbar.

Dazu kommen Abruf und inkrementelle Berechnung von hashes.json für die Daten-Pipeline.
"""

from __future__ import annotations

import io
import logging
import math
import re
import time
from collections import defaultdict
from typing import Any, Callable, Iterable, Mapping, Optional

log = logging.getLogger("arthash")

ALGO = "dhash17x16-v1"
REGION = (0.10, 0.14, 0.90, 0.56)
GRID_W, GRID_H = 17, 16

IMAGE_DELAY_S = 0.1
IMAGE_TIMEOUT_S = 20
MAX_NEW_IMAGES = 6000
CARD_ASPECT = 63 / 88          # ≈ 0,716
ASPECT_TOLERANCE = 0.08
PLACEHOLDER_MIN_NAMES = 5      # gleicher Hash bei mehr als 5 verschiedenen Namen → Platzhalter


# ---------------------------------------------------------------------------
# Algorithmus
# ---------------------------------------------------------------------------

def region_box(w: int, h: int) -> tuple[int, int, int, int]:
    """Illustrationsbereich (x0, y0, x1, y1): floor für x0/y0, ceil für x1/y1, auf das Bild begrenzt."""
    x0 = max(0, min(w, math.floor(REGION[0] * w)))
    y0 = max(0, min(h, math.floor(REGION[1] * h)))
    x1 = max(0, min(w, math.ceil(REGION[2] * w)))
    y1 = max(0, min(h, math.ceil(REGION[3] * h)))
    return x0, y0, x1, y1


def cell_edges(n: int, cells: int) -> list[tuple[int, int]]:
    """Zellgrenzen [a, b) je Zelle; leere Zelle nimmt die nächste Pixelzeile/-spalte."""
    out = []
    for i in range(cells):
        a = i * n // cells
        b = (i + 1) * n // cells
        if b <= a:
            a = min(a, n - 1)
            b = a + 1
        out.append((a, b))
    return out


def art_hash_rgb(data: bytes, w: int, h: int, channels: int = 3) -> tuple[str, str]:
    """artHash (64 Hex) und artColor (rrggbb) aus rohen Pixeldaten (RGB oder RGBA, zeilenweise)."""
    if channels not in (3, 4):
        raise ValueError("channels muss 3 oder 4 sein")
    if len(data) < w * h * channels:
        raise ValueError("Pixeldaten zu kurz")
    x0, y0, x1, y1 = region_box(w, h)
    rw, rh = x1 - x0, y1 - y0
    if rw <= 0 or rh <= 0:
        raise ValueError("Bild zu klein für den Illustrationsbereich")
    xe = cell_edges(rw, GRID_W)
    ye = cell_edges(rh, GRID_H)
    rows_to_cells: list[list[int]] = [[] for _ in range(rh)]
    for j, (a, b) in enumerate(ye):
        for y in range(a, b):
            rows_to_cells[y].append(j)

    sums = [[0] * GRID_W for _ in range(GRID_H)]
    sr = sg = sb = 0
    stride = w * channels
    for y in range(rh):
        start = (y0 + y) * stride + x0 * channels
        row = data[start:start + rw * channels]
        rs = row[0::channels]
        gs = row[1::channels]
        bs = row[2::channels]
        sr += sum(rs)
        sg += sum(gs)
        sb += sum(bs)
        if not rows_to_cells[y]:
            continue
        gray = [299 * r + 587 * g + 114 * b for r, g, b in zip(rs, gs, bs)]
        cols = [sum(gray[a:b]) for a, b in xe]
        for j in rows_to_cells[y]:
            target = sums[j]
            for i in range(GRID_W):
                target[i] += cols[i]

    bits = 0
    for j in range(GRID_H):
        cnt_y = ye[j][1] - ye[j][0]
        for i in range(GRID_W - 1):
            cnt_a = (xe[i][1] - xe[i][0]) * cnt_y
            cnt_b = (xe[i + 1][1] - xe[i + 1][0]) * cnt_y
            bit = 1 if sums[j][i + 1] * cnt_a > sums[j][i] * cnt_b else 0
            bits = (bits << 1) | bit
    n = rw * rh

    def mean(s: int) -> int:
        return min(255, (2 * s + n) // (2 * n))

    color = "%02x%02x%02x" % (mean(sr), mean(sg), mean(sb))
    return format(bits, "064x"), color


def art_hash_image(img: Any) -> tuple[str, str]:
    """artHash/artColor eines Pillow-Bildes (wird nach RGB umgewandelt)."""
    rgb = img.convert("RGB")
    w, h = rgb.size
    return art_hash_rgb(rgb.tobytes(), w, h, 3)


def decode_and_hash(raw: bytes) -> tuple[tuple[int, int], tuple[str, str]]:
    """Bilddatei (JPEG/PNG) dekodieren; liefert ((W, H), (hash, color))."""
    from PIL import Image  # nur hier nötig

    with Image.open(io.BytesIO(raw)) as im:
        im.load()
        return im.size, art_hash_image(im)


# ---------------------------------------------------------------------------
# hashes.json für die Pipeline
# ---------------------------------------------------------------------------

def image_candidates(url: Optional[str]) -> list[str]:
    """_400w zuerst (bessere Qualität), dann das gelieferte _200w-Bild."""
    if not url:
        return []
    if "_200w" in url:
        return [url.replace("_200w", "_400w"), url]
    return [url]


def aspect_ok(w: int, h: int) -> bool:
    return h > 0 and abs(w / h - CARD_ASPECT) <= ASPECT_TOLERANCE


def base_name(name: Any) -> str:
    """Name ohne Zusätze wie "(LOOT)", klein, nur a-z0-9 – zum Erkennen von Platzhalterbildern."""
    text = str(name or "")
    prev = None
    while prev != text:
        prev = text
        text = re.sub(r"\s*\([^()]*\)\s*$", "", text)
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def drop_placeholders(hashes: Mapping[str, list], names: Mapping[str, str]) -> dict[str, list]:
    """Hashes, die bei mehr als 5 verschiedenen Namen vorkommen, sind Platzhalter: verwerfen."""
    by_hash: dict[str, set] = defaultdict(set)
    for pid, entry in hashes.items():
        by_hash[entry[0]].add(base_name(names.get(pid, pid)))
    bad = {h for h, ns in by_hash.items() if len(ns) > PLACEHOLDER_MIN_NAMES}
    if bad:
        log.info("Platzhalterbilder verworfen: %d Hash(es)", len(bad))
    return {pid: list(e) for pid, e in hashes.items() if e[0] not in bad}


def valid_entry(entry: Any) -> bool:
    return (
        isinstance(entry, (list, tuple)) and len(entry) == 2
        and isinstance(entry[0], str) and re.fullmatch(r"[0-9a-f]{64}", entry[0]) is not None
        and isinstance(entry[1], str) and re.fullmatch(r"[0-9a-f]{6}", entry[1]) is not None
    )


def previous_hashes(doc: Any) -> dict[str, list]:
    """Wiederverwendbare Einträge der vorigen hashes.json (nur gleiche Algorithmus-Version und Region)."""
    if not isinstance(doc, dict) or doc.get("algo") != ALGO:
        return {}
    if [round(float(v), 4) for v in (doc.get("region") or [])] != list(REGION):
        return {}
    hashes = doc.get("hashes")
    if not isinstance(hashes, dict):
        return {}
    return {str(k): list(v) for k, v in hashes.items() if valid_entry(v)}


def hash_from_url(url: Optional[str], get: Callable[[str], bytes]) -> Optional[list]:
    """Bild laden (400w, sonst 200w), Seitenverhältnis prüfen, Hash berechnen. None bei Fehler."""
    for candidate in image_candidates(url):
        try:
            raw = get(candidate)
            (w, h), (art, color) = decode_and_hash(raw)
        except Exception as exc:  # Netzwerk- oder Dekodierfehler: nächste Variante
            log.debug("Bild %s: %s", candidate, exc)
            continue
        if not aspect_ok(w, h):
            log.debug("Bild %s: Seitenverhältnis %dx%d passt nicht (Platzhalter?)", candidate, w, h)
            return None
        return [art, color]
    return None


def build_hashes_doc(
    cards: Iterable[Mapping],
    previous: Any,
    get: Callable[[str], bytes],
    generated_at: str,
    max_new: int = MAX_NEW_IMAGES,
) -> tuple[dict[str, Any], dict[str, int]]:
    """hashes.json inkrementell bauen. `get(url)` liefert Bildbytes (und pausiert selbst)."""
    cards = list(cards)
    prev = previous_hashes(previous)
    names = {str(c["p"]): c.get("n") or "" for c in cards}
    out: dict[str, list] = {}
    todo = []
    for card in cards:
        pid = str(card["p"])
        if pid in prev:
            out[pid] = prev[pid]
        elif card.get("img"):
            todo.append(card)
    stats = {"reused": len(out), "fetched": 0, "failed": 0, "skipped": 0}
    for card in todo:
        if stats["fetched"] >= max_new:
            stats["skipped"] += 1
            continue
        stats["fetched"] += 1
        entry = hash_from_url(card.get("img"), get)
        if entry is None:
            stats["failed"] += 1
        else:
            out[str(card["p"])] = entry
    out = drop_placeholders(out, names)
    doc = {"generatedAt": generated_at, "algo": ALGO, "region": list(REGION), "hashes": out}
    stats["total"] = len(out)
    return doc, stats


class ImageGetter:
    """Höflicher Bildabruf: eigener User-Agent, Pause nach jeder Anfrage."""

    def __init__(self, session: Any, user_agent: str, delay: float = IMAGE_DELAY_S,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.session = session
        self.headers = {"User-Agent": user_agent}
        self.delay = delay
        self._sleep = sleep

    def __call__(self, url: str) -> bytes:
        try:
            resp = self.session.get(url, headers=self.headers, timeout=IMAGE_TIMEOUT_S)
        finally:
            self._sleep(self.delay)
        resp.raise_for_status()
        return resp.content


def load_previous(session: Any, url: str, user_agent: str) -> Any:
    """Vorige hashes.json von GitHub Pages laden; jeder Fehler ergibt None."""
    try:
        resp = session.get(url, headers={"User-Agent": user_agent}, timeout=IMAGE_TIMEOUT_S)
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        log.info("Keine vorige hashes.json (%s): %s", url, exc)
        return None
