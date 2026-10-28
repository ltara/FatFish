"use strict";
// Source-development only. Watches code, never application data or the private issuer.
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process"), { createHash } = require("node:crypto");
const controllers = new Set(["renderer.js", "status-view.js", "activation-view.js", "chat-render.js", "memory-view.js", "model-view.js", "onboarding-view.js", "data-clear-view.js", "persona-actions.js"]);
const inside = (base, file) => { const rel = path.relative(base, file); return rel === "" || !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep); };
function regularDirectory(dir) { if (!fs.statSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw Error("development_ui_directory_invalid"); return fs.realpathSync.native(dir); }
function regularFile(base, relative) {
  const target = path.resolve(base, relative);
  if (!inside(base, target)) throw Error("development_ui_path_invalid");
  let current = base;
  for (const part of path.relative(base, target).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error("development_ui_link_forbidden");
  }
  return target;
}
function instrumentPreload(text) {
  const anchor = 'const { contextBridge, ipcRenderer } = require("electron");';
  if (text.split(anchor).length !== 2 || !text.includes('contextBridge.exposeInMainWorld("fatfish", {') || !text.includes("ipcRenderer.invoke(")) throw Error("development_preload_contract_changed");
  const wrapped = text.replaceAll("ipcRenderer.invoke(", "__fatfishDevelopmentInvoke(");
  return wrapped.replace(anchor, anchor + `
let __fatfishDevelopmentPending = 0;
function __fatfishDevelopmentInvoke(...args) {
  ++__fatfishDevelopmentPending;
  let result;
  try { result = ipcRenderer.invoke(...args); }
  catch (error) { --__fatfishDevelopmentPending; throw error; }
  return Promise.resolve(result).finally(() => { --__fatfishDevelopmentPending; });
}
contextBridge.exposeInMainWorld("fatfishDevelopment", {
  getPending: () => __fatfishDevelopmentPending,
  requestReload: revision => { if (Number.isSafeInteger(revision) && revision > 0) ipcRenderer.send("development-ui-reload", revision); }
});
`);
}
function classify(relative) {
  const name = relative.replaceAll("\\", "/");
  if (name === "renderer/styles.css") return "style";
  if (name.startsWith("renderer-src/") && /\.(?:tsx?|jsx?|css|json|svg|png|jpe?g|webp|woff2?)$/.test(name) || ["vite.config.mjs", "tsconfig.json"].includes(name)) return "build";
  if (name.startsWith("renderer/") && controllers.has(name.slice(9))) return "controller";
  if (!name.includes("/") && /\.(?:js|cjs|json)$/.test(name)) return "restart";
  return null;
}
function buildUi(sourceUi) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|TOKEN|PASSWORD|SECRET|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)/i.test(key)));
    const child = spawn(process.execPath, [path.join(sourceUi, "scripts/build-ui.mjs")], { cwd: sourceUi, env, windowsHide: true, stdio: "ignore" });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(Error("development_ui_build_failed")));
  });
}
async function startDevelopmentUiSync({ sourceUi, copyUi, runRoot, dataRoot, sourceCore, build = buildUi, log = () => {}, debounceMs = 180 }) {
  sourceUi = regularDirectory(path.resolve(sourceUi)); copyUi = regularDirectory(path.resolve(copyUi)); runRoot = regularDirectory(path.resolve(runRoot)); dataRoot = regularDirectory(path.resolve(dataRoot));
  if (!inside(runRoot, copyUi) || inside(sourceUi, copyUi) || inside(copyUi, sourceUi) || inside(runRoot, dataRoot) || inside(dataRoot, runRoot) || inside(sourceUi, dataRoot)) throw Error("development_ui_roots_invalid");
  const state = { closed: false, timer: null, work: null, revision: 0, reloadRevision: 0, pending: new Set() }, watchers = [];
  const copy = relative => {
    const from = regularFile(sourceUi, relative), to = regularFile(copyUi, relative);
    if (!fs.lstatSync(from).isFile()) throw Error("development_ui_file_invalid");
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
  };
  function copyRenderer(relative = "renderer") {
    const directory = regularFile(sourceUi, relative);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error("development_ui_link_forbidden");
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) copyRenderer(name); else if (entry.isFile()) copy(name); else throw Error("development_ui_file_invalid");
    }
  }
  const fingerprint = () => ["renderer/index.html", "renderer/assets/ui.min.js"].map(file => {
    try { return createHash("sha256").update(fs.readFileSync(regularFile(sourceUi, file))).digest("hex"); } catch { return "missing"; }
  }).join("|");
  async function synchronize(kinds, initial = false) {
    const compiled = initial || kinds.has("build"), before = fingerprint();
    if (compiled) await build(sourceUi);
    if (state.closed) return;
    // A queued refresh must not read a half-copied renderer. On copy failure, keep
    // this marker until a successful save or a fresh development launch.
    const busyFile = regularFile(runRoot, "ui-sync-busy"); fs.writeFileSync(busyFile, "");
    if (compiled || initial) copyRenderer();
    else {
      if (kinds.has("style")) copy("renderer/styles.css");
      if (kinds.has("controller")) for (const name of controllers) copy("renderer/" + name);
    }
    if (initial) {
      const preload = regularFile(sourceUi, "preload.js"), target = regularFile(copyUi, "preload.js");
      fs.writeFileSync(target, instrumentPreload(fs.readFileSync(preload, "utf8")));
      fs.unlinkSync(busyFile);
      return;
    }
    const value = { revision: ++state.revision, cssOnly: !kinds.has("controller") && (!compiled || before === fingerprint()) };
    if (!value.cssOnly) state.reloadRevision = value.revision;
    value.reloadRevision = state.reloadRevision;
    const dest = regularFile(runRoot, "ui-update.json"), temporary = regularFile(runRoot, "ui-update.pending");
    fs.writeFileSync(temporary, JSON.stringify(value)); fs.renameSync(temporary, dest);
    fs.unlinkSync(busyFile);
    log(value.cssOnly ? "界面样式已同步。" : "界面代码已同步，将在没有请求、审批或未保存输入时刷新。");
  }
  function drain() {
    if (state.closed || state.work || !state.pending.size) return state.work;
    const kinds = new Set(state.pending); state.pending.clear();
    state.work = synchronize(kinds).catch(() => log("界面更新失败，当前页面保留。修正后再次保存，或运行 npm run build:ui 查看编译错误。"))
      .finally(() => { state.work = null; if (state.pending.size && !state.closed) drain(); });
    return state.work;
  }
  function schedule(relative) {
    if (state.closed) return;
    const kind = classify(relative); if (!kind) return;
    if (kind === "restart") { log("检测到主进程、桥接或依赖改动，请手动重开开发版；不会自动重启后台。"); return; }
    state.pending.add(kind); clearTimeout(state.timer); state.timer = setTimeout(drain, debounceMs);
  }
  try {
    // Register first, so edits made during the initial build cannot be lost.
    for (const relative of ["renderer-src", "renderer"]) {
      const watcher = fs.watch(regularFile(sourceUi, relative), { recursive: true }, (_event, file) => file && schedule(path.join(relative, String(file))));
      watcher.on("error", () => log("界面文件监听暂时不可用，请手动重开开发版。")); watchers.push(watcher);
    }
    const rootWatcher = fs.watch(sourceUi, (_event, file) => file && schedule(String(file)));
    rootWatcher.on("error", () => log("开发目录监听暂时不可用，请手动重开开发版。")); watchers.push(rootWatcher);
    if (sourceCore) {
      sourceCore = regularDirectory(path.resolve(sourceCore));
      if (inside(sourceCore, dataRoot) || inside(dataRoot, sourceCore) || inside(runRoot, sourceCore)) throw Error("development_ui_roots_invalid");
      const coreWatcher = fs.watch(sourceCore, { recursive: true }, (_event, file) => {
        const name = String(file || "").replaceAll("\\", "/");
        if (name && !name.startsWith("node_modules/") && /\.(?:mjs|cjs|js|json)$/.test(name)) schedule("main.js");
      });
      coreWatcher.on("error", () => log("后台源码监听暂时不可用，请手动重开开发版。")); watchers.push(coreWatcher);
    }
    state.work = synchronize(new Set(), true); await state.work; state.work = null;
    if (state.pending.size) await drain();
  } catch (error) { state.closed = true; watchers.forEach(w => w.close()); clearTimeout(state.timer); throw error; }
  return {
    schedule,
    async flush() { clearTimeout(state.timer); if (state.pending.size) drain(); while (state.work) await state.work; },
    async close() { state.closed = true; watchers.forEach(w => w.close()); clearTimeout(state.timer); state.pending.clear(); if (state.work) await state.work; },
    getRevision: () => state.revision,
  };
}
module.exports = { startDevelopmentUiSync, classify, instrumentPreload, inside };
