// Small helpers shared by several modules: base64, delayed restart, text formatting.
#pragma once

#include <Arduino.h>

// Decodes standard base64 (RFC 4648, '=' padding optional, whitespace ignored).
// Writes at most outCap bytes and sets outLen. Returns false on invalid input
// or when the output does not fit.
bool base64Decode(const char* in, size_t inLen, uint8_t* out, size_t outCap, size_t& outLen);

// Reboots the device after delayMs, without blocking the main loop.
// restartIfDue() must be called from loop().
void scheduleRestart(uint32_t delayMs);
void restartIfDue();

// Formats a price with a German decimal comma, e.g. "12,50 EUR".
String formatMoney(double value, const char* currency);

// Compares two strings without leaking the position of the first difference.
bool constantTimeEquals(const String& a, const String& b);

// True if the text contains a PEM block with the given label (e.g. "CERTIFICATE").
bool containsPemBlock(const String& text, const char* label);
