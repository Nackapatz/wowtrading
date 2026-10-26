#include "provisioning.h"

#include <ArduinoJson.h>
#include <stdlib.h>
#include <string.h>

#include "config.h"
#include "util.h"

namespace {

constexpr size_t kLineMax = 4096;  // a provisioning line is about 2 KB of base64 plus margin
constexpr char kCfgPrefix[] = "WOWCFG ";
constexpr size_t kCfgPrefixLen = sizeof(kCfgPrefix) - 1;

// Line buffer, allocated only while provisioning is possible (see provisioningLoop).
char* g_line = nullptr;
size_t g_lineLength = 0;
bool g_lineOverflow = false;

bool g_readySent = false;
uint32_t g_lastReadyMs = 0;

void replyError(const char* reason) {
    Serial.print(F("WOWCFG:ERR "));
    Serial.println(reason);
}

// Reads an optional string field, returning "" when absent or not a string.
String stringField(JsonDocument& doc, const char* key) {
    const char* value = doc[key] | "";
    return String(value);
}

void applyConfig(const char* base64Json, size_t base64Length) {
    if (base64Length == 0) return replyError("empty");

    // Decoded JSON is at most 3/4 of the input; one extra byte for the NUL terminator.
    const size_t capacity = base64Length / 4 * 3 + 3;
    uint8_t* buffer = static_cast<uint8_t*>(malloc(capacity + 1));
    if (!buffer) return replyError("no_memory");

    size_t decodedLength = 0;
    if (!base64Decode(base64Json, base64Length, buffer, capacity, decodedLength)) {
        free(buffer);
        return replyError("bad_base64");
    }
    buffer[decodedLength] = '\0';

    JsonDocument doc;
    const DeserializationError error =
        deserializeJson(doc, reinterpret_cast<const char*>(buffer));
    free(buffer);
    if (error || !doc.is<JsonObject>()) return replyError("bad_json");

    DeviceConfig cfg;
    cfg.ssid = stringField(doc, "ssid");
    cfg.pass = stringField(doc, "pass");
    cfg.otaPass = stringField(doc, "otaPass");
    cfg.hostname = sanitizeHostname(stringField(doc, "hostname").c_str());
    cfg.country = stringField(doc, "country");
    cfg.currency = stringField(doc, "currency");
    cfg.dataUrl = stringField(doc, "dataUrl");
    if (cfg.country.isEmpty()) cfg.country = DEFAULT_COUNTRY;
    if (cfg.currency.isEmpty()) cfg.currency = DEFAULT_CURRENCY;
    if (cfg.dataUrl.isEmpty()) cfg.dataUrl = DATA_URL;

    if (cfg.ssid.isEmpty() || cfg.ssid.length() > 32) return replyError("ssid");
    if (cfg.pass.length() > 63) return replyError("pass");
    if (cfg.otaPass.isEmpty() || cfg.otaPass.length() > 63) return replyError("otaPass");

    const String cert = stringField(doc, "cert");
    const String key = stringField(doc, "key");
    const bool hasCert = !cert.isEmpty() || !key.isEmpty();
    if (hasCert && !isCertPemValid(cert, key)) return replyError("cert_key");

    if (hasCert && !certSave(cert, key)) return replyError("save_failed");
    if (!configSave(cfg)) return replyError("save_failed");

    Serial.println(F("WOWCFG:OK"));
    Serial.flush();
    scheduleRestart(300);
}

void handleLine(const char* line, size_t length, bool overflow) {
    if (length < kCfgPrefixLen || strncmp(line, kCfgPrefix, kCfgPrefixLen) != 0) return;
    if (overflow) return replyError("line_too_long");
    applyConfig(line + kCfgPrefixLen, length - kCfgPrefixLen);
}

void announceReady() {
    Serial.print(F("WOWSCAN:READY "));
    Serial.println(FW_VERSION);
}

}  // namespace

void provisioningLoop(bool configured) {
    const uint32_t now = millis();

    // Provisioning is possible while unconfigured and during the boot window.
    // A configured device past the window frees its line buffer (RAM).
    const bool inBootWindow = now < SERIAL_READY_BOOT_WINDOW_MS;
    const bool canProvision = !configured || inBootWindow;
    if (!canProvision) {
        if (g_line) {
            free(g_line);
            g_line = nullptr;
            g_lineLength = 0;
            g_lineOverflow = false;
        }
        return;
    }
    if (!g_line) {
        g_line = static_cast<char*>(malloc(kLineMax + 1));
        if (!g_line) return;  // no RAM: provisioning is unavailable until the next loop
    }

    // Announce while unconfigured, and for the boot window after reset,
    // so a host that connects late still sees the device.
    if (!g_readySent || now - g_lastReadyMs >= SERIAL_READY_INTERVAL_MS) {
        announceReady();
        g_readySent = true;
        g_lastReadyMs = now;
    }

    while (Serial.available() > 0) {
        const int c = Serial.read();
        if (c < 0) break;

        if (c == '\n' || c == '\r') {
            if (g_lineLength > 0 || g_lineOverflow) {
                g_line[g_lineLength] = '\0';
                handleLine(g_line, g_lineLength, g_lineOverflow);
            }
            g_lineLength = 0;
            g_lineOverflow = false;
        } else if (g_lineLength < kLineMax) {
            g_line[g_lineLength++] = static_cast<char>(c);
        } else {
            g_lineOverflow = true;
        }
    }
}
