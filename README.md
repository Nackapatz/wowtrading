# WoW Trading Card Price Scanner

Ein kleiner Kartenscanner für das **World of Warcraft Trading Card Game**: Ein NodeMCU (ESP8266) mit OLED-Display und eine Web-App auf dem Handy. Du hältst eine Karte vor die Handykamera, die App erkennt Name und Nummer per OCR, der Scanner speichert den Fund auf dem Gerät und zeigt Name, Set, Seltenheit und Preis auf dem Display.

Das Projekt ist inoffiziell und steht in keiner Verbindung zu Blizzard Entertainment. Es werden keine Blizzard-Grafiken oder -Logos verwendet.

## Was du brauchst

- **NodeMCU ESP8266** (Board `nodemcuv2`, 4 MB Flash, USB-Seriell-Chip CH340)
- **0,96" OLED-Display**, 128 x 64 Pixel, SSD1306, I2C (Adresse 0x3C). Verdrahtung meist SDA an D5 und SCL an D6; die Firmware erkennt beide üblichen Belegungen selbst.
- **USB-Datenkabel** (kein reines Ladekabel)
- **Windows-PC** für die Ersteinrichtung mit dem Flasher
- **Handy** mit aktuellem Browser (Chrome, Edge oder Safari) und Kamera, für den Scan
- **WLAN mit 2,4 GHz.** Der ESP8266 kann kein 5-GHz-WLAN.

## Ersteinrichtung mit dem Flasher

Der Flasher ist eine einzelne Datei, `WoWScannerFlasher.exe`. Du findest sie im neuesten Release unter „Releases“ auf GitHub, zusammen mit `firmware.bin`. Beide Dateien in denselben Ordner legen.

