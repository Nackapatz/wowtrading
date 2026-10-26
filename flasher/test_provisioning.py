"""Tests für das serielle Provisionierungsprotokoll (ohne echte Hardware)."""

import base64
import json

import pytest
from serial import SerialException

import provisioning as prov
from provisioning import (
    MAX_RX_LINE,
    ProvEvent,
    ProvisionConfig,
    ProvisioningError,
    SerialPortInfo,
    Timeouts,
    build_payload,
    encode_config_line,
    encode_payload_json,
    find_ch340_ports,
    generate_ota_password,
    parse_line,
    preferred_port,
    provision,
    reset_esp8266,
    validate_config,
)


def make_cfg(**overrides) -> ProvisionConfig:
    base = dict(
        ssid="Wohnzimmer",
        password="geheimes-pw",
        ota_password="ota-passwort-1",
        hostname="wowscanner",
        country="DE",
        currency="EUR",
    )
    base.update(overrides)
    return ProvisionConfig(**base)


# ---------------------------------------------------------------------------
# Fake-Hardware
# ---------------------------------------------------------------------------


class FakeClock:
    """Uhr, die bei jedem Lesen und bei sleep() weiterläuft. Keine echten Wartezeiten."""

    def __init__(self, trace):
        self.now = 0.0
        self.trace = trace

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.trace.append(("sleep", round(seconds, 3)))
        self.now += seconds


class FakeSerial:
    """Scriptbarer serieller Port.

    script: Liste aus (zeitpunkt, bytes). readline() liefert die Zeilen, deren Zeitpunkt erreicht ist,
    sonst b"" (Timeout). Jeder readline-Aufruf dauert 0.1 s.
    on_cfg: Antworten (verzögerung, bytes), die nach einem WOWCFG-Schreiben eingeplant werden.
    fail_after_lines: nach so vielen gelieferten Zeilen wirft readline eine SerialException.
    """

    def __init__(self, clock, trace, script=(), on_cfg=(), fail_after_lines=None):
        self.clock = clock
        self.trace = trace
        self.script = sorted(script, key=lambda item: item[0])
        self.on_cfg = list(on_cfg)
        self.fail_after_lines = fail_after_lines
        self.written = []
        self.write_sizes = []
        self.lines_received = []
        self._pending = b""
        self.delivered = 0
        self._dtr = None
        self._rts = None

    @property
    def dtr(self):
        return self._dtr

    @dtr.setter
    def dtr(self, value):
        self._dtr = value
        self.trace.append(("dtr", value))

    @property
    def rts(self):
        return self._rts

    @rts.setter
    def rts(self, value):
        self._rts = value
        self.trace.append(("rts", value))

    def write(self, data):
        self.written.append(bytes(data))
        self.write_sizes.append(len(data))
        self._pending += bytes(data)
        # Antworten werden erst geplant, wenn die komplette Zeile (mit Newline) angekommen ist
        if self._pending.endswith(b"\n"):
            if self._pending.startswith(b"WOWCFG ") and self.on_cfg:
                for delay, reply in self.on_cfg:
                    self.script.append((self.clock.now + delay, reply))
                self.script.sort(key=lambda item: item[0])
            self.lines_received.append(self._pending)
            self._pending = b""
        return len(data)

    def flush(self):
        pass

    def close(self):
        pass

    def readline(self):
        self.clock.now += 0.1
        if self.fail_after_lines is not None and self.delivered >= self.fail_after_lines:
            raise SerialException("USB-Verbindung getrennt")
        for index, (at, data) in enumerate(self.script):
            if at <= self.clock.now:
                del self.script[index]
                self.delivered += 1
                return data
        return b""


def ready_lines(start, end, step=1.0, version=b"1.2.0"):
    out = []
    t = start
    while t <= end:
        out.append((t, b"WOWSCAN:READY " + version + b"\r\n"))
        t += step
    return out


