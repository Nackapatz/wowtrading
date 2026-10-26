"""Offline-Tests für arthash.py und die Bild-Hashes in build_data.py (keine Netzwerkzugriffe)."""
import io
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from PIL import Image

import arthash
import build_data as bd

FIX = Path(__file__).resolve().parent / "fixtures"


def png_bytes(w, h, fill=None, fn=None):
    img = Image.new("RGB", (w, h), fill or (0, 0, 0))
    if fn:
        img.putdata([fn(x, y) for y in range(h) for x in range(w)])
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def card_png(seed, w=200, h=279):
    """Unterschiedliche, deterministische 'Kartenbilder' je seed."""
    return png_bytes(w, h, fn=lambda x, y: ((x * seed) % 256, (y * (seed + 3)) % 256, (x * y + seed) % 256))


# ---------------------------------------------------------------------------
# Algorithmus
# ---------------------------------------------------------------------------

def test_fixtures_match_expected():
    expected = json.loads((FIX / "expected.json").read_text(encoding="utf-8"))
    assert expected["algo"] == arthash.ALGO
    assert expected["region"] == list(arthash.REGION)
    assert len(expected["images"]) >= 3
    for name, exp in expected["images"].items():
        with Image.open(FIX / name) as im:
            assert im.size == (exp["w"], exp["h"])
            assert arthash.art_hash_image(im) == (exp["hash"], exp["color"]), name


