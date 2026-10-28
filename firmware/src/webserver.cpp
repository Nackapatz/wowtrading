#include "webserver.h"

#include <ArduinoJson.h>
#include <BearSSLHelpers.h>
#include <ESP8266WebServer.h>
#include <ESP8266WebServerSecure.h>
#include <ESP8266WiFi.h>
#include <LittleFS.h>
#include <StackThunk.h>

#include "config.h"
#include "display.h"
#include "health.h"
#include "ota.h"
#include "scans.h"
#include "util.h"

#if !__has_include("web_assets.h")
#error "include/web_assets.h fehlt: python3 tools/embed_web.py ausfuehren"
#endif
#include "web_assets.h"

#if !__has_include("default_cert.h")
#error "include/default_cert.h fehlt: python3 tools/make_default_cert.py ausfuehren (pip install cryptography)"
#endif
#include "default_cert.h"

namespace {

BearSSL::ESP8266WebServerSecure https(HTTPS_PORT);
ESP8266WebServer httpRedirect(HTTP_REDIRECT_PORT);

// Session cache: resumes TLS sessions for fast follow-up requests from the phone.
BearSSL::ServerSessions sessionCache(5);

// Parsed certificate chain and key. BearSSL copies the PEM input while parsing,
// so the PEM text itself is not kept. These objects live for the whole run.
BearSSL::X509List* g_chain = nullptr;
BearSSL::PrivateKey* g_privateKey = nullptr;

// Time of the last HTTPS request, for the health checks (health.cpp).
uint32_t g_lastRequestMs = 0;

// Headers read with header() (OTA upload, asset ETag); they must be collected before begin().
const char* kCollectedHeaders[] = {"X-OTA-Pass", "Content-Length", "If-None-Match"};

String currentIp() {
    return WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String();
}

void sendJson(int code, JsonDocument& doc) {
    char buffer[768];
    serializeJson(doc, buffer, sizeof(buffer));
    https.sendHeader("Cache-Control", "no-store");
    https.send(code, "application/json; charset=utf-8", buffer);
}

void sendOk() {
    JsonDocument doc;
    doc["ok"] = true;
    sendJson(200, doc);
}

void sendError(int code, const char* error) {
    JsonDocument doc;
    doc["ok"] = false;
    doc["error"] = error;
    sendJson(code, doc);
}

// Reads a JSON value as text. Numbers are converted; anything else becomes "".
String textOf(JsonVariantConst value) {
    if (value.is<const char*>()) return String(value.as<const char*>());
    if (value.is<int>()) return String(value.as<int>());
    return String();
}

// True if text has exactly `length` ASCII upper-case letters.
bool isCode(const String& text, unsigned int length) {
    if (text.length() != length) return false;
    for (unsigned int i = 0; i < length; ++i) {
        if (text[i] < 'A' || text[i] > 'Z') return false;
    }
    return true;
}

// Builds the overlay content from a stored scan record.
CardView makeCardView(JsonDocument& scan) {
    CardView view;
    view.name = textOf(scan["name"]);
    // TCGplayer has no set code for many WoW sets; fall back to the set name.
    view.setLine = textOf(scan["setCode"]);
    if (view.setLine.isEmpty()) view.setLine = textOf(scan["set"]);
    const String number = textOf(scan["number"]);
    if (!number.isEmpty()) view.setLine += view.setLine.isEmpty() ? "#" + number : " #" + number;
    view.rarity = textOf(scan["rarity"]);

    const JsonVariantConst price = scan["price"];
    if (price.isNull()) {
        view.price = "kein Preis";
    } else {
        const String currency = textOf(scan["currency"]);
        view.price = formatMoney(price.as<double>(), currency.isEmpty() ? gConfig.currency.c_str() : currency.c_str());
    }
    return view;
}

// Serves one gzip-compressed asset from flash. send_P gives up after 1 s
// without progress; with little free heap TCP stalls longer than that and
// larger files (app.js) arrived cut off. So the body is written here in
// pieces, and only a stall of kAssetStallMs ends the transfer.
constexpr size_t kAssetChunk = 1024;
constexpr uint32_t kAssetStallMs = 10000;

// The assets only change with a new build, so the build time is the ETag. With
// "no-cache" the browser asks every time and gets a 304 without a body.
const char kAssetEtag[] = "\"" FW_VERSION "-" __DATE__ " " __TIME__ "\"";

void sendAsset(const WebAsset& asset) {
    https.sendHeader("ETag", kAssetEtag);
    https.sendHeader("Cache-Control", "no-cache");
    if (https.header("If-None-Match") == kAssetEtag) {
        https.send(304);
        return;
    }
    https.sendHeader("Content-Encoding", "gzip");
    https.setContentLength(asset.length);
    https.send(200, asset.mime, "");

    auto& client = https.client();
    const uint8_t* data = asset.data;
    size_t remaining = asset.length;
    uint32_t lastProgress = millis();
    while (remaining > 0 && client.connected()) {
        const size_t chunk = remaining < kAssetChunk ? remaining : kAssetChunk;
        const size_t written = client.write_P(reinterpret_cast<PGM_P>(data), chunk);
        if (written > 0) {
            data += written;
            remaining -= written;
            lastProgress = millis();
        } else if (millis() - lastProgress > kAssetStallMs) {
            break;
        }
        yield();
    }
}

void handleStatus() {
    JsonDocument doc;
    const String ip = currentIp();
    doc["version"] = FW_VERSION;
    doc["ip"] = ip;
    doc["hostname"] = gConfig.hostname;
    doc["scans"] = scansCount();
    doc["freeHeap"] = ESP.getFreeHeap();
    doc["maxBlock"] = ESP.getMaxFreeBlockSize();
    doc["heapFrag"] = ESP.getHeapFragmentation();
    doc["minHeap"] = healthMinFreeHeap();
    doc["rssi"] = WiFi.RSSI();
    doc["wifiDrops"] = healthWifiDrops();
    doc["resetReason"] = ESP.getResetReason();
    doc["uptime"] = millis() / 1000;
    doc["country"] = gConfig.country;
    doc["currency"] = gConfig.currency;
    doc["dataUrl"] = gConfig.dataUrl;
    sendJson(200, doc);
}

void handleScanPost() {
    const String body = https.arg("plain");
    if (body.isEmpty() || body.length() > MAX_SCAN_BODY) return sendError(400, "bad_size");

    JsonDocument scan;
    if (deserializeJson(scan, body.c_str()) != DeserializationError::Ok || !scan.is<JsonObject>()) {
        return sendError(400, "bad_json");
    }

    uint32_t id = 0;
    switch (scansAppend(scan, id)) {
        case ScanStatus::Ok:
            break;
        case ScanStatus::LimitReached:
            return sendError(507, "limit_reached");
        case ScanStatus::StorageFull:
            return sendError(507, "storage_full");
        case ScanStatus::IoError:
            return sendError(500, "io_error");
        default:
            return sendError(500, "unknown_status");
    }

    displayCard(makeCardView(scan), CARD_HOLD_MS);
    displayIdle(currentIp(), scansCount());

    JsonDocument response;
    response["ok"] = true;
    response["id"] = id;
    sendJson(200, response);
}

// Streams the stored scans as one JSON array. A first pass over the file gives
// the exact length, so the body goes out with Content-Length in ~1.4 KB blocks.
// (Chunked mode sent three TLS records per scan, each waiting for its ACK; with
// a few hundred scans that took minutes and blocked the server.)
constexpr size_t kScanBlock = 1400;
char g_scanBlock[kScanBlock];

void handleScansGet() {
    size_t total = 0;
    scansStream([&](const char*, size_t length) { total += length; });

    https.sendHeader("Cache-Control", "no-store");
    https.setContentLength(total);
    https.send(200, "application/json; charset=utf-8", "");

    auto& client = https.client();
    size_t used = 0;
    bool ok = true;
    auto flushBlock = [&]() {
        if (ok && used > 0 && client.write(reinterpret_cast<const uint8_t*>(g_scanBlock), used) != used) ok = false;
        used = 0;
    };
    scansStream([&](const char* data, size_t length) {
        while (ok && length > 0) {
            const size_t n = length < kScanBlock - used ? length : kScanBlock - used;
            memcpy(g_scanBlock + used, data, n);
            used += n;
            data += n;
            length -= n;
            if (used == kScanBlock) flushBlock();
        }
    });
    flushBlock();
}

bool readIdArg(uint32_t& id) {
    if (!https.hasArg("id")) return false;
    id = static_cast<uint32_t>(https.arg("id").toInt());
    return id != 0;
}

void handleScansPatch() {
    uint32_t id = 0;
    if (!readIdArg(id)) return sendError(400, "bad_id");

    // The quantity comes in the JSON body; the query string is accepted as a fallback.
    int qty = -1;
    const String body = https.arg("plain");
    if (!body.isEmpty()) {
        JsonDocument doc;
        if (deserializeJson(doc, body.c_str()) == DeserializationError::Ok) {
            qty = doc["qty"] | -1;
        }
    }
    if (qty < 0 && https.hasArg("qty")) qty = https.arg("qty").toInt();
    if (qty < 1 || qty > 999) return sendError(400, "bad_qty");

    switch (scansSetQty(id, static_cast<uint16_t>(qty))) {
        case EditStatus::Ok:
            return sendOk();
        case EditStatus::NotFound:
            return sendError(404, "not_found");
        case EditStatus::IoError:
            return sendError(500, "io_error");
        default:
            return sendError(500, "unknown_status");
    }
}

void handleScansDelete() {
    uint32_t id = 0;
    if (!https.hasArg("id")) {
        // DELETE /api/scans without id clears the whole collection.
        if (!scansRemoveAll()) return sendError(500, "io_error");
        displayIdle(currentIp(), 0);
        return sendOk();
    }
    if (!readIdArg(id)) return sendError(400, "bad_id");

    switch (scansRemove(id)) {
        case EditStatus::Ok:
            displayIdle(currentIp(), scansCount());
            return sendOk();
        case EditStatus::NotFound:
            return sendError(404, "not_found");
        case EditStatus::IoError:
            return sendError(500, "io_error");
        default:
            return sendError(500, "unknown_status");
    }
}

void handleSettingsGet() {
    JsonDocument doc;
    doc["country"] = gConfig.country;
    doc["currency"] = gConfig.currency;
    doc["dataUrl"] = gConfig.dataUrl;
    sendJson(200, doc);
}

void handleSettingsPost() {
    JsonDocument doc;
    if (deserializeJson(doc, https.arg("plain").c_str()) != DeserializationError::Ok ||
        !doc.is<JsonObject>()) {
        return sendError(400, "bad_json");
    }

    // Only the fields that were sent are changed.
    DeviceConfig updated = gConfig;
    if (doc["country"].is<const char*>()) {
        const String country = textOf(doc["country"]);
        if (!isCode(country, 2)) return sendError(400, "bad_country");
        updated.country = country;
    }
    if (doc["currency"].is<const char*>()) {
        const String currency = textOf(doc["currency"]);
        if (!isCode(currency, 3)) return sendError(400, "bad_currency");
        updated.currency = currency;
    }
    if (doc["dataUrl"].is<const char*>()) {
        const String url = textOf(doc["dataUrl"]);
        if (url.isEmpty()) {
            updated.dataUrl = DATA_URL;
        } else if (url.length() > 200 || !(url.startsWith("https://") || url.startsWith("http://"))) {
            return sendError(400, "bad_dataUrl");
        } else {
            updated.dataUrl = url;
        }
    }

    if (!configSave(updated)) return sendError(500, "save_failed");
    sendOk();
}

// Upload finished: report the result of the Update that ran during the upload.
void handleUpdateDone() {
    switch (otaLastResult()) {
        case OtaResult::Ok:
            sendOk();
            scheduleRestart(1500);  // lets the response leave the device first
            return;
        case OtaResult::Unauthorized:
            return sendError(401, "unauthorized");
        case OtaResult::Failed:
            return sendError(500, "update_failed");
        case OtaResult::None:
            return sendError(400, "no_file");
        default:
            return sendError(500, "update_failed");
    }
}

// Upload chunks: forwarded to the Updater. The password is checked at the start.
void handleUpdateUpload() {
    HTTPUpload& upload = https.upload();
    switch (upload.status) {
        case UPLOAD_FILE_START:
            otaUploadBegin(https.header("X-OTA-Pass"),
                           static_cast<size_t>(https.header("Content-Length").toInt()));
            break;
        case UPLOAD_FILE_WRITE:
            otaUploadWrite(upload.buf, upload.currentSize);
            break;
        case UPLOAD_FILE_END:
            otaUploadEnd();
            break;
        case UPLOAD_FILE_ABORTED:
            otaUploadAbort();
            break;
        default:
            break;
    }
}

void handleNotFound() {
    sendError(404, "not_found");
}

void handleRedirectToHttps() {
    const String url = "https://" + WiFi.localIP().toString() + "/";
    httpRedirect.sendHeader("Location", url);
    httpRedirect.sendHeader("Cache-Control", "no-cache");
    httpRedirect.send(301, "text/plain; charset=utf-8", "Weiterleitung auf HTTPS");
}

void registerRoutes() {
    for (size_t i = 0; i < WEB_ASSET_COUNT; ++i) {
        const WebAsset* asset = &WEB_ASSETS[i];
        https.on(asset->path, HTTP_GET, [asset]() { sendAsset(*asset); });
    }

    https.on("/api/status", HTTP_GET, handleStatus);
    https.on("/api/scan", HTTP_POST, handleScanPost);
    https.on("/api/scans", HTTP_GET, handleScansGet);
    https.on("/api/scans", HTTP_PATCH, handleScansPatch);
    https.on("/api/scans", HTTP_DELETE, handleScansDelete);
    https.on("/api/settings", HTTP_GET, handleSettingsGet);
    https.on("/api/settings", HTTP_POST, handleSettingsPost);
    https.on("/api/update", HTTP_POST, handleUpdateDone, handleUpdateUpload);
    https.onNotFound(handleNotFound);
}

// Uses the LittleFS certificate when valid, otherwise the built-in one.
// The PEM Strings are local: they are freed on return, before https.begin().
void loadTlsMaterial() {
    String certPem;
    String keyPem;
    if (!certLoad(certPem, keyPem)) {
        certPem = String(FPSTR(DEFAULT_CERT_PEM));
        keyPem = String(FPSTR(DEFAULT_KEY_PEM));
    }
    g_chain = new BearSSL::X509List(certPem.c_str());
    g_privateKey = new BearSSL::PrivateKey(keyPem.c_str());
}

}  // namespace

