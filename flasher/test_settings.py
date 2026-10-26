"""Tests für Einstellungen (ohne Passwörter) und die Suche nach der Firmware."""

import json
from pathlib import Path

from settings import (
    Settings,
    find_firmware,
    firmware_candidates,
    load_settings,
    save_settings,
    settings_path,
)


def test_settings_path_uses_appdata(tmp_path):
    path = settings_path({"APPDATA": str(tmp_path)})
    assert path == tmp_path / "WoWScannerFlasher" / "settings.json"


def test_settings_path_falls_back_to_home_config(tmp_path):
    path = settings_path({"HOME": str(tmp_path)})
    assert path == tmp_path / ".config" / "WoWScannerFlasher" / "settings.json"


def test_roundtrip_and_no_password_stored(tmp_path):
    path = tmp_path / "sub" / "settings.json"
    assert save_settings(path, Settings(port="COM7", ssid="Wohnzimmer", country="AT", hostname="scan1"))
    loaded = load_settings(path)
    assert loaded == Settings(port="COM7", ssid="Wohnzimmer", country="AT", hostname="scan1")
    data = json.loads(path.read_text(encoding="utf-8"))
    assert set(data) == {"port", "ssid", "country", "hostname"}
    assert "pass" not in path.read_text(encoding="utf-8").lower()


def test_missing_or_broken_file_gives_defaults(tmp_path):
    assert load_settings(tmp_path / "gibt-es-nicht.json") == Settings()
    broken = tmp_path / "kaputt.json"
    broken.write_text("{not json", encoding="utf-8")
    assert load_settings(broken) == Settings()
    wrong_type = tmp_path / "liste.json"
    wrong_type.write_text("[1, 2]", encoding="utf-8")
    assert load_settings(wrong_type) == Settings()


def test_unknown_and_invalid_keys_are_ignored(tmp_path):
    path = tmp_path / "s.json"
    path.write_text(json.dumps({"ssid": "X", "pass": "geheim", "country": 5}), encoding="utf-8")
    loaded = load_settings(path)
    assert loaded.ssid == "X"
    assert loaded.country == "DE"
    assert not hasattr(loaded, "pass")


def test_save_failure_returns_false(tmp_path):
    blocker = tmp_path / "datei"
    blocker.write_text("", encoding="utf-8")
    assert save_settings(blocker / "settings.json", Settings()) is False


def test_frozen_firmware_is_taken_from_bundle(tmp_path):
    assert firmware_candidates(True, str(tmp_path), Path("/irgendwo")) == [tmp_path / "firmware.bin"]


def test_source_firmware_candidates(tmp_path):
    base = tmp_path / "flasher"
    candidates = firmware_candidates(False, None, base)
    assert candidates[0] == base / "firmware.bin"
    assert candidates[1] == tmp_path / "firmware" / ".pio" / "build" / "nodemcuv2" / "firmware.bin"


def test_find_firmware_prefers_existing_file(tmp_path):
    base = tmp_path / "flasher"
    base.mkdir()
    assert find_firmware(False, None, base) is None
    build = tmp_path / "firmware" / ".pio" / "build" / "nodemcuv2"
    build.mkdir(parents=True)
    (build / "firmware.bin").write_bytes(b"\x00")
    assert find_firmware(False, None, base) == build / "firmware.bin"
    (base / "firmware.bin").write_bytes(b"\x01")
    assert find_firmware(False, None, base) == base / "firmware.bin"
