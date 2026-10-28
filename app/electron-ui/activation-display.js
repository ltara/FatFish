"use strict";
// Presentation metadata only: never used by a license gate or as an activation credential.
const fs = require("node:fs"), path = require("node:path"), { createHash, randomUUID } = require("node:crypto");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function files(root) {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) === path.parse(path.resolve(root)).root) throw new Error("display_path_invalid");
  const s = fs.lstatSync(root); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("display_path_invalid");
  return { license: path.join(root, "license.json"), display: path.join(root, "activation-display.json") };
}
function readFile(file, max) {
  const s = fs.lstatSync(file); if (!s.isFile() || s.isSymbolicLink() || s.size > max) throw new Error("display_file_invalid");
  return fs.readFileSync(file);
}
function read(root, state) {
  if (state?.valid !== true) return null;
  try {
    const f = files(root), license = readFile(f.license, 16384), raw = readFile(f.display, 512).toString("utf8"), data = JSON.parse(raw);
    if (!data || Object.keys(data).join("|") !== "version|licenseHash|codeTail" || JSON.stringify(data) + "\n" !== raw || data.version !== 1 || data.licenseHash !== hash(license) || typeof data.codeTail !== "string" || !/^[0-9A-F]{4}$/.test(data.codeTail)) return null;
    return data.codeTail;
  } catch { return null; } // Old/missing/corrupt metadata must not invalidate an authentic offline license.
}
function save(root, value) {
  let temp, fd;
  try {
    const code = typeof value === "string" ? value.trim().toUpperCase().replace(/[ \t\r\n-]/g, "") : "";
    if (!/^FF[0-9A-F]{32}$/.test(code)) return false;
    const f = files(root), license = readFile(f.license, 16384), envelope = JSON.parse(license.toString("utf8"));
    const payload = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8"));
    if (payload.code_hash !== hash(code)) return false;
    // Called only AFTER Main's successful verified activation. Hash binding also prevents a stale
    // receipt being displayed for another license. Editing this metadata never grants permission.
    try { readFile(f.display, 512); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const raw = JSON.stringify({ version: 1, licenseHash: hash(license), codeTail: code.slice(-4) }) + "\n";
    temp = f.display + "." + randomUUID() + ".tmp"; fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, raw); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temp, f.display); temp = undefined;
    return true;
  } catch { return false; } // Do not turn a display write failure into a second online activation.
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } if (temp) { try { fs.unlinkSync(temp); } catch {} } }
}
module.exports = { read, save };