void webserverBegin() {
    loadTlsMaterial();

    https.collectHeaders(kCollectedHeaders, sizeof(kCollectedHeaders) / sizeof(kCollectedHeaders[0]));
    registerRoutes();
    https.addHook([](const String&, const String&, WiFiClient*, BearSSL::ESP8266WebServerSecure::ContentTypeFunction) {
        g_lastRequestMs = millis();
        return BearSSL::ESP8266WebServerSecure::CLIENT_REQUEST_CAN_CONTINUE;
    });

    // Keep BearSSL's 6 KB stack allocated for good. Otherwise it is freed and
    // re-allocated around every connection, which fragments the heap over days.
    stack_thunk_add_ref();

    BearSSL::WiFiServerSecure& server = https.getServer();
    server.setECCert(g_chain, BR_KEYTYPE_KEYX | BR_KEYTYPE_SIGN, g_privateKey);
    server.setCache(&sessionCache);
    server.setBufferSizes(TLS_RX_BUFFER, TLS_TX_BUFFER);
    server.setNoDelay(true);  // send each TLS record at once instead of waiting for Nagle
    https.begin();

    httpRedirect.onNotFound(handleRedirectToHttps);
    httpRedirect.begin();
}

void webserverLoop() {
    https.handleClient();
    httpRedirect.handleClient();
}

uint32_t webserverIdleMs() {
    return millis() - g_lastRequestMs;
}
