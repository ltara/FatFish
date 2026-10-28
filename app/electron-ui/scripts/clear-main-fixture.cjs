"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), { EventEmitter } = require("node:events"), { createRequire } = require("node:module");
async function fixture(root) {
  const licensed = require("../../core/dev/license-fixture.cjs").licensedFixture(root), handlers = new Map(), windows = [], timers = [];
  fs.mkdirSync(path.join(root, "runtime"), { recursive: true }); fs.writeFileSync(path.join(root, "runtime/risk_ok"), "1\n");
  let ready, stopped = 0, quits = 0, stopFailure = false, pending;
  const app = new EventEmitter(); Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: () => ({ then: (fn) => { ready = fn; } }), quit() { quits++; }, isPackaged: false, getVersion: () => "test" });
  class Window extends EventEmitter { constructor() { super(); this.webContents = new EventEmitter(); Object.assign(this.webContents, { mainFrame: {}, isDestroyed: () => false, setWindowOpenHandler() {}, send() {} }); windows.push(this); } loadFile() {} isDestroyed() { return false; } }
  Window.getAllWindows = () => windows;
  class Services extends EventEmitter {
    sendCore() { return true; } async refreshProbes() {} getState() { return { phase: "running", core: true }; } getCore() { return { engines: {}, channels: { qq: "disabled" } }; } readQqEnabled() { return false; }
    async stopAll() { stopped++; }
    async stopForDataReset() { if (stopFailure) throw new Error("stop_failed"); return this.stopAll(); }
    requestCore() { return pending || Promise.resolve({ ok: true, data: {} }); }
  }
  const req = createRequire(path.join(__dirname, "../main.js"));
  const context = vm.createContext({ __dirname: path.resolve(__dirname, ".."), Buffer, console, process: { env: { FATFISH_APPDATA: root, FATFISH_SMOKE: "1" }, platform: process.platform, execPath: process.execPath },
    setTimeout: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, clearTimeout() {},
    require: (name) => name === "electron" ? { app, BrowserWindow: Window, ipcMain: { handle: (id, fn) => handlers.set(id, fn) }, session: { defaultSession: { setPermissionRequestHandler() {} } } } : name === "../core/license-gate.cjs" ? licensed.gate() : name === "./service-manager" ? { ServiceManager: Services } : req(name) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../main.js"), "utf8"), context); await ready();
  const event = { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame };
  return { context, timers, handlers, event, call: (id, ...args) => handlers.get(id)(event, ...args), stopped: () => stopped, quits: () => quits, setStopFailure: (v) => { stopFailure = v; }, setPending: (p) => { pending = p; }, dispose: () => vm.runInContext("shutdownServices()", context) };
}
module.exports = { fixture };
