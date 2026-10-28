/** Actual Main IPC license boundary in Node VM; every shell surface is a plain fake, not native UI. */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), { EventEmitter } = require("node:events");
const { join, resolve, sep } = require("node:path"), { tmpdir } = require("node:os"), { createRequire } = require("node:module");
const home = fs.mkdtempSync(join(tmpdir(), "fatfish-license-main-")), fixture = require("../../core/dev/license-fixture.cjs").licensedFixture(home), licenseFile = join(home, "license.json"), validBytes = fs.readFileSync(licenseFile, "utf8");
const evidenceIndex = process.argv.indexOf("--evidence"), evidence = evidenceIndex < 0 ? null : resolve(process.argv[evidenceIndex + 1]), results = [];
const check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
async function load() {
  let ready, starts = 0, stops = 0; const handlers = new Map(), windows = [], commands = [];
  const app = new EventEmitter(); Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: () => ({ then: (fn) => { ready = fn; } }), quit() {}, isPackaged: false, getVersion: () => "test" });
  class Window extends EventEmitter { constructor() { super(); this.webContents = new EventEmitter(); Object.assign(this.webContents, { mainFrame: {}, isDestroyed: () => false, setWindowOpenHandler() {}, send() {} }); windows.push(this); } loadFile() {} isDestroyed() { return false; } }
  Window.getAllWindows = () => windows;
  class Tray { setToolTip() {} setImage() {} setContextMenu() {} on() {} destroy() {} }
  class Services extends EventEmitter {
    sendCore(m) { commands.push(m); return true; } async startAll() { starts++; return { phase: "running" }; } async stopAll() { stops++; }
    async refreshProbes() {} getState() { return { phase: "running", core: true }; } getCore() { return { engines: {}, channels: {}, license: { valid: true } }; } readQqEnabled() { return false; }
    requestCore(type, args) { commands.push({ type, ...args }); return Promise.resolve({ ok: true, data: { connected: true } }); }
  }
  const realRequire = createRequire(join(__dirname, "../main.js")), image = { isEmpty: () => false };
  const context = vm.createContext({ __dirname: resolve(__dirname, ".."), Buffer, console, process: { env: { FATFISH_APPDATA: home, FATFISH_LICENSE_VALID: "1" }, platform: "win32", execPath: process.execPath }, setTimeout: () => ({ unref() {} }), clearTimeout() {},
    require: (name) => name === "electron" ? { app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: (items) => items }, nativeImage: { createFromPath: () => image, createFromBuffer: () => image, createFromBitmap: () => image }, ipcMain: { handle: (id, fn) => handlers.set(id, fn) }, session: { defaultSession: { setPermissionRequestHandler() {} } } } : name === "../core/license-gate.cjs" ? fixture.gate() : name === "./service-manager" ? { ServiceManager: Services } : realRequire(name) });
  vm.runInContext(fs.readFileSync(join(__dirname, "../main.js"), "utf8"), context); await ready();
  const event = { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame };
  return { handlers, context, commands, event, starts: () => starts, stops: () => stops, call: (id, ...args) => handlers.get(id)(event, ...args) };
}
(async () => {
  let first, second;
  try {
    fs.unlinkSync(licenseFile); first = await load();
    check("unlicensed Main startup never starts backend or Core despite forged env/Core flags", first.starts() === 0 && !(await first.call("get-license")).valid);
    const status = await first.call("get-status");
    check("unlicensed status returns only activation metadata, not private app data", status.license.error === "activation_required" && status.presentation.label === "待激活" && !Object.hasOwn(status, "appdata") && !Object.hasOwn(status, "active_persona_title") && !Object.hasOwn(status, "key_saved"));
    const publicNames = new Set(["get-license", "activate-license", "get-about", "get-status", "window-minimize", "window-maximize-toggle", "window-close"]), at = first.commands.length;
    for (const [name] of first.handlers) if (!publicNames.has(name)) assert.equal((await first.call(name, { text: "forbidden" })).error, "activation_required", name);
    check("every registered protected Main IPC is closed before activation", first.commands.length === at && first.stops() > 0);
    check("untrusted frames cannot read license state or submit a code", (await first.handlers.get("get-license")({ sender: {}, senderFrame: {} })).error === "forbidden" && (await first.handlers.get("activate-license")({ sender: first.event.sender, senderFrame: {} }, "FF" + "A".repeat(32))).error === "forbidden");
    fs.writeFileSync(licenseFile, validBytes);
    check("Main independently recognizes a valid locally installed license", (await first.call("get-license")).valid);
    const waitingConsent = await load();
    check("licensed startup still defers every service until consent is saved", waitingConsent.starts() === 0 && (await waitingConsent.call("get-status")).phase === "risk_confirmation_required");
    await vm.runInContext("shutdownServices()", waitingConsent.context);
    check("license alone cannot start a paid model test before basic consent", first.starts() === 0 && (await first.call("model-test", {})).error === "risk_confirmation_required");
    await first.call("accept-risk");
    check("licensed Main allows the bounded model connection command", (await first.call("model-test", {})).ok && first.commands.at(-1).type === "model_ui" && first.commands.at(-1).op === "test");
    fs.writeFileSync(licenseFile, validBytes + " "); const before = first.commands.length;
    check("tampered license blocks a new command even if Core claims valid", (await first.call("model-test", {})).error === "license_invalid" && first.commands.length === before);
    check("invalid code payload never reaches activation networking", (await first.call("activate-license", {})).error === "invalid_code");
    fs.writeFileSync(licenseFile, validBytes); second = await load();
    check("licensed non-smoke Main starts services exactly once", second.starts() === 1);
    check("license responses expose no fingerprint or signed payload", !JSON.stringify(await second.call("get-license")).includes(fixture.fingerprint) && !Object.hasOwn(await second.call("get-license"), "payload"));
    await vm.runInContext("shutdownServices()", first.context); first = null; await vm.runInContext("shutdownServices()", second.context); second = null;
    console.log(`${results.length}/${results.length} Main license checks passed (Node VM, no native UI)`);
  } finally {
    if (first) await vm.runInContext("shutdownServices()", first.context); if (second) await vm.runInContext("shutdownServices()", second.context);
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(join(evidence, "license-main-report.json"), JSON.stringify({ results, nativeUI: false, paidCalls: 0, ephemeralTestPublicKey: true }, null, 2)); }
    if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-license-main-")) fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
