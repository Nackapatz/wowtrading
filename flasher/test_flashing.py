"""Tests für den esptool-Aufruf: Argumente, Baudraten-Fallback und Ausgabe-Umleitung."""

import sys
import threading

import pytest

from flashing import FlashError, LineAssembler, ThreadRouter, flash_args, flash_firmware


def test_flash_args_are_separate_erase_and_write_calls():
    erase, write = flash_args("COM7", 460800, "fw.bin")
    assert erase == [
        "--chip", "esp8266",
        "--port", "COM7",
        "--baud", "460800",
        "--before", "default_reset",
        "--after", "hard_reset",
        "erase_flash",
    ]
    assert write[-3:] == ["write_flash", "0x0", "fw.bin"]
    assert write[:8] == erase[:8]


def test_success_with_primary_baud_runs_once():
    calls = []
    baud = flash_firmware("COM1", "fw.bin", run=lambda args: calls.append(args))
    assert baud == 460800
    assert len(calls) == 2  # erase_flash, dann write_flash
    assert "erase_flash" in calls[0]
    assert calls[1][-3:] == ["write_flash", "0x0", "fw.bin"]
    assert all("460800" in args for args in calls)


def test_falls_back_to_115200_on_failure():
    calls = []

    def run(args):
        calls.append(args)
        if "460800" in args:
            raise RuntimeError("Timed out waiting for packet header")

    baud = flash_firmware("COM1", "fw.bin", run=run)
    assert baud == 115200
    assert len(calls) == 3  # erster Erase schlägt fehl, dann Erase + Write mit 115200
    assert all("115200" in args for args in calls[1:])
    assert calls[1][-1] == "erase_flash"
    assert calls[2][-3:] == ["write_flash", "0x0", "fw.bin"]


def test_systemexit_from_esptool_counts_as_failure():
    def run(args):
        if "460800" in args:
            raise SystemExit(2)

    assert flash_firmware("COM1", "fw.bin", run=run) == 115200


def test_systemexit_message_is_readable():
    def run(args):
        raise SystemExit(2)

    with pytest.raises(FlashError, match="Code 2"):
        flash_firmware("COM1", "fw.bin", run=run, bauds=(460800,))


def test_both_bauds_failing_raises_flash_error():
    def run(args):
        raise RuntimeError("kein Gerät")

    with pytest.raises(FlashError, match="kein Gerät"):
        flash_firmware("COM1", "fw.bin", run=run)


def test_esptool_output_goes_to_log_and_progress():
    lines, percents = [], []

    def run(args):
        print("Connecting...")
        print("Writing at 0x00000000... (10 %)\r", end="")
        print("Writing at 0x00000000... (100 %)\r", end="")
        print("Hard resetting via RTS pin...")

    flash_firmware(
        "COM1", "fw.bin",
        log=lines.append,
        on_percent=percents.append,
        run=run,
    )
    assert "Connecting..." in lines
    assert "Hard resetting via RTS pin..." in lines
    assert not any("%" in line for line in lines)  # Fortschritt landet nicht im Log
    assert percents == [10.0, 100.0, 10.0, 100.0]  # je Schritt (erase, write) einmal


def test_stdout_is_restored_after_flash():
    before = sys.stdout
    flash_firmware("COM1", "fw.bin", run=lambda args: print("x"))
    assert sys.stdout is before


def test_other_threads_do_not_leak_into_the_log():
    lines = []

    def run(args):
        def other():
            print("gehoert zur GUI")
        worker = threading.Thread(target=other)
        worker.start()
        worker.join()
        print("esptool-Zeile")

    flash_firmware("COM1", "fw.bin", log=lines.append, run=run)
    assert "esptool-Zeile" in lines
    assert "gehoert zur GUI" not in lines


def test_line_assembler_splits_on_cr_and_lf():
    lines, percents = [], []
    asm = LineAssembler(lines.append, percents.append)
    asm.feed("Erster Teil ")
    asm.feed("und Ende\nWriting 45.5 %\r")
    asm.feed("  \n")
    asm.flush()
    assert lines == ["Erster Teil und Ende"]
    assert percents == [45.5]


def test_thread_router_uses_fallback_for_other_threads(tmp_path):
    class Sink:
        def __init__(self):
            self.text = ""

        def write(self, s):
            self.text += s
            return len(s)

        def flush(self):
            pass

    fallback = Sink()
    router = ThreadRouter(fallback)
    captured = []
    with router.capture(captured.append):
        router.write("routed")
    router.write("fallback")
    assert captured == ["routed"]
    assert fallback.text == "fallback"
    assert router.isatty() is False


