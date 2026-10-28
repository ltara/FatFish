import licenseFixture from "./license-fixture.cjs";
import { pathToFileURL } from "node:url";
/** Workspace persistence and actual Core/rc2 relative-file operations. No native window or paid call. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { fork } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import workspace from "../workspace-config.cjs";
import tools from "../tool-contract.cjs";
import { startModelProxy } from "./model-proxy.mjs";
const require = createRequire(import.meta.url), { ServiceManager } = require("../../electron-ui/service-manager.js");
const home = fs.mkdtempSync(join(tmpdir(), "fatfish-workspace-check-")), configFile = join(home, "config.json");
const licensed = licenseFixture.licensedFixture(home); Object.assign(process.env, licensed.env);
const evidenceArg = process.argv.indexOf("--evidence"), evidence = evidenceArg < 0 ? null : resolve(process.argv[evidenceArg + 1]);
const folders = [join(home, "中文 目录 A"), join(home, "目录 B"), join(home, "目录 C")]; folders.forEach((p) => fs.mkdirSync(p));
const results = [], messages = [], logs = [], approvals = [], services = new ServiceManager({ appDataRoot: home });
let core, proxy, nextTool, hold = false, sequence = 0;
const check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
const bad = (name, fn, error) => { assert.throws(fn, (e) => e.message === error); check(name, true); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, label) { const end = Date.now() + 25000; while (Date.now() < end) { if (fn()) return fn(); await sleep(20); } throw new Error("workspace_timeout:" + label); }
services.sendCore = (m) => core?.connected ? core.send(m) : false;
services.on("approval", (m) => { approvals.push(m); if (!hold) core.send({ type: "approval_answer", id: m.id, outcome: "allowed-once" }); });
const setting = (op, args) => services.requestCore("workspace_ui", { op, args });
async function chat(text) {
  const id = "workspace-chat-" + ++sequence;
  core.send({ type: "chat_send", id, sessionId: "local-main", text });
  return wait(() => messages.find((m) => m.type === "chat_result" && m.id === id), id);
}
async function start() {
  const from = messages.length;
  core = fork(licensed.entry, [], {
    execPath: process.env.E2E_EXEC_PATH || process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FATFISH_APPDATA: home, FATFISH_DEV_DEEPSEEK_BASE_URL: proxy.url },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  core.stdout.on("data", (b) => logs.push(b.toString())); core.stderr.on("data", (b) => logs.push(b.toString()));
  core.on("message", (m) => { messages.push(m); services._onCoreMessage(m); });
  await wait(() => messages.slice(from).some((m) => m.type === "ready"), "core_ready");
}
async function stop() {
  if (!core) return;
  const child = core; child.send({ type: "shutdown" }); await wait(() => child.exitCode !== null || child.signalCode !== null, "core_exit");
  assert.equal(child.exitCode, 0); services._identityUnavailable(); core = null;
}
try {
  fs.writeFileSync(configFile, JSON.stringify({ channels: { qq: { enabled: false } }, owners: [], untouched: { value: 42 } }));
  check("new installation uses default workspace and legacy context", workspace.read(home).isDefault && workspace.contextSuffix(home) === "");
  bad("relative path is refused", () => workspace.save(home, { path: "../outside" }), "workspace_invalid");
  bad("missing chosen directory is not silently created", () => workspace.save(home, { path: join(home, "missing") }), "workspace_unavailable");
  bad("file is not a workspace", () => workspace.save(home, { path: configFile }), "workspace_unavailable");
  bad("model-style extra fields cannot select another instance", () => workspace.save(home, { path: folders[0], instance: "external" }), "workspace_args_invalid");
  const first = workspace.save(home, { path: folders[0] }), suffix = workspace.contextSuffix(home);
  check("chosen path is canonical and changes only local context", first.changed && first.generation === 1 && first.path === fs.realpathSync.native(folders[0]) && /^-w1-/.test(suffix));
  check("unrelated config and owner/channel fields survive", JSON.parse(fs.readFileSync(configFile)).untouched.value === 42 && JSON.parse(fs.readFileSync(configFile)).channels.qq.enabled === false);
  const before = fs.readFileSync(configFile, "utf8");
  check("saving the same folder is a byte-preserving no-op", !workspace.save(home, { path: folders[0] }).changed && fs.readFileSync(configFile, "utf8") === before);
  const rename = fs.renameSync;
  try { fs.renameSync = (a, b) => { if (b === configFile) throw new Error("fixture_save_failure"); return rename(a, b); };
    bad("atomic save failure is reported", () => workspace.save(home, { path: folders[1] }), "config_save_failed");
  } finally { fs.renameSync = rename; }
  check("failed save retains config and selected folder", fs.readFileSync(configFile, "utf8") === before && workspace.read(home).path === first.path);
  fs.writeFileSync(configFile, "broken-json"); bad("corrupt config is not replaced", () => workspace.save(home, { reset: true }), "config_invalid");
  check("corrupt config bytes remain intact", fs.readFileSync(configFile, "utf8") === "broken-json"); fs.writeFileSync(configFile, before);
  const link = join(home, "chosen-link"); fs.symlinkSync(folders[0], link, process.platform === "win32" ? "junction" : "dir");
  check("initial folder-link selection resolves to its physical target", workspace.plan(home, { path: link }).path === first.path);
  fs.unlinkSync(link);
  fs.renameSync(folders[0], folders[0] + "-moved"); fs.symlinkSync(folders[1], folders[0], process.platform === "win32" ? "junction" : "dir");
  bad("replacing a saved folder with a junction fails closed", () => workspace.forEngine(home), "workspace_unavailable");
  fs.unlinkSync(folders[0]); fs.renameSync(folders[0] + "-moved", folders[0]);
  fs.mkdirSync(join(home, "secrets")); fs.writeFileSync(join(home, "secrets/deepseek_api_key"), "sk-workspace-fixture-not-a-key");
  proxy = await startModelProxy({ reply: () => "本机操作已处理。", tool: () => { const value = nextTool; nextTool = null; return value; } });
  await start();
  check("actual Core reports persisted workspace without starting local", (await setting("get")).data.path === first.path && !messages.some((m) => m.type === "engine" && m.instance === "local" && m.state === "ready"));
  nextTool = { name: "write", input: { file_path: "probe.txt", content: "first-workspace" } };
  check("relative write really lands in the chosen Chinese-space folder", (await chat("first workspace context sentinel")).ok && fs.readFileSync(join(folders[0], "probe.txt"), "utf8") === "first-workspace" && approvals.at(-1)?.toolName === "write");
  const oldPid = messages.findLast((m) => m.type === "engine" && m.instance === "local" && m.state === "ready").pid;
  check("actual Core rejects a forged workspace op", (await setting("execute", {})).error === "workspace_args_invalid");
  check("actual Core switches workspace without launching an engine", (await setting("set", { path: folders[1] })).ok && messages.findLast((m) => m.type === "engine" && m.instance === "local").state === "stopped");
  const requestAt = proxy.requests.length;
  nextTool = { name: "write", input: { file_path: "probe.txt", content: "second-workspace" } };
  check("next relative operation uses the new folder only", (await chat("second workspace context")).ok && fs.readFileSync(join(folders[1], "probe.txt"), "utf8") === "second-workspace" && fs.readFileSync(join(folders[0], "probe.txt"), "utf8") === "first-workspace");
  check("new workspace uses a new process and no old SDK context", messages.findLast((m) => m.type === "engine" && m.instance === "local" && m.state === "ready").pid !== oldPid && proxy.requests.slice(requestAt).every((p) => !JSON.stringify(p.messages).includes("first workspace context sentinel")));
  hold = true; nextTool = { name: "write", input: { file_path: "busy.txt", content: "allowed-active-turn" } };
  const approvalAt = approvals.length, active = chat("active approval must not change cwd"); await wait(() => approvals.length > approvalAt, "held_approval");
  check("pending human approval prevents a workspace switch", (await setting("set", { path: folders[2] })).error === "local_busy" && workspace.read(home).path === fs.realpathSync.native(folders[1]));
  hold = false; core.send({ type: "approval_answer", id: approvals.at(-1).id, outcome: "allowed-once" }); await active;
  check("active approved operation stays in its original workspace", fs.existsSync(join(folders[1], "busy.txt")) && !fs.existsSync(join(folders[2], "busy.txt")));
  await stop(); await start();
  check("selected workspace survives Core restart", (await setting("get")).data.path === fs.realpathSync.native(folders[1]));
  fs.renameSync(folders[1], folders[1] + "-missing"); const callsBefore = proxy.requests.length;
  check("missing selected folder does not fall back or charge a model call", (await chat("missing folder")).error === "workspace_unavailable" && proxy.requests.length === callsBefore && !fs.existsSync(folders[1]));
  fs.renameSync(folders[1] + "-missing", folders[1]);
  const reset = await setting("set", { reset: true });
  check("reset preserves files and advances workspace context", reset.ok && reset.data.isDefault && reset.data.generation === 3 && fs.existsSync(join(folders[0], "probe.txt")) && fs.existsSync(join(folders[1], "probe.txt")));
  nextTool = { name: "write", input: { file_path: "probe.txt", content: "default-workspace" } }; await chat("default workspace again");
  check("reset relative write lands in the default folder with approval", fs.readFileSync(join(workspace.defaultPath(home), "probe.txt"), "utf8") === "default-workspace" && approvals.at(-1)?.toolName === "write");
  check("every recorded local request uses the exact trimmed tool whitelist", proxy.requests.length > 0 && proxy.requests.every(tools.localToolsMatch));
  check("workspace changes never launch external or alter private memory generation", !messages.some((m) => m.type === "engine" && m.instance === "external" && m.state !== "stopped") && !fs.existsSync(join(home, "memory/context-generation.json")));
  check("Core metadata logs omit path, prompt and model key", !logs.join("").includes(folders[0]) && !logs.join("").includes("first workspace context sentinel") && !logs.join("").includes("sk-workspace-fixture-not-a-key"));
  console.log(`${results.length}/${results.length} workspace checks passed (no native UI/paid calls)`);
} finally {
  try { await stop(); } finally { await proxy?.close();
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(join(evidence, "workspace-report.json"), JSON.stringify({ results, paidCalls: 0, nativeUI: false, tools: tools.local, model: "loopback-fixture" }, null, 2)); }
    if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-workspace-check-")) fs.rmSync(home, { recursive: true, force: true });
  }
}
