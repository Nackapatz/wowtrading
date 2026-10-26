#include "util.h"

namespace {

// Value of one base64 alphabet character, or -1 if it is not in the alphabet.
int base64Value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

bool isBase64Space(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

uint32_t g_restartAt = 0;

}  // namespace

bool base64Decode(const char* in, size_t inLen, uint8_t* out, size_t outCap, size_t& outLen) {
    outLen = 0;
    uint32_t accumulator = 0;
    int bits = 0;

    for (size_t i = 0; i < inLen; ++i) {
        const char c = in[i];
        if (c == '=') break;  // padding ends the data
        if (isBase64Space(c)) continue;

        const int value = base64Value(c);
        if (value < 0) return false;

        accumulator = (accumulator << 6) | static_cast<uint32_t>(value);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (outLen >= outCap) return false;
            out[outLen++] = static_cast<uint8_t>((accumulator >> bits) & 0xFF);
        }
    }
    return true;
}

void scheduleRestart(uint32_t delayMs) {
    g_restartAt = millis() + delayMs;
    if (g_restartAt == 0) g_restartAt = 1;  // 0 means "no restart scheduled"
}

void restartIfDue() {
    if (g_restartAt != 0 && static_cast<int32_t>(millis() - g_restartAt) >= 0) {
        Serial.flush();
        ESP.restart();
    }
}

String formatMoney(double value, const char* currency) {
    String text(value, 2);
    text.replace('.', ',');
    text += ' ';
    text += currency;
    return text;
}

bool constantTimeEquals(const String& a, const String& b) {
    if (a.length() != b.length()) return false;
    uint8_t difference = 0;
    for (unsigned int i = 0; i < a.length(); ++i) {
        difference |= static_cast<uint8_t>(a[i]) ^ static_cast<uint8_t>(b[i]);
    }
    return difference == 0;
}

bool containsPemBlock(const String& text, const char* label) {
    String begin = "-----BEGIN ";
    begin += label;
    begin += "-----";
    String end = "-----END ";
    end += label;
    end += "-----";
    return text.indexOf(begin) >= 0 && text.indexOf(end) > text.indexOf(begin);
}
