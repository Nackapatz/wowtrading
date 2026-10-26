"""Serielles Provisionierungsprotokoll, Konfigurationsprüfung und Port-Erkennung.

Rein logisch, ohne GUI, damit alles unit-testbar ist. Protokoll siehe docs/SPEC.md, Abschnitt 1:

    Firmware -> Flasher:  WOWSCAN:READY <version>   (alle 1 s, siehe Firmware)
    Flasher  -> Firmware: WOWCFG <base64(json)>\\n
    Firmware -> Flasher:  WOWCFG:OK  |  WOWCFG:ERR <grund>
    Firmware -> Flasher:  WOWSCAN:IP <ip>  |  WOWSCAN:WIFIFAIL
"""

from __future__ import annotations

import base64
import ipaddress
import json
import re
import secrets
import time
from dataclasses import dataclass, replace
from typing import Callable, Iterable, List, Optional

import serial  # pyserial
from serial import SerialException
from serial.tools import list_ports

BAUD_SERIAL = 115200
CH340_VID = 0x1A86
DEFAULT_HOSTNAME = "wowscanner"
DEFAULT_COUNTRY = "DE"
# Ein Puffer-Limit für eine Zeile der Firmware (Serial-RX ist 4096 Byte).
MAX_RX_LINE = 4096

# Land -> (Anzeigename, Währung). Reihenfolge = Reihenfolge im Dropdown.
COUNTRIES: List[tuple] = [
    ("DE", "Deutschland", "EUR"),
    ("AT", "Österreich", "EUR"),
    ("CH", "Schweiz", "CHF"),
    ("US", "USA", "USD"),
    ("GB", "Vereinigtes Königreich", "GBP"),
    ("FR", "Frankreich", "EUR"),
    ("IT", "Italien", "EUR"),
    ("ES", "Spanien", "EUR"),
    ("NL", "Niederlande", "EUR"),
    ("BE", "Belgien", "EUR"),
    ("PL", "Polen", "PLN"),
    ("SE", "Schweden", "SEK"),
    ("DK", "Dänemark", "DKK"),
    ("NO", "Norwegen", "NOK"),
    ("CZ", "Tschechien", "CZK"),
    ("CA", "Kanada", "CAD"),
    ("AU", "Australien", "AUD"),
]

COUNTRY_CURRENCY = {code: cur for code, _name, cur in COUNTRIES}

_OTA_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_HOSTNAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
_COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


class ProvisioningError(Exception):
    """Fehler beim seriellen Einrichten. Die Meldung ist für die Anzeige auf Deutsch."""


# ---------------------------------------------------------------------------
# Konfiguration
# ---------------------------------------------------------------------------


@dataclass
class ProvisionConfig:
    ssid: str
    password: str = ""
    ota_password: str = ""
    hostname: str = DEFAULT_HOSTNAME
    country: str = DEFAULT_COUNTRY
    currency: str = "EUR"
    data_url: str = ""
    cert_pem: Optional[str] = None
    key_pem: Optional[str] = None

    def normalized(self) -> "ProvisionConfig":
        """Gibt eine Kopie mit vereinheitlichter Schreibweise zurück."""
        data_url = self.data_url.strip()
        if data_url and not data_url.endswith("/"):
            data_url += "/"
        return replace(
            self,
            ssid=self.ssid,
            password=self.password,
            ota_password=self.ota_password,
            hostname=self.hostname.strip().lower(),
            country=self.country.strip().upper(),
            currency=self.currency.strip().upper(),
            data_url=data_url,
        )


