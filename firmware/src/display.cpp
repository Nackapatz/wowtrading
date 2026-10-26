#include "display.h"

#include <U8g2lib.h>
#include <Wire.h>

#include "config.h"

#if !__has_include("logo.h")
#error "include/logo.h fehlt: python3 tools/make_logo.py ausfuehren (pip install pillow)"
#endif
#include "logo.h"

namespace {

constexpr int kWidth = 128;
constexpr int kTextMaxWidth = kWidth - 8;  // 4 px margin left and right

// Software I2C is used on purpose: the pins are only known after probing, and
// bit-banging avoids depending on the core's Wire pin configuration.
U8G2_SSD1306_128X64_NONAME_F_SW_I2C* g_u8g2 = nullptr;

// Idle screen content, remembered while an overlay is on screen.
bool g_hasIdle = false;
String g_idleIp;
uint32_t g_idleScans = 0;

// Overlay (card, notice or OTA) state. A timed overlay returns to the idle screen.
bool g_overlay = false;
uint32_t g_overlayUntil = 0;  // 0 = no timer
int g_otaPercent = -1;        // last drawn OTA progress, -1 = none

bool probeAddress(const I2cPins& pins) {
    Wire.begin(pins.sda, pins.scl);
    Wire.beginTransmission(OLED_I2C_ADDRESS);
    return Wire.endTransmission() == 0;
}

int textWidth(const String& text) {
    return static_cast<int>(g_u8g2->getUTF8Width(text.c_str()));
}

void drawCentered(const String& text, int baseline) {
    int x = (kWidth - textWidth(text)) / 2;
    if (x < 0) x = 0;
    g_u8g2->drawUTF8(x, baseline, text.c_str());
}

// Removes the last UTF-8 character (not just the last byte) from text.
void dropLastUtf8Char(String& text) {
    if (text.isEmpty()) return;
    int index = static_cast<int>(text.length()) - 1;
    while (index > 0 && (static_cast<uint8_t>(text[index]) & 0xC0) == 0x80) --index;
    text.remove(index);
}

// Appends "..." to the last line, dropping characters until it fits.
void ellipsize(String& line, int maxWidth) {
    while (!line.isEmpty() && textWidth(line + "...") > maxWidth) dropLastUtf8Char(line);
    line += "...";
}

// Breaks text at spaces into at most maxLines lines of at most maxWidth pixels.
// Words wider than a line are cut. If text remains, the last line gets "...".
// Returns the number of lines written.
int wrapText(const String& text, int maxWidth, String* lines, int maxLines) {
    const int length = static_cast<int>(text.length());
    int pos = 0;
    int count = 0;

    while (count < maxLines) {
        while (pos < length && text[pos] == ' ') ++pos;
        if (pos >= length) break;

        String line;
        while (pos < length) {
            int space = text.indexOf(' ', pos);
            if (space < 0) space = length;
            const String word = text.substring(pos, space);
            const String candidate = line.isEmpty() ? word : line + " " + word;
            if (textWidth(candidate) > maxWidth) break;
            line = candidate;
            pos = space;
            while (pos < length && text[pos] == ' ') ++pos;
        }

        if (line.isEmpty()) {
            // A single word that is wider than the line: cut it and mark the cut.
            int space = text.indexOf(' ', pos);
            if (space < 0) space = length;
            line = text.substring(pos, space);
            pos = space;
            if (textWidth(line) > maxWidth) ellipsize(line, maxWidth);
        }
        lines[count++] = line;
    }

    while (pos < length && text[pos] == ' ') ++pos;
    if (pos < length && count > 0) ellipsize(lines[count - 1], maxWidth);
    return count;
}

// Draws wrapped, centered text starting at firstBaseline.
void drawWrapped(const String& text, int firstBaseline, int lineHeight, int maxLines) {
    String lines[3];
    const int count = wrapText(text, kTextMaxWidth, lines, maxLines > 3 ? 3 : maxLines);
    for (int i = 0; i < count; ++i) {
        drawCentered(lines[i], firstBaseline + i * lineHeight);
    }
}

void renderSplash() {
    g_u8g2->clearBuffer();
    g_u8g2->drawXBMP(0, 0, LOGO_WIDTH, LOGO_HEIGHT, LOGO_BITS);
    g_u8g2->setFont(u8g2_font_6x10_tf);
    drawCentered("WoW Trading Card", 55);
    drawCentered("Price Scanner", 63);
    g_u8g2->sendBuffer();
}

void renderMessage(const char* title, const char* line1, const char* line2) {
    g_u8g2->clearBuffer();
    g_u8g2->setFont(u8g2_font_helvB08_tf);
    drawCentered(title, 12);
    g_u8g2->setFont(u8g2_font_6x10_tf);
    if (line1) drawWrapped(line1, 28, 12, 2);
    if (line2) drawWrapped(line2, 56, 10, 1);
    g_u8g2->sendBuffer();
}

void renderIdle() {
    const String ip = g_idleIp.isEmpty() ? String("-") : g_idleIp;
    g_u8g2->clearBuffer();
    g_u8g2->setFont(u8g2_font_6x10_tf);
    drawCentered("IP-Adresse", 11);
    g_u8g2->setFont(u8g2_font_helvB10_tf);
    drawCentered(ip, 28);
    g_u8g2->setFont(u8g2_font_6x10_tf);
    drawCentered(String("https://") + ip, 44);
    drawCentered(String("Scans: ") + String(g_idleScans), 58);
    g_u8g2->sendBuffer();
}

void renderCard(const CardView& card) {
    g_u8g2->clearBuffer();
    g_u8g2->setFont(u8g2_font_6x10_tf);
    drawWrapped(card.name, 10, 10, 2);
    drawCentered(card.setLine, 34);
    drawCentered(card.rarity, 46);
    g_u8g2->setFont(u8g2_font_helvB10_tf);
    drawCentered(card.price, 62);
    g_u8g2->sendBuffer();
}

void renderOta(uint8_t percent) {
    constexpr int kBarX = 10;
    constexpr int kBarY = 28;
    constexpr int kBarWidth = 108;
    constexpr int kBarHeight = 10;

    g_u8g2->clearBuffer();
    g_u8g2->setFont(u8g2_font_helvB08_tf);
    drawCentered("OTA-Update", 12);
    g_u8g2->drawFrame(kBarX - 2, kBarY - 2, kBarWidth + 4, kBarHeight + 4);
    g_u8g2->drawBox(kBarX, kBarY, kBarWidth * percent / 100, kBarHeight);
    g_u8g2->setFont(u8g2_font_6x10_tf);
    drawCentered(String(static_cast<int>(percent)) + " %", 58);
    g_u8g2->sendBuffer();
}

void restoreScreen() {
    if (g_hasIdle) {
        renderIdle();
    } else {
        renderMessage("WoW Scanner", "Starte...", nullptr);
    }
}

}  // namespace

