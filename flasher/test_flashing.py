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
