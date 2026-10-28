/** Execute real main.js handlers in a Node VM with a mocked shell; no Electron executable/window. */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), { EventEmitter } = require("node:events");
const { join, resolve, sep } = require("node:path"), { tmpdir } = require("node:os"), { createRequire } = require("node:module");
const home = fs.mkdtempSync(join(tmpdir(), "fatfish-inbox-main-")), handlers = new Map(), commands = [], windows = [];
const licensed = require("../../core/dev/license-fixture.cjs").licensedFixture(home); Object.assign(process.env, licensed.env);
fs.mkdirSync(join(home, "runtime"), { recursive: true }); fs.writeFileSync(join(home, "runtime/risk_ok"), "1\n");
const app = new EventEmitter(); let ready, checks = 0, stopped = 0;
Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: () => ({ then: (fn) => { ready = fn; } }), quit: () => {}, isPackaged: false, getVersion: () => "test" });
class FakeWindow extends EventEmitter {
  constructor() { super(); this.visible = false; this.focused = false; this.minimized = false; this.shows = 0; this.focuses = 0;
    this.webContents = new EventEmitter(); Object.assign(this.webContents, { mainFrame: {}, isDestroyed: () => false, setWindowOpenHandler: () => {}, send: () => {} }); windows.push(this); }
  loadFile() { return Promise.resolve(); }
  isDestroyed() { return false; }
  isVisible() { return this.visible; }
  isFocused() { return this.focused; }
  isMinimized() { return this.minimized; }
  show() { this.shows++; }
  focus() { this.focuses++; }
}
FakeWindow.getAllWindows = () => windows;
class FakeServices extends EventEmitter {
  constructor() { super(); FakeServices.instance = this; }
  sendCore(m) { commands.push(m); return true; }
  getState() { return { phase: "running", core: true, backend: false }; }
  getCore() { return { engines: {}, channels: { qq: "disabled" } }; }
  readQqEnabled() { return false; }
  async stopAll() { stopped++; }
}
const actualRequire = createRequire(join(__dirname, "../main.js"));
const context = vm.createContext({ __dirname: resolve(__dirname, ".."), Buffer, console,
  process: { env: { FATFISH_APPDATA: home, FATFISH_SMOKE: "1" }, platform: process.platform, execPath: process.execPath },
  setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
  require: (name) => name === "electron" ? { app, BrowserWindow: FakeWindow, ipcMain: { handle: (id, fn) => handlers.set(id, fn) }, session: { defaultSession: { setPermissionRequestHandler() {} } } } : name === "../core/license-gate.cjs" ? licensed.gate() : name === "./service-manager" ? { ServiceManager: FakeServices } : actualRequire(name),
});
const check = (name, value) => { assert.ok(value, name); checks++; console.log("PASS " + name); };
(async () => {
  try {
    vm.runInContext(fs.readFileSync(join(__dirname, "../main.js"), "utf8"), context); await ready();
    const win = windows[0], service = FakeServices.instance, event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    const call = (channel, ...args) => handlers.get(channel)(event, ...args);
    const payload = { type: "reminder_delivery", reminderId: "main-r1", deliveryId: "main-r1:1000", dueAt: 1000, sourceSession: "owner-main", text: "这是远程来源的提醒。", fallback: false };
    service.emit("core-message", { type: "reminder_catalog", ids: ["main-r1"] }); service.emit("core-message", { type: "ready" }); service.emit("core-message", payload);
    const first = await call("chat-get");
    check("actual Main handler merges durable reminders into chat display", first.ok && first.messages.some((m) => m.reminderDeliveryId === payload.deliveryId) && first.reminderUnshown === 1);
    check("Main receipt does not force a window to the foreground", win.shows === 0 && win.focuses === 0);
    const foreign = { sender: { mainFrame: {} }, senderFrame: {} };
    check("foreign window cannot read reminder text through chat-get", (await handlers.get("chat-get")(foreign)).error === "forbidden");
    check("foreign frame cannot mark the owner's reminders shown", (await handlers.get("reminders-shown")({ sender: win.webContents, senderFrame: {} }, [payload.deliveryId])).error === "forbidden");
    check("hidden Main window cannot mark displayed", (await call("reminders-shown", [payload.deliveryId])).error === "window_not_visible");
    win.visible = true;
    check("visible but unfocused Main window cannot mark displayed", (await call("reminders-shown", [payload.deliveryId])).error === "window_not_visible");
    win.focused = true; win.minimized = true;
    check("minimized Main window cannot mark displayed", (await call("reminders-shown", [payload.deliveryId])).error === "window_not_visible");
    win.minimized = false;
    check("focused owner Main window can mark displayed", (await call("reminders-shown", [payload.deliveryId])).ok && (await call("chat-get")).reminderUnshown === 0);
    const next = await call("chat-new");
    check("actual new-chat handler does not redisplay an old shown reminder", next.ok && (await call("chat-get")).messages.length === 0);
    service.emit("core-message", payload);
    check("late replay through Main does not resurrect it in the new chat", (await call("chat-get")).messages.length === 0);
    const nextPayload = { ...payload, dueAt: 2000, deliveryId: "main-r1:2000", text: "新的一次提醒。" }; service.emit("core-message", nextPayload);
    check("later occurrence reaches the new conversation", (await call("chat-get")).messages.some((m) => m.reminderDeliveryId === nextPayload.deliveryId));
    const file = join(home, "inbox/reminders.json"), saved = fs.readFileSync(file, "utf8"); fs.writeFileSync(file, "broken-json");
    const degraded = await call("chat-get");
    check("Main still serves ordinary chat if only inbox data is corrupt", degraded.ok && !!degraded.reminderError && Array.isArray(degraded.messages));
    fs.writeFileSync(file, saved); await call("chat-get");
    check("Main never routes a reminder as a new model prompt", commands.every((m) => ["reminder_ack", "reminder_inbox_status", "reminder_catalog_request"].includes(m.type)));
    check("Main has sent positive ack only for valid durable payloads", commands.filter((m) => m.type === "reminder_ack" && m.ok).length === 3);
    await vm.runInContext("shutdownServices()", context);
    check("Main shutdown detaches the inbox and stops services", stopped === 1 && service.listenerCount("core-message") === 1 && commands.at(-1).type === "reminder_inbox_status" && commands.at(-1).available === false);
    console.log(`${checks}/${checks} Main inbox checks passed (Node VM/mock shell, no windows)`);
  } finally { if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-inbox-main-")) fs.rmSync(home, { recursive: true, force: true }); }
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
