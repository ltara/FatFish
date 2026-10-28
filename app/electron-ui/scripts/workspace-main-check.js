/** Actual Main/preload handlers + isolated renderer functions in Node VM. No native shell is launched. */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), { EventEmitter } = require("node:events");
const { join, resolve, sep } = require("node:path"), { tmpdir } = require("node:os"), { createRequire } = require("node:module");
const home = fs.mkdtempSync(join(tmpdir(), "fatfish-workspace-main-")), handlers = new Map(), windows = [], requests = [];
const licensed = require("../../core/dev/license-fixture.cjs").licensedFixture(home); Object.assign(process.env, licensed.env);
fs.mkdirSync(join(home, "runtime"), { recursive: true }); fs.writeFileSync(join(home, "runtime/risk_ok"), "1\n");
const app = new EventEmitter(); let ready, count = 0, picked = { canceled: true, filePaths: [] }, dialogCount = 0, dialogOptions, pendingDialog, settingResult;
Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: () => ({ then: (fn) => { ready = fn; } }), quit() {}, isPackaged: false, getVersion: () => "test" });
class FakeWindow extends EventEmitter {
  constructor() { super(); this.webContents = new EventEmitter(); Object.assign(this.webContents, { mainFrame: {}, isDestroyed: () => false, setWindowOpenHandler() {}, send() {} }); windows.push(this); }
  loadFile() { return Promise.resolve(); }
  isDestroyed() { return false; }
}
FakeWindow.getAllWindows = () => windows;
class FakeServices extends EventEmitter {
  constructor() { super(); FakeServices.instance = this; }
  sendCore() { return true; }
  requestCore(type, payload) { requests.push({ type, ...payload }); return Promise.resolve(settingResult); }
  getState() { return { phase: "running", core: true, backend: false }; }
  getCore() { return { engines: {}, channels: { qq: "disabled" } }; }
  readQqEnabled() { return false; }
  async stopAll() {}
}
const actualRequire = createRequire(join(__dirname, "../main.js"));
const context = vm.createContext({ __dirname: resolve(__dirname, ".."), Buffer, console,
  process: { env: { FATFISH_APPDATA: home, FATFISH_SMOKE: "1" }, platform: process.platform, execPath: process.execPath },
  setTimeout: () => ({ unref() {} }), clearTimeout() {},
  require: (name) => name === "electron" ? { app, BrowserWindow: FakeWindow, ipcMain: { handle: (id, fn) => handlers.set(id, fn) },
    dialog: { showOpenDialog: async (_owner, options) => { dialogCount++; dialogOptions = options; return pendingDialog ? new Promise((r) => { pendingDialog.resolve = r; }) : picked; } },
    session: { defaultSession: { setPermissionRequestHandler() {} } } } : name === "../core/license-gate.cjs" ? licensed.gate() : name === "./service-manager" ? { ServiceManager: FakeServices } : actualRequire(name),
});
const check = (name, ok) => { assert.ok(ok, name); count++; console.log("PASS " + name); };
(async () => {
  try {
    vm.runInContext(fs.readFileSync(join(__dirname, "../main.js"), "utf8"), context); await ready();
    const win = windows[0], event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }, foreign = { sender: {}, senderFrame: {} };
    const call = (channel, ...args) => handlers.get(channel)(event, ...args);
    settingResult = { ok: true, data: { path: "C:\\default", isDefault: true, generation: 0 } };
    check("Main read uses only the owner Core workspace IPC", (await call("workspace-get")).data.isDefault && requests.at(-1).type === "workspace_ui" && requests.at(-1).op === "get");
    for (const channel of ["workspace-get", "workspace-choose", "workspace-reset"]) check("foreign window denied: " + channel, (await handlers.get(channel)(foreign)).error === "forbidden");
    check("child frame cannot open a folder selector", (await handlers.get("workspace-choose")({ sender: win.webContents, senderFrame: {} })).error === "forbidden" && dialogCount === 0);
    const beforeCancel = requests.length;
    check("native cancel makes no Core write", (await call("workspace-choose")).cancelled && requests.length === beforeCancel);
    picked = { canceled: false, filePaths: ["C:\\chosen"] }; settingResult = { ok: true, data: { path: "C:\\chosen", isDefault: false, generation: 1, changed: true } };
    const chosen = await call("workspace-choose", "C:\\untrusted-renderer-path");
    check("Main accepts only the picker path, not a renderer-supplied path", chosen.ok && requests.at(-1).args.path === "C:\\chosen");
    check("picker only selects one directory, without creating files", JSON.stringify(dialogOptions.properties) === JSON.stringify(["openDirectory"]));
    check("reset is a distinct trusted Core operation", (await call("workspace-reset")).ok && requests.at(-1).args.reset === true && requests.at(-1).args.path === undefined);
    pendingDialog = {}; const open = call("workspace-choose"); await Promise.resolve();
    check("second picker and reset are refused while native selection is pending", (await call("workspace-choose")).error === "local_busy" && (await call("workspace-reset")).error === "local_busy");
    pendingDialog.resolve({ canceled: true }); await open; pendingDialog = null;
    vm.runInContext("chatJob = { sessionId: 'local-main' }", context);
    const beforeBusy = dialogCount;
    check("active chat cannot open the picker or reset its workspace", (await call("workspace-choose")).error === "local_busy" && (await call("workspace-reset")).error === "local_busy" && dialogCount === beforeBusy);
    vm.runInContext("chatJob = null", context);
    picked = { canceled: false, filePaths: [] };
    check("invalid native selection fails closed", (await call("workspace-choose")).error === "workspace_unavailable");
    picked = { canceled: false, filePaths: ["C:\\chosen"] }; settingResult = { ok: false, error: "config_save_failed" };
    check("Main preserves a Core save failure instead of claiming success", (await call("workspace-choose")).error === "config_save_failed");

    const events = new EventEmitter(), calls = []; let exposed;
    vm.runInNewContext(fs.readFileSync(join(__dirname, "../preload.js"), "utf8"), { require: () => ({ contextBridge: { exposeInMainWorld: (_n, value) => { exposed = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); }, on: (...args) => events.on(...args), removeListener: (...args) => events.removeListener(...args) } }) });
    exposed.chooseWorkspace("C:\\injected"); exposed.resetWorkspace("C:\\injected"); exposed.getWorkspace();
    check("preload exposes no arbitrary path setter", calls.every((c) => c.length === 1) && calls[0][0] === "workspace-choose" && !exposed.setWorkspace);
    let changes = 0; const off = exposed.onWorkspaceChanged(() => changes++); events.emit("workspace-changed"); off(); events.emit("workspace-changed");
    check("workspace notification can be unsubscribed", changes === 1);

    const source = fs.readFileSync(join(__dirname, "../renderer/renderer.js"), "utf8"), start = source.indexOf("  // §8.6 工作区"), end = source.indexOf("  function wireUi()", start);
    assert.ok(start >= 0 && end > start);
    const elements = new Map();
    const element = (id) => { if (!elements.has(id)) { const classes = new Set(); elements.set(id, { textContent: "", disabled: false, title: "", attributes: {}, className: "", listeners: {},
      setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(k, fn) { this.listeners[k] = fn; }, classList: { add: (s) => classes.add(s), remove: (s) => classes.delete(s), contains: (s) => classes.has(s) } }); } return elements.get(id); };
    let renderResult = { ok: true, data: { path: "C:\\default", isDefault: true } }, chooseResult, readDelay;
    const view = vm.createContext({ $: element, api: { getWorkspace: () => readDelay || Promise.resolve(renderResult), chooseWorkspace: () => Promise.resolve(chooseResult), resetWorkspace: () => Promise.resolve(chooseResult), onWorkspaceChanged() {} }, refreshStatus() {} });
    vm.runInContext(source.slice(start, end), view); vm.runInContext("wireWorkspace()", view); await vm.runInContext("loadWorkspace()", view);
    check("renderer shows current path and explains disabled default reset", element("#workspace-path").textContent === "C:\\default" && element("#btn-workspace-reset").disabled && !!element("#btn-workspace-reset").title);
    chooseResult = { ok: true, cancelled: true }; await vm.runInContext("changeWorkspace(false)", view);
    check("renderer cancel retains the previous path", element("#workspace-path").textContent === "C:\\default" && element("#workspace-msg").textContent.includes("已取消"));
    chooseResult = { ok: true, data: { path: "C:\\新 文件夹", isDefault: false, changed: true } }; await vm.runInContext("changeWorkspace(false)", view);
    check("renderer success displays canonical path and context-reset consequence", element("#workspace-path").textContent === "C:\\新 文件夹" && !element("#btn-workspace-reset").disabled && element("#workspace-msg").textContent.includes("旧聊天记录和文件保留"));
    chooseResult = { ok: false, error: "config_save_failed" }; await vm.runInContext("changeWorkspace(false)", view);
    check("renderer save failure retains selected path and offers reread", element("#workspace-path").textContent === "C:\\新 文件夹" && !element("#btn-workspace-retry").classList.contains("hidden") && element("#workspace-msg").textContent.includes("没有保存成功"));
    renderResult = { ok: false, error: "core_unavailable" }; await vm.runInContext("loadWorkspace()", view);
    check("renderer Core failure is local to workspace controls", element("#workspace-path").textContent === "C:\\新 文件夹" && element("#workspace-msg").textContent.includes("本机服务暂时不可用"));
    let resolveRead; readDelay = new Promise((r) => { resolveRead = r; }); const stale = vm.runInContext("loadWorkspace()", view);
    chooseResult = { ok: true, data: { path: "C:\\latest", isDefault: false, changed: true } }; await vm.runInContext("changeWorkspace(false)", view);
    resolveRead({ ok: true, data: { path: "C:\\stale", isDefault: false } }); await stale;
    check("stale read cannot overwrite a newer chosen workspace", element("#workspace-path").textContent === "C:\\latest");
    await vm.runInContext("shutdownServices()", context);
    console.log(`${count}/${count} workspace Main/preload/renderer checks passed (Node VM, no windows)`);
  } finally { if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-workspace-main-")) fs.rmSync(home, { recursive: true, force: true }); }
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