bool displayBegin() {
    for (const I2cPins& pins : OLED_PIN_CANDIDATES) {
        if (!probeAddress(pins)) continue;
        // U8g2 takes the clock pin before the data pin.
        g_u8g2 = new U8G2_SSD1306_128X64_NONAME_F_SW_I2C(U8G2_R0, pins.scl, pins.sda, U8X8_PIN_NONE);
        g_u8g2->begin();
        g_u8g2->enableUTF8Print();
        return true;
    }
    return false;
}

void displaySplash() {
    if (!g_u8g2) return;
    g_overlay = true;  // keeps idle updates from overwriting the splash
    g_overlayUntil = 0;
    renderSplash();
}

void displayMessage(const char* title, const char* line1, const char* line2) {
    if (!g_u8g2) return;
    g_overlay = false;
    g_overlayUntil = 0;
    g_otaPercent = -1;
    renderMessage(title, line1, line2);
}

void displayIdle(const String& ip, uint32_t scans) {
    g_hasIdle = true;
    g_idleIp = ip;
    g_idleScans = scans;
    if (!g_u8g2 || g_overlay) return;  // rendered when the overlay ends
    renderIdle();
}

void displayCard(const CardView& card, uint32_t holdMs) {
    if (!g_u8g2) return;
    g_overlay = true;
    g_overlayUntil = holdMs ? millis() + holdMs : 0;
    g_otaPercent = -1;
    renderCard(card);
}

void displayNotice(const char* title, const char* line1, uint32_t holdMs) {
    if (!g_u8g2) return;
    g_overlay = true;
    g_overlayUntil = holdMs ? millis() + holdMs : 0;
    g_otaPercent = -1;
    renderMessage(title, line1, nullptr);
}

void displayOtaProgress(uint8_t percent) {
    if (!g_u8g2) return;
    if (percent > 100) percent = 100;

    // Redraws are slow (software I2C), so only draw on 5 % steps and at the ends.
    int step = static_cast<int>(percent) - g_otaPercent;
    if (step < 0) step = -step;
    const bool stepReached = g_otaPercent < 0 || percent == 0 || percent == 100 || step >= 5;
    if (!stepReached) return;

    g_otaPercent = percent;
    g_overlay = true;
    g_overlayUntil = 0;
    renderOta(percent);
}

void displayTick() {
    if (!g_u8g2 || !g_overlay || g_overlayUntil == 0) return;
    if (static_cast<int32_t>(millis() - g_overlayUntil) < 0) return;

    g_overlay = false;
    g_overlayUntil = 0;
    g_otaPercent = -1;
    restoreScreen();
}
