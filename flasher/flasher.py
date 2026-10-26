"""WoW Trading Card Price Scanner - Flasher (Windows, tkinter).

Flasht die Firmware auf den NodeMCU (ESP8266), erzeugt ein selbst signiertes Zertifikat
und richtet WLAN und Gerätekonfiguration über die serielle Schnittstelle ein.

Start aus dem Quellcode:  python flasher/flasher.py
Als EXE: WoWScannerFlasher.exe (PyInstaller, Firmware eingebettet).
"""

from __future__ import annotations

import queue
import sys
import threading
import time
import traceback
import webbrowser
from dataclasses import replace
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from certgen import generate_self_signed
from flashing import FlashError, flash_firmware, install_router
from provisioning import (
    COUNTRIES,
    COUNTRY_CURRENCY,
    ProvisionConfig,
    ProvisioningError,
    SerialPortInfo,
    generate_ota_password,
    list_serial_ports,
    open_serial,
    preferred_port,
    provision,
    validate_config,
)
from settings import Settings, find_firmware, load_settings, save_settings, settings_path

BASE_DIR = Path(__file__).resolve().parent
FROZEN = bool(getattr(sys, "frozen", False))
MEIPASS = getattr(sys, "_MEIPASS", None)

WINDOW_TITLE = "WoW Scanner einrichten"
SETTLE_AFTER_FLASH_S = 1.5  # Zeit nach hard_reset, bis das Gerät wieder am Port ist


class Job:
    """Eine Aufgabe für den Worker-Thread."""

    def __init__(self, mode: str, port: str, cfg: ProvisionConfig, firmware: Optional[Path]):
        self.mode = mode  # "flash" oder "settings"
        self.port = port
        self.cfg = cfg
        self.firmware = firmware


