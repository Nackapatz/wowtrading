// OLED output (SSD1306 128x64 via U8g2). All functions are no-ops when no display was found.
#pragma once

#include <Arduino.h>

// Content of the card overlay shown after a successful scan.
struct CardView {
    String name;     // card name, wrapped to two lines
    String setLine;  // e.g. "BFA #123"
    String rarity;
    String price;    // e.g. "12,50 EUR" or "kein Preis"
};

// Probes the configured I2C pin pairs for the OLED and initialises it.
// Returns false if no display answered (the device then runs headless).
bool displayBegin();

// Splash screen: logo and product name. Timing is handled by the caller.
void displaySplash();

// Full-screen text message, e.g. "WLAN verbinden..." with the SSID.
// Clears any running overlay.
void displayMessage(const char* title, const char* line1, const char* line2 = nullptr);

// Idle screen with IP address and number of stored scans. Stored and
// rendered later if an overlay is active.
void displayIdle(const String& ip, uint32_t scans);

// Card overlay for holdMs, then the idle screen returns (see displayTick()).
void displayCard(const CardView& card, uint32_t holdMs);

// Notice overlay (title and one line). holdMs = 0 keeps it until the next call.
void displayNotice(const char* title, const char* line1, uint32_t holdMs);

// OTA progress bar, percent 0-100. Redraws are throttled.
void displayOtaProgress(uint8_t percent);

// Call regularly from loop(); ends timed overlays.
void displayTick();
