import licenseFixture from "./license-fixture.cjs";
import { pathToFileURL } from "node:url";
/** Model config + actual Core/SDK switching and isolated draft tests. Loopback fixtures only, no native UI. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { fork } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { WebSocketServer } from "ws";
import model from "../model-config.cjs";
import tools from "../tool-contract.cjs";
import { startCompatProxy } from "./compat-proxy.mjs";
import { startModelProxy } from "./model-proxy.mjs";
const require = createRequire(import.meta.url), { ServiceManager } = require("../../electron-ui/service-manager.js");
const home = fs.mkdtempSync(join(tmpdir(), "fatfish-model-check-")), file = join(home, "config.json"), results = [], messages = [], logs = [], sent = [];
const licensed = licenseFixture.licensedFixture(home); Object.assign(process.env, licensed.env);
const evidenceArg = process.argv.indexOf("--evidence"), evidence = evidenceArg < 0 ? null : resolve(process.argv[evidenceArg + 1]);
const oldKey = "sk-model-legacy-fixture-AAAA", keyA = "sk-model-a-fixture-BBBB", keyB = "sk-model-b-fixture-CCCC", persona = "PRIVATE_PERSONA_SENTINEL";
let core, proxyA, proxyB, proxyC, nativeProxy, backend, socket, faultA = null, faultB = null, nextToolA = null, replyB = "接口二的回复。", sequence = 0;
const services = new ServiceManager({ appDataRoot: home }); services.sendCore = (m) => core?.connected ? core.send(m) : false;
services.on("approval", (m) => core.send({ type: "approval_answer", id: m.id, outcome: "rejected" }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, label) { const end = Date.now() + 30000; while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(20); } throw new Error("model_check_timeout:" + label); }
const check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
const bad = (name, fn, code) => { assert.throws(fn, (e) => e.message === code, name); check(name, true); };
const call = (op, args) => services.requestCore("model_ui", { op, args }, 60000);
async function start() {
  const from = messages.length;
  core = fork(licensed.entry, [], { execPath: process.env.E2E_EXEC_PATH || process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FATFISH_APPDATA: home, FATFISH_DEV_DEEPSEEK_BASE_URL: nativeProxy.url, OPENAI_API_KEY: "sk-ambient-must-not-be-used" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  core.stdout.on("data", (b) => logs.push(b.toString())); core.stderr.on("data", (b) => logs.push(b.toString()));
  core.on("message", (m) => { messages.push(m); services._onCoreMessage(m); if (m.type === "ready") core.send({ type: "pause", paused: false }); });
  await wait(() => messages.slice(from).some((m) => m.type === "ready"), "ready"); await wait(() => socket?.readyState === 1, "channel");
}
async function stop() {
  if (!core) return; const child = core; child.send({ type: "shutdown" });
  await wait(() => child.exitCode !== null || child.signalCode !== null, "exit"); assert.equal(child.exitCode, 0); services._identityUnavailable(); core = null; socket = null;
}
async function chat(text) { const id = "model-chat-" + ++sequence; core.send({ type: "chat_send", id, sessionId: "local-main", text }); return wait(() => messages.find((m) => m.type === "chat_result" && m.id === id), id); }
async function remote(text) {
  const before = sent.length; socket.send(JSON.stringify({ post_type: "message", message_type: "private", self_id: 90000, user_id: 10001, message: [{ type: "text", data: { text } }] }));
  return wait(() => sent.length > before && sent.at(-1), "remote_reply");
}
try {
  fs.mkdirSync(join(home, "secrets")); fs.writeFileSync(join(home, "secrets/deepseek_api_key"), oldKey); fs.writeFileSync(join(home, "persona.txt"), persona);
  fs.writeFileSync(file, JSON.stringify({ channels: { qq: { enabled: false } }, owners: [{ channel: "qq", account: "10001" }], untouched: 42 }));
  const before = fs.readFileSync(file, "utf8"), legacy = model.read(home);
  check("legacy default key remains readable without rewriting config", legacy.key === oldKey && legacy.generation === 0 && model.contextSuffix(home) === "" && fs.readFileSync(file, "utf8") === before);
  check("public settings expose only saved status and a partial tail", model.describe(legacy).key_tail === "AAAA" && !JSON.stringify(model.describe(legacy)).includes(oldKey) && !Object.hasOwn(model.describe(legacy), "keyRef"));
  for (const provider of ["unknown", "__proto__", "constructor"]) bad("invalid provider rejected: " + provider, () => model.normalize({ provider, model: "test" }), "model_provider_invalid");
  for (const baseURL of ["file:///secret", "https://u:p@example.test", "https://example.test?key=secret", "https://example.test/#secret", "https://example.test\n/secret"]) bad("unsafe endpoint rejected", () => model.endpoint(baseURL), "model_endpoint_invalid");
  bad("preset cannot be redirected to a foreign endpoint", () => model.normalize({ provider: "deepseek-official", baseURL: "https://foreign.example", model: "test" }), "model_preset_override");
  bad("output cap cannot exceed declared context", () => model.normalize({ provider: "custom", model: "test", api: "openai-completions", baseURL: "https://example.test/v1", contextWindow: 1024, maxTokens: 2048 }), "model_capacity_invalid");
  proxyA = await startCompatProxy({ reply: () => "接口一的回复。", failure: () => faultA, tool: () => { const value = nextToolA; nextToolA = null; return value; } });
  proxyB = await startCompatProxy({ api: "openai-responses", reply: () => replyB, failure: () => faultB });
  proxyC = await startCompatProxy({ api: "anthropic-messages" }); nativeProxy = await startModelProxy({ reply: () => "连接正常" });
  const draftA = { provider: "custom", model: "model-one", api: "openai-completions", baseURL: proxyA.url, key: keyA };
  const draftB = { provider: "custom", model: "model-two", api: "openai-responses", baseURL: proxyB.url, key: keyB };
  bad("a new endpoint never inherits the default saved key", () => model.draft(home, { ...draftA, key: "" }), "no_key");
  bad("model cannot smuggle key paths into settings", () => model.save(home, { ...draftA, keyRef: "../../secret" }), "model_args_invalid");
  const rename = fs.renameSync;
  try { fs.renameSync = (from, to) => { if (to === file) throw new Error("fixture_disk_failure"); return rename(from, to); };
    bad("failed config commit is reported", () => model.save(home, draftA), "model_save_failed");
  } finally { fs.renameSync = rename; }
  check("failed commit keeps old route/key and removes only the new orphan", fs.readFileSync(file, "utf8") === before && model.read(home).key === oldKey && fs.readdirSync(join(home, "secrets")).length === 1);
  const saved = model.save(home, draftA), bytes = fs.readFileSync(file, "utf8"), stored = JSON.parse(bytes);
  check("route and a versioned key are committed through one config pointer", saved.changed && saved.generation === 1 && stored.model.keyRef && !bytes.includes(keyA) && model.read(home).key === keyA && !fs.existsSync(join(home, "secrets/deepseek_api_key")));
  check("model save preserves owners, channel and unrelated settings", stored.untouched === 42 && stored.owners[0].account === "10001" && stored.channels.qq.enabled === false);
  check("same settings/key are a byte-preserving no-op", !model.save(home, { ...draftA, key: "" }).changed && fs.readFileSync(file, "utf8") === bytes);
  bad("invalid expected version is rejected before mutation", () => model.save(home, { ...draftA, expectedGeneration: -1 }), "model_args_invalid");
  bad("an old form version cannot overwrite a newer route", () => model.save(home, { ...draftB, expectedGeneration: 0 }), "model_stale");
  check("rejected versions preserve both saved bytes and credential", fs.readFileSync(file, "utf8") === bytes && model.read(home).key === keyA);
  const runtime = model.runtime(model.read(home));
  check("runtime overlay contains only a key env reference", runtime.env.FATFISH_MODEL_API_KEY === keyA && !JSON.stringify(runtime.patch).includes(keyA));
  fs.writeFileSync(file, "broken-json"); bad("corrupt config is never silently replaced", () => model.save(home, draftA), "config_invalid"); check("corrupt config bytes remain", fs.readFileSync(file, "utf8") === "broken-json"); fs.writeFileSync(file, bytes);
  backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  backend.on("connection", (ws) => { socket = ws; ws.on("message", (buf) => { const m = JSON.parse(buf); if (m.action === "send_private_msg") sent.push(m.params.message[0].data.text);
    ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: m.echo, data: m.action === "get_login_info" ? { user_id: 90000, nickname: "肥鱼" } : { message_id: sent.length } })); }); }); await once(backend, "listening");
  const config = JSON.parse(bytes); config.onebot_url = `ws://127.0.0.1:${backend.address().port}`; config.channels.qq.enabled = true; fs.writeFileSync(file, JSON.stringify(config));
  await start();
  const state = await call("get"); check("Core get uses masked metadata, never the full key", state.ok && state.data.key_saved && state.data.key_tail === "BBBB" && !JSON.stringify(state).includes(keyA));
  check("Core supplies the complete route catalog without credentials", state.data.presets.length === Object.keys(model.presets).length && state.data.apis.every((api) => model.apis.includes(api)) && state.data.apis.length === model.apis.length && !Object.hasOwn(state.data, "keyRef") && state.data.presets.every((p) => p.baseURL === model.presets[p.provider].baseURL));
  const staleBytes = fs.readFileSync(file, "utf8"), staleCalls = proxyA.requests.length + proxyB.requests.length;
  check("Core refuses stale saves and tests before any endpoint request", (await call("save", { ...draftB, expectedGeneration: 0 })).error === "model_stale" && (await call("test", { ...draftB, expectedGeneration: 0 })).error === "model_stale" && fs.readFileSync(file, "utf8") === staleBytes && proxyA.requests.length + proxyB.requests.length === staleCalls);
  check("real external conversation uses the selected compatible model", await remote("FIRST_REMOTE_CONTEXT_SENTINEL") === "接口一的回复。" && proxyA.requests.at(-1).body.model === "model-one" && tools.externalToolsMatch({ tools: proxyA.requests.at(-1).body.tools.map((t) => ({ name: t.function.name })) }));
  check("real local conversation uses the same route with its own exact tools", (await chat("FIRST_LOCAL_CONTEXT_SENTINEL")).ok && tools.localToolsMatch({ tools: proxyA.requests.at(-1).body.tools.map((t) => ({ name: t.function.name })) }));
  const configBeforeTest = fs.readFileSync(file, "utf8"), atB = proxyB.requests.length, chatsBefore = messages.filter((m) => m.type === "chat_result").length;
  replyB = keyB; const tested = await call("test", draftB);
  check("unsaved draft test really calls Responses without returning provider text", tested.ok && tested.data.connected && proxyB.requests.length === atB + 1 && !JSON.stringify(tested).includes(keyB) && !Object.hasOwn(tested.data, "text"));
  const testBody = proxyB.requests.at(-1).body;
  check("test request has no tools, persona, conversation or memory content", !testBody.tools?.length && !JSON.stringify(testBody).includes(persona) && !JSON.stringify(testBody).includes("FIRST_") && testBody.max_output_tokens <= 64);
  check("test never saves settings or creates a normal chat turn", fs.readFileSync(file, "utf8") === configBeforeTest && messages.filter((m) => m.type === "chat_result").length === chatsBefore);
  for (const [label, draft, proxy, bodyOf] of [
    ["Chat Completions", draftA, proxyA, (r) => r.body],
    ["Anthropic Messages", { ...draftB, api: "anthropic-messages", baseURL: proxyC.url }, proxyC, (r) => r.body],
    ["native default", { provider: "deepseek-official", model: "deepseek-flash", key: oldKey }, nativeProxy, (r) => r],
  ]) {
    const at = proxy.requests.length, result = await call("test", draft), body = bodyOf(proxy.requests.at(-1));
    check(label + " connection test really finishes in an isolated tool-free request", result.ok && result.data.connected && proxy.requests.length === at + 1 && !body.tools?.length);
    check(label + " test cannot include old private persona or chat", !JSON.stringify(body).includes(persona) && !JSON.stringify(body).includes("FIRST_") && fs.readFileSync(file, "utf8") === configBeforeTest);
  }
  faultB = 401; const failureAt = proxyB.requests.length, rejected = await call("test", draftB);
  check("bad key is classified and connection testing does not retry", rejected.error === "invalid_key" && proxyB.requests.length === failureAt + 1);
  faultB = 500; const serverAt = proxyB.requests.length; await call("test", draftB);
  check("server failure also causes just one test request", proxyB.requests.length === serverAt + 1); faultB = null; replyB = "接口二的回复。";
  faultB = "hold"; const testingAt = proxyB.requests.length, testing = call("test", draftB); await wait(() => proxyB.requests.length > testingAt, "held_test");
  check("a second connection test is rejected before another request", (await call("test", draftB)).error === "model_test_busy" && proxyB.requests.length === testingAt + 1);
  faultB = null; proxyB.releaseHeld();
  check("isolated held test can finish without modifying saved settings", (await testing).ok && fs.readFileSync(file, "utf8") === configBeforeTest);
  const forbiddenWrite = join(home, "connection-must-not-write.txt"); nextToolA = { name: "write", input: { file_path: forbiddenWrite, content: "must-not-execute" } };
  const malicious = await call("test", draftA);
  check("unsolicited model tool request cannot write or masquerade as a successful test", !malicious.ok && !fs.existsSync(forbiddenWrite));
  faultA = "hold"; const atA = proxyA.requests.length, waiting = remote("ACTIVE_REMOTE_MUST_FINISH_FIRST"); await wait(() => proxyA.requests.length > atA, "held_remote");
  check("active external turn blocks a model switch without changing keys", (await call("save", draftB)).error === "model_busy" && fs.readFileSync(file, "utf8") === configBeforeTest);
  faultA = null; proxyA.releaseHeld(); await waiting;
  faultA = "hold"; const localAt = proxyA.requests.length, activeLocal = chat("ACTIVE_LOCAL_MUST_FINISH_FIRST"); await wait(() => proxyA.requests.length > localAt, "held_local");
  check("active local turn also prevents a model switch", (await call("save", draftB)).error === "model_busy" && fs.readFileSync(file, "utf8") === configBeforeTest);
  faultA = null; proxyA.releaseHeld(); await activeLocal;
  const switched = await call("save", draftB), afterSwitch = proxyB.requests.length;
  check("idle switch commits a new shared model generation", switched.ok && switched.data.generation === 2 && switched.data.key_tail === "CCCC");
  await remote("SECOND_REMOTE_CONTEXT_SENTINEL"); await chat("SECOND_LOCAL_CONTEXT_SENTINEL");
  const current = proxyB.requests.slice(afterSwitch);
  check("both v1 instances actually use the second endpoint and model", current.length === 2 && current.every((r) => r.body.model === "model-two" && r.authorization === "Bearer " + keyB));
  check("new endpoint receives no SDK conversation from the previous provider", current.every((r) => !JSON.stringify(r.body).includes("FIRST_") && !JSON.stringify(r.body).includes("ACTIVE_REMOTE_")));
  check("Responses retains exact external/local tool segregation", tools.externalToolsMatch(current[0].body) && tools.localToolsMatch(current[1].body));
  check("model requests have neither private upload field", [...proxyA.requests, ...proxyB.requests].every((r) => !("dsh_session_log" in r.body) && !("dsh_plugin_packages" in r.body)));
  await stop(); await start(); const restartAt = proxyB.requests.length; await chat("AFTER_RESTART");
  check("same-provider context and key survive Core restart", proxyB.requests.length === restartAt + 1 && JSON.stringify(proxyB.requests.at(-1).body).includes("SECOND_LOCAL_CONTEXT_SENTINEL") && proxyB.requests.at(-1).authorization === "Bearer " + keyB);
  const keyFile = join(home, "secrets", model.read(home).keyRef); fs.renameSync(keyFile, keyFile + ".missing"); const beforeMissing = proxyA.requests.length + proxyB.requests.length;
  check("missing selected key cannot fall back to ambient or old credentials", (await chat("MISSING_KEY")).error === "no_key" && proxyA.requests.length + proxyB.requests.length === beforeMissing); fs.renameSync(keyFile + ".missing", keyFile);
  await stop(); const patchFile = join(home, "dsh/local/model.patch.json"); fs.renameSync(patchFile, patchFile + ".before"); fs.mkdirSync(patchFile);
  await start(); const beforeBadPatch = proxyB.requests.length;
  check("non-file generated overlay fails closed without leaving startup stuck", (await chat("BAD_OVERLAY")).error === "model_config_invalid" && proxyB.requests.length === beforeBadPatch && messages.findLast((m) => m.type === "engine" && m.instance === "local").state === "model_config_invalid");
  fs.rmdirSync(patchFile); fs.renameSync(patchFile + ".before", patchFile);
  check("repairing generated overlay restores the selected model", (await chat("REPAIRED_OVERLAY")).ok && proxyB.requests.at(-1).body.model === "model-two");
  process.env.FATFISH_APPDATA = home;
  const { ModelService } = await import(pathToFileURL(join(licensed.core, "model-service.mjs"))), isolated = new ModelService({ root: home, instances: {}, timeoutMs: 100 });
  faultB = "hold"; let timeoutCode;
  try { await isolated.test(draftB); } catch (e) { timeoutCode = e.message; } finally { await isolated.stop(); faultB = null; }
  check("connection timeout terminates only its temporary runtime", timeoutCode === "model_test_timeout" && !isolated.client && (await chat("CORE_STILL_USABLE_AFTER_TEST_TIMEOUT")).ok);
  check("Core logs omit every full fixture key, persona and prompt text", [oldKey, keyA, keyB, persona, "FIRST_LOCAL_CONTEXT_SENTINEL"].every((s) => !logs.join("").includes(s)));
  console.log(`${results.length}/${results.length} model checks passed (real Core/SDK, loopback fixtures, no windows/paid calls)`);
} finally {
  try { await stop(); } finally { await proxyA?.close(); await proxyB?.close(); await proxyC?.close(); await nativeProxy?.close(); if (backend) await new Promise((r) => { for (const ws of backend.clients) ws.terminate(); backend.close(r); });
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(join(evidence, "model-report.json"), JSON.stringify({ results, paidCalls: 0, nativeUI: false, model: "loopback-fixtures", instances: ["external", "local"] }, null, 2)); }
    if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-model-check-")) fs.rmSync(home, { recursive: true, force: true });
  }
}
