// WoW Trading Card Price Scanner - ESP8266 firmware entry point.
//
// The loop never blocks: every step is either a short poll or a timer check
// based on millis(). Modules:
//   config       LittleFS, /config.json, certificate files
//   provisioning serial setup protocol (WOWCFG)
//   display      OLED screens (U8g2)
//   webserver    HTTPS app + API, HTTP redirect
//   scans        scan records in LittleFS
//   ota          ArduinoOTA and web upload
//   health       WLAN/heap watchdog for long-term use
#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266mDNS.h>

#include "config.h"
#include "display.h"
#include "health.h"
#include "ota.h"
#include "provisioning.h"
#include "scans.h"
#include "util.h"
#include "webserver.h"

namespace {

bool g_configured = false;
uint32_t g_splashUntil = 0;  // 0 = splash finished

bool g_wifiUp = false;
bool g_ipReported = false;
bool g_servicesStarted = false;
uint32_t g_wifiAttemptStart = 0;

// Sets up mDNS, OTA and the web servers once the first connection is up.
void startServices() {
    if (g_servicesStarted) return;
    g_servicesStarted = true;

    if (MDNS.begin(gConfig.hostname.c_str())) {
        MDNS.addService("https", "tcp", HTTPS_PORT);
    }
    otaBegin(gConfig);
    webserverBegin();
    Serial.print(F("WOWSCAN:HEAP "));
    Serial.println(ESP.getFreeHeap());
}

void wifiBegin() {
    WiFi.persistent(false);  // do not rewrite flash on every connect
    WiFi.mode(WIFI_STA);
    // Modem sleep saves little on USB power but delays and drops incoming
    // connections; a server that must stay reachable keeps the radio awake.
    WiFi.setSleepMode(WIFI_NONE_SLEEP);
    WiFi.setAutoReconnect(true);
    WiFi.hostname(gConfig.hostname);
    WiFi.begin(gConfig.ssid.c_str(), gConfig.pass.c_str());
    g_wifiAttemptStart = millis();

    if (g_splashUntil == 0) displayMessage("WLAN verbinden...", gConfig.ssid.c_str());
}

// Connection state machine: report the IP, retry every 30 s after a failure.
void wifiLoop() {
    const bool up = WiFi.status() == WL_CONNECTED;

    if (up && !g_wifiUp) {
        g_wifiUp = true;
        const String ip = WiFi.localIP().toString();
        if (!g_ipReported) {
            Serial.print(F("WOWSCAN:IP "));
            Serial.println(ip);
            g_ipReported = true;
        }
        startServices();
        if (g_splashUntil == 0) displayIdle(ip, scansCount());
    } else if (!up && g_wifiUp) {
        // Dropped after a working connection: give auto-reconnect a full window.
        g_wifiUp = false;
        g_wifiAttemptStart = millis();
        healthNoteWifiDrop();
        if (g_splashUntil == 0) displayMessage("WLAN getrennt", gConfig.ssid.c_str(), "Verbinde neu...");
    }

    if (!up && static_cast<uint32_t>(millis() - g_wifiAttemptStart) >= WIFI_RETRY_MS) {
        Serial.println(F("WOWSCAN:WIFIFAIL"));
        if (g_splashUntil == 0) displayMessage("WLAN-Fehler", gConfig.ssid.c_str(), "Neuer Versuch...");
        WiFi.disconnect(false);
        WiFi.begin(gConfig.ssid.c_str(), gConfig.pass.c_str());
        g_wifiAttemptStart = millis();
    }
}

// Shown once the splash is over, based on the state at that moment.
void showAfterSplash() {
    if (!g_configured) {
        displayMessage("Warte auf Flasher...", "Seriell verbinden", "115200 Baud");
    } else if (g_wifiUp) {
        displayIdle(WiFi.localIP().toString(), scansCount());
    } else {
        displayMessage("WLAN verbinden...", gConfig.ssid.c_str());
    }
}

}  // namespace

void setup() {
    Serial.setRxBufferSize(1024);  // the flasher sends WOWCFG in 256-byte chunks
    Serial.begin(115200);

    displayBegin();
    displaySplash();
    g_splashUntil = millis() + SPLASH_MS;

    storageBegin();
    healthBoot();
    scansBegin();
    g_configured = configLoad() && configIsComplete(gConfig);

    if (g_configured) wifiBegin();
}

void loop() {
    provisioningLoop(g_configured);

    if (g_splashUntil != 0 && static_cast<int32_t>(millis() - g_splashUntil) >= 0) {
        g_splashUntil = 0;
        showAfterSplash();
    }

    if (g_configured) {
        wifiLoop();
        healthLoop(g_wifiUp);
    }

    if (g_wifiUp && g_servicesStarted) {
        MDNS.update();
        otaLoop();
        webserverLoop();
    }

    displayTick();
    restartIfDue();
    yield();
}