def make_run(*, ready_from=0.0, ready_until=60.0, cfg_reply=(1.0, b"WOWCFG:OK\r\n"),
             ip_reply=(3.0, b"WOWSCAN:IP 192.168.0.42\r\n")):
    trace = []
    clock = FakeClock(trace)
    on_cfg = []
    if cfg_reply is not None:
        on_cfg.append(cfg_reply)
    if ip_reply is not None:
        on_cfg.append(ip_reply)
    port = FakeSerial(clock, trace, script=ready_lines(ready_from, ready_until), on_cfg=on_cfg)
    return port, clock, trace


# ---------------------------------------------------------------------------
# Payload-Kodierung
# ---------------------------------------------------------------------------


def test_payload_is_compact_json_and_base64_roundtrips():
    cfg = make_cfg()
    raw = encode_payload_json(cfg)
    assert b" " not in raw and b"\n" not in raw
    assert json.loads(raw.decode("ascii")) == build_payload(cfg)


def test_payload_contains_exact_spec_field_names():
    payload = build_payload(make_cfg())
    assert set(payload) == {"ssid", "pass", "otaPass", "hostname", "country", "currency"}
    assert payload["pass"] == "geheimes-pw"
    assert payload["otaPass"] == "ota-passwort-1"


def test_optional_fields_only_when_set():
    cfg = make_cfg(data_url="https://example.github.io/repo/data", cert_pem="CERT", key_pem="KEY")
    payload = build_payload(cfg)
    assert payload["dataUrl"] == "https://example.github.io/repo/data/"
    assert payload["cert"] == "CERT"
    assert payload["key"] == "KEY"


def test_config_line_format():
    line = encode_config_line(make_cfg())
    assert line.startswith(b"WOWCFG ")
    assert line.endswith(b"\n")
    assert line.count(b"\n") == 1
    b64 = line[len(b"WOWCFG "):-1]
    assert base64.b64decode(b64, validate=True)  # echtes Base64
    assert json.loads(base64.b64decode(b64).decode("ascii"))["ssid"] == "Wohnzimmer"


def test_non_ascii_ssid_is_escaped_and_roundtrips():
    cfg = make_cfg(ssid="Wohnküche Ö")
    raw = encode_payload_json(cfg)
    assert raw.isascii()
    assert json.loads(raw.decode("ascii"))["ssid"] == "Wohnküche Ö"


def test_line_with_certificate_fits_serial_rx_buffer():
    from certgen import generate_self_signed

    cert, key = generate_self_signed("wowscanner")
    line = encode_config_line(make_cfg(cert_pem=cert, key_pem=key))
    assert len(line) < MAX_RX_LINE
    assert len(line) > 1000  # Zertifikat + Schlüssel sind tatsächlich enthalten


# ---------------------------------------------------------------------------
# Antworten parsen
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "line, expected",
    [
        ("WOWSCAN:READY 1.2.0", ProvEvent("ready", "1.2.0")),
        ("WOWSCAN:READY 1.2.0\r\n", ProvEvent("ready", "1.2.0")),
        ("WOWSCAN:READY", ProvEvent("ready", "")),
        ("WOWCFG:OK", ProvEvent("cfg_ok")),
        ("WOWCFG:OK\r\n", ProvEvent("cfg_ok")),
        ("WOWCFG:ERR json", ProvEvent("cfg_err", "json")),
        ("WOWCFG:ERR ssid zu lang\r\n", ProvEvent("cfg_err", "ssid zu lang")),
        ("WOWCFG:ERR", ProvEvent("cfg_err", "unbekannter Grund")),
        ("WOWSCAN:IP 192.168.1.23", ProvEvent("ip", "192.168.1.23")),
        ("WOWSCAN:WIFIFAIL", ProvEvent("wifi_fail")),
        # Boot-Müll vor der Protokollzeile (ESP8266 gibt beim Start Text aus)
        ("\x00\xffets Jan  8 2013WOWSCAN:READY 1.2.0", ProvEvent("ready", "1.2.0")),
    ],
)
def test_parse_known_lines(line, expected):
    assert parse_line(line) == expected


def test_parse_accepts_bytes():
    assert parse_line(b"WOWCFG:OK\r\n") == ProvEvent("cfg_ok")


