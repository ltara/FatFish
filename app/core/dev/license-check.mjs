/** License signatures/storage and actual independently licensed Core/SDK. No native UI, cloud or paid models. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { fork } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import licenseModule from "../license-gate.cjs";
import device from "../device-fingerprint.cjs";
import fixtureModule from "./license-fixture.cjs";
import { startModelProxy } from "./model-proxy.mjs";
const home = fs.mkdtempSync(join(tmpdir(), "fatfish-license-check-")), fixture = fixtureModule.licensedFixture(home), file = join(home, "license.json"), bytes = fs.readFileSync(file, "utf8"), results = [], logs = [];
process.env.FATFISH_APPDATA = home; Object.assign(process.env, fixture.env);
const { LicenseGate } = fixture.gate(), gate = new LicenseGate(home);
const evidenceIndex = process.argv.indexOf("--evidence"), evidence = evidenceIndex < 0 ? null : resolve(process.argv[evidenceIndex + 1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, label) { const end = Date.now() + 30000; while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(20); } throw new Error("license_check_timeout:" + label); }
const check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
const serialize = (x) => JSON.stringify(x) + "\n", verify = (s, fingerprint = fixture.fingerprint, key = fixture.publicKey) => licenseModule.verifyBytes(s, fingerprint, key);
let child, messages, proxy;
async function start(entry = fixture.entry, root = home, extra = {}) {
  messages = []; child = fork(entry, [], { execPath: process.env.E2E_EXEC_PATH || process.execPath, windowsHide: true, env: { ...process.env, FATFISH_APPDATA: root, ...extra, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.on("message", (m) => messages.push(m)); child.stdout.on("data", (b) => logs.push(b.toString())); child.stderr.on("data", (b) => logs.push(b.toString())); child.on("error", () => {});
  return wait(() => messages.find((m) => ["ready", "license"].includes(m.type)), "ready_or_refused");
}
async function exited() { await wait(() => child.exitCode !== null || child.signalCode !== null, "exit"); return child.exitCode; }
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { child.send({ type: "shutdown" }); await exited(); } child = null; }
try {
  check("authentic canonical license verifies locally", verify(bytes).valid && gate.inspect().valid);
  check("every single-byte mutation of the saved license is refused", [...Buffer.from(bytes)].every((_value, index) => { const b = Buffer.from(bytes); b[index] ^= 1; return !verify(b.toString("utf8")).valid; }));
  check("appended whitespace and missing final newline also fail closed", !verify(bytes + " ").valid && !verify(bytes.trim()).valid);
  check("another machine cannot use this signed license", verify(bytes, "b".repeat(64)).error === "license_wrong_device");
  const wrongKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  check("another public key and an absent trust anchor are refused", !verify(bytes, fixture.fingerprint, wrongKey).valid && verify(bytes, fixture.fingerprint, null).error === "license_unconfigured");
  for (const [name, overrides] of [["version", { version: 2 }], ["product", { product: "other" }], ["edition", { edition: "v2" }], ["code hash", { code_hash: "raw-code" }], ["timestamp", { issued_at: "not-a-date" }], ["unknown field", { expires_at: "tomorrow" }]]) check("even signed invalid " + name + " is refused", !verify(serialize(fixture.issue(overrides))).valid);
  check("permanent offline license has no clock/expiry dependency", verify(serialize(fixture.issue({ issued_at: "2000-01-01T00:00:00.000Z" }))).valid);
  const parsed = JSON.parse(bytes);
  check("noncanonical base64 and altered signature cannot verify", !verify(serialize({ ...parsed, payload: parsed.payload + "=" })).valid && !verify(serialize({ ...parsed, signature: parsed.signature.slice(1) })).valid);
  check("device hash normalizes case and volume separator without exposing raw values", device.fromParts("12345678-1234-5678-9ABC-123456789ABC", "ABCD-1234") === device.fromParts("12345678-1234-5678-9abc-123456789abc", "abcd1234"));
  for (const [guid, serial] of [["raw", "ABCD1234"], ["00000000-0000-0000-0000-000000000000", "ABCD1234"], ["12345678-1234-5678-9abc-123456789abc", "00000000"]]) assert.throws(() => device.fromParts(guid, serial), /device_unavailable/);
  check("missing/placeholder device components fail closed", true);
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => gate.install(fixture.issue({ fingerprint: "c".repeat(64) })), /license_wrong_device/);
  check("a rejected activation never overwrites the prior valid file", fs.readFileSync(file, "utf8") === before);
  const rename = fs.renameSync;
  try { fs.renameSync = (from, to) => { if (to === file) throw new Error("fixture_disk_failure"); return rename(from, to); }; assert.throws(() => gate.install(fixture.issue()), /license_save_failed/); }
  finally { fs.renameSync = rename; }
  check("atomic storage failure preserves prior bytes and removes only its own temp", fs.readFileSync(file, "utf8") === before && !fs.readdirSync(home).some((s) => s.endsWith(".tmp")));
  fs.renameSync(file, file + ".saved"); fs.mkdirSync(join(home, "link-target")); fs.symlinkSync(join(home, "link-target"), file, "junction");
  check("a junction in place of the license file is not accepted", !gate.inspect().valid); fs.unlinkSync(file); fs.renameSync(file + ".saved", file);
  fs.writeFileSync(file, "x".repeat(16385)); check("oversized license is not accepted", !gate.inspect().valid); fs.writeFileSync(file, bytes);
  const prodRoot = join(home, "production-anchor"); fs.mkdirSync(prodRoot); fs.writeFileSync(join(prodRoot, "license.json"), bytes);
  await start(fileURLToPath(new URL("../server.mjs", import.meta.url)), prodRoot, { FATFISH_LICENSE_VALID: "1", FATFISH_PUBLIC_KEY: fixture.publicKey, FATFISH_SMOKE: "1" });
  check("original Core ignores forged environment/parent license assertions and unconfigured trust", await exited() === 78 && messages.some((m) => m.type === "license" && m.error === "license_unconfigured") && !messages.some((m) => m.type === "ready" || m.type === "engine") && !fs.existsSync(join(prodRoot, "dsh"))); await stop();
  fs.unlinkSync(file); await start(); check("missing license blocks Core before any engine or channel starts", await exited() === 78 && messages[0].error === "activation_required" && !messages.some((m) => m.type === "engine")); await stop();
  fs.writeFileSync(file, bytes.replace(/.$/m, "!")); await start(); check("tampered file blocks the actual Core independently", await exited() === 78 && messages[0].error === "license_invalid"); await stop();
  fs.writeFileSync(file, serialize(fixture.issue({ fingerprint: "e".repeat(64) }))); await start(); check("valid signature for another device still blocks Core", await exited() === 78 && messages[0].error === "license_wrong_device"); await stop();
  fs.writeFileSync(file, bytes); fs.mkdirSync(join(home, "secrets")); fs.writeFileSync(join(home, "secrets/deepseek_api_key"), "sk-license-fixture-not-a-key"); fs.writeFileSync(join(home, "config.json"), JSON.stringify({ channels: { qq: { enabled: false } } }));
  proxy = await startModelProxy({ reply: () => "已激活的本机回复。" }); process.env.FATFISH_DEV_DEEPSEEK_BASE_URL = proxy.url;
  check("licensed Core starts offline without contacting activation service", (await start()).type === "ready");
  child.send({ type: "chat_send", id: "licensed-chat", sessionId: "local-main", text: "固定本机测试" });
  check("actual local SDK conversation is possible after independent verification", (await wait(() => messages.find((m) => m.type === "chat_result" && m.id === "licensed-chat"), "chat")).ok && proxy.requests.length === 1);
  fs.unlinkSync(file); check("removing the license stops an already-running idle Core and its engine", await exited() === 0); await stop();
  const { ModelService } = await import(pathToFileURL(join(fixture.core, "model-service.mjs"))), service = new ModelService({ root: home, instances: {} });
  assert.throws(() => service.test({ provider: "deepseek-official", model: "deepseek-flash", key: "sk-must-not-leave" }), /activation_required/);
  check("standalone connection test also refuses before spawning or calling a model", !service.client && proxy.requests.length === 1); await service.stop();
  const { EngineHost } = await import(pathToFileURL(join(fixture.core, "engine-host.mjs"))), host = new EngineHost({ name: "external", profile: "fatfish-external", dshHome: join(home, "dsh/external"), workspace: join(home, "workspace/external") });
  check("direct EngineHost startup cannot bypass the local license check", !await host.start() && !host.client && host.state === "activation_required"); await host.dispose();
  gate.install(fixture.issue()); check("restoring a valid license recovers on a fresh Core startup", (await start()).type === "ready"); await stop();
  check("Core logs omit license bytes, fingerprint and fixture input", [bytes.trim(), fixture.fingerprint, "固定本机测试", "sk-license-fixture-not-a-key"].every((s) => !logs.join("").includes(s)));
  console.log(`${results.length}/${results.length} license Core checks passed (no windows or paid calls)`);
} finally {
  await stop(); await proxy?.close();
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(join(evidence, "license-report.json"), JSON.stringify({ results, sourceManifest: fixture.manifest, testTrustAnchorOnly: true, nativeUI: false, paidCalls: 0, realQQ: false }, null, 2)); }
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-license-check-")) fs.rmSync(home, { recursive: true, force: true });
}
