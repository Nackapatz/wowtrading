// Over-the-air updates: ArduinoOTA (espota, port 8266) and HTTPS upload via /api/update.
// Both only replace the sketch area; LittleFS (WLAN settings, certificate, scans) is kept.
#pragma once

#include <Arduino.h>

#include "config.h"

enum class OtaResult { None, Ok, Unauthorized, Failed };

// Starts ArduinoOTA with the device hostname and otaPass. Call after WLAN is up.
void otaBegin(const DeviceConfig& cfg);

// Call from loop().
void otaLoop();

// Web upload, driven by the HTTP handler. Begin checks the X-OTA-Pass header value.
// expectedBytes (from Content-Length) is only used for the progress bar.
bool otaUploadBegin(const String& passHeader, size_t expectedBytes);
bool otaUploadWrite(const uint8_t* data, size_t length);
bool otaUploadEnd();
void otaUploadAbort();

// Outcome of the most recent web upload.
OtaResult otaLastResult();
