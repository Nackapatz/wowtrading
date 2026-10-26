#include "ota.h"

#include <ArduinoOTA.h>
#include <Updater.h>

#include "display.h"
#include "util.h"

namespace {

OtaResult g_lastResult = OtaResult::None;
bool g_uploadActive = false;
size_t g_expectedBytes = 0;
size_t g_writtenBytes = 0;

const char* otaErrorText(ota_error_t error) {
    switch (error) {
        case OTA_AUTH_ERROR: return "Passwort falsch";
        case OTA_BEGIN_ERROR: return "Start fehlgeschlagen";
        case OTA_CONNECT_ERROR: return "Verbindung fehlt";
        case OTA_RECEIVE_ERROR: return "Empfang fehlerhaft";
        case OTA_END_ERROR: return "Prüfung fehlgeschlagen";
        default: return "Unbekannter Fehler";
    }
}

void abortUpload() {
    if (g_uploadActive) {
        Update.end();  // resets the Updater; the partial image is discarded
        g_uploadActive = false;
    }
    g_lastResult = OtaResult::Failed;
    displayNotice("OTA-Fehler", "Upload abgebrochen", 4000);
}

}  // namespace

void otaBegin(const DeviceConfig& cfg) {
    ArduinoOTA.setHostname(cfg.hostname.c_str());
    ArduinoOTA.setPassword(cfg.otaPass.c_str());

    ArduinoOTA.onStart([]() {
        displayOtaProgress(0);
    });
    ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
        if (total > 0) displayOtaProgress(static_cast<uint8_t>(progress * 100ULL / total));
    });
    ArduinoOTA.onEnd([]() {
        displayNotice("Update fertig", "Neustart...", 0);
    });
    ArduinoOTA.onError([](ota_error_t error) {
        displayNotice("OTA-Fehler", otaErrorText(error), 4000);
    });

    ArduinoOTA.begin();
}

void otaLoop() {
    ArduinoOTA.handle();
}

bool otaUploadBegin(const String& passHeader, size_t expectedBytes) {
    if (g_uploadActive) abortUpload();  // a previous upload never finished

    g_lastResult = OtaResult::None;
    if (!constantTimeEquals(passHeader, gConfig.otaPass)) {
        g_lastResult = OtaResult::Unauthorized;
        return false;
    }

    // The exact image size is not known before the multipart body is read, so
    // the Updater reserves the whole free sketch space. end(true) below accepts
    // a shorter image.
    if (!Update.begin(ESP.getFreeSketchSpace())) {
        g_lastResult = OtaResult::Failed;
        displayNotice("OTA-Fehler", "Start fehlgeschlagen", 4000);
        return false;
    }

    g_uploadActive = true;
    g_expectedBytes = expectedBytes;
    g_writtenBytes = 0;
    displayOtaProgress(0);
    return true;
}

bool otaUploadWrite(const uint8_t* data, size_t length) {
    if (!g_uploadActive) return false;

    // Update.write() takes a non-const pointer in the core API, but does not modify the data.
    if (Update.write(const_cast<uint8_t*>(data), length) != length) {
        abortUpload();
        return false;
    }

    g_writtenBytes += length;
    if (g_expectedBytes > 0) {
        size_t percent = g_writtenBytes * 100 / g_expectedBytes;
        if (percent > 99) percent = 99;  // 100 is reserved for the successful end
        displayOtaProgress(static_cast<uint8_t>(percent));
    }
    return true;
}

bool otaUploadEnd() {
    if (!g_uploadActive) {
        g_lastResult = OtaResult::Failed;
        return false;
    }
    g_uploadActive = false;

    // evenIfRemaining: the upload size was unknown, so the Updater cannot check for missing bytes.
    if (!Update.end(true)) {
        g_lastResult = OtaResult::Failed;
        displayNotice("OTA-Fehler", "Image ungültig", 4000);
        return false;
    }

    g_lastResult = OtaResult::Ok;
    displayNotice("Update fertig", "Neustart...", 0);
    return true;
}

void otaUploadAbort() {
    abortUpload();
}

OtaResult otaLastResult() {
    return g_lastResult;
}
