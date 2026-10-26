"""esptool-Aufrufe: löschen und Firmware schreiben, mit Fallback auf 115200 Baud.

Der serielle Port wird hier selbst geöffnet und nach jedem esptool-Aufruf immer
geschlossen, auch wenn esptool mitten in der Operation eine Ausnahme wirft. Sonst
bliebe der Port unter Windows belegt und der Fallback-Versuch scheiterte mit
"Zugriff verweigert".

Die Ausgabe von esptool wird über einen thread-bezogenen Router umgeleitet:
Nur der Worker-Thread, der gerade flasht, bekommt die Zeilen in den Callback.
Andere Threads (GUI) schreiben weiterhin in das ursprüngliche Ziel.
"""

from __future__ import annotations

import contextlib
import io
import os
import re
import sys
import threading
from pathlib import Path
from typing import Callable, Iterator, List, Optional, Sequence

import esptool
import serial

ESP_ROM_BAUD = 115200        # esptool verbindet sich immer mit dieser Rate, danach change_baud
CONNECT_ATTEMPTS = 7
STUB_JSON_NAME = "esp8266.json"

BAUD_PRIMARY = 460800
BAUD_FALLBACK = 115200
FIRMWARE_OFFSET = "0x0"

_PERCENT_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*%")


class FlashError(Exception):
    """Flashen ist auch mit dem Fallback-Baudrate fehlgeschlagen."""


def esptool_args(port: str, baud: int, operations: Sequence[str], no_stub: bool = False) -> List[str]:
    args = [
        "--chip", "esp8266",
        "--port", port,
        "--baud", str(baud),
        "--before", "default_reset",
        "--after", "hard_reset",
    ]
    if no_stub:
        args.append("--no-stub")
    return args + list(operations)


def erase_args(port: str, baud: int, no_stub: bool = False) -> List[str]:
    return esptool_args(port, baud, ["erase_flash"], no_stub)


def write_args(port: str, baud: int, firmware_path: str, no_stub: bool = False) -> List[str]:
    return esptool_args(port, baud, ["write_flash", FIRMWARE_OFFSET, firmware_path], no_stub)


def flash_args(port: str, baud: int, firmware_path: str, no_stub: bool = False) -> List[List[str]]:
    """Die beiden esptool-Aufrufe in Reihenfolge: erase_flash, dann write_flash 0x0.

    esptool 4.x kann keine Operationen verketten, deshalb zwei separate Aufrufe.
    """
    return [erase_args(port, baud, no_stub), write_args(port, baud, firmware_path, no_stub)]


# ---------------------------------------------------------------------------
# Stub-Dateien von esptool (müssen in der EXE mitgebündelt sein)
# ---------------------------------------------------------------------------


def esptool_stub_dir() -> Path:
    """Verzeichnis, in dem esptool die Stub-JSON-Dateien sucht."""
    try:
        from esptool.loader import StubFlasher

        return Path(StubFlasher.STUB_DIR)
    except (ImportError, AttributeError):
        return Path(esptool.__file__).resolve().parent / "targets" / "stub_flasher"


def _stub_subdirs() -> List[str]:
    try:
        from esptool.loader import StubFlasher

        return list(StubFlasher.STUB_SUBDIRS)
    except (ImportError, AttributeError):
        return ["1", "2"]


def find_esp8266_stub(stub_dir: Optional[Path] = None) -> Optional[Path]:
    """Pfad der ESP8266-Stub-JSON, so wie esptool sie sucht, oder None."""
    base = Path(stub_dir) if stub_dir is not None else esptool_stub_dir()
    for subdir in _stub_subdirs():
        candidate = base / subdir / STUB_JSON_NAME
        if candidate.is_file():
            return candidate
    flat = base / STUB_JSON_NAME  # ältere esptool-Versionen ohne Unterordner
    return flat if flat.is_file() else None


def check_esptool_stub(stub_dir: Optional[Path] = None) -> Optional[str]:
    """Deutsche Fehlermeldung, wenn der ESP8266-Stub fehlt, sonst None."""
    if find_esp8266_stub(stub_dir) is not None:
        return None
    base = Path(stub_dir) if stub_dir is not None else esptool_stub_dir()
    return (
        f"Die esptool-Stub-Datei für den ESP8266 ({STUB_JSON_NAME}) fehlt im Ordner {base}. "
        "Die EXE wurde unvollständig gebaut. Der Flasher versucht es ohne Stub: das ist langsamer, "
        "und der Flash kann dabei nicht komplett gelöscht werden. "
        "Bitte die aktuelle WoWScannerFlasher.exe aus dem Release verwenden."
    )