def test_bit_order_gradients():
    w, h = 200, 279
    inc = bytes(v for y in range(h) for x in range(w) for v in (x * 255 // 199,) * 3)
    dec = bytes(v for y in range(h) for x in range(w) for v in ((199 - x) * 255 // 199,) * 3)
    assert arthash.art_hash_rgb(inc, w, h)[0] == "f" * 64
    assert arthash.art_hash_rgb(dec, w, h)[0] == "0" * 64


def test_first_bit_is_msb_of_first_hex_char():
    # Nur die erste Zellgrenze (Zeile 0, Spalten 0→1) steigt: erstes Bit = 0x8 im ersten Hex-Zeichen.
    w, h = 170, 160 * 100 // 42 + 1
    x0, y0, x1, y1 = arthash.region_box(w, h)
    xe = arthash.cell_edges(x1 - x0, 17)
    ye = arthash.cell_edges(y1 - y0, 16)

    def px(x, y):
        rx, ry = x - x0, y - y0
        if 0 <= ry < ye[0][1] and xe[1][0] <= rx < xe[1][1]:
            return (200, 200, 200)
        return (10, 10, 10)
    data = bytes(v for y in range(h) for x in range(w) for v in px(x, y))
    art = arthash.art_hash_rgb(data, w, h)[0]
    assert art[0] == "8"
    assert art[1:] == "0" * 63


def test_rgba_equals_rgb():
    w, h = 60, 84
    rgb = bytes((x * 3 + y) % 256 for y in range(h) for x in range(w) for _ in range(3))
    rgba = bytearray()
    for i in range(0, len(rgb), 3):
        rgba += rgb[i:i + 3] + b"\xff"
    assert arthash.art_hash_rgb(rgb, w, h, 3) == arthash.art_hash_rgb(bytes(rgba), w, h, 4)


def test_region_box_floor_ceil():
    assert arthash.region_box(200, 279) == (20, 39, 180, 157)    # 39,06→39, 156,24→157
    assert arthash.region_box(15, 21) == (1, 2, 14, 12)


def test_empty_cells_take_next_pixel_line():
    edges = arthash.cell_edges(5, 17)
    assert len(edges) == 17
    assert all(b - a == 1 for a, b in edges)
    assert all(0 <= a < 5 for a, _ in edges)
    # Kleines Bild läuft durch und liefert 64 Hex-Zeichen
    data = bytes((x * 40) % 256 for y in range(21) for x in range(15) for _ in range(3))
    art, color = arthash.art_hash_rgb(data, 15, 21)
    assert len(art) == 64 and len(color) == 6


def test_color_rounds_half_up():
    # Bereich 8×5 = 40 Pixel bei 10×10; Hälfte R=0, Hälfte R=1 → Mittel 0,5 → 1 (nicht Bankers-Rundung 0)
    w = h = 10
    x0, y0, x1, y1 = arthash.region_box(w, h)
    assert (x1 - x0) * (y1 - y0) == 40
    def px(x, y):
        inside = x0 <= x < x1 and y0 <= y < y1
        return (1 if inside and (x + y) % 2 else 0, 0, 0)
    data = bytes(v for y in range(h) for x in range(w) for v in px(x, y))
    assert arthash.art_hash_rgb(data, w, h)[1] == "010000"


def test_too_small_raises():
    with pytest.raises(ValueError):
        arthash.art_hash_rgb(b"", 0, 0)
    # 1×1 ist gültig (Bereich floor 0 … ceil 1): degeneriert, aber definiert
    assert len(arthash.art_hash_rgb(b"\x10\x20\x30", 1, 1)[0]) == 64


# ---------------------------------------------------------------------------
# hashes.json
# ---------------------------------------------------------------------------

def test_image_candidates_prefers_400w():
    url = "https://tcgplayer-cdn.tcgplayer.com/product/123_200w.jpg"
    assert arthash.image_candidates(url) == [url.replace("_200w", "_400w"), url]
    assert arthash.image_candidates("https://x/1.jpg") == ["https://x/1.jpg"]
    assert arthash.image_candidates(None) == []


def test_aspect_filter():
    assert arthash.aspect_ok(200, 279)
    assert arthash.aspect_ok(400, 558)
    assert not arthash.aspect_ok(200, 200)
    assert not arthash.aspect_ok(279, 200)


def cards(n, names=None):
    return [{"p": 100 + i, "n": (names or {}).get(i, f"Card {i}"),
             "img": f"https://cdn.example/product/{100 + i}_200w.jpg"} for i in range(n)]


class FakeImages:
    def __init__(self, table):
        self.table = table
        self.calls = []

    def __call__(self, url):
        self.calls.append(url)
        if url not in self.table:
            raise IOError("404 " + url)
        return self.table[url]


def test_build_fetches_400w_then_falls_back_to_200w():
    cs = cards(2)
    imgs = FakeImages({
        "https://cdn.example/product/100_400w.jpg": card_png(5, 400, 558),
        "https://cdn.example/product/101_200w.jpg": card_png(9),        # nur 200w vorhanden
    })
    doc, stats = arthash.build_hashes_doc(cs, None, imgs, "2026-10-26T06:00:00Z")
    assert doc["algo"] == arthash.ALGO and doc["region"] == list(arthash.REGION)
    assert set(doc["hashes"]) == {"100", "101"}
    assert imgs.calls == [
        "https://cdn.example/product/100_400w.jpg",
        "https://cdn.example/product/101_400w.jpg",
        "https://cdn.example/product/101_200w.jpg",
    ]
    assert stats["fetched"] == 2 and stats["failed"] == 0


def test_build_reuses_previous_and_only_fetches_missing():
    cs = cards(3)
    prev = {"algo": arthash.ALGO, "region": list(arthash.REGION),
            "hashes": {"100": ["a" * 64, "112233"], "101": ["b" * 64, "445566"], "999": ["c" * 64, "000000"]}}
    imgs = FakeImages({"https://cdn.example/product/102_400w.jpg": card_png(3, 400, 558)})
    doc, stats = arthash.build_hashes_doc(cs, prev, imgs, "t")
    assert doc["hashes"]["100"] == ["a" * 64, "112233"]
    assert "999" not in doc["hashes"]                 # Produkt gibt es nicht mehr
    assert "102" in doc["hashes"]
    assert imgs.calls == ["https://cdn.example/product/102_400w.jpg"]
    assert stats["reused"] == 2


def test_build_ignores_previous_with_other_algo_or_region():
    cs = cards(1)
    imgs = FakeImages({"https://cdn.example/product/100_400w.jpg": card_png(4, 400, 558)})
    for prev in ({"algo": "old", "region": list(arthash.REGION), "hashes": {"100": ["a" * 64, "000000"]}},
                 {"algo": arthash.ALGO, "region": [0, 0, 1, 1], "hashes": {"100": ["a" * 64, "000000"]}}):
        imgs.calls.clear()
        doc, _ = arthash.build_hashes_doc(cs, prev, imgs, "t")
        assert doc["hashes"]["100"][0] != "a" * 64
        assert len(imgs.calls) == 1


def test_build_rejects_wrong_aspect_and_broken_images():
    cs = cards(2)
    imgs = FakeImages({
        "https://cdn.example/product/100_400w.jpg": png_bytes(300, 300, (90, 90, 90)),   # quadratischer Platzhalter
        "https://cdn.example/product/101_400w.jpg": b"not an image",
        "https://cdn.example/product/101_200w.jpg": b"still not",
    })
    doc, stats = arthash.build_hashes_doc(cs, None, imgs, "t")
    assert doc["hashes"] == {}
    assert stats["failed"] == 2


def test_build_caps_new_images():
    cs = cards(5)
    imgs = FakeImages({f"https://cdn.example/product/{100 + i}_400w.jpg": card_png(i + 1, 400, 558) for i in range(5)})
    doc, stats = arthash.build_hashes_doc(cs, None, imgs, "t", max_new=3)
    assert len(doc["hashes"]) == 3
    assert stats["skipped"] == 2


def test_placeholder_hash_shared_by_many_names_is_dropped():
    cs = cards(8)
    same = png_bytes(200, 279, (120, 120, 120))
    table = {f"https://cdn.example/product/{100 + i}_400w.jpg": same for i in range(6)}
    table["https://cdn.example/product/106_400w.jpg"] = card_png(11, 400, 558)
    table["https://cdn.example/product/107_400w.jpg"] = card_png(12, 400, 558)
    doc, _ = arthash.build_hashes_doc(cs, None, FakeImages(table), "t")
    assert set(doc["hashes"]) == {"106", "107"}


def test_reprints_with_same_name_are_not_placeholders():
    names = {i: "Same Card (LOOT)" if i % 2 else "Same Card" for i in range(7)}
    cs = cards(7, names)
    same = card_png(21, 400, 558)
    table = {f"https://cdn.example/product/{100 + i}_400w.jpg": same for i in range(7)}
    doc, _ = arthash.build_hashes_doc(cs, None, FakeImages(table), "t")
    assert len(doc["hashes"]) == 7


def test_image_getter_sends_user_agent_and_sleeps():
    sleeps, seen = [], []

    class Resp:
        content = b"img"
        def raise_for_status(self):
            pass

    class Session:
        def get(self, url, headers, timeout):
            seen.append((url, headers["User-Agent"]))
            return Resp()

    get = arthash.ImageGetter(Session(), "UA/1", delay=0.1, sleep=sleeps.append)
    assert get("https://x/1.jpg") == b"img"
    assert seen == [("https://x/1.jpg", "UA/1")]
    assert sleeps == [0.1]


def test_load_previous_ignores_errors():
    class Session:
        def get(self, *a, **k):
            raise IOError("offline")
    assert arthash.load_previous(Session(), "https://x/hashes.json", "UA") is None


def test_previous_hashes_url(monkeypatch):
    monkeypatch.delenv("PAGES_DATA_URL", raising=False)
    monkeypatch.setenv("GITHUB_REPOSITORY", "Owner/repo")
    assert bd.previous_hashes_url() == "https://owner.github.io/repo/data/hashes.json"
    monkeypatch.delenv("GITHUB_REPOSITORY")
    assert bd.previous_hashes_url() == "https://nackapatz.github.io/wowtrading/data/hashes.json"
    monkeypatch.setenv("PAGES_DATA_URL", "https://e.x/d")
    assert bd.previous_hashes_url() == "https://e.x/d/hashes.json"


# ---------------------------------------------------------------------------
# Einbindung in run(): Bild-Hashes sind optional
# ---------------------------------------------------------------------------

from test_build_data import CARD_PRODUCT, FakeClient, GROUP, PRICE_ROWS  # noqa: E402


def _client():
    return FakeClient([GROUP], {24: [CARD_PRODUCT]}, {24: PRICE_ROWS})


def test_run_writes_hashes_json(tmp_path):
    out = tmp_path / "site" / "data"

    def images(cards_list, generated_at):
        assert [c["p"] for c in cards_list] == [1001]
        return {"generatedAt": generated_at, "algo": arthash.ALGO, "region": list(arthash.REGION),
                "hashes": {"1001": ["f" * 64, "102030"]}}

    summary = bd.run(_client(), out_dir=out, site_dir=tmp_path / "site",
                     now=datetime(2026, 10, 26, 6, tzinfo=timezone.utc), images=images)
    doc = json.loads((out / "hashes.json").read_text(encoding="utf-8"))
    assert doc["hashes"]["1001"] == ["f" * 64, "102030"]
    assert summary["hashes"] == 1
    assert "data/hashes.json" in (tmp_path / "site" / "index.html").read_text(encoding="utf-8")


def test_run_survives_image_failure(tmp_path):
    out = tmp_path / "site" / "data"

    def images(cards_list, generated_at):
        raise RuntimeError("CDN down")

    summary = bd.run(_client(), out_dir=out, site_dir=tmp_path / "site", images=images)
    assert (out / "cards.json").exists() and (out / "prices.json").exists()
    assert not (out / "hashes.json").exists()
    assert summary["hashes"] is None


def test_image_hasher_falls_back_to_previous_doc(monkeypatch):
    prev = {"generatedAt": "old", "algo": arthash.ALGO, "region": list(arthash.REGION),
            "hashes": {"1": ["a" * 64, "000000"]}}
    monkeypatch.setattr(arthash, "load_previous", lambda *a, **k: prev)

    def boom(*a, **k):
        raise RuntimeError("kaputt")
    monkeypatch.setattr(arthash, "build_hashes_doc", boom)
    doc = bd.make_image_hasher("UA", 10)([{"p": 1, "n": "x", "img": None}], "new")
    assert doc["hashes"] == prev["hashes"]


def test_main_no_images_flag(monkeypatch, tmp_path):
    monkeypatch.setattr(bd, "TcgClient", lambda **kwargs: _client())
    called = []
    monkeypatch.setattr(bd, "make_image_hasher", lambda *a: called.append(a) or (lambda c, g: {}))
    assert bd.main(["--out", str(tmp_path / "site" / "data"), "--no-images"]) == 0
    assert called == []
