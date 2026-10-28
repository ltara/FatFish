/** Owner-selected local working directory. Core alone persists this setting. */
"use strict";
const fs = require("node:fs"), path = require("node:path"), { randomUUID, createHash } = require("node:crypto");
const { readConfig } = require("./channel-config.cjs");
const same = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const defaultPath = (root) => path.resolve(root, "workspace", "local");
function pathShape(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value) && path.isAbsolute(value) &&
    (process.platform !== "win32" || /^[A-Za-z]:[\\/]/.test(value));
}
function read(root) {
  const file = path.join(root, "config.json");
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("config_invalid");
  const config = readConfig(file), chosen = config.local_workspace, generation = config.local_workspace_generation ?? 0;
  if (chosen != null && !pathShape(chosen) || !Number.isSafeInteger(generation) || generation < 0) throw new Error("workspace_invalid");
  return { path: chosen == null ? defaultPath(root) : path.resolve(chosen), isDefault: chosen == null, generation };
}
function validateDirectory(value) {
  if (!pathShape(value)) throw new Error("workspace_invalid");
  try {
    if (!fs.statSync(value).isDirectory()) throw new Error();
    fs.accessSync(value, fs.constants.R_OK | fs.constants.W_OK);
    const canonical = fs.realpathSync.native(value);
    if (!pathShape(canonical)) throw new Error();
    return canonical;
  } catch { throw new Error("workspace_unavailable"); }
}
function ensureDefault(root) {
  const folder = defaultPath(root);
  for (const part of [path.dirname(folder), folder]) {
    try { if (fs.lstatSync(part).isSymbolicLink()) throw new Error("workspace_unavailable"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  fs.mkdirSync(folder, { recursive: true }); return validateDirectory(folder);
}
function forEngine(root) {
  const setting = read(root), canonical = setting.isDefault ? ensureDefault(root) : validateDirectory(setting.path);
  // A chosen folder later replaced by a junction must not silently change the scope.
  if (!setting.isDefault && !same(canonical, setting.path)) throw new Error("workspace_unavailable");
  return { ...setting, path: canonical };
}
function plan(root, args) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((k) => !["path", "reset"].includes(k)) ||
    (args.reset === true ? args.path !== undefined : args.reset !== undefined || typeof args.path !== "string")) throw new Error("workspace_args_invalid");
  const before = read(root), canonical = args.reset ? ensureDefault(root) : validateDirectory(args.path);
  let standard = defaultPath(root);
  if (fs.existsSync(standard)) standard = validateDirectory(standard);
  const isDefault = same(canonical, standard);
  const beforePath = before.isDefault ? standard : before.path;
  return { before, path: canonical, isDefault, changed: !same(canonical, beforePath) || isDefault !== before.isDefault };
}
function save(root, args) {
  const next = plan(root, args), file = path.join(root, "config.json");
  if (!next.changed) return { ...next.before, path: next.path, changed: false };
  const config = readConfig(file), generation = (config.local_workspace_generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation)) throw new Error("workspace_invalid");
  if (next.isDefault) delete config.local_workspace; else config.local_workspace = next.path;
  config.local_workspace_generation = generation;
  const temp = file + "." + randomUUID() + ".tmp"; let fd;
  try {
    fs.mkdirSync(root, { recursive: true }); fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(config, null, 2) + "\n", "utf8"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temp, file);
  } catch { throw new Error("config_save_failed"); }
  finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch { /* only this transaction's file */ } }
  return { path: next.path, isDefault: next.isDefault, generation, changed: true };
}
function contextSuffix(root) {
  const setting = read(root);
  if (setting.isDefault && setting.generation === 0) return ""; // Preserve existing default-workspace sessions.
  const normalized = process.platform === "win32" ? setting.path.toLowerCase() : setting.path;
  return "-w" + setting.generation + "-" + createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}
module.exports = { defaultPath, read, validateDirectory, forEngine, plan, save, contextSuffix };