def is_stub_error(exc: BaseException) -> bool:
    """Fehler, die mit dem Stub-Lader zu tun haben (fehlende JSON, Stub startet nicht)."""
    return "stub" in _describe(exc).lower()


# ---------------------------------------------------------------------------
# esptool im eigenen Prozess, Port wird immer geschlossen
# ---------------------------------------------------------------------------


def open_esptool_port(port_name: str):
    """Öffnet den Port wie esptool selbst (exklusiv, unter Windows ohne Reset-Impuls)."""
    ser = serial.serial_for_url(port_name, exclusive=True, do_not_open=True)
    if sys.platform == "win32":
        ser.rts = False
        ser.dtr = False
    ser.open()
    return ser


def _detect_chip(ser, baud: int):
    from esptool.cmds import detect_chip

    return detect_chip(
        ser,
        baud,
        connect_mode="default_reset",
        trace_enabled=False,
        connect_attempts=CONNECT_ATTEMPTS,
    )


def _close_quietly(port) -> None:
    if port is None:
        return
    try:
        port.close()
    except Exception:
        pass


def run_esptool(
    args: List[str],
    port_name: str,
    *,
    open_port: Callable[[str], object] = open_esptool_port,
    detect: Callable[[object, int], object] = _detect_chip,
    main: Optional[Callable[..., object]] = None,
) -> None:
    """Ein esptool-Aufruf mit selbst verwaltetem Port.

    Der Port wird hier geöffnet, die Verbindung per detect_chip aufgebaut und an
    esptool.main(args, esp=esp) übergeben. esptool schließt einen übergebenen Port
    nicht selbst, deshalb schließt der finally-Block ihn immer, auch bei Fehlern.
    """
    main = main or esptool.main
    ser = open_port(port_name)
    esp = None
    try:
        esp = detect(ser, ESP_ROM_BAUD)
        chip = getattr(esp, "CHIP_NAME", "ESP8266")
        if chip != "ESP8266":
            raise FlashError(f"Falscher Chip erkannt: {chip}. Erwartet wird ein ESP8266 (NodeMCU).")
        main(args, esp=esp)
    finally:
        esp_port = getattr(esp, "_port", None)
        if esp_port is not None and esp_port is not ser:
            _close_quietly(esp_port)
        _close_quietly(ser)


class _Route:
    def __init__(self, callback: Callable[[str], None]):
        self.callback = callback


class ThreadRouter(io.TextIOBase):
    """Ersetzt sys.stdout/sys.stderr. Schreibt je nach Thread in einen Callback oder das Original.

    Nötig, weil die GUI-Anwendung mit --windowed kein stdout hat (sys.stdout ist None)
    und esptool trotzdem print() und isatty() aufruft.
    """

    def __init__(self, fallback):
        super().__init__()
        self._fallback = fallback
        self._routes = {}
        self._lock = threading.Lock()

    @contextlib.contextmanager
    def capture(self, callback: Callable[[str], None]) -> Iterator[None]:
        ident = threading.get_ident()
        with self._lock:
            self._routes[ident] = _Route(callback)
        try:
            yield
        finally:
            with self._lock:
                self._routes.pop(ident, None)

    def _target(self):
        with self._lock:
            route = self._routes.get(threading.get_ident())
        return route

    def write(self, text: str) -> int:
        route = self._target()
        if route is not None:
            route.callback(text)
            return len(text)
        return self._fallback.write(text)

    def flush(self) -> None:
        if self._target() is None:
            try:
                self._fallback.flush()
            except Exception:
                pass

    def isatty(self) -> bool:
        return False

    @property
    def encoding(self) -> str:
        return "utf-8"


def install_router() -> None:
    """Setzt sys.stdout/sys.stderr dauerhaft auf den Router (GUI-Start, z. B. wegen --windowed)."""
    sys.stdout, _ = _wrap_stream(sys.stdout)
    sys.stderr, _ = _wrap_stream(sys.stderr)


def _wrap_stream(stream):
    """Liefert (router, neu_gesetzt). Vorhandener Router wird wiederverwendet."""
    if isinstance(stream, ThreadRouter):
        return stream, False
    return ThreadRouter(stream if stream is not None else open(os.devnull, "w", encoding="utf-8")), True


