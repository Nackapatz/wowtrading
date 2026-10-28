#include "health.h"

#include "config.h"
#include "display.h"
#include "util.h"
#include "webserver.h"

namespace {

uint32_t g_lastCheck = 0;
uint32_t g_wifiDownSince = 0;  // 0 = connected
uint32_t g_minFreeHeap = UINT32_MAX;
uint32_t g_wifiDrops = 0;
uint8_t g_lowHeapChecks = 0;
bool g_restarting = false;

void restartFor(const char* reason) {
    if (g_restarting) return;
    g_restarting = true;
    Serial.print(F("WOWSCAN:RESTART "));
    Serial.println(reason);
    displayNotice("Neustart", reason, 0);
    scheduleRestart(500);
}

}  // namespace

void healthLoop(bool wifiUp) {
    const uint32_t now = millis();
    const uint32_t freeHeap = ESP.getFreeHeap();
    if (freeHeap < g_minFreeHeap) g_minFreeHeap = freeHeap;

    if (now - g_lastCheck < HEALTH_CHECK_MS) return;
    g_lastCheck = now;

    // WLAN gone for minutes: a fresh start of the WiFi stack usually helps
    // where auto-reconnect got stuck.
    if (wifiUp) {
        g_wifiDownSince = 0;
    } else {
        if (g_wifiDownSince == 0) g_wifiDownSince = now ? now : 1;
        if (now - g_wifiDownSince >= WIFI_DOWN_RESTART_MS) restartFor("WLAN weg");
        return;
    }

    // Only judge the heap while nobody is using the scanner: during a TLS
    // connection the buffers are allocated and the numbers say nothing.
    const uint32_t idle = webserverIdleMs();
    if (idle < BUSY_IDLE_MS) {
        g_lowHeapChecks = 0;
        return;
    }

    // Largest free block too small for the next TLS connection, several times in a row.
    if (ESP.getMaxFreeBlockSize() < LOW_HEAP_BLOCK) {
        if (++g_lowHeapChecks >= LOW_HEAP_CHECKS) restartFor("Speicher knapp");
    } else {
        g_lowHeapChecks = 0;
    }

    // Planned restart once a day, only while unused.
    if (now >= MAINT_RESTART_MS && idle >= MAINT_IDLE_MS) restartFor("Wartung");
}

void healthNoteWifiDrop() {
    ++g_wifiDrops;
}

uint32_t healthMinFreeHeap() {
    return g_minFreeHeap;
}

uint32_t healthWifiDrops() {
    return g_wifiDrops;
}
