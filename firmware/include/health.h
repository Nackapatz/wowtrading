// Long-term health: watches WLAN and heap and restarts the device before it
// becomes unreachable. Scans and settings live in LittleFS and survive a restart.
#pragma once

#include <Arduino.h>

// Call from loop(). wifiUp: the station is connected.
void healthLoop(bool wifiUp);

// Called by the WLAN state machine when a working connection drops.
void healthNoteWifiDrop();

// Lowest free heap seen since boot, in bytes.
uint32_t healthMinFreeHeap();

// Number of WLAN drops since boot.
uint32_t healthWifiDrops();
