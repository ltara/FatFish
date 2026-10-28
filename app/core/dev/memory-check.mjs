import licenseFixture from "./license-fixture.cjs";
import { pathToFileURL } from "node:url";
/** M4 memory: real pinned runtime + gateway, loopback-only model, isolated temporary data. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { startModelProxy } from "./model-proxy.mjs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import toolContract from "../tool-contract.cjs";
import { MemoryStore, validateMemoryTool } from "../memory-store.mjs";
import { MemoryService } from "../memory-service.mjs";

const home = mkdtempSync(join(tmpdir(), "fatfish-memory-check-"));
const licensed = licenseFixture.licensedFixture(home); Object.assign(process.env, licensed.env);
process.env.FATFISH_APPDATA = home;
const { ensureDirs } = await import("../paths.mjs");
const { InstanceManager } = await import(pathToFileURL(join(licensed.core, "instance-manager.mjs")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, ms = 20000) => { const until = Date.now() + ms; while (Date.now() < until) { const v = fn(); if (v) return v; await sleep(10); } throw new Error("memory_check_timeout"); };
let checks = 0, manager, proxy, core, nextCall = null, hold = false, owner = true, approval = "allowed-once";
const check = (name, value) => { assert.ok(value, name); checks++; console.log("PASS " + name); };
const rejects = (name, fn, code) => { assert.throws(fn, (e) => e.message === code, name); check(name, true); };
const approvals = [], events = [], changes = [];
try {
  ensureDirs();
  writeFileSync(join(home, "secrets/deepseek_api_key"), "sk-memory-fixture-not-a-key");
  writeFileSync(join(home, "config.json"), JSON.stringify({ channels: { qq: { enabled: false } } }));
  const store = new MemoryStore({ root: home });
  check("new memory is empty and generation starts at zero", store.list().total === 0 && store.generation() === 0);
  for (const [op, args] of [["save", { text: "a", scope: "owner_public" }], ["search", { query: "", instance: "auto" }], ["forget", { id: "a", sessionId: "local-main" }], ["save", { text: "" }], ["save", { text: "a", tags: [" "] }]]) {
    rejects("model arguments are strict: " + op + " " + Object.keys(args).join("/"), () => validateMemoryTool(op, args), "memory_args_invalid");
  }
  const basic = store.saveOwner("普通偏好", ["标签"], "local-store");
  check("records include scope, tags, time and source session", basic.scope === "owner" && basic.tags[0] === "标签" && Number.isFinite(basic.createdAt) && basic.sourceSession === "local-store");
  check("exact duplicate saves are idempotent", store.saveOwner("普通偏好", ["标签"]).id === basic.id && store.list().total === 1);
  check("keyword and tag search is bounded and scoped", store.search(["owner"], "标签").length === 1 && store.search(["owner_public"], "标签").length === 0);
  store.forget("owner", basic.id);
  const corruptRoot = join(home, "corrupt"); mkdirSync(corruptRoot);
  const bad = new MemoryStore({ root: corruptRoot }), badFile = join(corruptRoot, "memory/owner.jsonl");
  writeFileSync(badFile, "broken-json\n");
  rejects("corrupt JSONL fails without overwriting", () => bad.saveOwner("不得覆盖"), "memory_invalid");
  check("corrupt bytes are preserved", readFileSync(badFile, "utf8") === "broken-json\n");
  writeFileSync(join(corruptRoot, "memory/context-generation.json"), "{\"generation\":-1}");
  rejects("corrupt generation cannot silently resume old context", () => bad.generation(), "memory_invalid");
  const linkedRoot = join(home, "linked"), target = join(home, "target"); mkdirSync(linkedRoot); mkdirSync(target);
  symlinkSync(target, join(linkedRoot, "memory"), "junction");
  rejects("memory directory junction is refused", () => new MemoryStore({ root: linkedRoot }), "memory_path_invalid");
  unlinkSync(join(linkedRoot, "memory"));

  proxy = await startModelProxy({ reply: () => "夹具回复", failure: () => hold ? "hold" : null,
    tool: () => { const call = nextCall; nextCall = null; return call; } });
  process.env.FATFISH_DEV_DEEPSEEK_BASE_URL = proxy.url;
  let service;
  const makeManager = () => new InstanceManager({ remoteEnabled: false, memoryGeneration: store.generation(),
    authorizeExternal: (c) => owner && c.channel === "qq" && c.account === "10001",
    onTool: (request) => service.tool(request), onApproval: async (request) => { approvals.push(request); return approval; } });
  const wire = () => { service = new MemoryService({ store, instances: manager, isOwner: (channel, account) => owner && channel === "qq" && account === "10001", changed: (e) => changes.push(e) }); manager.on("chat_event", (e) => events.push(e)); };
  manager = makeManager(); wire(); await manager.start();
  const actor = { channel: "qq", account: "10001" };
  const invoke = async (name, sid, tool, input, text = "执行当前测试", context = actor) => {
    const start = proxy.requests.length;
    nextCall = { name: tool, input };
    const result = await manager.turn(name, sid, text, context);
    const requests = proxy.requests.slice(start);
    const toolResults = requests.flatMap((r) => r.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((c) => c.type === "tool_result") : []));
    return { result, requests, toolResults, rendered: JSON.stringify(toolResults) };
  };
  const fact = "MEMORY_FACT_跨会话_" + Date.now();
  const saved = await invoke("local", "local-first", "memory_save", { text: fact, tags: ["饮食"] });
  check("real local tool saves through the authenticated gateway", saved.result.ok && store.search(["owner"], fact).length === 1);
  const factId = store.search(["owner"], fact)[0].id;
  check("local memory tools still require runtime approval", approvals.some((r) => r.toolName === "memory_save" && r.sessionId === "local-first"));
  check("plugin produces a successful rendered tool result", saved.rendered.includes('\\"ok\\":true'));
  const found = await invoke("local", "local-second", "memory_search", { query: "跨会话" });
  check("new local session retrieves a saved fact", found.result.ok && found.rendered.includes(fact));
  check("memory is not automatically injected into a new model request", !JSON.stringify(found.requests[0]).includes(fact));
  await manager.setRemoteEnabled(true);
  const remote = await invoke("external", manager.externalSessionId, "memory_search", { query: "跨会话" });
  check("bound external owner retrieves local private memory across processes", remote.result.ok && remote.rendered.includes(fact));
  check("actual external tool names strictly equal the memory whitelist", remote.requests.length >= 2 && remote.requests.every(toolContract.externalToolsMatch));
  check("both real profiles activate without pending plugins", [...manager.hosts.values()].every((h) => !/pending|did not activate|error/i.test(h.client?.stderrTail || "")));
  const remoteSave = await invoke("external", manager.externalSessionId, "memory_save", { text: "远程明确保存", tags: [] });
  check("external saves are always private owner records", remoteSave.result.ok && store.search(["owner"], "远程明确保存").length === 1 && store.list("owner_public").total === 0);
  const oldGen = store.generation(); service.ui("public_set", { text: "公开昵称_小鱼" });
  check("public data is only saved by trusted UI and invalidates context", store.publicText() === "公开昵称_小鱼" && store.generation() === oldGen + 1);
  const publicRead = await invoke("local", "local-second", "memory_search", { query: "公开昵称" });
  check("model search can read UI-edited public data", publicRead.rendered.includes("公开昵称_小鱼"));
  check("logical session identity survives generation changes for approvals and events", approvals.at(-1).sessionId === "local-second" && events.some((e) => e.sessionId === "local-second" && e.event?.type === "tool/call") && !events.some((e) => /-g\d+$/.test(e.sessionId)));
  for (const [tool, args] of [["memory_save", { text: "越权公开资料", scope: "owner_public" }], ["memory_search", { query: "", scope: "owner" }], ["memory_forget", { id: "public-profile" }]]) {
    const invalid = await invoke("external", manager.externalSessionId, tool, args);
    check("real model cannot choose scope or modify public data: " + tool, invalid.result.ok && !invalid.rendered.includes('\\"ok\\":true') && store.publicText() === "公开昵称_小鱼" && store.search(["owner"], "越权公开资料").length === 0);
  }
  approval = "rejected";
  const beforeDeny = store.list().total;
  await invoke("local", "local-denied", "memory_save", { text: "拒绝后不得保存" });
  check("denied local memory tool makes no change", store.list().total === beforeDeny && store.search(["owner"], "拒绝后不得保存").length === 0);
  approval = "allowed-once";
  rejects("UI deletion requires explicit confirmation", () => service.ui("forget", { scope: "owner", id: factId }), "memory_args_invalid");
  const beforeDeleteGen = store.generation(); service.ui("forget", { scope: "owner", id: factId, confirmed: true });
  check("deletion is persisted and context generation advances", store.search(["owner"], fact).length === 0 && store.generation() === beforeDeleteGen + 1);
  const afterDeleteStart = proxy.requests.length;
  await manager.turn("local", "local-second", "继续聊聊");
  await manager.turn("external", manager.externalSessionId, "继续聊聊", actor);
  check("same logical local and remote sessions do not resume deleted facts", proxy.requests.slice(afterDeleteStart).length === 2 && proxy.requests.slice(afterDeleteStart).every((r) => !JSON.stringify(r).includes(fact)));
  await manager.stop(); manager = makeManager(); wire(); await manager.start();
  const restartStart = proxy.requests.length;
  await manager.turn("local", "local-first", "重启后继续聊聊");
  check("generation survives restart; old model context is not resumed", proxy.requests.slice(restartStart).length === 1 && !JSON.stringify(proxy.requests[restartStart]).includes(fact));
  check("public data survives restart", service.ui("public_get").text === "公开昵称_小鱼");
  const forgetSaved = await invoke("local", "local-forget", "memory_save", { text: "FORGET_TOOL_FACT" });
  check("tool deletion setup is a real saved fact", forgetSaved.result.ok && store.search(["owner"], "FORGET_TOOL_FACT").length === 1);
  const forgotten = await invoke("local", "local-forget", "memory_forget", { id: store.search(["owner"], "FORGET_TOOL_FACT")[0].id });
  check("real forget tool deletes without transport deadlock or stale model output", forgotten.result.ok && forgotten.result.memoryReset === true && !forgotten.result.text.includes("FORGET_TOOL_FACT") && store.search(["owner"], "FORGET_TOOL_FACT").length === 0);

  await manager.setRemoteEnabled(true);
  hold = true;
  const heldStart = proxy.requests.length;
  const pending = manager.turn("external", manager.externalSessionId, "等待在途请求", actor);
  await wait(() => proxy.requests.length > heldStart);
  const ext = manager.hosts.get("external"), token = ext.gatewayEnv.FATFISH_GATEWAY_TOKEN;
  const call = async (body) => { const r = await fetch(manager.gateway.url, { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify(body) }); return { status: r.status, ...await r.json() }; };
  const payload = { plugin: "fatfish-memory", op: "save", sessionId: ext.activeSessionId, args: { text: "不得伪造" }, instance: "local" };
  const spoof = await call({ ...payload, args: { text: "不得伪造", scope: "owner_public" } });
  check("raw gateway refuses scope escalation even if schema is bypassed", spoof.status === 200 && spoof.ok === false && spoof.error === "memory_args_invalid");
  check("token cannot address a different active instance", (await call({ ...payload, sessionId: "local-main" })).status === 403);
  check("unknown plugin cannot bypass the boundary", (await call({ ...payload, plugin: "unknown" })).status === 403);
  owner = false;
  check("revoking owner blocks a memory request during a live turn", (await call(payload)).status === 403 && store.search(["owner"], "不得伪造").length === 0);
  owner = true;
  service.ui("clear", { scope: "owner", confirmed: true }); hold = false;
  check("in-flight turn after a reset returns only Core confirmation", (await pending).memoryReset === true);
  check("clear leaves the chosen scope empty", store.list().total === 0 && store.search(["owner"], "").length === 0 && store.publicText() === "公开昵称_小鱼");
  check("JSON export includes public scope and schema version", service.ui("export").version === 1 && service.ui("export").items.some((r) => r.scope === "owner_public"));
  check("memory change notifications are emitted", changes.length >= 6);
  check("inactive and future autonomous instances cannot read owner memory", service.tool({ instance: "auto", sessionId: "local-main", op: "search", args: { query: "" } }).error === "memory_forbidden" && service.tool({ instance: "local", sessionId: "local-foreign", op: "search", args: { query: "" } }).error === "memory_forbidden");
  await manager.memoryReset;
  let releaseIdle;
  manager.idleStop = new Promise((r) => { releaseIdle = r; });
  const delayedAt = proxy.requests.length;
  const delayed = manager.turn("local", "local-first", "排队后的请求");
  await sleep(10);
  service.ui("clear", { scope: "owner", confirmed: true });
  releaseIdle();
  check("a turn awaiting idle shutdown cannot revive an old generation", (await delayed).memoryReset === true && proxy.requests.length === delayedAt);
  manager.idleStop = null;
  check("memory storage has no unexpected files", readdirSync(join(home, "memory")).every((name) => ["owner.jsonl", "owner_public.jsonl", "context-generation.json"].includes(name)));
  await manager.stop(); manager = null;

  // Verify the actual Core IPC entry too; no in-process manager stand-in here.
  const messages = [], logs = [];
  core = fork(licensed.entry, [], { execPath: process.env.E2E_EXEC_PATH || process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FATFISH_APPDATA: home, FATFISH_DEV_DEEPSEEK_BASE_URL: proxy.url },
    stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  core.stdout.on("data", (b) => logs.push(b.toString())); core.stderr.on("data", (b) => logs.push(b.toString()));
  core.on("message", (m) => { messages.push(m); if (m.type === "ready") core.send({ type: "pause", paused: false }); if (m.type === "approval") core.send({ type: "approval_answer", id: m.id, outcome: "allowed-once" }); });
  await wait(() => messages.some((m) => m.type === "ready"));
  let sequence = 0;
  const ui = async (op, args) => { const requestId = "memory-test-" + ++sequence; core.send({ type: "memory_ui", requestId, op, args }); return wait(() => messages.find((m) => m.type === "memory_result" && m.requestId === requestId)); };
  check("Core IPC reads the persisted public profile", (await ui("public_get")).data.text === "公开昵称_小鱼");
  check("Core IPC refuses unconfirmed clearing", !(await ui("clear", { scope: "owner_public" })).ok && store.publicText() === "公开昵称_小鱼");
  check("Core IPC cannot choose an arbitrary memory file", !(await ui("list", { scope: "../secrets/deepseek_api_key" })).ok);
  nextCall = { name: "memory_save", input: { text: "CORE_IPC_长期事实" } };
  core.send({ type: "chat_send", id: "core-memory", sessionId: "local-core-memory", text: "通过核心保存" });
  const coreResult = await wait(() => messages.find((m) => m.type === "chat_result" && m.id === "core-memory"));
  const list = await ui("list", { scope: "owner" });
  check("real Core chat calls the memory plugin and UI reads it back", coreResult.ok && list.data.items.some((r) => r.text === "CORE_IPC_长期事实"));
  check("Core chat events and approvals retain the logical session id", messages.some((m) => m.type === "chat_event" && m.sessionId === "local-core-memory") && messages.some((m) => m.type === "approval" && m.sessionId === "local-core-memory"));
  check("Core notifies the parent when a model saves memory", messages.some((m) => m.type === "memory_changed" && m.kind === "saved"));
  const coreId = list.data.items.find((r) => r.text === "CORE_IPC_长期事实").id;
  check("Core UI deletes and subsequently exports an empty private scope", (await ui("forget", { scope: "owner", id: coreId, confirmed: true })).ok && !(await ui("export")).data.items.some((r) => r.scope === "owner"));
  check("Core logs contain neither memory text nor the model key", !logs.join("").includes("CORE_IPC_长期事实") && !logs.join("").includes("sk-memory-fixture-not-a-key"));
  core.send({ type: "shutdown" }); await wait(() => core.exitCode !== null || core.signalCode !== null);
  check("Core shuts down without an orphan process", core.exitCode === 0); core = null;
  console.log(`${checks}/${checks} memory checks passed (no paid calls)`);
} finally {
  if (core && core.exitCode === null && core.signalCode === null) { core.send({ type: "shutdown" }); await wait(() => core.exitCode !== null || core.signalCode !== null).catch(() => core.kill()); }
  if (manager) await manager.stop();
  if (proxy) await proxy.close();
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-memory-check-")) rmSync(home, { recursive: true, force: true });
}
