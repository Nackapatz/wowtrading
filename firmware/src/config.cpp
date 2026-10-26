#include "config.h"

#include <ArduinoJson.h>
#include <LittleFS.h>

#include "util.h"

DeviceConfig gConfig;

namespace {

// Hostnames: 1-31 characters, a-z, 0-9 and '-', no leading or trailing '-'.
bool isValidHostname(const String& name) {
    if (name.isEmpty() || name.length() > 31) return false;
    for (unsigned int i = 0; i < name.length(); ++i) {
        const char c = name[i];
        const bool allowed = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
        if (!allowed) return false;
    }
    return name[0] != '-' && name[name.length() - 1] != '-';
}

bool readWholeFile(const char* path, String& out) {
    File file = LittleFS.open(path, "r");
    if (!file) return false;
    out = file.readString();
    file.close();
    return !out.isEmpty();
}

bool writeWholeFile(const char* path, const String& content) {
    File file = LittleFS.open(path, "w");
    if (!file) return false;
    const size_t written = file.print(content);
    file.close();
    return written == content.length();
}

}  // namespace

bool storageBegin() {
    if (LittleFS.begin()) return true;
    // First boot after a full flash erase: the filesystem is unformatted.
    if (!LittleFS.format()) return false;
    return LittleFS.begin();
}

bool configLoad() {
    File file = LittleFS.open(CONFIG_FILE, "r");
    if (!file) return false;

    JsonDocument doc;
    const DeserializationError error = deserializeJson(doc, file);
    file.close();
    if (error) return false;

    gConfig.ssid = doc["ssid"] | "";
    gConfig.pass = doc["pass"] | "";
    gConfig.otaPass = doc["otaPass"] | "";
    gConfig.hostname = sanitizeHostname(doc["hostname"] | "");
    gConfig.country = doc["country"] | DEFAULT_COUNTRY;
    gConfig.currency = doc["currency"] | DEFAULT_CURRENCY;
    gConfig.dataUrl = doc["dataUrl"] | DATA_URL;
    if (gConfig.dataUrl.isEmpty()) gConfig.dataUrl = DATA_URL;
    return true;
}

bool configSave(const DeviceConfig& cfg) {
    JsonDocument doc;
    doc["ssid"] = cfg.ssid;
    doc["pass"] = cfg.pass;
    doc["otaPass"] = cfg.otaPass;
    doc["hostname"] = cfg.hostname;
    doc["country"] = cfg.country;
    doc["currency"] = cfg.currency;
    doc["dataUrl"] = cfg.dataUrl;

    File file = LittleFS.open(CONFIG_FILE, "w");
    if (!file) return false;
    const size_t written = serializeJson(doc, file);
    file.close();
    if (written == 0) return false;

    // Keep the in-RAM copy in sync; callers that need it do not reload.
    gConfig = cfg;
    return true;
}

bool configIsComplete(const DeviceConfig& cfg) {
    return !cfg.ssid.isEmpty() && !cfg.otaPass.isEmpty();
}

String sanitizeHostname(const char* raw) {
    String name = raw ? String(raw) : String();
    name.toLowerCase();
    if (isValidHostname(name)) return name;
    return DEFAULT_HOSTNAME;
}

bool isCertPemValid(const String& certPem, const String& keyPem) {
    const bool hasKey = containsPemBlock(keyPem, "EC PRIVATE KEY") ||
                        containsPemBlock(keyPem, "PRIVATE KEY");
    return containsPemBlock(certPem, "CERTIFICATE") && hasKey;
}

bool certLoad(String& certPem, String& keyPem) {
    if (!readWholeFile(CERT_FILE, certPem) || !readWholeFile(KEY_FILE, keyPem)) return false;
    return isCertPemValid(certPem, keyPem);
}

bool certSave(const String& certPem, const String& keyPem) {
    return writeWholeFile(CERT_FILE, certPem) && writeWholeFile(KEY_FILE, keyPem);
}
