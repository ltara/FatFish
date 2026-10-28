/** Shared, fail-closed channel settings. Only Core writes, serially with owner updates. */
"use strict";
const fs = require("node:fs");
const { dirname } = require("node:path");
const { randomUUID } = require("node:crypto");
function readConfig(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    return config;
  } catch { throw new Error("config_invalid"); }
}
function qqEnabled(config) {
  const value = config.channels?.qq?.enabled;
  if (value !== undefined) return value === true;
  // Preserve existing installations/tests. A newly created config has an explicit false.
  return !!(config.owner_qq || config.owners?.some?.((o) => o?.channel === "qq") ||
    Object.hasOwn(config, "onebot_url"));
}
function setQQEnabled(file, enabled) {
  if (typeof enabled !== "boolean") throw new Error("invalid_channel_setting");
  const config = readConfig(file);
  if (config.channels != null && (typeof config.channels !== "object" || Array.isArray(config.channels))) throw new Error("config_invalid");
  config.channels = { ...config.channels, qq: { ...config.channels?.qq, enabled } };
  fs.mkdirSync(dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(config, null, 2) + "\n");
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } catch { throw new Error("config_save_failed"); }
  finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* only this write's unique temp */ }
  }
  return config;
}
module.exports = { readConfig, qqEnabled, setQQEnabled };