def validate_config(cfg: ProvisionConfig) -> List[str]:
    """Prüft die Eingaben. Liefert eine Liste deutscher Fehlermeldungen (leer = gültig)."""
    c = cfg.normalized()
    errors: List[str] = []

    ssid_len = len(c.ssid.encode("utf-8"))
    if not c.ssid:
        errors.append("WLAN-Name (SSID) fehlt.")
    elif ssid_len > 32:
        errors.append("WLAN-Name (SSID) ist länger als 32 Bytes.")

    if c.password:
        if not 8 <= len(c.password) <= 63:
            errors.append("WLAN-Passwort muss 8 bis 63 Zeichen lang sein (oder leer für offene Netze).")
        elif not _is_printable_ascii(c.password):
            errors.append("WLAN-Passwort darf nur ASCII-Zeichen enthalten.")

    if not 8 <= len(c.ota_password) <= 63 or not _is_printable_ascii(c.ota_password):
        errors.append("OTA-Passwort muss 8 bis 63 ASCII-Zeichen lang sein.")

    if not _HOSTNAME_RE.match(c.hostname):
        errors.append(
            "Hostname: nur Buchstaben, Ziffern und Bindestriche, 1 bis 63 Zeichen, "
            "nicht am Anfang oder Ende ein Bindestrich."
        )

    if not _COUNTRY_RE.match(c.country):
        errors.append("Land muss ein zweistelliger Code sein (z. B. DE).")
    if not _CURRENCY_RE.match(c.currency):
        errors.append("Währung muss ein dreistelliger Code sein (z. B. EUR).")

    if c.data_url and not c.data_url.startswith("https://"):
        errors.append("Daten-URL muss mit https:// beginnen.")

    return errors


def _is_printable_ascii(text: str) -> bool:
    return all(32 <= ord(ch) <= 126 for ch in text)


def generate_ota_password(length: int = 12) -> str:
    """Zufälliges OTA-Passwort ohne leicht verwechselbare Zeichen (0/O, 1/l/I)."""
    return "".join(secrets.choice(_OTA_ALPHABET) for _ in range(length))


def build_payload(cfg: ProvisionConfig) -> dict:
    """JSON-Objekt für WOWCFG mit exakt den Feldnamen aus der Spezifikation."""
    c = cfg.normalized()
    payload = {
        "ssid": c.ssid,
        "pass": c.password,
        "otaPass": c.ota_password,
        "hostname": c.hostname,
        "country": c.country,
        "currency": c.currency,
    }
    if c.data_url:
        payload["dataUrl"] = c.data_url
    if c.cert_pem:
        payload["cert"] = c.cert_pem
    if c.key_pem:
        payload["key"] = c.key_pem
    return payload


def encode_payload_json(cfg: ProvisionConfig) -> bytes:
    """Kompaktes JSON (ohne Leerzeichen), ASCII-only, damit die Zeile auf jeder Seite gleich ist."""
    return json.dumps(build_payload(cfg), separators=(",", ":"), ensure_ascii=True).encode("ascii")


def encode_config_line(cfg: ProvisionConfig) -> bytes:
    """Komplette Zeile `WOWCFG <base64(json)>\\n` als Bytes zum Senden."""
    b64 = base64.b64encode(encode_payload_json(cfg)).decode("ascii")
    return b"WOWCFG " + b64.encode("ascii") + b"\n"


# ---------------------------------------------------------------------------
# Antworten der Firmware
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProvEvent:
    kind: str  # "ready" | "cfg_ok" | "cfg_err" | "ip" | "wifi_fail"
    value: Optional[str] = None


_READY_RE = re.compile(r"WOWSCAN:READY(?:[ \t]+(\S+))?")
_CFG_OK_RE = re.compile(r"WOWCFG:OK")
_CFG_ERR_RE = re.compile(r"WOWCFG:ERR(?:[ \t]+([^\r\n]*))?")
_IP_RE = re.compile(r"WOWSCAN:IP[ \t]+(\S+)")
_WIFIFAIL_RE = re.compile(r"WOWSCAN:WIFIFAIL")