@pytest.mark.parametrize("line", ["", "   ", "Hallo Welt", "WOWSCAN:IP kaputt", "WOWSCAN:IP 999.1.1.1"])
def test_parse_ignores_unknown_or_invalid(line):
    assert parse_line(line) is None


# ---------------------------------------------------------------------------
# Validierung
# ---------------------------------------------------------------------------


def test_valid_config_has_no_errors():
    assert validate_config(make_cfg()) == []


@pytest.mark.parametrize(
    "ssid, ok",
    [
        ("a", True),
        ("x" * 32, True),
        ("x" * 33, False),
        ("", False),
        ("ä" * 16, True),   # 32 Bytes in UTF-8
        ("ä" * 17, False),  # 34 Bytes
    ],
)
def test_ssid_length_in_bytes(ssid, ok):
    assert (validate_config(make_cfg(ssid=ssid)) == []) is ok


@pytest.mark.parametrize(
    "password, ok",
    [
        ("", True),          # offenes Netz
        ("1234567", False),  # 7 Zeichen
        ("12345678", True),
        ("x" * 63, True),
        ("x" * 64, False),
        ("ä" * 8, False),    # nur ASCII erlaubt
    ],
)
def test_wpa_password_rules(password, ok):
    assert (validate_config(make_cfg(password=password)) == []) is ok


@pytest.mark.parametrize(
    "hostname, ok",
    [
        ("wowscanner", True),
        ("WoW-Scanner", True),  # wird kleingeschrieben
        ("a", True),
        ("a" * 63, True),
        ("a" * 64, False),
        ("-abc", False),
        ("abc-", False),
        ("my_host", False),
        ("mein host", False),
        ("", False),
    ],
)
def test_hostname_rules(hostname, ok):
    assert (validate_config(make_cfg(hostname=hostname)) == []) is ok


def test_hostname_is_normalized_to_lowercase():
    assert make_cfg(hostname="  WoW-Scanner ").normalized().hostname == "wow-scanner"


@pytest.mark.parametrize("country, ok", [("DE", True), ("de", True), ("DEU", False), ("D", False)])
def test_country_code(country, ok):
    assert (validate_config(make_cfg(country=country)) == []) is ok


def test_currency_code():
    assert validate_config(make_cfg(currency="EUR")) == []
    assert validate_config(make_cfg(currency="eu")) != []


@pytest.mark.parametrize(
    "url, ok",
    [("", True), ("https://a.github.io/b/data/", True), ("http://a/b", False), ("ftp://x", False)],
)
def test_data_url_rules(url, ok):
    assert (validate_config(make_cfg(data_url=url)) == []) is ok


def test_ota_password_rules():
    assert validate_config(make_cfg(ota_password="kurz")) != []
    assert validate_config(make_cfg(ota_password="achtzeichen")) == []


def test_generated_ota_password_is_valid_and_unambiguous():
    seen = set()
    for _ in range(50):
        pw = generate_ota_password()
        assert len(pw) == 12
        assert not set(pw) & set("0O1lI")
        assert validate_config(make_cfg(ota_password=pw)) == []
        seen.add(pw)
    assert len(seen) == 50


def test_countries_map_to_currency():
    assert prov.COUNTRY_CURRENCY["DE"] == "EUR"
    assert prov.COUNTRY_CURRENCY["CH"] == "CHF"
    assert prov.COUNTRY_CURRENCY["PL"] == "PLN"
    assert prov.COUNTRY_CURRENCY["US"] == "USD"


# ---------------------------------------------------------------------------
# Port-Erkennung
# ---------------------------------------------------------------------------


def test_ch340_is_preselected():
    ports = [
        SerialPortInfo("COM1", "Kommunikationsanschluss", 0x8086),
        SerialPortInfo("COM7", "USB-SERIAL CH340 (COM7)", 0x1A86),
        SerialPortInfo("COM9", "USB-SERIAL CH340 (COM9)", 0x1A86),
    ]
    assert [p.device for p in find_ch340_ports(ports)] == ["COM7", "COM9"]
    assert preferred_port(ports) == "COM7"