1. **Treiber prüfen.** Schließe das NodeMCU per USB an. Der Flasher erkennt den CH340-Chip automatisch. Falls kein COM-Port erscheint, siehe [Fehlerbehebung](#fehlerbehebung).
2. **Flasher starten.** Windows SmartScreen meldet bei nicht signierten Programmen oft eine Warnung. Dann „Weitere Informationen“ und „Trotzdem ausführen“ wählen.
3. **COM-Port wählen.** Der CH340-Port ist vorausgewählt. Mit „Aktualisieren“ liest du die Liste neu ein.
4. **WLAN eintragen.** WLAN-Name (SSID) und WLAN-Passwort. Das Passwort ist versteckt; „anzeigen“ zeigt es an. Land und Hostname lassen sich ändern. Der Hostname ist der Name im Netzwerk, Standard ist `wowscanner`.
5. **OTA-Passwort notieren.** Der Flasher schlägt ein zufälliges Passwort vor. Es wird für Firmware-Updates per WLAN gebraucht und **nicht gespeichert**. Notiere es, bevor du weitermachst.
6. **„Flashen + Einrichten“ drücken.** Der Flasher löscht den Flash, schreibt die Firmware, erzeugt ein eigenes Zertifikat und überträgt die Einstellungen. Das dauert ein bis zwei Minuten.
7. **IP-Adresse ablesen.** Am Ende zeigt der Flasher die IP-Adresse groß an. Mit „Im Browser öffnen“ startest du die Web-App direkt am PC.

**Achtung:** „Flashen + Einrichten“ löscht den gesamten Speicher des Geräts, also auch alle bisher gespeicherten Scans. Exportiere deine Sammlung in der Web-App, bevor du neu flashst.

Mit „Nur WLAN/Einstellungen ändern“ werden WLAN und Land geändert, ohne neu zu flashen. Das Zertifikat bleibt dabei erhalten.

## Die Web-App auf dem Handy

Die Web-App kommt direkt vom Scanner. Das Gerät läuft mit HTTPS.

1. Verbinde das Handy mit **demselben WLAN** wie den Scanner.
2. Öffne im Browser `https://<IP-Adresse>` (die IP steht im Flasher und auf dem OLED-Display), alternativ `https://wowscanner.local` (bzw. dein Hostname). Den Hostnamen über mDNS erkennen Android-Geräte oft nicht; dann die IP nutzen.
3. **Zertifikatswarnung akzeptieren.** Das Zertifikat ist selbst signiert, deshalb warnt der Browser. Das ist erwartet und sicher, weil die Verbindung zu deinem eigenen Gerät geht. So geht es:
   - **Chrome (Android):** „Erweitert“ antippen, dann „Weiter zu <IP> (unsicher)“.
   - **Safari (iPhone):** „Details anzeigen“, dann „Diese Website besuchen“ und bestätigen.
   - **Edge (Android):** „Erweitert“, dann „Weiter zu … (unsicher)“.
4. Die Web-App lädt die Kartendaten (einmal, danach aus dem Cache). Erlaube den Kamerazugriff.
5. **Scannen:** „Scan starten“ drücken und die Karte in den Rahmen halten. Erkannte Karten erscheinen in der Liste und auf dem Display. Dieselbe Karte wird nicht doppelt gezählt, solange sie im Bild bleibt. Ist die Erkennung unsicher, zeigt die App Vorschläge zum Antippen. Über die Suche trägst du Karten auch manuell ein.
6. **Sammlung:** Menge ändern, Einträge löschen und Summen einsehen. Über „Export“ gibt es CSV (Semikolon, für Excel), JSON und einen Kurzbericht.

Die Kartennamen sind englisch. Deutsche Kartenausgaben werden über die englischen Namen erkannt, wenn der Name sich ähnlich genug ist.

### Preise

**Preisquelle:** TCGplayer-Marktpreise (US) via tcgcsv.com, umgerechnet mit EZB-Referenzkursen.

Die Preise sind Marktpreise aus den USA in US-Dollar, umgerechnet in deine Währung. Sie sind keine Verkaufsangebote und keine Garantie. Fehlt ein Preis für eine Karte, zeigt die App „kein Preis“ und erfindet keinen Wert. Die Preise entstehen einmal täglich über die GitHub-Pages-Datenbasis. Die App zeigt den Stand der Preise an.

## Firmware-Update (OTA)

Es gibt zwei Wege. Beide nutzen das OTA-Passwort aus der Ersteinrichtung. Das Update ändert nur das Programm. WLAN, Zertifikat und Scans bleiben erhalten.

**Über die Web-App:** Die Web-App bietet einen Firmware-Upload für eine `.bin`-Datei. Die `firmware.bin` aus dem Release wählen und das OTA-Passwort eingeben. Nach dem Upload startet das Gerät neu.

**Über ArduinoOTA:** Im Arduino-Netzwerkport (IP oder `<hostname>.local`, Port 8266) das OTA-Passwort eingeben. Das passt für Entwickler, die aus dem Quellcode bauen.

## Aus dem Quellcode bauen

- Firmware: `pio run -d firmware` (PlatformIO, Board `nodemcuv2`). Vorher `python tools/make_logo.py`, `python tools/embed_web.py` und `python tools/make_default_cert.py` ausführen.
- Flasher aus dem Quellcode starten: `python flasher/flasher.py` (Python 3.11 mit tkinter). Die Firmware wird aus `firmware/.pio/build/nodemcuv2/firmware.bin` gelesen oder über „Firmware-Datei wählen…“ im Bereich „Erweitert“.
- EXE bauen: `flasher\build_exe.ps1` unter Windows. Der GitHub-Workflow `.github/workflows/build.yml` baut Firmware und EXE bei jedem Push und veröffentlicht bei Tags `v*` ein Release.

## Fehlerbehebung

**Kein COM-Port im Flasher.**
- Ist das Kabel ein Datenkabel? Viele USB-Kabel laden nur.
- CH340-Treiber installieren (siehe unten), dann den PC neu starten oder das NodeMCU abziehen und wieder einstecken.
- „Aktualisieren“ drücken.

**CH340-Treiber.** Das NodeMCU hat einen CH340-USB-Chip. Windows 10 und 11 installieren den Treiber meist automatisch. Wenn nicht, lade den Treiber „CH341SER“ von der Herstellerseite WCH (wch-ic.com) herunter und installiere ihn. Danach im Geräte-Manager unter „Anschlüsse (COM und LPT)“ prüfen, ob „USB-SERIAL CH340 (COMx)“ erscheint.

**„Port belegt“ oder „Could not open port“.** Ein anderes Programm hat den Port offen, etwa der Serial Monitor der Arduino IDE oder PuTTY. Schließe es und versuche es erneut.

**Verbindung beim Flashen schlägt fehl.** Trenne das NodeMCU, halte die Taste FLASH (GPIO0) gedrückt, stecke das USB-Kabel ein und lasse die Taste nach zwei Sekunden los. Dann erneut „Flashen + Einrichten“ drücken. Der Flasher versucht es automatisch auch mit 115200 Baud.

**Das Display zeigt „WLAN-Fehler“.** Name und Passwort prüfen. Das Netz muss 2,4 GHz haben. Mit „Nur WLAN/Einstellungen ändern“ korrigieren. Das Gerät versucht es alle 30 Sekunden erneut.

**Der Flasher meldet „Das Gerät meldet sich nicht“.** Gerät neu starten, Kabel und COM-Port prüfen. Der Flasher startet das Gerät selbst per DTR/RTS neu, wenn es nach 5 Sekunden nichts meldet.

**Die Web-App lädt nicht / keine Kamera.** Kamera und Scan brauchen HTTPS. Die Zertifikatswarnung muss akzeptiert werden (siehe oben). Das Handy muss im selben WLAN sein.

**Keine Preise.** Die Preisdaten werden aus dem Internet geladen. Ohne Verbindung nutzt die App die zuletzt geladenen Daten. Ist die Karte in den Daten nicht vorhanden, steht dort „kein Preis“.

**Die Sammlung ist nach dem Flashen leer.** Das ist erwartet, siehe Warnung bei der Ersteinrichtung. Exportiere vorher.

**Das OTA-Passwort ist verloren.** Dann hilft nur eine neue Ersteinrichtung mit dem Flasher. Das löscht den Flash.

**Windows meldet die EXE als unbekannt.** Das Programm ist nicht signiert. Siehe SmartScreen-Hinweis oben. Die Datei stammt aus dem offiziellen Release dieses Repositorys, du kannst den Quellcode selbst prüfen und bauen.

## Hinweise

Inoffizielles Fan-Projekt. World of Warcraft und das Trading Card Game sind Marken der Blizzard Entertainment, Inc. Dieses Projekt enthält keine Blizzard-Assets.