def parse_line(line: str) -> Optional[ProvEvent]:
    """Erkennt eine Protokollzeile. Unbekannte Zeilen (Boot-Log etc.) ergeben None."""
    if isinstance(line, bytes):
        line = line.decode("utf-8", errors="replace")
    text = line.strip()
    if not text:
        return None

    if _CFG_ERR_RE.search(text):
        reason = (_CFG_ERR_RE.search(text).group(1) or "").strip()
        return ProvEvent("cfg_err", reason or "unbekannter Grund")
    if _CFG_OK_RE.search(text):
        return ProvEvent("cfg_ok")
    match = _IP_RE.search(text)
    if match:
        try:
            ipaddress.ip_address(match.group(1))
        except ValueError:
            return None
        return ProvEvent("ip", match.group(1))
    if _WIFIFAIL_RE.search(text):
        return ProvEvent("wifi_fail")
    match = _READY_RE.search(text)
    if match:
        return ProvEvent("ready", match.group(1) or "")
    return None


# ---------------------------------------------------------------------------
# Reset und Handshake
# ---------------------------------------------------------------------------


def reset_esp8266(port, sleep: Callable[[float], None] = time.sleep) -> None:
    """Reset eines NodeMCU (ESP8266) über DTR/RTS, wie vom Auto-Reset-Schaltkreis erwartet."""
    port.dtr = False
    port.rts = True
    sleep(0.1)
    port.rts = False


@dataclass(frozen=True)
class Timeouts:
    ready: float = 20.0          # max. Wartezeit auf WOWSCAN:READY (Firmware-Bootfenster >= 8 s)
    reset_after: float = 5.0     # ohne READY nach so vielen Sekunden einmal resetten
    ack: float = 10.0            # Wartezeit auf WOWCFG:OK / WOWCFG:ERR
    ip: float = 45.0             # Wartezeit auf WOWSCAN:IP nach WOWCFG:OK


class _Link:
    """Liest Protokollereignisse von einem seriellen Port, mit Wiederverbindung."""

    MAX_RECONNECTS = 3

    def __init__(self, port, reopen: Optional[Callable[[], object]]):
        self.port = port
        self._reopen = reopen
        self._buf = b""
        self._reconnects = 0

    def next_event(self) -> Optional[ProvEvent]:
        """Liefert das nächste Ereignis oder None (Timeout, Teilzeile, unbekannte Zeile)."""
        try:
            raw = self.port.readline()
        except SerialException:
            if self._reopen is None or self._reconnects >= self.MAX_RECONNECTS:
                raise ProvisioningError("Serielle Verbindung zum Gerät verloren.")
            self._reconnects += 1
            self._buf = b""
            try:
                self.port = self._reopen()
            except SerialException as exc:
                raise ProvisioningError(f"Serielle Verbindung konnte nicht neu aufgebaut werden: {exc}")
            return None

        if not raw:
            return None
        self._buf += raw
        if len(self._buf) > MAX_RX_LINE:
            self._buf = b""
            return None
        if not self._buf.endswith(b"\n"):
            return None  # Teilzeile, Rest kommt beim nächsten Aufruf
        text = self._buf.decode("utf-8", errors="replace")
        self._buf = b""
        return parse_line(text)


CHUNK_SIZE = 256            # Firmware-RX-Puffer ist klein, daher Zeile in Stücken senden
CHUNK_PAUSE_S = 0.030


def write_chunked(port, line: bytes, sleep: Callable[[float], None] = time.sleep,
                  chunk_size: int = CHUNK_SIZE, pause: float = CHUNK_PAUSE_S) -> None:
    """Schreibt die komplette Zeile in Blöcken von chunk_size Bytes.

    Nach jedem Block wird geflusht und 30 ms gewartet, danach folgt das abschließende
    Newline. Die Firmware empfängt so eine Zeile, die in den kleinen RX-Puffer passt.
    """
    if not line.endswith(b"\n"):
        raise ValueError("Zeile muss mit Newline enden.")
    body = line[:-1]
    for start in range(0, len(body), chunk_size):
        port.write(body[start:start + chunk_size])
        port.flush()
        sleep(pause)
    port.write(b"\n")
    port.flush()