def test_no_ch340_gives_no_preselection():
    assert preferred_port([SerialPortInfo("COM1", "Anderes", None)]) is None
    assert preferred_port([]) is None


# ---------------------------------------------------------------------------
# DTR/RTS-Reset
# ---------------------------------------------------------------------------


def test_reset_sequence_dtr_false_rts_true_sleep_rts_false():
    trace = []
    clock = FakeClock(trace)
    port = FakeSerial(clock, trace)
    reset_esp8266(port, sleep=clock.sleep)
    assert trace == [("dtr", False), ("rts", True), ("sleep", 0.1), ("rts", False)]


# ---------------------------------------------------------------------------
# Handshake
# ---------------------------------------------------------------------------


def test_full_handshake_returns_ip_and_sends_config():
    port, clock, _trace = make_run(ready_until=2.0)
    ip = provision(port, make_cfg(), sleep=clock.sleep, clock=clock)
    assert ip == "192.168.0.42"
    assert port.lines_received == [encode_config_line(make_cfg())]


def test_handshake_logs_german_steps():
    port, clock, _ = make_run(ready_until=2.0)
    messages = []
    provision(port, make_cfg(), sleep=clock.sleep, clock=clock, log=messages.append)
    joined = "\n".join(messages)
    assert "WOWSCAN:READY" in joined
    assert "Konfiguration" in joined
    assert "192.168.0.42" in joined


