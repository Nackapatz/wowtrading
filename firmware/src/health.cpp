#include "health.h"

#include <ArduinoJson.h>
#include <LittleFS.h>
#include <user_interface.h>

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
String g_bootInfo;

// RTC user memory survives a reset (not a power cut). Blocks of 4 bytes; the
// first 32 blocks belong to eboot (OTA), so this starts at block 64.
constexpr uint32_t kRtcBlock = 64;
constexpr uint32_t kRtcMagic = 0x57534331;  // "WSC1"
constexpr uint8_t kTraceMax = 12;

struct RtcState {
    uint32_t magic;
    uint32_t uptimeS;      // last health check before the reset
    uint32_t minHeap;
    uint32_t maxBlock;
    uint32_t idleS;        // seconds since the last request at that check
    uint32_t planned;      // 1..3 = restartFor reason, 0 = none
    uint32_t traceN;       // code addresses found on the stack by the crash callback
    uint32_t trace[kTraceMax];
};
RtcState g_rtc;

const char* const kPlannedText[] = {"", "WLAN weg", "Speicher knapp", "Wartung"};

void rtcSave() {
    g_rtc.magic = kRtcMagic;
    ESP.rtcUserMemoryWrite(kRtcBlock, reinterpret_cast<uint32_t*>(&g_rtc), sizeof(g_rtc));
}

void restartFor(uint8_t code) {
    if (g_restarting) return;
    g_restarting = true;
    const char* reason = kPlannedText[code];
    g_rtc.planned = code;
    rtcSave();
    Serial.print(F("WOWSCAN:RESTART "));
    Serial.println(reason);
    displayNotice("Neustart", reason, 0);
    scheduleRestart(500);
}

String hex(uint32_t v) {
    char buf[11];
    snprintf(buf, sizeof(buf), "0x%08x", static_cast<unsigned>(v));
    return buf;
}

}  // namespace

// Called by the core on an exception or watchdog reset, before the restart.
// Only RTC memory is safe here: it keeps the code addresses found on the stack
// (flash 0x402..., IRAM 0x401...), which `addr2line -e firmware.elf` turns into functions.
extern "C" void custom_crash_callback(struct rst_info*, uint32_t stack, uint32_t stackEnd) {
    uint32_t n = 0;
    for (uint32_t p = stack; p + 4 <= stackEnd && n < kTraceMax; p += 4) {
        const uint32_t v = *reinterpret_cast<const uint32_t*>(p);
        if ((v >= 0x40200000 && v < 0x40300000) || (v >= 0x40100000 && v < 0x40108000)) g_rtc.trace[n++] = v;
    }
    g_rtc.traceN = n;
    rtcSave();
}

void healthBoot() {
    RtcState prev;
    const bool have = ESP.rtcUserMemoryRead(kRtcBlock, reinterpret_cast<uint32_t*>(&prev), sizeof(prev)) && prev.magic == kRtcMagic;
    memset(&g_rtc, 0, sizeof(g_rtc));
    rtcSave();

    const rst_info* ri = ESP.getResetInfoPtr();
    const uint32_t reason = ri->reason;
    const uint32_t planned = have && prev.planned < 4 ? prev.planned : 0;
    // Power-on and the flasher's reset are normal; OTA/config restarts are software restarts without a plan code.
    const bool crash = reason == REASON_EXCEPTION_RST || reason == REASON_SOFT_WDT_RST || reason == REASON_WDT_RST;
    if (crash) {
        g_bootInfo = ESP.getResetReason();
        if (reason == REASON_EXCEPTION_RST) g_bootInfo += " " + String(ri->exccause) + " @" + hex(ri->epc1);
    } else if (planned) {
        g_bootInfo = String(F("Neustart: ")) + kPlannedText[planned];
    } else {
        g_bootInfo = ESP.getResetReason();
        return;
    }

    JsonDocument doc;
    doc["fw"] = FW_VERSION;
    doc["reason"] = ESP.getResetReason();
    if (planned) doc["planned"] = kPlannedText[planned];
    if (crash) doc["epc"] = hex(ri->epc1);
    if (reason == REASON_EXCEPTION_RST) {
        doc["exc"] = ri->exccause;
        doc["excvaddr"] = hex(ri->excvaddr);
    }
    if (have) {
        doc["prevUp"] = prev.uptimeS;
        doc["prevMinHeap"] = prev.minHeap;
        doc["prevMaxBlock"] = prev.maxBlock;
        doc["prevIdle"] = prev.idleS;
        if (crash && prev.traceN) {
            JsonArray bt = doc["bt"].to<JsonArray>();
            for (uint32_t i = 0; i < prev.traceN && i < kTraceMax; ++i) bt.add(hex(prev.trace[i]));
        }
    }
    File old = LittleFS.open(CRASH_FILE, "r");
    const bool full = old && old.size() > CRASH_MAX_BYTES;
    if (old) old.close();
    if (full) LittleFS.remove(CRASH_FILE);
    File file = LittleFS.open(CRASH_FILE, "a");
    if (!file) return;
    serializeJson(doc, file);
    file.write('\n');
    file.close();
}

const String& healthBootInfo() {
    return g_bootInfo;
}

void healthLoop(bool wifiUp) {
    const uint32_t now = millis();
    const uint32_t freeHeap = ESP.getFreeHeap();
    if (freeHeap < g_minFreeHeap) g_minFreeHeap = freeHeap;

    if (now - g_lastCheck < HEALTH_CHECK_MS) return;
    g_lastCheck = now;

    // Breadcrumbs for the next boot's crash record
    g_rtc.uptimeS = now / 1000;
    g_rtc.minHeap = g_minFreeHeap;
    g_rtc.maxBlock = ESP.getMaxFreeBlockSize();
    g_rtc.idleS = webserverIdleMs() / 1000;
    rtcSave();

    // WLAN gone for minutes: a fresh start of the WiFi stack usually helps
    // where auto-reconnect got stuck.
    if (wifiUp) {
        g_wifiDownSince = 0;
    } else {
        if (g_wifiDownSince == 0) g_wifiDownSince = now ? now : 1;
        if (now - g_wifiDownSince >= WIFI_DOWN_RESTART_MS) restartFor(1);
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
        if (++g_lowHeapChecks >= LOW_HEAP_CHECKS) restartFor(2);
    } else {
        g_lowHeapChecks = 0;
    }

    // Planned restart once a day, only while unused.
    if (now >= MAINT_RESTART_MS && idle >= MAINT_IDLE_MS) restartFor(3);
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