def provision(
    port,
    cfg: ProvisionConfig,
    *,
    log: Callable[[str], None] = lambda _msg: None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    reopen: Optional[Callable[[], object]] = None,
    timeouts: Timeouts = Timeouts(),
) -> str:
    """Führt den kompletten Handshake aus und liefert die IP-Adresse.

    Ablauf: auf READY warten (ggf. Reset), WOWCFG senden, auf OK/ERR warten,
    danach auf WOWSCAN:IP warten. Wirft ProvisioningError mit deutscher Meldung.
    """
    errors = validate_config(cfg)
    if errors:
        raise ProvisioningError(errors[0])

    link = _Link(port, reopen)

    # 1) READY abwarten, notfalls per DTR/RTS neu starten.
    log("Warte auf das Gerät (WOWSCAN:READY) …")
    start = clock()
    deadline = start + timeouts.ready
    reset_done = False
    got_ready = False
    while clock() < deadline:
        if not reset_done and clock() - start >= timeouts.reset_after:
            log("Kein READY empfangen – Gerät wird per DTR/RTS neu gestartet …")
            reset_esp8266(link.port, sleep)
            reset_done = True
        event = link.next_event()
        if event and event.kind == "ready":
            got_ready = True
            break
    if not got_ready:
        raise ProvisioningError(
            "Das Gerät meldet sich nicht (WOWSCAN:READY fehlt). "
            "Bitte USB-Kabel und COM-Port prüfen und das Gerät neu starten."
        )
    log(f"Gerät bereit{' (Firmware ' + event.value + ')' if event.value else ''}.")

    # 2) Konfiguration senden.
    line = encode_config_line(cfg)
    log("Sende WLAN- und Gerätekonfiguration …")
    write_chunked(link.port, line, sleep)

    # 3) Quittung abwarten.
    deadline = clock() + timeouts.ack
    while clock() < deadline:
        event = link.next_event()
        if event is None:
            continue
        if event.kind == "cfg_ok":
            log("Konfiguration vom Gerät übernommen. Gerät startet neu …")
            break
        if event.kind == "cfg_err":
            raise ProvisioningError(f"Gerät hat die Konfiguration abgelehnt: {event.value}")
    else:
        raise ProvisioningError("Keine Antwort auf die Konfiguration (WOWCFG:OK fehlt).")

    # 4) IP-Adresse abwarten.
    log("Verbinde mit dem WLAN …")
    deadline = clock() + timeouts.ip
    while clock() < deadline:
        event = link.next_event()
        if event is None:
            continue
        if event.kind == "ip":
            log(f"WLAN verbunden, IP-Adresse: {event.value}")
            return event.value
        if event.kind == "wifi_fail":
            raise ProvisioningError(
                f"WLAN-Verbindung zu „{cfg.ssid}“ fehlgeschlagen. Name und Passwort prüfen."
            )
    raise ProvisioningError("Keine IP-Adresse vom Gerät erhalten (WOWSCAN:IP fehlt nach 45 s).")


# ---------------------------------------------------------------------------
# Port-Erkennung
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SerialPortInfo:
    device: str
    description: str
    vid: Optional[int]


def list_serial_ports() -> List[SerialPortInfo]:
    """Alle seriellen Ports des Systems (über pyserial)."""
    result = []
    for item in list_ports.comports():
        result.append(SerialPortInfo(item.device, item.description or "", item.vid))
    return result


def find_ch340_ports(ports: Iterable[SerialPortInfo]) -> List[SerialPortInfo]:
    return [p for p in ports if p.vid == CH340_VID]


def preferred_port(ports: Iterable[SerialPortInfo]) -> Optional[str]:
    """Erster CH340-Port, sonst None. Der Nutzer kann im GUI immer manuell wählen."""
    ch340 = find_ch340_ports(ports)
    return ch340[0].device if ch340 else None


def open_serial(port_name: str, timeout: float = 0.2):
    """Öffnet den Port ohne DTR/RTS-Impuls beim Öffnen (kein ungewollter Reset)."""
    ser = serial.Serial()
    ser.port = port_name
    ser.baudrate = BAUD_SERIAL
    ser.timeout = timeout
    ser.dtr = False
    ser.rts = False
    ser.open()
    return ser
