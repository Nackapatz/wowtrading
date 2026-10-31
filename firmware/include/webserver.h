// HTTPS server (BearSSL, port 443) with the web app and the JSON API, plus the
// plain HTTP redirect on port 80. See SPEC section 1 for the endpoint list.
#pragma once

#include <Arduino.h>

// Loads the TLS material (LittleFS, or the built-in fallback) and starts both
// servers. Call once, after WLAN is connected.
void webserverBegin();

// Call from loop().
void webserverLoop();

// Milliseconds since the last HTTPS request (since boot if there was none).
uint32_t webserverIdleMs();
