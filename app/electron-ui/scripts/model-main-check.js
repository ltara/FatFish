/** Model IPC/legacy key forwarding and key-input contracts in Node VM; no Electron/window is launched. */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), { EventEmitter } = require("node:events");
const { join, resolve, sep } = require("node:path"), { tmpdir } = require("node:os"), { createRequire } = require("node:module");
const model = require("../../core/model-config.cjs"), home = fs.mkdtempSync(join(tmpdir(), "fatfish-model-main-")), handlers = new Map(), windows = [], requests = [];
const licensed = require("../../core/dev/license-fixture.cjs").licensedFixture(home); Object.assign(process.env, licensed.env);
fs.mkdirSync(join(home, "runtime"), { recursive: true }); fs.writeFileSync(join(home, "runtime/risk_ok"), "1\n");
const key = "sk-main-model-fixture-DDDD", settings = { provider: "custom", model: "test-model", api: "openai-completions", baseURL: "http://127.0.0.1:12345/v1" };
let ready, count = 0, coreFailure = null;
const app = new EventEmitter(); Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: () => ({ then: (fn) => { ready = fn; } }), quit() {}, isPackaged: false, getVersion: () => "test" });
class Window extends EventEmitter {
  constructor() { super(); this.webContents = new EventEmitter(); Object.assign(this.webContents, { mainFrame: {}, isDestroyed: () => false, setWindowOpenHandler() {}, send() {} }); windows.push(this); }
  loadFile() { return Promise.resolve(); }
  isDestroyed() { return false; }
}
Window.getAllWindows = () => windows;
class Services extends EventEmitter {
  sendCore() { return true; }
  async refreshProbes() {}
  requestCore(type, payload) { requests.push({ type, ...payload }); return Promise.resolve(coreFailure || { ok: true, data: payload.op === "test" ? { connected: true, durationMs: 1 } : { ...settings, key_saved: true, key_tail: "DDDD", generation: 1 } }); }
  getState() { return { phase: "running", core: true, backend: false }; }
  getCore() { return { engines: {}, channels: { qq: "disabled" } }; }
  readQqEnabled() { return false; }
  async stopAll() {}
}
const actualRequire = createRequire(join(__dirname, "../main.js"));
const context = vm.createContext({ __dirname: resolve(__dirname, ".."), Buffer, console,
  process: { env: { FATFISH_APPDATA: home, FATFISH_SMOKE: "1" }, platform: process.platform, execPath: process.execPath },
  setTimeout: () => ({ unref() {} }), clearTimeout() {},
  require: (name) => name === "electron" ? { app, BrowserWindow: Window, ipcMain: { handle: (id, fn) => handlers.set(id, fn) }, session: { defaultSession: { setPermissionRequestHandler() {} } } } : name === "../core/license-gate.cjs" ? licensed.gate() : name === "./service-manager" ? { ServiceManager: Services } : actualRequire(name),
});
const check = (name, ok) => { assert.ok(ok, name); count++; console.log("PASS " + name); };
(async () => {
  try {
    model.save(home, { ...settings, key });
    vm.runInContext(fs.readFileSync(join(__dirname, "../main.js"), "utf8"), context); await ready();
    const win = windows[0], event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }, foreign = { sender: {}, senderFrame: {} };
    const call = (channel, ...args) => handlers.get(channel)(event, ...args);
    for (const channel of ["model-get", "model-save", "model-test", "save-api-key"]) check("foreign window denied: " + channel, (await handlers.get(channel)(foreign, { ...settings, key })).error === "forbidden");
    check("child frame cannot read saved model metadata", (await handlers.get("model-get")({ sender: win.webContents, senderFrame: {} })).error === "forbidden");
    check("Main reads saved status from the active versioned key, not the legacy filename", (await call("get-status")).key_saved && !fs.existsSync(join(home, "secrets/deepseek_api_key")));
    check("new model get forwards only to Core", (await call("model-get")).ok && requests.at(-1).type === "model_ui" && requests.at(-1).op === "get");
    check("new save and test are distinct Core operations", (await call("model-save", { ...settings, key })).ok && requests.at(-1).op === "save" && (await call("model-test", { ...settings, key })).data.connected && requests.at(-1).op === "test");
    check("invalid and excessive payloads are refused before Core", (await call("model-save", [])).error === "model_args_invalid" && (await call("model-test", { key: "x".repeat(17000) })).error === "model_args_invalid");
    const circular = {}; circular.self = circular;
    check("cyclic IPC payload fails closed instead of throwing raw errors", (await call("model-save", circular)).error === "model_args_invalid");
    const before = requests.length;
    check("legacy key entry forwards into the currently selected route", (await call("save-api-key", "  " + key + "  ")).ok && requests.length === before + 2 && requests.at(-1).args.provider === "custom" && requests.at(-1).args.baseURL === settings.baseURL && requests.at(-1).args.key === key);
    check("legacy forwarding strips status fields instead of persisting them", !Object.hasOwn(requests.at(-1).args, "generation") && !Object.hasOwn(requests.at(-1).args, "key_saved"));
    check("legacy forwarding uses the version it read to avoid overwriting a concurrent model change", requests.at(-1).args.expectedGeneration === 1);
    coreFailure = { ok: false, error: "core_unavailable" };
    check("legacy entry preserves Core failure instead of falsely saving an unused key", (await call("save-api-key", key)).error === "core_unavailable"); coreFailure = null;
    check("metadata responses do not echo the complete key", !JSON.stringify(await call("model-get")).includes(key) && !JSON.stringify(await call("get-status")).includes(key));

    const events = new EventEmitter(), calls = []; let exposed;
    vm.runInNewContext(fs.readFileSync(join(__dirname, "../preload.js"), "utf8"), { require: () => ({ contextBridge: { exposeInMainWorld: (_n, api) => { exposed = api; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); }, on: (...args) => events.on(...args), removeListener: (...args) => events.removeListener(...args) } }) });
    exposed.getModel(); exposed.saveModel(settings); exposed.testModel(settings);
    check("preload has bounded model channels, not a general Core command", calls[0][0] === "model-get" && calls[1][0] === "model-save" && calls[2][0] === "model-test" && !exposed.sendCore);
    let notices = 0; const off = exposed.onModelChanged(() => notices++); events.emit("model-changed"); off(); events.emit("model-changed");
    check("model subscription can be detached", notices === 1);
    await vm.runInContext("shutdownServices()", context);
    console.log(`${count}/${count} model Main/preload/key-input checks passed (Node VM, no windows)`);
  } finally { if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-model-main-")) fs.rmSync(home, { recursive: true, force: true }); }
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
