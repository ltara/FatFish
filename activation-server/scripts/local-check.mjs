/** Real wrangler dev + local D1 acceptance. No cloud credentials, remote mutation, native UI or paid models. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { generateKeyPairSync, randomBytes, createHash, verify, createPublicKey, sign } from "node:crypto";
import net from "node:net";
const exec = promisify(execFile), root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), cli = join(root, "node_modules/wrangler/bin/wrangler.js");
const home = fs.mkdtempSync(join(tmpdir(), "fatfish-activation-check-")), config = join(home, "wrangler.json"), persist = join(home, "state"), results = [], clientResults = [], logs = [];
const evidenceIndex = process.argv.indexOf("--evidence"), evidence = evidenceIndex < 0 ? null : resolve(process.argv[evidenceIndex + 1]);
const keys = generateKeyPairSync("ed25519"), key64 = keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), token = randomBytes(32).toString("hex"), rateSalt = randomBytes(32).toString("hex");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLOUDFLARE_|CF_|WRANGLER_)/i.test(k)));
Object.assign(env, { WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" });
let child, base, ip = 0;
const check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
const hash = (s) => createHash("sha256").update(s).digest("hex"), fp = (n) => hash("activation-fixture-device-" + n);
const code = () => "FF-" + randomBytes(16).toString("hex").toUpperCase().match(/.{8}/g).join("-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function port() { const server = net.createServer(); await new Promise((r) => server.listen(0, "127.0.0.1", r)); const p = server.address().port; await new Promise((r) => server.close(r)); return p; }
async function run(args) { return exec(process.execPath, [cli, ...args, "--config", config], { env, cwd: home, windowsHide: true, timeout: 60000, maxBuffer: 1000000 }); }
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const c = child;
  if (process.platform === "win32") await exec("taskkill", ["/PID", String(c.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
  else c.kill("SIGTERM");
  const until = Date.now() + 10000; while (c.exitCode === null && c.signalCode === null && Date.now() < until) await sleep(40);
  assert.ok(c.exitCode !== null || c.signalCode !== null, "owned_wrangler_did_not_stop"); child = null;
}
async function start() {
  const p = await port(); base = "http://127.0.0.1:" + p;
  child = spawn(process.execPath, [cli, "dev", "--local", "--ip", "127.0.0.1", "--port", String(p), "--inspector-port", "0", "--persist-to", persist, "--config", config], { env, cwd: home, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (b) => logs.push(b.toString())); child.stderr.on("data", (b) => logs.push(b.toString()));
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("wrangler_start_failed");
    try { if ((await fetch(base + "/health", { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* wait only for this local child */ }
    await sleep(150);
  }
  throw new Error("wrangler_start_timeout");
}
async function request(path, body, { admin = false, headers = {}, method = body === undefined ? "GET" : "POST" } = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), "CF-Connecting-IP": "198.51.100." + ++ip, ...(admin ? { authorization: "Bearer " + token } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  return { status: res.status, headers: res.headers, ...await res.json() };
}
const activate = (c, n, options) => request("/activate", { code: c, fingerprint: fp(n) }, options);
const importCodes = (codes) => request("/admin/codes", { code_hashes: codes.map((c) => hash(c.replaceAll("-", ""))), edition: "v1", max_devices: 2 }, { admin: true });
try {
  assert.ok(fs.existsSync(cli), "install_server_dev_dependencies_first");
  fs.writeFileSync(config, JSON.stringify({ name: "fatfish-activation-local-check", main: join(root, "src/worker.mjs"), compatibility_date: "2026-10-01", workers_dev: false, observability: { enabled: false }, d1_databases: [{ binding: "DB", database_name: "fatfish-activation", database_id: "00000000-0000-0000-0000-000000000000" }] }));
  fs.writeFileSync(join(home, ".dev.vars"), `LICENSE_PRIVATE_KEY=${key64}\nADMIN_TOKEN=${token}\nRATE_SALT=${rateSalt}\n`, { mode: 0o600 });
  await run(["d1", "execute", "fatfish-activation", "--local", "--persist-to", persist, "--file", join(root, "schema.sql")]);
  await start(); check("real wrangler dev serves only the isolated local Worker", (await request("/health")).ok);
  const c = code(), h = hash(c.replaceAll("-", ""));
  check("unauthorized admin import is denied", (await request("/admin/codes", { code_hashes: [h], edition: "v1", max_devices: 2 })).status === 401);
  check("unknown code cannot activate", (await activate(c, 1)).error === "invalid_code");
  check("authenticated batch import stores one hash", (await importCodes([c])).created === 1);
  check("reimport is idempotent without resetting device capacity", (await importCodes([c])).created === 0);
  const first = await activate(c.toLowerCase(), 1), license = first.license;
  check("first machine receives a genuine Ed25519 signed license", first.ok && verify(null, Buffer.from(license.payload, "base64url"), keys.publicKey, Buffer.from(license.signature, "base64url")));
  const payload = JSON.parse(Buffer.from(license.payload, "base64url").toString("utf8"));
  check("license binds hash, fingerprint, edition and no expiry", payload.code_hash === h && payload.fingerprint === fp(1) && payload.edition === "v1" && payload.product === "fatfish" && payload.version === 1 && !Object.hasOwn(payload, "expires_at"));
  check("license response contains neither code nor server secret", !JSON.stringify(first).includes(c) && !JSON.stringify(first).includes(key64) && !JSON.stringify(first).includes(token));
  check("same machine can retry without consuming a new slot", (await activate(c, 1)).ok);
  check("a second machine can activate", (await activate(c, 2)).ok);
  check("a third machine is refused", (await activate(c, 3)).error === "device_limit");
  check("full capacity still allows an existing machine", (await activate(c, 1)).ok);
  const detail = await request("/admin/code?code_hash=" + h, undefined, { admin: true });
  check("admin sees only the hash and two fingerprints, never a plaintext code", detail.devices.length === 2 && detail.code.code_hash === h && !JSON.stringify(detail).includes(c));
  const adminEnv = { ...env, FATFISH_ACTIVATION_URL: base, FATFISH_ACTIVATION_ADMIN_TOKEN: token };
  const cliRead = await exec(process.execPath, [join(root, "scripts/admin.mjs"), "query", h], { env: adminEnv, windowsHide: true });
  check("actual admin CLI can query without printing credentials", JSON.parse(cliRead.stdout).devices.length === 2 && !cliRead.stdout.includes(token) && !cliRead.stdout.includes(key64));
  let cliDenied = false;
  try { await exec(process.execPath, [join(root, "scripts/admin.mjs"), "query", h], { env: { ...adminEnv, FATFISH_ACTIVATION_ADMIN_TOKEN: "wrong-token-with-at-least-32-characters" }, windowsHide: true }); }
  catch (e) { cliDenied = e.code === 1 && !e.stderr.includes(token) && e.stderr.includes("401"); }
  check("actual admin CLI reports failure without claiming success or leaking the token", cliDenied);
  check("admin unbind frees only the chosen machine", (await request("/admin/unbind", { code_hash: h, fingerprint: fp(1) }, { admin: true })).removed && (await activate(c, 3)).ok);
  check("unbound machine must compete for a new slot", (await activate(c, 1)).error === "device_limit");
  check("unbinding a nonexistent machine is an honest no-op", (await request("/admin/unbind", { code_hash: h, fingerprint: fp(99) }, { admin: true })).removed === false);
  check("revocation blocks subsequent activations including known machines", (await request("/admin/revoke", { code_hash: h }, { admin: true })).found && (await activate(c, 2)).error === "invalid_code");
  check("reimport cannot revive a revoked code", (await importCodes([c])).created === 0 && (await activate(c, 3)).error === "invalid_code");
  check("offline signature stays valid after server revocation by permanent-offline design", verify(null, Buffer.from(license.payload, "base64url"), keys.publicKey, Buffer.from(license.signature, "base64url")));
  const parallelCode = code(); await importCodes([parallelCode]);
  const parallel = await Promise.all(Array.from({ length: 8 }, (_, n) => activate(parallelCode, 100 + n)));
  check("eight simultaneous activations allocate exactly two machines", parallel.filter((r) => r.ok).length === 2 && parallel.filter((r) => r.error === "device_limit").length === 6);
  const ids = (await request("/admin/code?code_hash=" + hash(parallelCode.replaceAll("-", "")), undefined, { admin: true })).devices;
  check("parallel allocation leaves precisely two durable database rows", ids.length === 2);
  const mixed = await Promise.all(Array.from({ length: 6 }, () => request("/activate", { code: parallelCode, fingerprint: ids[0].fingerprint })));
  check("concurrent retries of the same machine are idempotent", mixed.every((r) => r.ok));
  if (process.argv.includes("--client")) {
    const clientCheck = (name, ok) => { clientResults.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("CLIENT PASS " + name); };
    const { default: helpers } = await import("../../app/core/dev/license-fixture.cjs");
    const clientRoot = join(home, "client"), fixture = helpers.licensedFixture(clientRoot), trustFile = join(fixture.core, "license-trust.cjs"), clientFile = join(clientRoot, "license.json");
    // Only a PUBLIC test anchor and loopback URL enter the client copy. Signing key remains in Worker secrets.
    fs.writeFileSync(trustFile, '"use strict";module.exports=Object.freeze(' + JSON.stringify({ publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), activationURL: base + "/activate" }) + ');\n');
    fs.unlinkSync(clientFile); const { LicenseGate } = fixture.gate(), client = new LicenseGate(clientRoot), clientCode = code(); await importCodes([clientCode]);
    clientCheck("actual client starts with activation required", client.inspect().error === "activation_required");
    clientCheck("actual client activates against real local Worker/D1", (await client.activate(clientCode)).valid && client.inspect().valid);
    const saved = fs.readFileSync(clientFile, "utf8");
    clientCheck("saved canonical credential contains no plaintext code or server private key", saved.endsWith("\n") && !saved.includes(clientCode) && !saved.includes(key64));
    const ch = hash(clientCode.replaceAll("-", "")); await client.activate(clientCode);
    clientCheck("actual client retry keeps exactly one machine binding", (await request("/admin/code?code_hash=" + ch, undefined, { admin: true })).devices.length === 1);
    const stable = fs.readFileSync(clientFile, "utf8");
    let failure; try { await client.activate(parallelCode); } catch (e) { failure = e.message; }
    clientCheck("actual device-cap response is classified and preserves prior license", failure === "device_limit" && fs.readFileSync(clientFile, "utf8") === stable);
    try { await client.activate(code()); } catch (e) { failure = e.message; }
    clientCheck("actual unknown-code response has a fixed client classification", failure === "invalid_code");
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => { throw new TypeError("transport-detail-must-not-leak"); };
      try { await client.activate(clientCode); } catch (e) { failure = e.message; }
      clientCheck("transport failure exposes no raw diagnostic and preserves prior bytes", failure === "activation_network" && fs.readFileSync(clientFile, "utf8") === stable);
      globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, license: fixture.issue() }));
      try { await client.activate(clientCode); } catch (e) { failure = e.message; }
      clientCheck("a response signed by another key cannot replace a valid license", failure === "license_invalid" && fs.readFileSync(clientFile, "utf8") === stable);
      const wrongPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(JSON.parse(stable).payload, "base64url").toString("utf8")), code_hash: "f".repeat(64) }));
      globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, license: { payload: wrongPayload.toString("base64url"), signature: sign(null, wrongPayload, keys.privateKey).toString("base64url") } }));
      try { await client.activate(clientCode); } catch (e) { failure = e.message; }
      clientCheck("even an authentic response for a different code is rejected without overwriting", failure === "activation_response_invalid" && fs.readFileSync(clientFile, "utf8") === stable);
      globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: "raw-server-detail-must-not-leak" }), { status: 503 });
      try { await client.activate(clientCode); } catch (e) { failure = e.message; }
      clientCheck("arbitrary server errors are mapped rather than echoed", failure === "activation_unavailable");
      let requestSafe = false;
      globalThis.fetch = async (url, opts) => { const b = JSON.parse(opts.body); requestSafe = url === base + "/activate" && opts.redirect === "error" && Object.keys(b).join("|") === "code|fingerprint" && /^[0-9a-f]{64}$/.test(b.fingerprint); throw new TypeError(); };
      try { await client.activate(clientCode); } catch {}
      clientCheck("native client sends only code/hash to fixed URL and refuses redirects", requestSafe);
      let release, requests = 0; globalThis.fetch = async () => { requests++; return new Promise((r) => { release = r; }); };
      const firstCall = client.activate(clientCode); try { await client.activate(clientCode); } catch (e) { failure = e.message; }
      clientCheck("concurrent native activation is refused before a second request", failure === "activation_busy" && requests === 1);
      release(new Response(JSON.stringify({ ok: true, license: JSON.parse(stable) }))); await firstCall;
      globalThis.fetch = async () => { throw new Error("offline"); };
      clientCheck("activated client verifies offline without using fetch", client.inspect().valid);
    } finally { globalThis.fetch = originalFetch; }
    let clientCore; const messages = [];
    try {
      clientCore = fork(fixture.entry, [], { execPath: process.env.E2E_EXEC_PATH || process.execPath, env: { ...env, ...fixture.env, FATFISH_APPDATA: clientRoot, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      clientCore.stdout.resume(); clientCore.stderr.resume(); clientCore.on("message", (m) => messages.push(m));
      const end = Date.now() + 15000; while (!messages.some((m) => m.type === "ready") && clientCore.exitCode === null && Date.now() < end) await sleep(30);
      clientCheck("independent actual Core accepts the credential issued by the real Worker", messages.some((m) => m.type === "ready") && !messages.some((m) => m.type === "license" && !m.valid));
      clientCore.send({ type: "shutdown" }); await new Promise((r) => clientCore.once("exit", r));
    } finally { if (clientCore && clientCore.exitCode === null && clientCore.signalCode === null) { clientCore.kill(); await new Promise((r) => clientCore.once("exit", r)); } }
    console.log(`${clientResults.length}/${clientResults.length} client/real-Worker contracts passed (no production keys or cloud)`);
  }
  check("invalid fingerprint is rejected", (await request("/activate", { code: c, fingerprint: "raw-machine-guid" })).error === "invalid_request");
  check("extra activation fields cannot select an edition", (await request("/activate", { code: c, fingerprint: fp(1), edition: "v2" })).error === "invalid_request");
  check("arbitrary websites cannot read or trigger activation", (await activate(c, 1, { headers: { origin: "https://untrusted.example" } })).status === 403);
  check("oversized request is refused without reflecting its body", (await request("/activate", { code: "sensitive-input".repeat(2000), fingerprint: fp(1) })).error === "invalid_request");
  check("wrong admin token is denied", (await request("/admin/code?code_hash=" + h, undefined, { headers: { authorization: "Bearer " + token.slice(1) } })).status === 401);
  check("unsupported method and route fail closed", (await request("/activate")).status === 404 && (await request("/admin/unknown", {}, { admin: true })).status === 404);
  if (Date.now() % 60000 > 58000) await sleep(60020 - Date.now() % 60000);
  const rates = []; for (let i = 0; i < 11; i++) rates.push(await activate(code(), 400, { headers: { "CF-Connecting-IP": "203.0.113.1" } }));
  check("activation brute-force limit rejects the eleventh attempt in one minute", rates.slice(0, 10).every((r) => r.error === "invalid_code") && rates[10].status === 429 && rates[10].error === "rate_limited");
  check("responses disable caches and do not opt into cross-origin reads", first.headers.get("cache-control") === "no-store" && !first.headers.has("access-control-allow-origin"));
  await stop(); await start();
  check("local D1 survives Worker restart without reviving revoked codes", (await activate(c, 2)).error === "invalid_code" && (await request("/admin/code?code_hash=" + h, undefined, { admin: true })).devices.length === 2);
  await stop();
  fs.writeFileSync(join(home, ".dev.vars"), `LICENSE_PRIVATE_KEY=not-a-private-key\nADMIN_TOKEN=${token}\nRATE_SALT=${rateSalt}\n`, { mode: 0o600 });
  await start(); const badKeyCode = code(), bh = hash(badKeyCode.replaceAll("-", "")); await importCodes([badKeyCode]);
  check("invalid signing key fails closed with a generic response", (await activate(badKeyCode, 500)).error === "unavailable");
  check("signing failure consumes no machine capacity", (await request("/admin/code?code_hash=" + bh, undefined, { admin: true })).devices.length === 0);
  await stop();
  check("Worker logs contain no plaintext codes, private key, token or machine hash", [c, parallelCode, key64, token, fp(1), "sensitive-input"].every((value) => !logs.join("").includes(value)));
  const keyDir = join(home, "keygen"); await exec(process.execPath, [join(root, "scripts/generate-keys.mjs"), keyDir], { windowsHide: true });
  const testPublic = createPublicKey({ key: Buffer.from(fs.readFileSync(join(keyDir, "public.spki.base64"), "utf8").trim(), "base64"), format: "der", type: "spki" });
  check("key generator emits a valid public key and independent server-only secrets", testPublic.asymmetricKeyType === "ed25519" && fs.readFileSync(join(keyDir, "admin-token.txt"), "utf8").trim().length === 64);
  let overwriteBlocked = false; try { await exec(process.execPath, [join(root, "scripts/generate-keys.mjs"), keyDir], { windowsHide: true }); } catch { overwriteBlocked = true; }
  check("key generator cannot overwrite existing keys", overwriteBlocked);
  const codeDir = join(home, "codegen"); await exec(process.execPath, [join(root, "scripts/generate-codes.mjs"), "5", codeDir], { windowsHide: true });
  const plain = fs.readFileSync(join(codeDir, "delivery-codes.txt"), "utf8").trim().split("\n"), manifest = JSON.parse(fs.readFileSync(join(codeDir, "import.json"), "utf8"));
  check("batch code manifest contains only matching unique hashes", plain.length === 5 && new Set(plain).size === 5 && manifest.code_hashes.every((h, i) => h === hash(plain[i].replaceAll("-", ""))) && !JSON.stringify(manifest).includes(plain[0]));
  console.log(`${results.length}/${results.length} activation checks passed (real local Worker/D1, no cloud deployment)`);
} finally {
  await stop();
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(join(evidence, "activation-report.json"), JSON.stringify({ results, clientResults, at: new Date().toISOString(), localWrangler: true, remoteDeployment: false, paidModelCalls: 0, nativeUI: false }, null, 2)); }
  // Never persist raw Wrangler output: it may reveal configured secrets on startup failures.
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-activation-check-")) fs.rmSync(home, { recursive: true, force: true });
}
