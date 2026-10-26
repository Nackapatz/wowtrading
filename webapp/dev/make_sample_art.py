#!/usr/bin/env python3
"""Erzeugt ERFUNDENE Sample-Kartenbilder und sample-data/hashes.json für die Web-App-Tests.

- webapp/dev/sample-data/img/<productId>.png (200x279, Pixel aus Formeln, deterministisch)
- webapp/dev/sample-data/hashes.json (artHash/artColor mit data-pipeline/arthash.py)
- webapp/dev/sample-data/camera.y4m (Kamerabild mit Sample-Karte im Overlay-Rahmen, für Chromiums Fake-Kamera)
- webapp/dev/sample-data/camera-offset.y4m (kleinere, versetzte, um 4° gedrehte Sample-Karte auf texturiertem Hintergrund)
- webapp/dev/sample-data/camera-unknown.y4m (Karte, die nicht in der Datenbank steht: kein Treffer, Standbild-Zusammenführung)

Nachdrucke (gleicher Name in anderem Set, "(Foil)"-Variante) bekommen dieselbe Illustration.
Eine Karte (900024) bleibt absichtlich ohne Hash, Karten ohne productId (p = null) haben kein Bild. Aufruf: python3 webapp/dev/make_sample_art.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SAMPLE = HERE / "sample-data"
sys.path.insert(0, str(HERE.parent.parent / "data-pipeline"))
import arthash  # noqa: E402

W, H = 200, 279
SAME_ART = {900016: 900001, 900017: 900009, 900026: 900011, 900032: 900031}   # Nachdrucke → Illustration des Originals
NO_HASH = {900024}
CAMERA_CARD = 900003
CAMERA_OFFSET_CARD = 900005
UNKNOWN_ART = 777777     # Illustration ohne Eintrag in hashes.json und cards.json
BG = (118, 112, 104)     # Tisch hinter der Karte: der dunkle Kartenrand muss sich davon abheben (CARD_DETECT.md)


def lcg(seed: int):
    state = (seed * 2654435761) & 0x7FFFFFFF
    while True:
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        yield state


def card_pixels(art_id: int) -> bytes:
    rnd = lcg(art_id)
    rv = lambda n: next(rnd) % n  # noqa: E731
    bg1 = (rv(200), rv(200), rv(200))
    bg2 = (rv(256), rv(256), rv(256))
    ax, ay, period = 1 + rv(5), rv(4), 30 + rv(50)            # schräg laufende Bänder: variiert horizontal
    shapes = []
    for _ in range(10):
        kind = rv(2)
        cx, cy = 20 + rv(160), int(0.14 * H) + rv(int(0.42 * H))
        size = 12 + rv(40)
        shapes.append((kind, cx, cy, size, (rv(256), rv(256), rv(256))))
    out = bytearray()
    for y in range(H):
        for x in range(W):
            col = (35, 28, 22)                                     # Rahmen
            if 6 <= x < W - 6 and 6 <= y < H - 6:
                col = (196, 178, 140)                              # Kartenfläche
            if 0.06 * H <= y < 0.12 * H and 0.2 * W <= x < 0.85 * W:
                col = (70, 48, 26) if (x // 6 + art_id) % 5 else (230, 210, 160)   # Namensbanner mit "Schrift"
            if y < 0.12 * H and x < 0.16 * W and (x - 16) ** 2 + (y - 16) ** 2 < 140:
                col = (40, 90, 200)                                # Kosten-Symbol
            if y < 0.13 * H and x > 0.86 * W:
                col = (150, 30, 30)                                # Wappen
            if 0.14 * H <= y < 0.56 * H and 0.10 * W <= x < 0.90 * W:
                t = ((x * ax + y * ay) % period) / period
                t = 2 * t if t < 0.5 else 2 - 2 * t
                col = tuple(int(bg1[k] * (1 - t) + bg2[k] * t) for k in range(3))
                for kind, cx, cy, size, c in shapes:
                    if kind == 0 and (x - cx) ** 2 + (y - cy) ** 2 < size * size:
                        col = c
                    elif kind == 1 and abs(x - cx) < size and abs(y - cy) < size // 2:
                        col = c
            if 0.62 * H <= y < 0.92 * H and 0.1 * W <= x < 0.9 * W and (y // 7) % 2 == 0 and x < 0.9 * W - (y * 13 + art_id) % 60:
                col = (60, 50, 40)                                 # Kartentext
            out += bytes(col)
    return bytes(out)


def write_y4m(path: Path, card: Image.Image, fw: int = 360, fh: int = 480) -> None:
    """Einzelbild-Y4M (YUV 4:2:0): Sample-Karte im Bereich, den das Overlay bei 390 px Breite markiert."""
    # Layout der App bei 390x844: Kamerafeld 358x477,33 px (3:4), Rahmen = 74 % der Höhe, 63:88.
    cw, ch = 358.0, 358.0 * 4 / 3
    gh = min(ch * 0.74, cw * 0.9 * 88 / 63)
    gw = gh * 63 / 88
    s = max(cw / fw, ch / fh)
    gx, gy = ((cw - gw) / 2 - (cw - fw * s) / 2) / s, ((ch - gh) / 2 - (ch - fh * s) / 2) / s
    frame = Image.new("RGB", (fw, fh), BG)
    frame.paste(card.convert("RGB").resize((round(gw / s), round(gh / s)), Image.BILINEAR), (round(gx), round(gy)))
    ycc = frame.convert("YCbCr")
    y, cb, cr = ycc.split()
    cb = cb.resize((fw // 2, fh // 2), Image.BILINEAR)
    cr = cr.resize((fw // 2, fh // 2), Image.BILINEAR)
    with open(path, "wb") as f:
        f.write(f"YUV4MPEG2 W{fw} H{fh} F10:1 Ip A1:1 C420jpeg\n".encode())
        f.write(b"FRAME\n" + y.tobytes() + cb.tobytes() + cr.tobytes())   # 1 Bild, Chromium wiederholt die Datei


def textured_background(fw: int, fh: int) -> Image.Image:
    """Tisch mit Wellenmuster und leichtem Rauschen, deterministisch."""
    rnd = lcg(4242)
    out = bytearray()
    for y in range(fh):
        for x in range(fw):
            base = 118 + 14 * math.sin(x / 9.0) * math.cos(y / 13.0) + 10 * math.sin((x + y) / 5.0)
            v = max(0, min(255, int(base + next(rnd) % 9 - 4)))
            out += bytes((v, v - 4, v - 10))
    return Image.frombytes("RGB", (fw, fh), bytes(out))


def write_y4m_offset(path: Path, card: Image.Image, fw: int = 360, fh: int = 480) -> None:
    """Kleinere Karte (202 px statt Overlay 253 px), um 14/10 px aus der Mitte versetzt und 4° gedreht."""
    frame = textured_background(fw, fh)
    c = card.convert("RGBA").resize((202, 283), Image.BILINEAR).rotate(4, resample=Image.BICUBIC, expand=True)
    frame.paste(c, (round(fw / 2 + 14 - c.width / 2), round(fh / 2 - 10 - c.height / 2)), c)
    ycc = frame.convert("YCbCr")
    y, cb, cr = ycc.split()
    cb = cb.resize((fw // 2, fh // 2), Image.BILINEAR)
    cr = cr.resize((fw // 2, fh // 2), Image.BILINEAR)
    with open(path, "wb") as f:
        f.write(f"YUV4MPEG2 W{fw} H{fh} F10:1 Ip A1:1 C420jpeg\n".encode())
        f.write(b"FRAME\n" + y.tobytes() + cb.tobytes() + cr.tobytes())


def wood_photo_background(w: int, h: int, seed: int = 5150) -> Image.Image:
    """Holztisch: waagerechte Bretter mit unterschiedlicher Farbe, Maserung und Rauschen, deterministisch."""
    out = bytearray()
    rnd = lcg(seed)
    plank_h = 150
    cols = {}
    for y in range(h):
        plank = y // plank_h
        if plank not in cols:
            pr = lcg(seed + plank)
            cols[plank] = (120 + next(pr) % 35, 78 + next(pr) % 25, 46 + next(pr) % 20)
        r0, g0, b0 = cols[plank]
        for x in range(w):
            grain = math.sin((x + 60 * math.sin(y / 37.0)) / 9.0 + plank) * 0.5 + 0.5
            k = 0.82 + 0.18 * grain + (next(rnd) % 9 - 4) / 255.0
            out += bytes((max(0, min(255, int(r0 * k))), max(0, min(255, int(g0 * k))), max(0, min(255, int(b0 * k)))))
    return Image.frombytes("RGB", (w, h), bytes(out))


def write_photos(out_dir: Path, card_img: Image.Image, neighbour_img: Image.Image) -> None:
    """Handyfoto-ähnliche Bilder (1600×1200, JPEG) für den Galerie-Test: Karte ca. 35 % der Bildhöhe, 6° gedreht,
    Holztisch, Nachbarkarte am rechten Rand. photo-nocard.jpg zeigt nur die Textur."""
    from PIL import ImageFilter
    W_, H_ = 1600, 1200
    bg = wood_photo_background(W_, H_)
    ch = round(0.35 * H_)                                   # 420 px
    cw = round(ch * 63 / 88)
    nb = neighbour_img.convert("RGBA").resize((cw, ch), Image.BILINEAR).rotate(-4, resample=Image.BICUBIC, expand=True)
    bg.paste(nb, (W_ - cw // 2 - 20, 260), nb)                # angeschnitten am rechten Rand
    c = card_img.convert("RGBA").resize((cw, ch), Image.BILINEAR).rotate(6, resample=Image.BICUBIC, expand=True)
    cx, cy = 680, 610
    shadow = Image.new("RGBA", c.size, (0, 0, 0, 0))
    shadow.putalpha(c.getchannel("A").point(lambda v: v * 6 // 10))
    shadow = shadow.filter(ImageFilter.GaussianBlur(7))
    bg.paste(shadow, (cx - c.width // 2 + 8, cy - c.height // 2 + 10), shadow)
    bg.paste(c, (cx - c.width // 2, cy - c.height // 2), c)
    bg.save(out_dir / "photo-card.jpg", format="JPEG", quality=90)
    wood_photo_background(W_, H_, seed=7777).save(out_dir / "photo-nocard.jpg", format="JPEG", quality=90)


def main() -> int:
    cards = json.loads((SAMPLE / "cards.json").read_text(encoding="utf-8"))["cards"]
    img_dir = SAMPLE / "img"
    img_dir.mkdir(exist_ok=True)
    hashes = {}
    for card in cards:
        pid = card["p"]
        if pid is None or pid in NO_HASH:              # Karte ohne TCGplayer-Produkt: kein Bild
            continue
        path = img_dir / f"{pid}.png"
        Image.frombytes("RGB", (W, H), card_pixels(SAME_ART.get(pid, pid))).save(path, format="PNG", optimize=True)
        with Image.open(path) as im:
            hashes[str(pid)] = list(arthash.art_hash_image(im))
    doc = {"generatedAt": "2026-10-26T06:00:00Z", "sample": True, "algo": arthash.ALGO,
           "region": list(arthash.REGION), "hashes": hashes}
    (SAMPLE / "hashes.json").write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    write_y4m(SAMPLE / "camera.y4m", Image.open(img_dir / f"{CAMERA_CARD}.png"))
    write_y4m_offset(SAMPLE / "camera-offset.y4m", Image.open(img_dir / f"{CAMERA_OFFSET_CARD}.png"))
    write_y4m(SAMPLE / "camera-unknown.y4m", Image.frombytes("RGB", (W, H), card_pixels(UNKNOWN_ART)))
    write_photos(SAMPLE, Image.open(img_dir / f"{CAMERA_CARD}.png"), Image.open(img_dir / "900001.png"))
    print(f"{len(hashes)} Sample-Hashes, Kamera-Testbilder: Produkte {CAMERA_CARD} und {CAMERA_OFFSET_CARD} (versetzt, gedreht)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
