"use strict";
// Explicitly authorized independent window. No owner history/key, real QQ, paid model or install.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http"), { spawn } = require("node:child_process"), { createHash } = require("node:crypto"), { pathToFileURL } = require("node:url");
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== "--allow-independent-window" || args[1] !== "--evidence" || !path.isAbsolute(args[2])) throw Error("explicit_window_authorization_required");
const evidence = path.resolve(args[2]), home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fatfish-m5-native-")); fs.mkdirSync(evidence, { recursive: true });
const fixture = require("../../core/dev/license-fixture.cjs").licensedFixture(home), ui = fixture.ui();
fs.unlinkSync(path.join(home, "license.json"));
const code = "FF" + "3".repeat(28) + "9A7C", controlFile = path.join(evidence, "control.json"), liveFile = path.join(evidence, "live.json");
let mode = "invalid_code", child, model, server, stopping = false, ready = false, activationCalls = 0, restarts = 0, nextId = 0, lastEvent = 0;
const events = [], snapshots = [];
const config = { home, ui, evidence, title: "肥鱼 · M5 独立验收", width: 960, height: 640 }, configFile = path.join(home, "native-config.json");
const safeEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:DSH_|DEEPSEEK_|FATFISH_|ELECTRON_RUN_AS_NODE$)/i.test(key)));
function state() {
  const read = name => { try { return JSON.parse(fs.readFileSync(path.join(home, name), "utf8")); } catch { return null; } };
  const onboarding = read("onboarding.json"), modelConfig = read("config.json")?.model;
  return { at: new Date().toISOString(), supervisorPid: process.pid, windowPid: child?.pid, home, title: config.title, ready, mode, activationCalls, localModelCalls: model?.requests.length || 0, restarts,
    licenseFile: fs.existsSync(path.join(home, "license.json")), consentSaved: fs.existsSync(path.join(home, "runtime/risk_ok")), modelSaved: !!modelConfig?.keyRef, modelGeneration: modelConfig?.generation,
    onboarding: onboarding ? { deferred: onboarding.deferred, baseComplete: onboarding.baseComplete, qqActive: onboarding.qqActive, qqComplete: onboarding.qqComplete, modelTested: !!onboarding.tested } : null,
    nativeUI: true, realQQ: false, paidCalls: 0, snapshots, events };
}
function writeState() { fs.writeFileSync(liveFile, JSON.stringify(state(), null, 2)); }
async function closeChild() {
  const owned = child; if (!owned || owned.exitCode !== null || owned.signalCode !== null) return;
  const exit = new Promise(resolve => owned.once("exit", resolve)); send({ type: "shutdown" });
  let timeout;
  try { await Promise.race([exit, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error("native_test_shutdown_timeout")), 25000); })]); }
  finally { clearTimeout(timeout); }
}
function send(message) { fs.writeFileSync(path.join(home, "native-host-command.json"), JSON.stringify(message)); }
function launch() {
  ready = false; fs.writeFileSync(configFile, JSON.stringify(config));
  child = spawn(require("electron"), [path.join(__dirname, "onboarding-native-host.js")], { windowsHide: false, env: { ...safeEnv(), NODE_PATH: process.env.NODE_PATH, FATFISH_NATIVE_CONFIG: configFile,
    FATFISH_DSH_EXE: fixture.env.FATFISH_DSH_EXE, FATFISH_DEV_DEEPSEEK_BASE_URL: model.url }, stdio: ["ignore", "pipe", "pipe"] });
  // Raw stdout/stderr stay in RAM, never written (Core may still contain synthetic text on errors).
  child.stdout.resume(); child.stderr.resume();
  child.receive = message => {
    if (message.type === "ready") ready = true;
    if (message.type === "snapshot") { snapshots.push(message.name); fs.writeFileSync(path.join(evidence, message.name + ".json"), JSON.stringify(message, null, 2)); }
    if (["host_error", "close_requested"].includes(message.type)) events.push({ type: message.type, code: message.code, at: new Date().toISOString() });
    writeState();
  };
  const launched = child;
  child.on("exit", (exitCode, signal) => { if (launched === child) ready = false; events.push({ type: "window_exit", exitCode, signal }); writeState(); });
  child.on("error", () => { events.push({ type: "window_spawn_error" }); writeState(); }); writeState();
}
async function stop() { if (stopping) return; stopping = true; clearInterval(timer); await closeChild(); await model?.close(); if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); writeState(); }
let timer;
(async () => {
  const { startModelProxy } = await import(pathToFileURL(path.resolve(__dirname, "../../core/dev/model-proxy.mjs")));
  model = await startModelProxy({ reply: () => "你好，本机测试回复已送达。" });
  server = http.createServer(async (request, response) => {
    activationCalls++; let raw = ""; for await (const part of request) raw += part;
    let data; try { data = JSON.parse(raw); } catch { return response.writeHead(400).end(); }
    if (mode === "network") return request.socket.destroy();
    if (mode !== "ok") return response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: mode }));
    const license = fixture.issue({ code_hash: createHash("sha256").update(code).digest("hex"), fingerprint: data.fingerprint });
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, license }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(fixture.core, "license-trust.cjs"), '"use strict";module.exports=' + JSON.stringify({ publicKey: fixture.publicKey, activationURL: "http://127.0.0.1:" + server.address().port + "/activate" }) + ";\n");
  launch();
  timer = setInterval(async () => {
    if (stopping) return;
    try {
      const hostFile = path.join(home, "native-host-event.json");
      if (fs.existsSync(hostFile)) { const event = JSON.parse(fs.readFileSync(hostFile, "utf8")); if (event.serial > lastEvent) { lastEvent = event.serial; child.receive(event); } }
      if (!fs.existsSync(controlFile)) return writeState();
      const command = JSON.parse(fs.readFileSync(controlFile, "utf8")); fs.unlinkSync(controlFile);
      if (command.id <= nextId) return; nextId = command.id;
      if (command.type === "fault" && ["invalid_code", "device_limit", "network", "ok"].includes(command.mode)) mode = command.mode;
      else if (command.type === "snapshot" && /^[a-z0-9-]{1,70}$/.test(command.name)) send({ type: "snapshot", name: command.name });
      else if (command.type === "restart") { await closeChild(); restarts++; launch(); }
      else if (command.type === "viewport" && [800, 960].includes(command.width) && [560, 640].includes(command.height) && [1, 2].includes(command.zoom)) { config.width = command.width; config.height = command.height; send(command); }
      else if (command.type === "shutdown") { await stop(); return; }
      writeState();
    } catch { events.push({ type: "supervisor_error" }); writeState(); }
  }, 400);
  console.log("independent_native_window_ready " + liveFile);
})().catch(async () => { process.exitCode = 1; await stop(); });
process.once("SIGINT", () => stop().catch(() => {})); process.once("SIGTERM", () => stop().catch(() => {}));
