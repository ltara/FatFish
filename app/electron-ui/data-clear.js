"use strict";
// Owned application data only. Never accept a path or follow a directory link from the renderer.
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const modelConfig = require("../core/model-config.cjs");
const owned = ["personas.json", "persona.txt", "onboarding.json", "chat", "dsh", "memory", "reminders.json", "inbox", "activity.jsonl", "activity", "companion-home", "logs", "runtime"];
function options(value, confirmed = false) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== (confirmed ? "confirmed|includeKeys|includeLicense" : "includeKeys|includeLicense") || typeof value.includeKeys !== "boolean" || typeof value.includeLicense !== "boolean" || confirmed && value.confirmed !== true) throw new Error("clear_args_invalid");
  return value;
}
function boundary(root, io) {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) === path.parse(path.resolve(root)).root) throw new Error("clear_path_invalid");
  const stat = io.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("clear_path_invalid");
  return io.realpathSync(root);
}
function target(root, relative) {
  const file = path.resolve(root, relative), rel = path.relative(root, file);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("clear_path_invalid");
  return file;
}
function stat(io, file) { try { return io.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
function check(io, root, file) {
  target(root, path.relative(root, file));
  const s = stat(io, file); if (!s) return null;
  // Check every parent before touching a nested key. A final symlink is unlinked, never traversed.
  let parent = path.dirname(file);
  while (parent !== root) { const p = io.lstatSync(parent); if (!p.isDirectory() || p.isSymbolicLink()) throw new Error("clear_path_invalid"); parent = path.dirname(parent); }
  if (s.isSymbolicLink()) return s;
  const real = io.realpathSync(file); target(root, path.relative(root, real));
  if (s.isDirectory()) for (const name of io.readdirSync(file)) check(io, root, path.join(file, name));
  else if (!s.isFile()) throw new Error("clear_path_invalid");
  return s;
}
function plan(root, args, io = fs) {
  options(args); root = boundary(root, io);
  let model;
  if (!args.includeKeys) {
    // Read through the existing model contract before changing anything; never lose a custom key's auth scope.
    try { if (stat(io, target(root, "config.json"))?.isSymbolicLink() || stat(io, target(root, "secrets"))?.isSymbolicLink()) throw new Error(); model = modelConfig.read(root); }
    catch { throw new Error("clear_model_invalid"); }
  }
  const files = [...owned, "secrets/local_token"];
  if (args.includeKeys) {
    const secretDir = target(root, "secrets"), secrets = stat(io, secretDir);
    if (secrets && (!secrets.isDirectory() || secrets.isSymbolicLink())) throw new Error("clear_path_invalid");
    if (secrets) for (const name of io.readdirSync(secretDir)) if (name === "deepseek_api_key" || /^model-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.key$/i.test(name)) files.push("secrets/" + name);
  }
  // Config is replaced with model settings only when keeping keys. License deletion is always last.
  files.push("config.json"); if (args.includeLicense) files.push("activation-display.json", "license.json");
  const targets = files.map((name) => target(root, name)).filter((file) => {
    const s = check(io, root, file); if (!s) return false;
    if (!s.isSymbolicLink() && (/[.](?:json|jsonl|txt|key)$/.test(file) || file.endsWith(path.sep + "local_token") || file.endsWith(path.sep + "deepseek_api_key")) && !s.isFile()) throw new Error("clear_path_invalid");
    return true;
  });
  return { root, targets, model, count: targets.length };
}
function preview(root, args) { return { count: plan(root, args).count }; }
function remove(io, root, file) {
  const s = check(io, root, file); if (!s) return;
  if (s.isSymbolicLink() || s.isFile()) io.unlinkSync(file);
  else { for (const name of io.readdirSync(file)) remove(io, root, path.join(file, name)); io.rmdirSync(file); }
}
function clear(root, args, io = fs) {
  options(args, true); const p = plan(root, { includeKeys: args.includeKeys, includeLicense: args.includeLicense }, io);
  const configFile = target(p.root, "config.json");
  let temp, fd;
  try {
    // Commit the retained route/key pointer first. A failed config write must not follow other deletions.
    if (p.model) {
      const model = { ...p.model.route, generation: p.model.generation, ...(p.model.keyRef ? { keyRef: p.model.keyRef } : {}) };
      temp = target(p.root, "clear-model-" + randomUUID() + ".tmp");
      fd = io.openSync(temp, "wx", 0o600); io.writeFileSync(fd, JSON.stringify({ model }, null, 2) + "\n", "utf8"); io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
      io.renameSync(temp, configFile); temp = undefined;
    }
    for (const file of p.targets) { if (p.model && file === configFile) continue; remove(io, p.root, file); }
    return { count: p.count, keysCleared: args.includeKeys, licenseCleared: args.includeLicense };
  } catch { throw new Error("clear_failed"); }
  finally { if (fd !== undefined) { try { io.closeSync(fd); } catch {} } if (temp) { try { io.unlinkSync(temp); } catch {} } }
}
module.exports = { options, preview, clear };