class LineAssembler:
    """Setzt esptool-Ausgabe zu Zeilen zusammen. Prozentangaben (\\r-Fortschritt) gehen an on_percent."""

    def __init__(self, on_line: Callable[[str], None], on_percent: Optional[Callable[[float], None]] = None):
        self._on_line = on_line
        self._on_percent = on_percent
        self._pending = ""

    def feed(self, text: str) -> None:
        self._pending += text
        while True:
            cut = None
            for idx, ch in enumerate(self._pending):
                if ch in "\r\n":
                    cut = idx
                    break
            if cut is None:
                return
            piece = self._pending[:cut]
            terminator = self._pending[cut]
            self._pending = self._pending[cut + 1:]
            self._handle(piece, terminator)

    def flush(self) -> None:
        if self._pending:
            self._handle(self._pending, "\n")
            self._pending = ""

    def _handle(self, piece: str, terminator: str) -> None:
        text = piece.strip()
        if not text:
            return
        match = _PERCENT_RE.search(text)
        if match and self._on_percent is not None:
            try:
                self._on_percent(float(match.group(1)))
            except ValueError:
                pass
        if terminator == "\n":
            self._on_line(text)


def flash_firmware(
    port: str,
    firmware_path: str,
    *,
    log: Callable[[str], None] = lambda _m: None,
    on_percent: Optional[Callable[[float], None]] = None,
    run: Optional[Callable[[List[str]], object]] = None,
    bauds: Sequence[int] = (BAUD_PRIMARY, BAUD_FALLBACK),
    use_stub: bool = True,
) -> int:
    """Löscht den Flash und schreibt die Firmware. Liefert den Baudrate, der funktioniert hat.

    Bei Fehler mit der ersten Rate wird mit der zweiten wiederholt. Scheitert auch
    die letzte, wird FlashError geworfen.

    Stub-Fehler: write_flash wird einmal mit --no-stub wiederholt. erase_flash geht
    beim ESP8266 nur mit Stub (der ROM-Lader kann den Chip nicht komplett löschen),
    deshalb wird das Löschen ohne Stub übersprungen; write_flash löscht dann nur die
    beschriebenen Sektoren. Alte Einstellungen überschreibt danach die Einrichtung.
    """
    if run is None:
        def run(args: List[str]) -> None:
            run_esptool(args, port)

    no_stub = not use_stub
    if no_stub:
        log("Hinweis: Flashen ohne esptool-Stub (langsamer).")
    last_error: Optional[BaseException] = None
    for baud in bauds:
        assembler = LineAssembler(log, on_percent)
        try:
            if no_stub:
                log("Ohne Stub kann der ESP8266 nicht komplett gelöscht werden – Löschen wird übersprungen.")
            else:
                log(f"Lösche Flash mit {baud} Baud …")
                try:
                    _run_step(run, erase_args(port, baud), assembler)
                except (Exception, SystemExit) as exc:
                    if not is_stub_error(exc):
                        raise
                    assembler.flush()
                    no_stub = True
                    log(f"Stub-Fehler beim Löschen: {_describe(exc)}")
                    log("Weiter ohne Stub. Das komplette Löschen ist ohne Stub nicht möglich und wird übersprungen.")

            log(f"Schreibe Firmware mit {baud} Baud{' (ohne Stub)' if no_stub else ''} …")
            try:
                _run_step(run, write_args(port, baud, firmware_path, no_stub), assembler)
            except (Exception, SystemExit) as exc:
                if no_stub or not is_stub_error(exc):
                    raise
                assembler.flush()
                no_stub = True
                log(f"Stub-Fehler beim Schreiben: {_describe(exc)}")
                log("Neuer Versuch ohne Stub (--no-stub) …")
                _run_step(run, write_args(port, baud, firmware_path, True), assembler)
            return baud
        except (Exception, SystemExit) as exc:  # esptool wirft FatalError oder SystemExit
            assembler.flush()
            last_error = exc
            log(f"Fehler bei {baud} Baud: {_describe(exc)}")
    raise FlashError(f"Flashen fehlgeschlagen: {_describe(last_error)}")


def _run_step(run: Callable[[List[str]], object], args: List[str], assembler: LineAssembler) -> None:
    with _capture_stdout(assembler):
        run(args)
    assembler.flush()


def _describe(exc: Optional[BaseException]) -> str:
    if isinstance(exc, SystemExit):
        return f"esptool wurde mit Code {exc.code} beendet"
    return str(exc) or exc.__class__.__name__


@contextlib.contextmanager
def _capture_stdout(assembler: LineAssembler) -> Iterator[None]:
    """Leitet stdout/stderr für den aktuellen Thread in den Assembler, danach wird alles zurückgesetzt."""
    prev_out, prev_err = sys.stdout, sys.stderr
    out_router, out_new = _wrap_stream(prev_out)
    err_router, err_new = _wrap_stream(prev_err)
    sys.stdout, sys.stderr = out_router, err_router
    try:
        with out_router.capture(assembler.feed), err_router.capture(assembler.feed):
            yield
    finally:
        if out_new:
            sys.stdout = prev_out
        if err_new:
            sys.stderr = prev_err