# ---------------------------------------------------------------------------
# Port-Freigabe nach Fehlern (Windows: "Zugriff verweigert" beim Fallback)
# ---------------------------------------------------------------------------

from serial import SerialException  # noqa: E402

from flashing import (  # noqa: E402
    check_esptool_stub,
    esptool_args,
    find_esp8266_stub,
    is_stub_error,
    run_esptool,
)


class FakePort:
    def __init__(self, name, registry=None):
        self.name = name
        self.closed = False
        self._registry = registry

    def close(self):
        self.closed = True
        if self._registry is not None:
            self._registry.release(self.name)


class ExclusivePorts:
    """Wie Windows: ein noch offener COM-Port lässt sich kein zweites Mal öffnen."""

    def __init__(self):
        self.open_ports = {}
        self.opened = []

    def open(self, name):
        if name in self.open_ports:
            raise SerialException(
                f"could not open port '{name}': PermissionError(13, 'Zugriff verweigert', None, 5)"
            )
        port = FakePort(name, self)
        self.open_ports[name] = port
        self.opened.append(port)
        return port

    def release(self, name):
        self.open_ports.pop(name, None)


class FakeEsp:
    def __init__(self, port, chip="ESP8266"):
        self._port = port
        self.CHIP_NAME = chip


def test_run_esptool_passes_esp_to_main_and_closes_port():
    ports = ExclusivePorts()
    seen = {}

    def main(args, esp=None):
        seen["args"], seen["esp"] = args, esp

    run_esptool(["erase_flash"], "COM5", open_port=ports.open, detect=lambda ser, baud: FakeEsp(ser), main=main)
    assert seen["args"] == ["erase_flash"]
    assert seen["esp"]._port is ports.opened[0]
    assert ports.opened[0].closed
    assert ports.open_ports == {}


def test_run_esptool_closes_port_when_main_raises_mid_operation():
    ports = ExclusivePorts()

    def main(args, esp=None):
        raise RuntimeError("Timed out waiting for packet header")

    with pytest.raises(RuntimeError):
        run_esptool(["erase_flash"], "COM5", open_port=ports.open, detect=lambda ser, baud: FakeEsp(ser), main=main)
    assert ports.opened[0].closed
    assert ports.open_ports == {}


def test_run_esptool_closes_port_when_detect_raises():
    ports = ExclusivePorts()

    def detect(ser, baud):
        raise RuntimeError("Failed to connect to ESP8266: No serial data received.")

    with pytest.raises(RuntimeError):
        run_esptool(["erase_flash"], "COM5", open_port=ports.open, detect=detect, main=lambda a, esp=None: None)
    assert ports.opened[0].closed


def test_run_esptool_also_closes_a_different_esp_port():
    ports = ExclusivePorts()
    other = FakePort("intern")

    def main(args, esp=None):
        raise RuntimeError("abgebrochen")

    with pytest.raises(RuntimeError):
        run_esptool(["erase_flash"], "COM5", open_port=ports.open, detect=lambda ser, baud: FakeEsp(other), main=main)
    assert other.closed and ports.opened[0].closed


def test_run_esptool_rejects_wrong_chip_and_closes_port():
    ports = ExclusivePorts()
    with pytest.raises(FlashError, match="ESP32"):
        run_esptool(["erase_flash"], "COM5", open_port=ports.open,
                    detect=lambda ser, baud: FakeEsp(ser, chip="ESP32"), main=lambda a, esp=None: None)
    assert ports.opened[0].closed


def test_fallback_can_reopen_port_after_exception_in_first_attempt():
    """Genau der Fehler aus dem echten Flash-Versuch: Abbruch bei 460800, Fallback braucht den Port."""
    ports = ExclusivePorts()
    calls = []

    def main(args, esp=None):
        calls.append(args)
        assert ports.open_ports, "esptool muss mit offenem Port laufen"
        if "460800" in args:
            raise RuntimeError("Fehler mitten im Löschen")

    def run(args):
        run_esptool(args, "COM5", open_port=ports.open, detect=lambda ser, baud: FakeEsp(ser), main=main)

    lines = []
    assert flash_firmware("COM5", "fw.bin", run=run, log=lines.append) == 115200
    assert not any("Zugriff verweigert" in line for line in lines)
    assert all(port.closed for port in ports.opened)
    assert len(ports.opened) == 3  # Erase bei 460800, Erase + Write bei 115200


