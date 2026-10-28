/** Actual Core/SDK + service manager lifecycle. All data and model responses are isolated fixtures. */
import fs from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import fixtureModule from "../../core/dev/license-fixture.cjs";
import { startModelProxy } from "../../core/dev/model-proxy.mjs";
import manager from "../service-manager.js";
import dataClear from "../data-clear.js";
const require = createRequire(import.meta.url), base = fs.mkdtempSync(join(tmpdir(), "fatfish-clear-runtime-"));
const evidenceAt = process.argv.indexOf("--evidence"), evidence = evidenceAt < 0 ? null : resolve(process.argv[evidenceAt + 1]);
const results = [], check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, name) { const end = Date.now() + 30000; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); } throw new Error("clear_runtime_timeout:" + name); }
function countEngines() {
  const quoted = base.replaceAll("'", "''");
  const cmd = `$n=@(Get-CimInstance Win32_Process -Filter "Name='deepseek-harness-sdk-runtime-win-x64.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${quoted}') }).Count; [Console]::Write($n)`;
  return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true, timeout: 15000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}
let core, services, proxy;
try {
  const m = new manager.ServiceManager({ appDataRoot: join(base, "start-order") });
  const order = []; let finish;
  m._startAllImpl = async () => { await new Promise((r) => { finish = r; }); order.push("started"); };
  m.stopAll = async () => { order.push("stopped"); };
  const starting = m.startAll(), stopping = m.stopForDataReset();
  await assert.rejects(m.startAll(), /data_reset_locked/);
  check("reset locks future starts while waiting for a confirmed pending startup", order.length === 0);
  finish(); await starting; await stopping;
  check("safe stop cannot finish ahead of an already-pending startup", order.join() === "started,stopped");
  const live = new manager.ServiceManager({ appDataRoot: join(base, "live-stop") });
  live._children.core = { pid: process.pid }; live.stopAll = async () => {}; // Zero-signal check of this test process only; no kill operation.
  await assert.rejects(live.stopForDataReset(), /data_reset_stop_failed/);
  check("an observed live managed PID prevents deletion authorization even if stop returned", live._dataResetLocked === true);
  // Exercise only the launcher's descriptor ownership using a fake spawn, never the real launcher.
  const opened = [], closed = [], actualFs = require("node:fs"), realRequire = createRequire(fileURLToPath(new URL("../service-manager.js", import.meta.url)));
  const fakeFs = Object.create(actualFs); fakeFs.openSync = (...args) => { const fd = actualFs.openSync(...args); opened.push(fd); return fd; }; fakeFs.closeSync = (fd) => { closed.push(fd); actualFs.closeSync(fd); };
  let failSpawn = false, calls = 0, failFork = false; const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(fileURLToPath(new URL("../service-manager.js", import.meta.url)), "utf8"), { module: mod, exports: mod.exports, process: { ...process, platform: "win32" }, __dirname: dirname(fileURLToPath(new URL("../service-manager.js", import.meta.url))), Buffer, setTimeout, clearTimeout,
    require: (name) => name === "node:fs" ? fakeFs : name === "node:child_process" ? { ...require(name), spawn: () => { calls++; if (failSpawn) throw new Error("spawn_fixture_failed"); return { pid: -1 }; }, fork: () => { if (failFork) throw new Error("fork_fixture_failed"); return new (require("node:events").EventEmitter)(); } } : realRequire(name) });
  const backend = join(base, "launcher-fixture"); fs.mkdirSync(backend); fs.writeFileSync(join(backend, "launcher-user.bat"), "@exit /b 0\r\n");
  const fakeManager = new mod.exports.ServiceManager({ appDataRoot: join(base, "fd-fixture") }); fakeManager.spawnBackend(backend);
  check("backend spawn closes both parent log descriptors after transferring them", calls === 1 && opened.length === 2 && opened.every((fd) => closed.includes(fd)));
  failSpawn = true; assert.throws(() => fakeManager.spawnBackend(backend), /spawn_fixture_failed/);
  check("spawn failure also releases every parent-owned log descriptor", calls === 2 && opened.length === 4 && closed.length === 4);
  fakeManager.forkCore("fixture-not-executed.mjs", base);
  check("Core fork transfers and closes its parent-owned log descriptors too", opened.length === 6 && closed.length === 6);
  failFork = true; assert.throws(() => fakeManager.forkCore("fixture-not-executed.mjs", base), /fork_fixture_failed/);
  check("Core fork failure leaves no log handle to obstruct later clearing", opened.length === 8 && closed.length === 8);
  const home = join(base, "appdata"); fs.mkdirSync(home); const licensed = fixtureModule.licensedFixture(home);
  Object.assign(process.env, licensed.env);
  fs.mkdirSync(join(home, "secrets")); fs.writeFileSync(join(home, "secrets/deepseek_api_key"), "sk-clear-runtime-fixture-only"); fs.writeFileSync(join(home, "config.json"), JSON.stringify({ channels: { qq: { enabled: false } } }));
  proxy = await startModelProxy({ reply: () => "只在临时目录里的清理测试。" }); process.env.FATFISH_DEV_DEEPSEEK_BASE_URL = proxy.url;
  services = new manager.ServiceManager({ appDataRoot: home, electronExecPath: process.env.E2E_EXEC_PATH || process.execPath });
  const messages = []; services.on("core-message", (v) => messages.push(v));
  core = services.forkCore(licensed.entry, dirname(licensed.entry)); services._children.core = core;
  await wait(() => messages.some((v) => v.type === "ready"), "ready");
  core.send({ type: "chat_send", id: "clear-runtime-chat", text: "CLEAR_RUNTIME_SENTINEL" });
  const result = await wait(() => messages.find((v) => v.type === "chat_result" && v.id === "clear-runtime-chat"), "chat");
  check("actual licensed Core/SDK completes a local fixture conversation before clear", result.ok && proxy.requests.length === 1);
  check("Windows process inventory confirms exactly this fixture's SDK is live", countEngines() === 1);
  fs.mkdirSync(join(home, "chat")); fs.writeFileSync(join(home, "chat/history.json"), "[]"); fs.mkdirSync(join(home, "workspace/local"), { recursive: true }); fs.writeFileSync(join(home, "workspace/local/user.txt"), "KEEP_USER_FILE");
  const license = fs.readFileSync(join(home, "license.json")), key = fs.readFileSync(join(home, "secrets/deepseek_api_key"));
  await services.stopForDataReset();
  check("real service safe-stop observes actual Core exit and no matching SDK process", core.exitCode !== null && countEngines() === 0);
  await assert.rejects(services.startAll(), /data_reset_locked/);
  check("an old Main/service object cannot resurrect cleared data by restarting", !services._children.core);
  const cleared = dataClear.clear(home, { confirmed: true, includeKeys: false, includeLicense: false });
  check("real runtime/session/log files can be removed after stop with no open-handle error", cleared.count > 0 && !fs.existsSync(join(home, "dsh")) && !fs.existsSync(join(home, "logs")) && !fs.existsSync(join(home, "chat")));
  check("real clearing retains license, key and default user workspace bytes", fs.readFileSync(join(home, "license.json")).equals(license) && fs.readFileSync(join(home, "secrets/deepseek_api_key")).equals(key) && fs.readFileSync(join(home, "workspace/local/user.txt"), "utf8") === "KEEP_USER_FILE");
  check("a settled wait cannot create late runtime files or processes after clear", countEngines() === 0 && !fs.existsSync(join(home, "dsh")));
  console.log(`${results.length}/${results.length} data-clear runtime checks passed (actual Core/SDK, hidden Node/PowerShell, no windows/paid calls)`);
} finally {
  if (services) await services.stopAll(); if (core && core.exitCode === null) { core.kill(); await wait(() => core.exitCode !== null || core.signalCode !== null, "final_stop"); } await proxy?.close();
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(join(evidence, "data-clear-runtime-report.json"), JSON.stringify({ results, nativeUI: false, actualUserData: false, realQQ: false, paidCalls: 0 }, null, 2)); }
  if (resolve(base).startsWith(resolve(tmpdir()) + sep + "fatfish-clear-runtime-")) fs.rmSync(base, { recursive: true, force: true });
}
