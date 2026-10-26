"""esptool-Aufrufe: löschen und Firmware schreiben, mit Fallback auf 115200 Baud.

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
from typing import Callable, Iterator, List, Optional, Sequence

import esptool

BAUD_PRIMARY = 460800
BAUD_FALLBACK = 115200
FIRMWARE_OFFSET = "0x0"

_PERCENT_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*%")


class FlashError(Exception):
    """Flashen ist auch mit dem Fallback-Baudrate fehlgeschlagen."""


def esptool_args(port: str, baud: int, operations: Sequence[str]) -> List[str]:
    return [
        "--chip", "esp8266",
        "--port", port,
        "--baud", str(baud),
        "--before", "default_reset",
        "--after", "hard_reset",
        *operations,
    ]


def erase_args(port: str, baud: int) -> List[str]:
    return esptool_args(port, baud, ["erase_flash"])


def write_args(port: str, baud: int, firmware_path: str) -> List[str]:
    return esptool_args(port, baud, ["write_flash", FIRMWARE_OFFSET, firmware_path])


def flash_args(port: str, baud: int, firmware_path: str) -> List[List[str]]:
    """Die beiden esptool-Aufrufe in Reihenfolge: erase_flash, dann write_flash 0x0.

    esptool 4.x kann keine Operationen verketten, deshalb zwei separate Aufrufe.
    """
    return [erase_args(port, baud), write_args(port, baud, firmware_path)]


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
    run: Callable[[List[str]], object] = esptool.main,
    bauds: Sequence[int] = (BAUD_PRIMARY, BAUD_FALLBACK),
) -> int:
    """Löscht den Flash und schreibt die Firmware. Liefert den Baudrate, der funktioniert hat.

    Bei Fehler mit der ersten Rate wird mit der zweiten wiederholt. Scheitert auch
    die letzte, wird FlashError geworfen.
    """
    last_error: Optional[BaseException] = None
    for baud in bauds:
        assembler = LineAssembler(log, on_percent)
        try:
            erase, write = flash_args(port, baud, firmware_path)
            log(f"Lösche Flash mit {baud} Baud …")
            _run_step(run, erase, assembler)
            log(f"Schreibe Firmware mit {baud} Baud …")
            _run_step(run, write, assembler)
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
