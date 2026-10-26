#include "webserver.h"

#include <ArduinoJson.h>
#include <BearSSLHelpers.h>
#include <ESP8266WebServer.h>
#include <ESP8266WebServerSecure.h>
#include <ESP8266WiFi.h>
#include <LittleFS.h>

#include "config.h"
#include "display.h"
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

// Headers the OTA handler reads with header(); they must be collected before begin().
const char* kCollectedHeaders[] = {"X-OTA-Pass", "Content-Length"};

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

// Serves one gzip-compressed asset from flash.
void sendAsset(const WebAsset& asset) {
    https.sendHeader("Content-Encoding", "gzip");
    https.sendHeader("Cache-Control", "no-cache");
    https.send_P(200, asset.mime, reinterpret_cast<PGM_P>(asset.data), asset.length);
}

void handleStatus() {
    JsonDocument doc;
    const String ip = currentIp();
    doc["version"] = FW_VERSION;
    doc["ip"] = ip;
    doc["hostname"] = gConfig.hostname;
    doc["scans"] = scansCount();
    doc["freeHeap"] = ESP.getFreeHeap();
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

// Streams the stored scans. The array is sent with chunked transfer encoding,
// so the file never has to fit in RAM.
void handleScansGet() {
    https.sendHeader("Cache-Control", "no-store");
    // Chunked mode needs HTTP/1.1; the core refuses it for HTTP/1.0 clients.
    if (!https.chunkedResponseModeStart(200, "application/json; charset=utf-8")) {
        return sendError(505, "http11_required");
    }
    scansStream([](const char* data, size_t length) {
        https.sendContent(data, length);
        yield();
    });
    https.chunkedResponseFinalize();
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

    https.getServer().setECCert(g_chain, BR_KEYTYPE_KEYX | BR_KEYTYPE_SIGN, g_privateKey);
    https.getServer().setCache(&sessionCache);
    https.begin();

    httpRedirect.onNotFound(handleRedirectToHttps);
    httpRedirect.begin();
}

void webserverLoop() {
    https.handleClient();
    httpRedirect.handleClient();
}
