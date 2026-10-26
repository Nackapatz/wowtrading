// Serial provisioning protocol (115200 baud, line based). See SPEC section 1.
//
//   device -> host   WOWSCAN:READY <version>     (boot, then every 1 s for the boot
//                                                  window; every 1 s until configured)
//   host   -> device WOWCFG <base64(json)>
//   device -> host   WOWCFG:OK | WOWCFG:ERR <reason>   (then the device restarts)
#pragma once

#include <Arduino.h>

// Call from loop(). Sends READY announcements, reads and applies WOWCFG lines.
// configured tells whether a usable configuration already exists.
void provisioningLoop(bool configured);
