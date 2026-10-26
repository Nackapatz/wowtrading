#!/usr/bin/env python3
"""Erzeugt gemeinsame Testvektoren für artHash (Python ↔ JavaScript).

Die Bilder werden Pixel für Pixel aus Formeln berechnet (kein Zeichnen mit Pillow), damit
sie unabhängig von der Pillow-Version identisch entstehen. expected.json enthält artHash
und artColor, berechnet mit data-pipeline/arthash.py. webapp/dev/arthash_test.js prüft,
dass webapp/arthash.js für dieselben PNGs exakt dasselbe Ergebnis liefert.

Aufruf: python3 data-pipeline/fixtures/make_fixtures.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import arthash  # noqa: E402


def lcg(seed: int):
    state = seed & 0x7FFFFFFF
    while True:
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        yield state


def gradient(w: int, h: int) -> bytes:
    """Verläufe plus ein heller Kreis in der Illustration."""
    out = bytearray()
    cx, cy, r2 = w * 2 // 5, h * 7 // 20, (w // 6) ** 2
    for y in range(h):
        for x in range(w):
            r = x * 255 // (w - 1)
            g = y * 255 // (h - 1)
            b = (x + 2 * y) % 256
            if (x - cx) ** 2 + (y - cy) ** 2 <= r2:
                r, g, b = 250, 240, 200
            out += bytes((r, g, b))
    return bytes(out)


def shapes(w: int, h: int) -> bytes:
    """Dunkler Rahmen, Namensbanner, Rechtecke und Dreieck im Bildbereich."""
    out = bytearray()
    for y in range(h):
        for x in range(w):
            r, g, b = 40, 30, 25                                   # Rahmen
            if 8 <= x < w - 8 and 8 <= y < h - 8:
                r, g, b = 200, 180, 140                            # Kartenfläche
            if 0.06 * h <= y < 0.12 * h and 0.2 * w <= x < 0.85 * w:
                r, g, b = 90, 60, 30                               # Namensbanner
            if 0.14 * h <= y < 0.56 * h and 0.1 * w <= x < 0.9 * w:
                r, g, b = 30, 70, 120                              # Illustration
                if 0.2 * w <= x < 0.45 * w and 0.2 * h <= y < 0.4 * h:
                    r, g, b = 220, 60, 50
                if 0.55 * w <= x < 0.8 * w and 0.3 * h <= y < 0.5 * h:
                    r, g, b = 60, 200, 90
                if y > 0.45 * h and (x - 0.5 * w) ** 2 < (y - 0.45 * h) * w * 0.3:
                    r, g, b = 240, 220, 90
            out += bytes((r, g, b))
    return bytes(out)


def blocks(w: int, h: int, seed: int) -> bytes:
    """Pseudozufällige 7×7-Blöcke (deterministischer LCG)."""
    rnd = lcg(seed)
    bw, bh = (w + 6) // 7, (h + 6) // 7
    palette = [(next(rnd) % 256, next(rnd) % 256, next(rnd) % 256) for _ in range(bw * bh)]
    out = bytearray()
    for y in range(h):
        for x in range(w):
            out += bytes(palette[(y // 7) * bw + (x // 7)])
    return bytes(out)


FIXTURES = [
    ("fx1_gradient.png", 200, 279, gradient),
    ("fx2_shapes.png", 200, 279, shapes),
    ("fx3_blocks.png", 251, 350, lambda w, h: blocks(w, h, 42)),
    ("fx4_tiny.png", 15, 21, lambda w, h: blocks(w, h, 7)),   # kleiner als das Raster: leere Zellen
]


def main() -> int:
    expected = {"algo": arthash.ALGO, "region": list(arthash.REGION), "images": {}}
    for name, w, h, fn in FIXTURES:
        data = fn(w, h)
        Image.frombytes("RGB", (w, h), data).save(HERE / name, format="PNG", optimize=True)
        # Aus der gespeicherten Datei lesen, genau wie die Tests.
        with Image.open(HERE / name) as im:
            art, color = arthash.art_hash_image(im)
        expected["images"][name] = {"w": w, "h": h, "hash": art, "color": color}
        print(f"{name}: {w}x{h} {art} {color}")
    (HERE / "expected.json").write_text(json.dumps(expected, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
