// Scan storage in LittleFS. One JSON object per line in /scans.jsonl.
#pragma once

#include <ArduinoJson.h>
#include <Arduino.h>

#include <functional>

enum class ScanStatus { Ok, LimitReached, StorageFull, IoError };
enum class EditStatus { Ok, NotFound, IoError };

// Scans the file once to count entries and find the highest id. Call after storageBegin().
bool scansBegin();

uint32_t scansCount();

// Appends a scan. The firmware assigns "id" and defaults "qty" to 1.
ScanStatus scansAppend(JsonDocument& scan, uint32_t& outId);

// Streams the scans as a JSON array. write() receives the pieces in order;
// the whole file is never held in RAM.
void scansStream(const std::function<void(const char*, size_t)>& write);

// Changes the quantity of one scan (rewrites the file through a temp file).
EditStatus scansSetQty(uint32_t id, uint16_t qty);

EditStatus scansRemove(uint32_t id);
bool scansRemoveAll();
