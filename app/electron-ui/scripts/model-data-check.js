/** Actual Main/preload/form module/Core/runtime data chain, with mock shell/elements. Never creates a native window. */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), { EventEmitter } = require("node:events");
const { join, resolve, sep } = require("node:path"), { tmpdir } = require("node:os"), { createRequire } = require("node:module"), { fork } = require("node:child_process");
const { ServiceManager } = require("../service-manager"), { create } = require("../renderer/model-view");
const home = fs.mkdtempSync(join(tmpdir(), "fatfish-model-data-")), handlers = new Map(), elements = new Map(), rendererEvents = new EventEmitter(), windows = [], requests = [], messages = [], results = [];
const licensed = require("../../core/dev/license-fixture.cjs").licensedFixture(home); Object.assign(process.env, licensed.env);
const key = "sk-model-data-fixture-EEEE", evidenceIndex = process.argv.indexOf("--evidence"), evidence = evidenceIndex < 0 ? null : resolve(process.argv[evidenceIndex + 1]);
let ready, core, proxy, services, exposed, view, fault = null, context, backend, socket, reply = key, deliveryFail = false;
const withOnboarding = process.argv.includes("--onboarding"), logs = [];
if (!withOnboarding) { fs.mkdirSync(join(home, "runtime"), { recursive: true }); fs.writeFileSync(join(home, "runtime/risk_ok"), "1\n"); }
const check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, label) { const end = Date.now() + 30000; while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(20); } throw new Error("model_data_timeout:" + label); }
const $ = (id) => {
  if (!elements.has(id)) { const classes = new Set(); elements.set(id, { value: "", textContent: "", className: "", disabled: false, attrs: {}, listeners: new Map(),
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, fn) { this.listeners.set(k, fn); }, classList: { toggle: (s, on) => on ? classes.add(s) : classes.delete(s), contains: (s) => classes.has(s) } }); }
  return elements.get(id);
};
const input = (id, value, event = "input") => { $(id).value = value; $(id).listeners.get(event)?.(); };
const app = new EventEmitter(); Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: () => ({ then: (fn) => { ready = fn; } }), quit() {}, isPackaged: false, getVersion: () => "test" });
class Window extends EventEmitter {
  constructor() { super(); this.webContents = new EventEmitter(); Object.assign(this.webContents, { mainFrame: {}, isDestroyed: () => false, setWindowOpenHandler() {}, send: (channel, ...args) => rendererEvents.emit(channel, {}, ...args) }); windows.push(this); }
  loadFile() { return Promise.resolve(); }
  isDestroyed() { return false; }
}
Window.getAllWindows = () => windows;
class BridgeServices extends ServiceManager {
  constructor(options) { super(options); services = this; }
  sendCore(message) { return core?.connected ? core.send(message) : false; }
  requestCore(type, payload = {}, timeout) {
    if (type === "model_ui" && ["save", "test"].includes(payload.op)) {
      if (payload.args.provider !== "custom" || payload.args.baseURL !== proxy.url) throw new Error("fixture_refuses_external_endpoint");
    }
    requests.push({ type, op: payload.op }); return super.requestCore(type, payload, timeout);
  }
  getState() { return { phase: "running", core: !!core?.connected, backend: false }; }
  async setQqEnabled(enabled) { return this.requestCore("channel_set", { enabled }); } // Fixture transport only; never launch a real account backend.
  async refreshProbes() {}
  async stopAll() {
    if (!core) return;
    const child = core; child.send({ type: "shutdown" }); await wait(() => child.exitCode !== null || child.signalCode !== null, "core_exit"); assert.equal(child.exitCode, 0); this._identityUnavailable(); core = null;
  }
}
(async () => {
  try {
    const { startCompatProxy } = await import("../../core/dev/compat-proxy.mjs");
    proxy = await startCompatProxy({ failure: () => fault, reply: () => reply }); // Deliberately echo a credential: UI must not show provider test text.
    let onebot_url;
    if (withOnboarding) {
      const { WebSocketServer } = require("../../core/node_modules/ws"); backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      backend.on("connection", (ws) => { socket = ws; ws.on("message", (b) => { const m = JSON.parse(b), failed = m.action === "send_private_msg" && deliveryFail;
        ws.send(JSON.stringify({ status: failed ? "failed" : "ok", retcode: failed ? 1 : 0, echo: m.echo, data: m.action === "get_login_info" ? { user_id: 90000, nickname: "肥鱼" } : { message_id: 1 } })); }); });
      await new Promise((r) => backend.once("listening", r)); onebot_url = "ws://127.0.0.1:" + backend.address().port;
    }
    fs.writeFileSync(join(home, "config.json"), JSON.stringify({ channels: { qq: { enabled: false } }, owners: [], ...(onebot_url ? { onebot_url } : {}) }));
    const actualRequire = createRequire(join(__dirname, "../main.js"));
    context = vm.createContext({ __dirname: resolve(__dirname, ".."), Buffer, console, process: { env: { FATFISH_APPDATA: home, FATFISH_SMOKE: "1" }, platform: process.platform, execPath: process.execPath },
      setTimeout: () => ({ unref() {} }), clearTimeout() {},
      require: (name) => name === "electron" ? { app, BrowserWindow: Window, ipcMain: { handle: (id, fn) => handlers.set(id, fn) }, session: { defaultSession: { setPermissionRequestHandler() {} } } } : name === "../core/license-gate.cjs" ? licensed.gate() : name === "./service-manager" ? { ServiceManager: BridgeServices } : actualRequire(name) });
    vm.runInContext(fs.readFileSync(join(__dirname, "../main.js"), "utf8"), context); await ready();
    const win = windows[0], event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    vm.runInNewContext(fs.readFileSync(join(__dirname, "../preload.js"), "utf8"), { require: () => ({ contextBridge: { exposeInMainWorld: (_n, api) => { exposed = api; } },
      ipcRenderer: { invoke: (id, ...args) => Promise.resolve(handlers.get(id)(event, ...args)), on: (...args) => rendererEvents.on(...args), removeListener: (...args) => rendererEvents.removeListener(...args) } }) });
    core = fork(licensed.entry, [], { execPath: process.env.E2E_EXEC_PATH || process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FATFISH_APPDATA: home }, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    core.stdout.on("data", (b) => logs.push(b.toString())); core.stderr.on("data", (b) => logs.push(b.toString())); core.on("message", (m) => { messages.push(m); services._onCoreMessage(m); });
    await wait(() => messages.some((m) => m.type === "ready"), "ready");
    if (withOnboarding) {
      check("fresh setup begins at explicit consent", (await exposed.getOnboarding()).data.phase === "risk");
      const beforeConsent = proxy.requests.length;
      check("even direct model commands cannot run before consent", (await exposed.testModel({})).error === "risk_confirmation_required" && proxy.requests.length === beforeConsent);
      check("actual consent persistence advances to the model step", await exposed.acceptRisk() === true && (await exposed.getOnboarding()).data.phase === "model");
    }
    view = create(exposed, { query: $, changed: () => {} }); view.wire(); view.enter("settings");
    await wait(() => $("#model-name").value === "deepseek-flash", "read_form");
    check("actual form obtains current model and catalog through preload/Main/Core", requests.some((r) => r.type === "model_ui" && r.op === "get") && $("#btn-model-test").disabled);
    input("#model-provider", "custom", "change"); input("#model-base-url", proxy.url); input("#model-name", "data-chain-model"); input("#api-key", key);
    await view.save();
    const stored = JSON.parse(fs.readFileSync(join(home, "config.json"), "utf8"));
    check("form save reaches the actual atomic Core model/key store", stored.model.provider === "custom" && stored.model.model === "data-chain-model" && stored.model.generation === 1 && !!stored.model.keyRef && !JSON.stringify(stored).includes(key));
    check("saved key is cleared in the form and recognized by real Main status", $("#api-key").value === "" && (await exposed.getStatus()).key_saved && $("#key-mask-hint").textContent.includes("EEEE"));
    const before = fs.readFileSync(join(home, "config.json"), "utf8"), at = proxy.requests.length;
    await view.test();
    check("explicit form test reaches the real temporary runtime once", proxy.requests.length === at + 1 && proxy.requests.at(-1).body.model === "data-chain-model" && !proxy.requests.at(-1).body.tools?.length && $("#settings-msg").textContent === "连接正常。");
    check("test neither changes config nor creates a normal chat/message", fs.readFileSync(join(home, "config.json"), "utf8") === before && !messages.some((m) => m.type === "chat_result") && !fs.existsSync(join(home, "chat")));
    check("provider echo of the complete credential never reaches visible status text", [...elements.values()].every((e) => !e.textContent.includes(key)));
    input("#model-name", "unsaved-owner-draft");
    const changed = await services.requestCore("model_ui", { op: "save", args: { provider: "custom", model: "changed-elsewhere", api: "openai-completions", baseURL: proxy.url, expectedGeneration: 1 } }, 60000);
    await wait(() => $("#btn-model-test").disabled && $("#settings-msg").textContent.includes("当前输入已保留"), "stale_notification");
    check("real Core change notification preserves a dirty form and blocks stale actions", changed.ok && $("#model-name").value === "unsaved-owner-draft");
    const blockedAt = proxy.requests.length; await view.test();
    check("stale form cannot generate a paid test request", proxy.requests.length === blockedAt);
    await view.reload();
    check("explicit reread restores the actual new Core model/version", $("#model-name").value === "changed-elsewhere" && !$("#btn-model-test").disabled);
    fault = "hold"; const holdAt = proxy.requests.length, testing = view.test(); await wait(() => proxy.requests.length > holdAt, "held_connection");
    const requestAt = requests.length; await view.test(); await view.save();
    check("busy controls prevent duplicate requests across the full data chain", requests.length === requestAt && $("#btn-save-key").disabled && $("#model-provider").disabled);
    fault = null; proxy.releaseHeld(); await testing;
    check("held test recovers with no settings write", $("#settings-msg").textContent === "连接正常。" && JSON.parse(fs.readFileSync(join(home, "config.json"))).model.generation === 2);
    fault = 401; await view.test();
    check("real invalid-key classification becomes fixed Chinese form feedback", $("#settings-msg").textContent.includes("密钥未通过验证") && !$("#settings-msg").textContent.includes(key));
    if (withOnboarding) {
      fault = null;
      const priorRoute = (await exposed.getModel()).data;
      await exposed.saveModel({ provider: "custom", model: "onboarding-final-route", api: "openai-completions", baseURL: proxy.url, expectedGeneration: priorRoute.generation });
      check("changing a pending saved route invalidates its earlier connection receipt", !(await exposed.getOnboarding()).data.modelReady && (await exposed.getOnboarding()).data.phase === "model");
      const older = (await exposed.getModel()).data, heldAt = proxy.requests.length; fault = "hold";
      const oldTest = exposed.testModel({ provider: "custom", model: older.model, api: older.api, baseURL: older.baseURL, expectedGeneration: older.generation });
      await wait(() => proxy.requests.length > heldAt, "old_model_test_held");
      await exposed.saveModel({ provider: "custom", model: "onboarding-newer-route", api: "openai-completions", baseURL: proxy.url, expectedGeneration: older.generation });
      fault = null; proxy.releaseHeld(); const superseded = await oldTest;
      check("a late successful test cannot certify settings changed while it was running", superseded.ok && superseded.data.connected && !superseded.data.onboarding_model_ready && !(await exposed.getOnboarding()).data.modelReady);
      const current = (await exposed.getModel()).data, args = Object.fromEntries(["provider", "model", "api", "baseURL", "contextWindow", "maxTokens"].map((k) => [k, current[k]])); args.expectedGeneration = current.generation;
      check("successful unsaved draft test cannot certify saved settings", (await exposed.testModel({ ...args, model: "different-unsaved-draft" })).ok && !(await exposed.getOnboarding()).data.modelReady);
      const rename = fs.renameSync, progressFile = join(home, "onboarding.json"); let tested;
      try { fs.renameSync = (from, to) => { if (to === progressFile) throw new Error("fixture_progress_write_failure"); return rename(from, to); }; tested = await exposed.testModel(args); }
      finally { fs.renameSync = rename; }
      check("a real successful connection with a failed progress write is not reported as durable", tested.ok && tested.data.connected && !tested.data.onboarding_saved);
      const afterTestCalls = proxy.requests.length;
      check("reread recovers the current-generation test receipt without another model call", (await exposed.getOnboarding()).data.phase === "local" && proxy.requests.length === afterTestCalls);
      fault = 401; const failedLocal = await exposed.sendChat("不会成功的固定试聊"); fault = null;
      check("failed local model result cannot complete first-run setup", !failedLocal.ok && !(await exposed.getOnboarding()).data.baseComplete);
      reply = "本机试聊已完成。"; let chat;
      try { fs.renameSync = (from, to) => { if (to === progressFile) throw new Error("fixture_trial_progress_write_failure"); return rename(from, to); }; chat = await exposed.sendChat("ONBOARDING_LOCAL_TRIAL_SENTINEL"); }
      finally { fs.renameSync = rename; }
      check("a delivered local reply is retained even if setup progress cannot be saved", chat.ok && !chat.onboarding_saved && JSON.parse(fs.readFileSync(progressFile, "utf8")).baseComplete === false);
      const afterChatCalls = proxy.requests.length;
      check("actual local chat receipt completes base after disk recovery without QQ or resend", (await exposed.getOnboarding()).data.baseComplete && proxy.requests.length === afterChatCalls && !socket);
      const progress = fs.readFileSync(join(home, "onboarding.json"), "utf8");
      check("setup progress never stores key or local conversation text", !progress.includes(key) && !progress.includes("ONBOARDING_LOCAL_TRIAL_SENTINEL") && !progress.includes(reply));
      check("optional branch starts separately and does not enable QQ automatically", (await exposed.startQqOnboarding()).data.phase === "qq-risk" && !socket);
      await exposed.deferOnboarding(true);
      check("defer preserves unfinished optional branch without claiming it complete", !(await exposed.getOnboarding()).data.needsWizard && !(await exposed.getOnboarding()).data.qqComplete);
      check("explicit resume restores the same pending branch", (await exposed.deferOnboarding(false)).data.phase === "qq-risk");
      check("QQ still requires separate explicit account-risk confirmation", (await exposed.setQqEnabled(true, false)).error === "risk_confirmation_required" && !socket);
      await exposed.setQqEnabled(true, true); await wait(() => services.getCore().channels.qq === "online" && services.getCore().self.qq?.userId, "fixture_qq_online");
      check("actual fixture login advances to owner pairing", (await exposed.getOnboarding()).data.phase === "qq-pair");
      const pair = await exposed.startPairing();
      const sendRemote = (account, text) => socket.send(JSON.stringify({ post_type: "message", message_type: "private", self_id: 90000, user_id: account, message: [{ type: "text", data: { text } }] }));
      sendRemote(10001, pair.pairing.code); await wait(() => JSON.parse(fs.readFileSync(join(home, "config.json"), "utf8")).owners.length > 0, "real_pairing");
      check("pairing acknowledgement is not a remote model conversation", (await exposed.getOnboarding()).data.phase === "qq-trial");
      const ignoredAt = services.getCore().stats?.ignored || 0, modelAt = proxy.requests.length; sendRemote(20002, "我是假主人");
      await wait(() => services.getCore().stats.ignored > ignoredAt, "ignored_stranger");
      check("unbound account cannot consume a model call or complete setup", proxy.requests.length === modelAt && !(await exposed.getOnboarding()).data.qqComplete);
      const errorsAt = services.getCore().stats.errors || 0; fault = 401; sendRemote(10001, "固定错误回复测试");
      await wait(() => services.getCore().stats.errors > errorsAt, "model_error_reply"); fault = null;
      check("acknowledged system error text is not a successful remote model conversation", !(await exposed.getOnboarding()).data.qqComplete);
      deliveryFail = true; sendRemote(10001, "固定的远程试聊"); await wait(() => logs.some((s) => s.includes("sent=false")), "failed_delivery");
      check("successful model generation without channel acknowledgement cannot complete QQ", !(await exposed.getOnboarding()).data.qqComplete);
      deliveryFail = false; sendRemote(10001, "再发一句固定试聊");
      await wait(() => JSON.parse(fs.readFileSync(join(home, "onboarding.json"), "utf8")).qqComplete, "confirmed_owner_reply");
      check("actual owner delivery completes optional setup through Core metadata only", (await exposed.getOnboarding()).data.qqComplete && (await exposed.getOnboarding()).data.phase === "done" && messages.some((m) => m.type === "owner_reply"));
      check("renderer has no API to manufacture model or delivery receipts", !exposed.recordOnboarding && !exposed.markSetupComplete && !exposed.sendCore);
      check("metadata logs omit key and trial text", [key, "ONBOARDING_LOCAL_TRIAL_SENTINEL", "固定的远程试聊"].every((s) => !logs.join("").includes(s)));
    }
    view.dispose(); view = null; await vm.runInContext("shutdownServices()", context);
    check("full-chain shutdown releases Core and model subscriptions", !core && rendererEvents.listenerCount("model-changed") === 0);
    console.log(`${results.length}/${results.length} model data-chain checks passed (real Core/runtime, mock shell/elements, no windows/paid calls)`);
  } finally {
    view?.dispose(); if (core) await services?.stopAll(); await proxy?.close();
    if (backend) await new Promise((r) => { for (const ws of backend.clients) ws.terminate(); backend.close(r); });
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(join(evidence, "model-data-report.json"), JSON.stringify({ results, sourceManifest: licensed.manifest, nativeUI: false, DOM: false, paidCalls: 0, model: "loopback-fixture", withOnboarding, realQQ: false }, null, 2)); }
    if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-model-data-")) fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