def test_real_esptool_detect_failure_releases_real_serial_port():
    """Echter esptool-Code und echter pyserial-Port (loop://): nach dem Fehler ist der Port zu."""
    import serial
    from esptool.cmds import detect_chip

    opened = []

    def open_port(name):
        ser = serial.serial_for_url("loop://", timeout=0.1)
        opened.append(ser)
        return ser

    def detect(ser, baud):
        return detect_chip(ser, baud, connect_mode="default_reset", connect_attempts=1)

    with pytest.raises(Exception):
        run_esptool(["erase_flash"], "loop://", open_port=open_port, detect=detect)
    assert opened and opened[0].is_open is False


# ---------------------------------------------------------------------------
# Stub-Dateien und --no-stub-Fallback
# ---------------------------------------------------------------------------

STUB_MISSING = (
    "Flasher stub data is missing for ESP8266. \nThis means the esptool installation is incomplete "
    "or broken - stub JSON files were removed or a third-party distribution package didn't ship them."
)


def test_installed_esptool_has_esp8266_stub():
    assert find_esp8266_stub() is not None
    assert check_esptool_stub() is None


def test_missing_stub_gives_german_error(tmp_path):
    assert find_esp8266_stub(tmp_path) is None
    message = check_esptool_stub(tmp_path)
    assert "esp8266.json" in message
    assert "fehlt" in message
    (tmp_path / "2").mkdir()
    (tmp_path / "2" / "esp8266.json").write_text("{}", encoding="utf-8")
    assert find_esp8266_stub(tmp_path) == tmp_path / "2" / "esp8266.json"
    assert check_esptool_stub(tmp_path) is None


def test_stub_error_detection():
    assert is_stub_error(RuntimeError(STUB_MISSING))
    assert is_stub_error(RuntimeError("Failed to start stub flasher. Unexpected reply"))
    assert not is_stub_error(RuntimeError("Could not open COM5, the port is busy"))
    assert not is_stub_error(SystemExit(2))


def test_no_stub_flag_comes_before_the_operation():
    args = esptool_args("COM5", 460800, ["write_flash", "0x0", "fw.bin"], no_stub=True)
    assert args.index("--no-stub") < args.index("write_flash")
    assert "--no-stub" not in esptool_args("COM5", 460800, ["erase_flash"])


def test_missing_stub_retries_write_without_stub_and_skips_erase():
    calls = []

    def run(args):
        calls.append(args)
        if "--no-stub" not in args:
            raise RuntimeError(STUB_MISSING)

    lines = []
    assert flash_firmware("COM5", "fw.bin", run=run, log=lines.append) == 460800
    assert calls[0][-1] == "erase_flash" and "--no-stub" not in calls[0]
    assert calls[1][-3:] == ["write_flash", "0x0", "fw.bin"] and "--no-stub" in calls[1]
    assert len(calls) == 2  # kein Erase ohne Stub (ROM-Lader des ESP8266 kann das nicht)
    assert any("ohne Stub" in line for line in lines)


def test_stub_error_on_write_only_retries_same_write_once_with_no_stub():
    calls = []

    def run(args):
        calls.append(args)
        if "write_flash" in args and "--no-stub" not in args:
            raise RuntimeError("Failed to start stub flasher")

    assert flash_firmware("COM5", "fw.bin", run=run) == 460800
    assert [("--no-stub" in c, c[-1] if c[-1] == "erase_flash" else "write") for c in calls] == [
        (False, "erase_flash"),
        (False, "write"),
        (True, "write"),
    ]


def test_use_stub_false_skips_erase_and_writes_without_stub():
    calls = []
    flash_firmware("COM5", "fw.bin", run=calls.append, use_stub=False)
    assert len(calls) == 1
    assert "--no-stub" in calls[0] and "write_flash" in calls[0]


def test_non_stub_errors_do_not_trigger_no_stub():
    calls = []

    def run(args):
        calls.append(args)
        if "460800" in args:
            raise RuntimeError("Timed out waiting for packet header")

    assert flash_firmware("COM5", "fw.bin", run=run) == 115200
    assert not any("--no-stub" in c for c in calls)
