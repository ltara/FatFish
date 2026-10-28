/** Windows device identity. Raw OS values stay in memory; callers receive only the salted hash. */
"use strict";
const { createHash } = require("node:crypto"), { execFileSync } = require("node:child_process"), path = require("node:path");
let cached;
function fromParts(machineGuid, volumeSerial) {
  if (typeof machineGuid !== "string" || typeof volumeSerial !== "string") throw new Error("device_unavailable");
  const guid = machineGuid.trim().toLowerCase(), serial = volumeSerial.trim().replaceAll("-", "").toUpperCase();
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(guid) || /^0+$/.test(guid.replaceAll("-", "")) || !/^[0-9A-F]{8}$/.test(serial) || /^0+$/.test(serial)) throw new Error("device_unavailable");
  return createHash("sha256").update("fatfish-license-device-v1\0" + guid + "\0" + serial).digest("hex");
}
function fingerprint() {
  if (cached) return cached;
  if (process.platform !== "win32") throw new Error("device_unavailable");
  try {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
    if (typeof systemRoot !== "string" || !/^[A-Za-z]:\\[^\x00-\x1f"<>|]+$/.test(systemRoot) || /(?:^|\\)\.\.(?:\\|$)/.test(systemRoot)) throw new Error();
    const options = { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 8192 };
    const registry = execFileSync(path.win32.join(systemRoot, "System32/reg.exe"), ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"], options);
    const guid = /^\s*MachineGuid\s+REG_SZ\s+([0-9a-f-]+)\s*$/im.exec(registry)?.[1];
    // Only the OS drive letter is used; no user-provided shell command or PowerShell 7 dependency.
    const output = execFileSync(path.win32.join(systemRoot, "System32/cmd.exe"), ["/d", "/c", "vol", systemRoot.slice(0, 2)], options);
    const serials = [...output.matchAll(/\b([0-9a-f]{4}-[0-9a-f]{4})\s*$/gim)].map((m) => m[1]);
    if (serials.length !== 1) throw new Error();
    cached = fromParts(guid, serials[0]); return cached;
  } catch { throw new Error("device_unavailable"); }
}
module.exports = { fingerprint, fromParts };