def run_job(job: Job, post: Callable[[tuple], None]) -> None:
    """Läuft im Worker-Thread. Kommuniziert nur über post(), keine Tk-Aufrufe."""
    holder: Dict[str, object] = {}

    def close_serial() -> None:
        ser = holder.pop("ser", None)
        if ser is not None:
            try:
                ser.close()
            except Exception:
                pass

    def reopen():
        close_serial()
        holder["ser"] = open_serial(job.port)
        return holder["ser"]

    try:
        cfg = job.cfg
        flashed = False
        if job.mode == "flash":
            post(("status", "Erzeuge Zertifikat …"))
            cert_pem, key_pem = generate_self_signed(cfg.hostname)
            cfg = replace(cfg, cert_pem=cert_pem, key_pem=key_pem)
            post(("progress", 5))

            post(("status", "Flashe Firmware …"))
            flash_firmware(
                job.port,
                str(job.firmware),
                log=lambda msg: post(("log", msg)),
                on_percent=lambda pct: post(("progress", 5 + pct * 0.65)),
            )
            flashed = True
            post(("progress", 70))
            post(("log", "Firmware geschrieben. Gerät startet neu …"))
            time.sleep(SETTLE_AFTER_FLASH_S)

        post(("status", "Richte Gerät ein …"))
        post(("progress", 75))
        holder["ser"] = open_serial(job.port)
        try:
            ip = provision(
                holder["ser"],
                cfg,
                log=lambda msg: post(("log", msg)),
                reopen=reopen,
            )
        finally:
            close_serial()
        post(("progress", 100))
        post(("done", ip, cfg.ota_password, flashed))
    except (ProvisioningError, FlashError) as exc:
        post(("error", str(exc)))
    except Exception as exc:  # unerwartet: Traceback ins Log, Meldung für den Nutzer
        post(("log", traceback.format_exc()))
        post(("error", f"Unerwarteter Fehler: {exc}"))
    finally:
        close_serial()


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.queue: "queue.Queue[tuple]" = queue.Queue()
        self.busy = False
        self.ip: Optional[str] = None
        self.settings_file = settings_path()
        self.settings = load_settings(self.settings_file)
        self.firmware: Optional[Path] = find_firmware(FROZEN, MEIPASS, BASE_DIR)
        self.ports: List[SerialPortInfo] = []
        self._port_labels: Dict[str, str] = {}

        root.title(WINDOW_TITLE)
        root.minsize(640, 560)
        self._build()
        self._refresh_ports(keep_selection=False)
        self._update_firmware_label()
        self.root.after(80, self._poll)

    # ------------------------------------------------------------------ GUI
    def _build(self) -> None:
        root = self.root
        root.columnconfigure(0, weight=1)
        pad = {"padx": 8, "pady": 4}

        header = ttk.Label(root, text="WoW Trading Card Price Scanner einrichten", font=("Segoe UI", 13, "bold"))
        header.grid(row=0, column=0, sticky="w", padx=10, pady=(10, 2))

        # 1) Gerät
        dev = ttk.LabelFrame(root, text="1. Gerät (NodeMCU per USB)")
        dev.grid(row=1, column=0, sticky="ew", padx=10, pady=4)
        dev.columnconfigure(1, weight=1)
        ttk.Label(dev, text="COM-Port:").grid(row=0, column=0, sticky="w", **pad)
        self.port_var = tk.StringVar()
        self.port_box = ttk.Combobox(dev, textvariable=self.port_var, state="readonly")
        self.port_box.grid(row=0, column=1, sticky="ew", **pad)
        ttk.Button(dev, text="Aktualisieren", command=lambda: self._refresh_ports(keep_selection=True)).grid(
            row=0, column=2, sticky="e", **pad
        )
        self.port_hint = ttk.Label(dev, text="")
        self.port_hint.grid(row=1, column=1, columnspan=2, sticky="w", padx=8, pady=(0, 6))

        # 2) WLAN und Einstellungen
        net = ttk.LabelFrame(root, text="2. WLAN und Einstellungen")
        net.grid(row=2, column=0, sticky="ew", padx=10, pady=4)
        net.columnconfigure(1, weight=1)

        ttk.Label(net, text="WLAN-Name (SSID):").grid(row=0, column=0, sticky="w", **pad)
        self.ssid_var = tk.StringVar(value=self.settings.ssid)
        ttk.Entry(net, textvariable=self.ssid_var).grid(row=0, column=1, columnspan=2, sticky="ew", **pad)

        ttk.Label(net, text="WLAN-Passwort:").grid(row=1, column=0, sticky="w", **pad)
        self.pass_var = tk.StringVar()
        self.pass_entry = ttk.Entry(net, textvariable=self.pass_var, show="•")
        self.pass_entry.grid(row=1, column=1, sticky="ew", **pad)
        self.show_pass_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(net, text="anzeigen", variable=self.show_pass_var, command=self._toggle_pass).grid(
            row=1, column=2, sticky="w", **pad
        )

        ttk.Label(net, text="OTA-Passwort:").grid(row=2, column=0, sticky="w", **pad)
        self.ota_var = tk.StringVar(value=generate_ota_password())
        ttk.Entry(net, textvariable=self.ota_var).grid(row=2, column=1, sticky="ew", **pad)
        ttk.Button(net, text="Neu erzeugen", command=lambda: self.ota_var.set(generate_ota_password())).grid(
            row=2, column=2, sticky="w", **pad
        )

        ttk.Label(net, text="Land:").grid(row=3, column=0, sticky="w", **pad)
        self.country_values = [f"{code} – {name}" for code, name, _cur in COUNTRIES]
        self.country_var = tk.StringVar()
        country_box = ttk.Combobox(net, textvariable=self.country_var, values=self.country_values, state="readonly")
        country_box.grid(row=3, column=1, columnspan=2, sticky="ew", **pad)
        self._select_country(self.settings.country or "DE")

        ttk.Label(net, text="Hostname:").grid(row=4, column=0, sticky="w", **pad)
        self.host_var = tk.StringVar(value=self.settings.hostname or "wowscanner")
        ttk.Entry(net, textvariable=self.host_var).grid(row=4, column=1, columnspan=2, sticky="ew", **pad)
        ttk.Label(net, text="Erreichbar unter <hostname>.local (mDNS).", foreground="#666").grid(
            row=5, column=1, columnspan=2, sticky="w", padx=8, pady=(0, 6)
        )

        # Erweitert
        adv = ttk.LabelFrame(root, text="Erweitert")
        adv.grid(row=3, column=0, sticky="ew", padx=10, pady=4)
        adv.columnconfigure(0, weight=1)
        self.fw_label = ttk.Label(adv, text="", wraplength=460, justify="left")
        self.fw_label.grid(row=0, column=0, sticky="w", **pad)
        ttk.Button(adv, text="Firmware-Datei wählen…", command=self._choose_firmware).grid(
            row=0, column=1, sticky="e", **pad
        )

        # Aktionen
        actions = ttk.Frame(root)
        actions.grid(row=4, column=0, sticky="ew", padx=10, pady=6)
        self.flash_btn = ttk.Button(actions, text="Flashen + Einrichten", command=lambda: self._start("flash"))
        self.flash_btn.pack(side="left", padx=(0, 8))
        self.settings_btn = ttk.Button(
            actions, text="Nur WLAN/Einstellungen ändern", command=lambda: self._start("settings")
        )
        self.settings_btn.pack(side="left")

        # Fortschritt und Status
        self.progress = ttk.Progressbar(root, mode="determinate", maximum=100)
        self.progress.grid(row=5, column=0, sticky="ew", padx=10, pady=(4, 2))
        self.status_var = tk.StringVar(value="Bereit.")
        ttk.Label(root, textvariable=self.status_var).grid(row=6, column=0, sticky="w", padx=10)

        # Ergebnis (wird nach Erfolg eingeblendet)
        self.result = ttk.LabelFrame(root, text="Fertig")
        self.result.columnconfigure(0, weight=1)
        self.ip_var = tk.StringVar()
        ttk.Label(self.result, textvariable=self.ip_var, font=("Segoe UI", 26, "bold")).grid(
            row=0, column=0, sticky="w", padx=8, pady=(6, 0)
        )
        self.open_btn = ttk.Button(self.result, text="Im Browser öffnen", command=self._open_browser)
        self.open_btn.grid(row=0, column=1, sticky="e", padx=8, pady=(6, 0))
        ttk.Label(
            self.result,
            text=(
                "Der Browser zeigt eine Zertifikatswarnung, weil das Zertifikat selbst signiert ist. "
                "Das ist erwartet: „Erweitert“ und dann „Trotzdem fortfahren“ wählen. "
                "Auf dem Handy siehe README."
            ),
            wraplength=560,
            justify="left",
        ).grid(row=1, column=0, columnspan=2, sticky="w", padx=8, pady=4)
        ota_row = ttk.Frame(self.result)
        ota_row.grid(row=2, column=0, columnspan=2, sticky="ew", padx=8, pady=(4, 8))
        ota_row.columnconfigure(1, weight=1)
        ttk.Label(
            ota_row,
            text="OTA-Passwort (bitte jetzt notieren, es wird nicht gespeichert):",
        ).grid(row=0, column=0, columnspan=3, sticky="w")
        self.shown_ota_var = tk.StringVar()
        ttk.Entry(ota_row, textvariable=self.shown_ota_var, state="readonly").grid(
            row=1, column=0, columnspan=2, sticky="ew", pady=(2, 0)
        )
        ttk.Button(ota_row, text="Kopieren", command=self._copy_ota).grid(row=1, column=2, padx=(6, 0), pady=(2, 0))

        # Log
        log_frame = ttk.LabelFrame(root, text="Protokoll")
        log_frame.grid(row=8, column=0, sticky="nsew", padx=10, pady=(4, 10))
        root.rowconfigure(8, weight=1)
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)
        self.log_text = tk.Text(log_frame, height=10, wrap="word", state="disabled")
        self.log_text.grid(row=0, column=0, sticky="nsew")
        scroll = ttk.Scrollbar(log_frame, orient="vertical", command=self.log_text.yview)
        scroll.grid(row=0, column=1, sticky="ns")
        self.log_text.configure(yscrollcommand=scroll.set)

        self.port_box.bind("<<ComboboxSelected>>", lambda _e: self._update_port_hint())

    def _toggle_pass(self) -> None:
        self.pass_entry.configure(show="" if self.show_pass_var.get() else "•")

    def _select_country(self, code: str) -> None:
        for value in self.country_values:
            if value.split(" ")[0] == code:
                self.country_var.set(value)
                return
        self.country_var.set(self.country_values[0])

    def _selected_country_code(self) -> str:
        return self.country_var.get().split(" ")[0]

    def _refresh_ports(self, keep_selection: bool) -> None:
        previous = self.port_var.get() if keep_selection else ""
        try:
            self.ports = list_serial_ports()
        except Exception as exc:  # pyserial kann unter Windows Fehler werfen
            self.ports = []
            self._log(f"COM-Ports konnten nicht gelesen werden: {exc}")
        self._port_labels = {}
        values = []
        for info in self.ports:
            label = f"{info.device} – {info.description}" if info.description else info.device
            self._port_labels[label] = info.device
            values.append(label)
        self.port_box.configure(values=values)

        target = None
        if previous and any(p.device == previous for p in self.ports):
            target = previous
        elif self.settings.port and any(p.device == self.settings.port for p in self.ports):
            target = self.settings.port
        else:
            target = preferred_port(self.ports)
        if target is None and self.ports:
            target = self.ports[0].device
        self._set_port(target)

    def _set_port(self, device: Optional[str]) -> None:
        if device is None:
            self.port_var.set("")
        else:
            for label, dev in self._port_labels.items():
                if dev == device:
                    self.port_var.set(label)
                    break
        self._update_port_hint()

    def _current_port(self) -> str:
        label = self.port_var.get()
        return self._port_labels.get(label, "")

    def _update_port_hint(self) -> None:
        device = self._current_port()
        info = next((p for p in self.ports if p.device == device), None)
        if info is None:
            self.port_hint.configure(text="Kein COM-Port gefunden. NodeMCU anschließen und „Aktualisieren“ drücken.")
        elif info.vid == 0x1A86:
            self.port_hint.configure(text="CH340-USB-Adapter erkannt (automatisch gewählt).")
        else:
            self.port_hint.configure(text="Kein CH340 erkannt. Ist es der richtige Port? Sonst Treiber prüfen (README).")

    def _update_firmware_label(self) -> None:
        if self.firmware is not None:
            self.fw_label.configure(text=f"Firmware: {self.firmware}")
        else:
            self.fw_label.configure(text="Firmware nicht gefunden. Bitte mit „Firmware-Datei wählen…“ auswählen.")

    def _choose_firmware(self) -> None:
        path = filedialog.askopenfilename(
            title="Firmware-Datei wählen",
            filetypes=[("Firmware", "*.bin"), ("Alle Dateien", "*.*")],
        )
        if path:
            self.firmware = Path(path)
            self._update_firmware_label()

    def _copy_ota(self) -> None:
        self.root.clipboard_clear()
        self.root.clipboard_append(self.shown_ota_var.get())
        self.status_var.set("OTA-Passwort in die Zwischenablage kopiert.")

    def _open_browser(self) -> None:
        if self.ip:
            webbrowser.open(f"https://{self.ip}")

    # ----------------------------------------------------------- Ablauf
    def _build_config(self) -> ProvisionConfig:
        code = self._selected_country_code()
        return ProvisionConfig(
            ssid=self.ssid_var.get(),
            password=self.pass_var.get(),
            ota_password=self.ota_var.get().strip(),
            hostname=self.host_var.get(),
            country=code,
            currency=COUNTRY_CURRENCY.get(code, "EUR"),
        )

    def _start(self, mode: str) -> None:
        if self.busy:
            return
        port = self._current_port()
        if not port:
            messagebox.showerror(WINDOW_TITLE, "Bitte einen COM-Port auswählen.")
            return
        cfg = self._build_config()
        errors = validate_config(cfg)
        if mode == "flash" and self.firmware is None:
            errors.insert(0, "Keine Firmware-Datei gefunden. Bitte über „Erweitert“ auswählen.")
        if errors:
            messagebox.showerror(WINDOW_TITLE, "\n".join(errors))
            return
        if mode == "flash":
            confirmed = messagebox.askyesno(
                WINDOW_TITLE,
                "Der komplette Flash des Geräts wird gelöscht und neu beschrieben. "
                "Alte WLAN-Daten und das Zertifikat gehen dabei verloren.\n\nFortfahren?",
            )
            if not confirmed:
                return

        self._save_settings(port)
        self._set_busy(True)
        self.ip = None
        self.result.grid_remove()
        self._clear_log()
        self.progress["value"] = 0
        self.status_var.set("Läuft …")
        job = Job(mode, port, cfg, self.firmware if mode == "flash" else None)
        worker = threading.Thread(target=run_job, args=(job, self.queue.put), daemon=True, name="flasher-worker")
        worker.start()

    def _save_settings(self, port: str) -> None:
        save_settings(
            self.settings_file,
            Settings(
                port=port,
                ssid=self.ssid_var.get(),
                country=self._selected_country_code(),
                hostname=self.host_var.get().strip().lower(),
            ),
        )

    def _set_busy(self, busy: bool) -> None:
        self.busy = busy
        state = "disabled" if busy else "normal"
        self.flash_btn.configure(state=state)
        self.settings_btn.configure(state=state)

    def _poll(self) -> None:
        try:
            while True:
                self._handle(self.queue.get_nowait())
        except queue.Empty:
            pass
        self.root.after(80, self._poll)

    def _handle(self, msg: Tuple) -> None:
        kind = msg[0]
        if kind == "log":
            self._log(msg[1])
        elif kind == "status":
            self.status_var.set(msg[1])
        elif kind == "progress":
            self.progress["value"] = max(0.0, min(100.0, float(msg[1])))
        elif kind == "done":
            _, ip, ota_password, flashed = msg
            self._finished(ip, ota_password, flashed)
        elif kind == "error":
            self._set_busy(False)
            self.status_var.set("Fehler – siehe Protokoll.")
            messagebox.showerror(WINDOW_TITLE, msg[1])

    def _finished(self, ip: str, ota_password: str, flashed: bool) -> None:
        self._set_busy(False)
        self.ip = ip
        self.ip_var.set(ip)
        self.shown_ota_var.set(ota_password)
        self.result.grid(row=7, column=0, sticky="ew", padx=10, pady=4)
        self.status_var.set("Fertig. Das Gerät ist im WLAN erreichbar.")
        self._log(f"Fertig. IP-Adresse: {ip}")
        if flashed:
            self._log("Hinweis: Das OTA-Passwort wird nicht gespeichert – bitte jetzt notieren.")

    def _log(self, text: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"[{stamp}] {text}\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _clear_log(self) -> None:
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.configure(state="disabled")


def main() -> None:
    install_router()  # --windowed hat kein stdout; esptool-Ausgabe läuft über den Router ins Log
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
