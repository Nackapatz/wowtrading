"""Nicht geheime Einstellungen des Flashers und Suche nach der Firmware-Datei.

Passwörter werden nie gespeichert: das Settings-Objekt hat dafür kein Feld.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import List, Mapping, Optional

APP_DIR_NAME = "WoWScannerFlasher"
SETTINGS_FILE_NAME = "settings.json"
FIRMWARE_NAME = "firmware.bin"


@dataclass
class Settings:
    port: str = ""
    ssid: str = ""
    country: str = "DE"
    hostname: str = "wowscanner"


def settings_path(env: Optional[Mapping[str, str]] = None) -> Path:
    """%APPDATA%/WoWScannerFlasher/settings.json; ohne APPDATA (z. B. Linux) ~/.config/...."""
    env = os.environ if env is None else env
    base = env.get("APPDATA") or str(Path(env.get("HOME", str(Path.home()))) / ".config")
    return Path(base) / APP_DIR_NAME / SETTINGS_FILE_NAME


def load_settings(path: Path) -> Settings:
    """Lädt die Einstellungen. Fehlende oder kaputte Datei ergibt die Standardwerte."""
    defaults = Settings()
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return defaults
    if not isinstance(data, dict):
        return defaults
    values = {}
    for key in ("port", "ssid", "country", "hostname"):
        value = data.get(key)
        if isinstance(value, str):
            values[key] = value
    return Settings(**{**asdict(defaults), **values})


def save_settings(path: Path, settings: Settings) -> bool:
    """Speichert die Einstellungen. Liefert False, wenn das Schreiben nicht klappt (kein Absturz)."""
    try:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(settings), ensure_ascii=False, indent=2), encoding="utf-8")
        return True
    except OSError:
        return False


def firmware_candidates(frozen: bool, meipass: Optional[str], base_dir: Path) -> List[Path]:
    """Mögliche Speicherorte der firmware.bin in der Suchreihenfolge.

    Als EXE: im Bundle (sys._MEIPASS). Aus dem Quellcode: flasher/firmware.bin
    oder der PlatformIO-Build unter firmware/.pio/build/nodemcuv2/.
    """
    if frozen:
        return [Path(meipass or base_dir) / FIRMWARE_NAME]
    return [
        Path(base_dir) / FIRMWARE_NAME,
        Path(base_dir).parent / "firmware" / ".pio" / "build" / "nodemcuv2" / FIRMWARE_NAME,
    ]


def find_firmware(frozen: bool, meipass: Optional[str], base_dir: Path) -> Optional[Path]:
    for candidate in firmware_candidates(frozen, meipass, base_dir):
        if candidate.is_file():
            return candidate
    return None
