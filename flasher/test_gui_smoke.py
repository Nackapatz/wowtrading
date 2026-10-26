"""Smoke-Tests für die GUI und den Worker (laufen nur mit tkinter und Display, z. B. unter xvfb)."""

import pytest

tk = pytest.importorskip("tkinter")

import flasher  # noqa: E402
from provisioning import ProvisionConfig, SerialPortInfo  # noqa: E402


@pytest.fixture
def root(tmp_path, monkeypatch):
    try:
        window = tk.Tk()
    except tk.TclError:
        pytest.skip("kein Display verfügbar")
    monkeypatch.setenv("APPDATA", str(tmp_path))
    monkeypatch.setattr(flasher, "list_serial_ports", lambda: [
        SerialPortInfo("COM3", "Kommunikationsanschluss", 0x8086),
        SerialPortInfo("COM7", "USB-SERIAL CH340 (COM7)", 0x1A86),
    ])
    yield window
    window.destroy()


def test_gui_builds_and_preselects_ch340(root):
    app = flasher.App(root)
    assert app._current_port() == "COM7"
    assert "CH340" in app.port_hint.cget("text")
    assert app.country_var.get().startswith("DE")
    assert len(app.ota_var.get()) == 12
    app.result.grid_remove()
    root.update_idletasks()


def test_build_config_uses_country_currency(root):
    app = flasher.App(root)
    app.ssid_var.set("Wohnzimmer")
    app.pass_var.set("geheimes-pw")
    app._select_country("CH")
    cfg = app._build_config()
    assert cfg.country == "CH"
    assert cfg.currency == "CHF"
    assert cfg.password == "geheimes-pw"


def test_run_job_settings_mode_reports_done(monkeypatch):
    events = []
    monkeypatch.setattr(flasher, "open_serial", lambda port: _Dummy())
    monkeypatch.setattr(flasher, "provision", lambda ser, cfg, **kw: "192.168.0.9")
    job = flasher.Job("settings", "COM7", ProvisionConfig(ssid="X", password="", ota_password="ota-passwort-1"), None)
    flasher.run_job(job, events.append)
    assert events[-1] == ("done", "192.168.0.9", "ota-passwort-1", False)


def test_run_job_flash_mode_flashes_then_provisions(monkeypatch, tmp_path):
    events = []
    order = []
    fw = tmp_path / "firmware.bin"
    fw.write_bytes(b"\x00")

    def fake_flash(port, path, **kw):
        order.append("flash")
        assert path == str(fw)
        return 460800

    def fake_provision(ser, cfg, **kw):
        order.append("provision")
        assert cfg.cert_pem and cfg.key_pem  # Zertifikat wurde erzeugt und mitgesendet
        return "10.1.2.3"

    monkeypatch.setattr(flasher, "flash_firmware", fake_flash)
    monkeypatch.setattr(flasher, "provision", fake_provision)
    monkeypatch.setattr(flasher, "open_serial", lambda port: _Dummy())
    monkeypatch.setattr(flasher, "SETTLE_AFTER_FLASH_S", 0)
    job = flasher.Job("flash", "COM7", ProvisionConfig(ssid="X", password="", ota_password="ota-passwort-1", hostname="wowscanner"), fw)
    flasher.run_job(job, events.append)
    assert order == ["flash", "provision"]
    assert events[-1] == ("done", "10.1.2.3", "ota-passwort-1", True)


def test_run_job_reports_errors_in_german(monkeypatch):
    from provisioning import ProvisioningError

    events = []
    monkeypatch.setattr(flasher, "open_serial", lambda port: _Dummy())

    def boom(ser, cfg, **kw):
        raise ProvisioningError("Das Gerät meldet sich nicht.")

    monkeypatch.setattr(flasher, "provision", boom)
    job = flasher.Job("settings", "COM7", ProvisionConfig(ssid="X", password="", ota_password="ota-passwort-1"), None)
    flasher.run_job(job, events.append)
    assert events[-1] == ("error", "Das Gerät meldet sich nicht.")


class _Dummy:
    def close(self):
        pass
