// Device configuration, build-time defaults and persistent storage (LittleFS).
#pragma once

#include <Arduino.h>

// ---------------------------------------------------------------------------
// Build-time defaults. The platformio.ini build flags set FW_VERSION and
// DATA_URL; the fallbacks here only matter for IDE indexing.
// ---------------------------------------------------------------------------
#ifndef FW_VERSION
#define FW_VERSION "dev"
#endif

#ifndef DATA_URL
#define DATA_URL "https://example.github.io/wowtrading/data/"
#endif

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
constexpr uint16_t HTTPS_PORT = 443;
constexpr uint16_t HTTP_REDIRECT_PORT = 80;
constexpr uint32_t WIFI_RETRY_MS = 30000;  // retry / WOWSCAN:WIFIFAIL interval

// ---------------------------------------------------------------------------
// Storage paths in LittleFS
// ---------------------------------------------------------------------------
constexpr char CONFIG_FILE[] = "/config.json";
constexpr char CERT_FILE[] = "/cert.pem";
constexpr char KEY_FILE[] = "/key.pem";
constexpr char SCANS_FILE[] = "/scans.jsonl";
constexpr char SCANS_TMP_FILE[] = "/scans.tmp";

constexpr size_t MAX_SCANS = 2000;
constexpr size_t MAX_SCAN_BODY = 2048;   // POST /api/scan body limit
constexpr size_t SCAN_LINE_MAX = 2304;   // stored record incl. id/qty, one line
constexpr size_t FS_RESERVE_BYTES = 16 * 1024;  // keep headroom for LittleFS metadata

// ---------------------------------------------------------------------------
// Defaults for a freshly provisioned device
// ---------------------------------------------------------------------------
#define DEFAULT_HOSTNAME "wowscanner"
#define DEFAULT_COUNTRY "DE"
#define DEFAULT_CURRENCY "EUR"

// ---------------------------------------------------------------------------
// OLED (SSD1306 128x64, I2C address 0x3C)
//
// Boards differ in wiring. Without overrides the firmware probes the pairs
// below in order and uses the first one that answers on 0x3C. To pin the
// pins, build with -DOLED_SDA_PIN=<n> -DOLED_SCL_PIN=<n>.
// ---------------------------------------------------------------------------
constexpr uint8_t OLED_I2C_ADDRESS = 0x3C;

struct I2cPins {
    uint8_t sda;
    uint8_t scl;
};

#if defined(OLED_SDA_PIN) && defined(OLED_SCL_PIN)
constexpr I2cPins OLED_PIN_CANDIDATES[] = {{OLED_SDA_PIN, OLED_SCL_PIN}};
#else
constexpr I2cPins OLED_PIN_CANDIDATES[] = {{14, 12}, {12, 14}, {4, 5}};
#endif

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
constexpr uint32_t SPLASH_MS = 3000;
constexpr uint32_t CARD_HOLD_MS = 6000;
constexpr uint32_t SERIAL_READY_INTERVAL_MS = 1000;
constexpr uint32_t SERIAL_READY_BOOT_WINDOW_MS = 8000;  // provisioning window after reset (at least 8 s)

// ---------------------------------------------------------------------------
// Device settings persisted in /config.json
// ---------------------------------------------------------------------------
struct DeviceConfig {
    String ssid;
    String pass;
    String otaPass;
    String hostname;
    String country;
    String currency;
    String dataUrl;
};

// Process-wide configuration, loaded once at boot.
extern DeviceConfig gConfig;

// Mounts LittleFS, formatting it on first use. Returns false if it cannot be mounted.
bool storageBegin();

// Loads /config.json into gConfig. Missing fields fall back to defaults.
bool configLoad();
bool configSave(const DeviceConfig& cfg);

// A device is configured once it has a WLAN SSID and an OTA password.
bool configIsComplete(const DeviceConfig& cfg);

// Converts arbitrary text into a valid mDNS hostname, or returns DEFAULT_HOSTNAME.
String sanitizeHostname(const char* raw);

// True if both PEM texts contain a certificate and a private key block (EC SEC1 or PKCS#8).
bool isCertPemValid(const String& certPem, const String& keyPem);

// Certificate and key as PEM text. Returns false if either file is missing.
bool certLoad(String& certPem, String& keyPem);
bool certSave(const String& certPem, const String& keyPem);
