#include "scans.h"

#include <LittleFS.h>
#include <stdlib.h>
#include <string.h>

#include "config.h"

namespace {

uint32_t g_count = 0;
uint32_t g_nextId = 1;

// Shared line buffer. Only one scan operation runs at a time (single-threaded
// loop), so a static buffer keeps the 2 KB off the stack.
char g_line[SCAN_LINE_MAX];

// Extracts the value of the "id" key. Records are written by this firmware,
// so a plain search for "id": is reliable and much cheaper than parsing JSON.
uint32_t parseId(const char* line) {
    const char* p = strstr(line, "\"id\":");
    if (!p) return 0;
    return static_cast<uint32_t>(strtoul(p + 5, nullptr, 10));
}

// Calls fn(line, length) for each non-empty line. Lines longer than the buffer are skipped.
template <typename Fn>
void forEachLine(File& file, Fn fn) {
    uint8_t block[128];
    size_t length = 0;
    bool overflow = false;

    while (file.available() > 0) {
        const int n = file.read(block, sizeof(block));  // -1 on error
        if (n <= 0) break;
        for (int i = 0; i < n; ++i) {
            const char c = static_cast<char>(block[i]);
            if (c == '\n') {
                if (length > 0 && !overflow) {
                    g_line[length] = '\0';
                    fn(g_line, length);
                }
                length = 0;
                overflow = false;
            } else if (c != '\r') {
                if (length < SCAN_LINE_MAX - 1) {
                    g_line[length++] = c;
                } else {
                    overflow = true;
                }
            }
        }
        yield();
    }
    if (length > 0 && !overflow) {
        g_line[length] = '\0';
        fn(g_line, length);
    }
}

bool writeLine(File& file, const char* line, size_t length) {
    if (file.write(reinterpret_cast<const uint8_t*>(line), length) != length) return false;
    return file.write('\n') == 1;
}

// Recounts the entries. Ids never decrease, so a deleted record's id is not reused.
void refreshStats() {
    uint32_t count = 0;
    uint32_t maxId = 0;
    File file = LittleFS.open(SCANS_FILE, "r");
    if (file) {
        forEachLine(file, [&](char* line, size_t) {
            ++count;
            const uint32_t id = parseId(line);
            if (id > maxId) maxId = id;
        });
        file.close();
    }
    g_count = count;
    if (maxId + 1 > g_nextId) g_nextId = maxId + 1;
}

// Copies the file to a temp file, replacing the matching line.
// remove = true drops it; otherwise its quantity is set to qty.
EditStatus rewriteScans(uint32_t id, bool remove, uint16_t qty) {
    File source = LittleFS.open(SCANS_FILE, "r");
    if (!source) return EditStatus::NotFound;
    File target = LittleFS.open(SCANS_TMP_FILE, "w");
    if (!target) {
        source.close();
        return EditStatus::IoError;
    }

    bool found = false;
    bool ioError = false;
    forEachLine(source, [&](char* line, size_t length) {
        if (found || parseId(line) != id) {
            if (!writeLine(target, line, length)) ioError = true;
            return;
        }
        found = true;
        if (remove) return;

        // Re-serialise only the matching record. On parse errors keep the original line.
        JsonDocument doc;
        if (deserializeJson(doc, static_cast<const char*>(line))) {
            if (!writeLine(target, line, length)) ioError = true;
            return;
        }
        doc["qty"] = qty;
        if (serializeJson(doc, target) == 0 || target.write('\n') != 1) ioError = true;
    });

    source.close();
    target.close();

    if (!found) {
        LittleFS.remove(SCANS_TMP_FILE);
        return EditStatus::NotFound;
    }
    if (ioError || !LittleFS.rename(SCANS_TMP_FILE, SCANS_FILE)) {
        LittleFS.remove(SCANS_TMP_FILE);
        return EditStatus::IoError;
    }
    refreshStats();
    return EditStatus::Ok;
}

}  // namespace

bool scansBegin() {
    refreshStats();
    return true;
}

uint32_t scansCount() {
    return g_count;
}

ScanStatus scansAppend(JsonDocument& scan, uint32_t& outId) {
    if (g_count >= MAX_SCANS) return ScanStatus::LimitReached;

    FSInfo info;
    if (LittleFS.info(info) && info.usedBytes + FS_RESERVE_BYTES > info.totalBytes) {
        return ScanStatus::StorageFull;
    }

    outId = g_nextId;
    scan["id"] = outId;
    if (!scan["qty"].is<int>()) scan["qty"] = 1;

    File file = LittleFS.open(SCANS_FILE, "a");
    if (!file) return ScanStatus::IoError;
    const size_t written = serializeJson(scan, file);
    const bool terminated = file.write('\n') == 1;
    file.close();
    if (written == 0 || !terminated) return ScanStatus::IoError;

    ++g_nextId;
    ++g_count;
    return ScanStatus::Ok;
}

void scansStream(const std::function<void(const char*, size_t)>& write) {
    write("[", 1);
    bool first = true;
    File file = LittleFS.open(SCANS_FILE, "r");
    if (file) {
        forEachLine(file, [&](char* line, size_t length) {
            // Skip anything that is not a complete object (e.g. a torn write).
            if (line[0] != '{' || line[length - 1] != '}') return;
            if (!first) write(",", 1);
            write(line, length);
            first = false;
        });
        file.close();
    }
    write("]", 1);
}

EditStatus scansSetQty(uint32_t id, uint16_t qty) {
    return rewriteScans(id, false, qty);
}

EditStatus scansRemove(uint32_t id) {
    return rewriteScans(id, true, 0);
}

bool scansRemoveAll() {
    if (LittleFS.exists(SCANS_FILE) && !LittleFS.remove(SCANS_FILE)) return false;
    g_count = 0;
    return true;
}