def test_config_is_written_in_chunks_of_256_bytes_with_pauses():
    port, clock, trace = make_run(ready_until=2.0)
    cfg = make_cfg(cert_pem="C" * 900, key_pem="K" * 300)
    line = encode_config_line(cfg)
    assert len(line) > 1000  # wirklich mehrere Blöcke

    provision(port, cfg, sleep=clock.sleep, clock=clock)

    assert all(size <= 256 for size in port.write_sizes)
    assert port.write_sizes[-1] == 1  # abschließendes Newline als eigener Schreibvorgang
    body_len = len(line) - 1
    expected_blocks = -(-body_len // 256)  # aufgerundet
    assert len(port.write_sizes) == expected_blocks + 1  # Blöcke + Newline
    assert port.write_sizes[:-2] == [256] * (expected_blocks - 1)
    # 30 ms Pause nach jedem Datenblock, nicht nach dem Newline
    pauses = [item for item in trace if item == ("sleep", 0.03)]
    assert len(pauses) == expected_blocks
    # Zusammengesetzt ergibt es exakt die Zeile, und die Firmware sieht genau eine Zeile
    assert b"".join(port.written) == line
    assert port.lines_received == [line]


def test_write_chunked_rejects_line_without_newline():
    trace = []
    clock = FakeClock(trace)
    port = FakeSerial(clock, trace)
    with pytest.raises(ValueError):
        prov.write_chunked(port, b"WOWCFG abc", clock.sleep)


def test_cfg_err_reason_is_reported():
    port, clock, _ = make_run(cfg_reply=(0.5, b"WOWCFG:ERR json\r\n"), ip_reply=None)
    with pytest.raises(ProvisioningError, match="json"):
        provision(port, make_cfg(), sleep=clock.sleep, clock=clock)


def test_missing_ready_triggers_reset_then_times_out():
    port, clock, trace = make_run(ready_from=1000.0, cfg_reply=None, ip_reply=None)
    with pytest.raises(ProvisioningError, match="READY"):
        provision(port, make_cfg(), sleep=clock.sleep, clock=clock)
    # DTR/RTS-Reset wurde genau einmal ausgeführt, in der richtigen Reihenfolge
    sequence = [item for item in trace if item[0] in ("dtr", "rts", "sleep")]
    assert sequence[:4] == [("dtr", False), ("rts", True), ("sleep", 0.1), ("rts", False)]
    assert sequence.count(("dtr", False)) == 1
    assert port.written == []  # nichts gesendet, solange kein READY kam


def test_ready_after_reset_continues_provisioning():
    # Gerät läuft erst nach dem Reset (ca. 5 s) und meldet dann READY
    port, clock, trace = make_run(ready_from=6.0, ready_until=8.0)
    ip = provision(port, make_cfg(), sleep=clock.sleep, clock=clock)
    assert ip == "192.168.0.42"
    assert ("dtr", False) in trace and ("rts", True) in trace
    assert len(port.lines_received) == 1


def test_no_ack_times_out():
    port, clock, _ = make_run(ready_until=2.0, cfg_reply=None, ip_reply=None)
    with pytest.raises(ProvisioningError, match="WOWCFG:OK"):
        provision(port, make_cfg(), sleep=clock.sleep, clock=clock)


def test_wifi_fail_is_reported_with_ssid():
    port, clock, _ = make_run(ready_until=2.0, ip_reply=(2.0, b"WOWSCAN:WIFIFAIL\r\n"))
    with pytest.raises(ProvisioningError, match="Wohnzimmer"):
        provision(port, make_cfg(), sleep=clock.sleep, clock=clock)


def test_no_ip_times_out():
    port, clock, _ = make_run(ready_until=2.0, ip_reply=None)
    with pytest.raises(ProvisioningError, match="WOWSCAN:IP"):
        provision(port, make_cfg(), sleep=clock.sleep, clock=clock)


def test_partial_lines_are_joined():
    trace = []
    clock = FakeClock(trace)
    port = FakeSerial(clock, trace, script=[(0.0, b"WOWSCAN:READY 1\r\n")])
    original_write = port.write

    def write_with_split_reply(data):
        written = original_write(data)
        # Die Antwort kommt in Teilen, wie bei einem Timeout mitten in der Zeile
        port.script.append((clock.now + 0.5, b"WOWCFG"))
        port.script.append((clock.now + 0.8, b":OK\r\n"))
        port.script.append((clock.now + 1.5, b"WOWSCAN:IP 10.0.0.5\r\n"))
        port.script.sort(key=lambda item: item[0])
        return written

    port.write = write_with_split_reply
    ip = provision(port, make_cfg(), sleep=clock.sleep, clock=clock)
    assert ip == "10.0.0.5"


def test_serial_drop_during_ip_wait_reconnects():
    trace_a, trace_b = [], []
    clock = FakeClock(trace_a)
    # Port A: READY, dann OK, danach bricht die Verbindung ab (Gerät startet neu)
    first = FakeSerial(
        clock,
        trace_a,
        script=[(0.0, b"WOWSCAN:READY 1\r\n"), (0.5, b"WOWCFG:OK\r\n")],
        fail_after_lines=2,
    )
    second = FakeSerial(clock, trace_b, script=[(0.0, b"WOWSCAN:IP 192.168.0.77\r\n")])
    reopened = []

    def reopen():
        reopened.append(True)
        return second

    ip = provision(first, make_cfg(), sleep=clock.sleep, clock=clock, reopen=reopen)
    assert ip == "192.168.0.77"
    assert reopened == [True]


def test_serial_drop_without_reopen_raises():
    trace = []
    clock = FakeClock(trace)
    port = FakeSerial(clock, trace, script=[(0.0, b"WOWSCAN:READY 1\r\n")], fail_after_lines=1)
    with pytest.raises(ProvisioningError, match="verloren"):
        provision(port, make_cfg(), sleep=clock.sleep, clock=clock)


def test_invalid_config_is_rejected_before_any_io():
    port, clock, _ = make_run()
    with pytest.raises(ProvisioningError):
        provision(port, make_cfg(ssid=""), sleep=clock.sleep, clock=clock)
    assert port.written == []


def test_ready_wait_is_20_seconds_by_default():
    assert Timeouts().ready == 20.0
    assert Timeouts().reset_after == 5.0


def test_custom_timeouts_are_respected():
    port, clock, _ = make_run(ready_from=1000.0)
    timeouts = Timeouts(ready=3.0, reset_after=1.0)
    with pytest.raises(ProvisioningError):
        provision(port, make_cfg(), sleep=clock.sleep, clock=clock, timeouts=timeouts)
    assert clock.now < 5.0
