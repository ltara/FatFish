"use strict";
// Code/resource fixture only. No Electron window, installer, live account or paid model.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const { generateKeyPairSync, sign } = require("node:crypto"), { fork, execFileSync } = require("node:child_process"), { createRequire } = require("node:module"), { pathToFileURL } = require("node:url"), { EventEmitter } = require("node:events");
const asar = require("@electron/asar"), protection = require("./protection.cjs");
const repo = path.resolve(__dirname, "../.."), root = fs.mkdtempSync(path.join(os.tmpdir(), "fatfish-protection-check-"));
const appOutDir = path.join(root, "fixture"), resources = path.join(appOutDir, "resources"), home = path.join(root, "appdata"), core = path.join(resources, "core");
const evidenceAt = process.argv.indexOf("--evidence"), evidence = evidenceAt < 0 ? null : path.resolve(process.argv[evidenceAt + 1]);
const results = [], logs = []; let child, proxy, manifest;
const check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
const keys = generateKeyPairSync("ed25519"), config = { version: 1, publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), activationURL: "https://activation.fatfish.test/activate" };
const context = { appOutDir, electronPlatformName: "win32", arch: 1, packager: { appInfo: { productFilename: "FatFish-Fixture" }, info: { framework: { version: "33.4.11" } } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, label) { const end = Date.now() + 35000; while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(20); } throw new Error("protection_timeout:" + label); }
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { child.send({ type: "shutdown" }); await wait(() => child.exitCode !== null || child.signalCode !== null, "stop"); } child = null; }
async function start() {
  const messages = [];
  child = fork(path.join(core, "server.mjs"), [], { windowsHide: true, execPath: process.env.E2E_EXEC_PATH || process.execPath, env: { ...process.env, FATFISH_APPDATA: home, FATFISH_DSH_EXE: path.join(repo, "vendor/dsh/deepseek-harness-sdk-runtime-win-x64.exe"), ELECTRON_RUN_AS_NODE: "1", FATFISH_LICENSE_VALID: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.on("message", (m) => messages.push(m)); child.stdout.on("data", (v) => logs.push(v.toString())); child.stderr.on("data", (v) => logs.push(v.toString())); child.on("error", () => {});
  const first = await wait(() => messages.find((m) => ["ready", "license"].includes(m.type)), "start");
  return { first, messages };
}
async function loadMain(ui) {
  let ready, starts = 0; const handlers = new Map(), windows = [];
  const app = new EventEmitter(); Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: () => ({ then: (fn) => { ready = fn; } }), quit() {}, isPackaged: true, getVersion: () => "test" });
  class Window extends EventEmitter { constructor() { super(); this.webContents = new EventEmitter(); Object.assign(this.webContents, { mainFrame: {}, isDestroyed: () => false, setWindowOpenHandler() {}, send() {} }); windows.push(this); } loadFile() {} isDestroyed() { return false; } }
  Window.getAllWindows = () => windows;
  class Tray { setToolTip() {} setImage() {} setContextMenu() {} on() {} destroy() {} }
  class Services extends EventEmitter { async startAll() { starts++; return { phase: "running" }; } async stopAll() {} async refreshProbes() {} getState() { return { phase: "running" }; } getCore() { return { engines: {}, channels: {}, license: { valid: true } }; } readQqEnabled() { return false; } }
  const image = { isEmpty: () => false }, req = createRequire(path.join(ui, "main.js"));
  const shell = { app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: (items) => items }, nativeImage: { createFromPath: () => image, createFromBuffer: () => image, createFromBitmap: () => image }, ipcMain: { handle: (id, fn) => handlers.set(id, fn) }, session: { defaultSession: { setPermissionRequestHandler() {} } } };
  const ctx = vm.createContext({ __dirname: ui, Buffer, console: { ...console, log() {} }, process: { env: { FATFISH_APPDATA: home }, platform: "win32", execPath: process.execPath, resourcesPath: resources }, setTimeout: () => ({ unref() {} }), clearTimeout() {}, require: (name) => name === "electron" ? shell : name === "./service-manager" ? { ServiceManager: Services } : req(name) });
  vm.runInContext(fs.readFileSync(path.join(ui, "main.js"), "utf8"), ctx); await ready();
  const event = { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame };
  return { handlers, event, starts: () => starts, call: (id, ...args) => handlers.get(id)(event, ...args) };
}
(async () => {
  const oldConfig = process.env.FATFISH_RELEASE_CONFIG;
  try {
    const uiRoot = path.join(repo, "app/electron-ui"), builder = require(path.join(uiRoot, "node_modules/app-builder-lib/out/util/resolve.js")), build = JSON.parse(fs.readFileSync(path.join(uiRoot, "package.json"))).build, cwd = process.cwd();
    try {
      process.chdir(uiRoot);
      for (const name of ["beforePack", "afterPack", "afterSign"]) assert.equal(typeof await builder.resolveFunction(undefined, build[name], name), "function");
    } finally { process.chdir(cwd); }
    check("the locked builder resolves all three configured hooks without starting a build", true);
    assert.throws(() => protection.validateConfig({ ...config, privateKey: "DO_NOT_ACCEPT" }), /release_config_invalid/);
    check("release configuration cannot contain a signing/private key field", true);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    assert.throws(() => protection.validateConfig({ ...config, publicKey: rsa }), /release_public_key_invalid/);
    check("only canonical Ed25519 public SPKI is accepted", true);
    for (const activationURL of ["http://host.test/activate", "https://127.0.0.1/activate", "https://localhost/activate", "https://x.local/activate", "https://a:b@host.test/activate", "https://host.test/activate?q=key", "https://host.test/admin"]) assert.throws(() => protection.validateConfig({ ...config, activationURL }), /release_activation_url_invalid/);
    check("release URL rejects plaintext, local IP/hosts, credentials, queries and admin routes", true);
    delete process.env.FATFISH_RELEASE_CONFIG; await assert.rejects(protection.beforePack(context), /release_config_required/);
    check("pack preflight fails before resource output when public configuration is missing", !fs.existsSync(appOutDir));
    await assert.rejects(protection.afterPack(context), /release_preflight_required/);
    check("afterPack cannot be used without a matching build preflight", true);
    await assert.rejects(protection.afterPack({ ...context, appOutDir: path.join(repo, "app/electron-ui/dist/win-unpacked") }), /release_preflight_required/);
    check("the configured default dist output is allowed without permitting application source overwrites", true);
    await assert.rejects(protection.beforePack({ ...context, arch: 3 }), /release_target_invalid/);
    check("unsupported architectures cannot silently produce a release", true);
    const cfg = path.join(root, "public-release.json"); fs.writeFileSync(cfg, JSON.stringify(config)); process.env.FATFISH_RELEASE_CONFIG = cfg;
    await assert.rejects(protection.beforePack({ ...context, packager: { ...context.packager, info: { framework: { version: "99.0.0" } } } }), /release_runtime_version_changed/);
    check("an Electron version override cannot silently bypass the frozen release runtime", true);
    const before = protection.sourceSnapshot();
    await protection.beforePack(context);
    // A change to the file after preflight must not change this build's trusted public configuration.
    fs.writeFileSync(cfg, JSON.stringify({ ...config, publicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64") }));
    fs.mkdirSync(resources, { recursive: true });
    const coreSrc = path.join(repo, "app/core");
    fs.cpSync(coreSrc, core, { recursive: true, filter: (p) => !/^(?:dev|node_modules)(?:[\\/]|$)/.test(path.relative(coreSrc, p)) });
    fs.cpSync(path.join(coreSrc, "node_modules/ws"), path.join(core, "node_modules/ws"), { recursive: true });
    const uiSrc = path.join(repo, "app/electron-ui"), uiInput = path.join(root, "ui-input");
    for (const p of JSON.parse(fs.readFileSync(path.join(uiSrc, "package.json"))).build.files) {
      const name = p.replace(/\/\*\*\/\*$/, ""); assert.ok(!name.includes("*"));
      fs.mkdirSync(path.dirname(path.join(uiInput, name)), { recursive: true }); fs.cpSync(path.join(uiSrc, name), path.join(uiInput, name), { recursive: true });
    }
    const nested = path.join(uiInput, "node_modules/fatfish-nested-fixture/lib"); fs.mkdirSync(nested, { recursive: true }); fs.writeFileSync(path.join(nested, "entry.js"), "module.exports=42;\n");
    await asar.createPackage(uiInput, path.join(resources, "app.asar"));
    // A non-runnable minimal PE resource fixture, not a copied or packaged application executable.
    const resedit = require("resedit"), pe = resedit.NtExecutable.createEmpty(false, true), peResources = resedit.NtExecutableResource.from(pe);
    peResources.entries.push({ type: "INTEGRITY", id: "ELECTRONASAR", bin: Buffer.from('[{"value":"OLD_ARCHIVE_HASH"}]'), lang: 1033, codepage: 1200 });
    peResources.outputResource(pe); fs.writeFileSync(path.join(appOutDir, "FatFish-Fixture.exe"), Buffer.from(pe.generate()));
    const originalGate = fs.readFileSync(path.join(core, "license-gate.cjs")); fs.appendFileSync(path.join(core, "license-gate.cjs"), "\n// mismatched\n");
    await assert.rejects(protection.protect(resources, config, before), /release_source_mismatch/);
    check("a copied resource/source mismatch fails without overwriting the other copied files", fs.readFileSync(path.join(core, "license-trust.cjs"), "utf8") === before.get("core/license-trust.cjs"));
    fs.writeFileSync(path.join(core, "license-gate.cjs"), originalGate);
    manifest = await protection.afterPack(context);
    check("actual build hooks transform eight modules, including both independent gates and entry paths", manifest.modules.length === 8 && manifest.modules.every((m) => m.sourceSha256 !== m.protectedSha256) && protection.inspect(resources, manifest));
    check("post-transform PE resource is replaced with the new ASAR header hash, without disabling integrity", protection.inspectExecutable(appOutDir, manifest));
    const trust = require(path.join(core, "license-trust.cjs"));
    check("only the preflight public anchor and fixed HTTPS URL were injected", trust.publicKey === config.publicKey && trust.activationURL === config.activationURL && Object.keys(trust).length === 2);
    check("working sources, including deliberately null production trust, remain byte-identical", [...before].every(([p, s]) => protection.sourceSnapshot().get(p) === s));
    check("no source maps, clear verification algorithm or fixture/private signing key is shipped", protection.inspect(resources, manifest) && !JSON.stringify(manifest).includes("privateKey"));
    const gateFile = path.join(core, "license-gate.cjs"), protectedGate = fs.readFileSync(gateFile);
    fs.appendFileSync(gateFile, "\n// changed\n"); assert.throws(() => protection.inspect(resources, manifest), /release_module_changed/); fs.writeFileSync(gateFile, protectedGate);
    check("artifact inspection rejects a changed protected module", true);
    fs.writeFileSync(path.join(core, "license-backup.bak"), originalGate); assert.throws(() => protection.inspect(resources, manifest), /release_unwanted_file/); fs.unlinkSync(path.join(core, "license-backup.bak"));
    check("artifact inspection rejects an accidental plaintext backup", true);
    const packed = fs.readFileSync(path.join(resources, "app.asar")); fs.appendFileSync(path.join(resources, "app.asar"), "changed"); assert.throws(() => protection.inspect(resources, manifest), /release_archive_changed/); fs.writeFileSync(path.join(resources, "app.asar"), packed); asar.uncacheAll();
    check("artifact inspection also covers the UI archive bytes", true);
    const peFile = path.join(appOutDir, "FatFish-Fixture.exe"), peBytes = fs.readFileSync(peFile); fs.appendFileSync(peFile, "changed"); assert.throws(() => protection.inspectExecutable(appOutDir, manifest), /release_integrity_invalid/); fs.writeFileSync(peFile, peBytes);
    check("post-transform PE bytes and embedded archive metadata are both checked", true);
    fs.appendFileSync(peFile, "SIMULATED_SIGNING_OVERLAY"); manifest = await protection.afterSign(context);
    check("post-sign hook rechecks integrity and records changed PE bytes without rewriting a signature", manifest.executable.finalizedAfterSign && protection.inspectExecutable(appOutDir, manifest));
    fs.writeFileSync(cfg, JSON.stringify(config));
    execFileSync(process.execPath, [path.join(__dirname, "verify-artifact.cjs"), "--app-dir", appOutDir, "--config", cfg], { windowsHide: true, stdio: "pipe" });
    check("the standalone artifact verifier accepts matching protected resources and public configuration", true);
    fs.writeFileSync(cfg, JSON.stringify({ ...config, publicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64") }));
    assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, "verify-artifact.cjs"), "--app-dir", appOutDir, "--config", cfg], { windowsHide: true, stdio: "pipe" }));
    fs.writeFileSync(cfg, JSON.stringify(config));
    check("the standalone verifier rejects a different operator public anchor", true);
    const electron = process.env.E2E_EXEC_PATH || path.join(repo, "app/electron-ui/node_modules/electron/dist/electron.exe");
    const probe = `const r=require('node:module').createRequire(${JSON.stringify(path.join(resources, "app.asar/main.js"))});const g=r('../core/license-gate.cjs');const s=r('./service-manager.js');process.stdout.write(JSON.stringify({v:process.versions.electron,g:typeof g.LicenseGate==='function',s:typeof s.ServiceManager==='function',nested:r('fatfish-nested-fixture/lib/entry.js')===42}));`;
    const imported = JSON.parse(execFileSync(electron, ["-e", probe], { windowsHide: true, encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] }));
    check("Electron-as-Node imports protected modules through actual ASAR and sibling Core paths without UI", imported.v === "33.4.11" && imported.g && imported.s);
    check("multi-level ASAR dependency paths are inspected and still executable on Windows", imported.nested);
    const ui = path.join(resources, "app"); asar.extractAll(path.join(resources, "app.asar"), ui);
    // Only dependency lookup for a plain VM shell; these dev dependencies are not added to the archive.
    process.env.NODE_PATH = path.join(repo, "app/electron-ui/node_modules") + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : "");
    require("node:module").Module._initPaths();
    const { ServiceManager } = require(path.join(ui, "service-manager.js")), sm = new ServiceManager({ appDataRoot: home, isPackaged: true, resourcesPath: resources, electronExecPath: process.execPath });
    check("protected service manager resolves the production resources/core entry without changing imports", sm.resolvePaths().coreJs === path.join(core, "server.mjs"));
    fs.mkdirSync(home); const fingerprint = require(path.join(core, "device-fingerprint.cjs")).fingerprint();
    const { LicenseGate, verifyBytes } = require(path.join(core, "license-gate.cjs")), gate = new LicenseGate(home);
    const issue = (overrides = {}) => { const bytes = Buffer.from(JSON.stringify({ version: 1, product: "fatfish", code_hash: "a".repeat(64), fingerprint, issued_at: "2026-10-26T00:00:00.000Z", edition: "v1", ...overrides })); return { payload: bytes.toString("base64url"), signature: sign(null, bytes, keys.privateKey).toString("base64url") }; };
    check("protected gate is still closed when a license is absent", gate.inspect().error === "activation_required");
    let main = await loadMain(ui);
    check("protected Main independently refuses startup and model commands with no license", main.starts() === 0 && (await main.call("model-test", {})).error === "activation_required");
    const publicNames = new Set(["get-license", "activate-license", "get-about", "get-status", "window-minimize", "window-maximize-toggle", "window-close"]);
    for (const [name] of main.handlers) if (!publicNames.has(name)) assert.equal((await main.call(name, { text: "forbidden" })).error, "activation_required", name);
    check("every protected Main channel retains the unlicensed boundary after obfuscation", true);
    gate.install(issue()); const valid = fs.readFileSync(gate.file, "utf8");
    check("protected signature implementation accepts a permanent valid same-device license", gate.inspect().valid && verifyBytes(valid, fingerprint).valid);
    check("protected implementation rejects modified signature bytes and a signed wrong device", !verifyBytes(valid.replace(/.$/m, "!"), fingerprint).valid && !verifyBytes(JSON.stringify(issue({ fingerprint: "e".repeat(64) })) + "\n", fingerprint).valid);
    const bytes = Buffer.from(valid); for (let i = 0; i < bytes.length; i++) { const changed = Buffer.from(bytes); changed[i] ^= 1; assert.equal(verifyBytes(changed.toString("utf8"), fingerprint).valid, false); }
    check("every single-byte modification is rejected by the protected signature implementation", true);
    const oldFetch = global.fetch, code = "FF" + "A".repeat(32); let request;
    try {
      global.fetch = async (url, opts) => { request = { url, opts }; return new Response(JSON.stringify({ ok: true, license: issue({ code_hash: protection.hash(code) }) }), { headers: { "content-type": "application/json" } }); };
      check("protected activation path uses only its injected URL and still verifies/stores the response", (await gate.activate(code)).valid && request.url === config.activationURL && request.opts.redirect === "error" && Object.keys(JSON.parse(request.opts.body)).sort().join("|") === "code|fingerprint");
    } finally { global.fetch = oldFetch; gate.install(issue()); }
    main = await loadMain(ui);
    check("protected Main still waits for explicit basic consent after successful activation", main.starts() === 0 && (await main.call("model-test", {})).error === "risk_confirmation_required");
    fs.mkdirSync(path.join(home, "runtime")); fs.writeFileSync(path.join(home, "runtime/risk_ok"), "1"); main = await loadMain(ui);
    check("protected Main can start services after independently checking license and consent", main.starts() === 1 && (await main.call("get-license")).valid);
    fs.unlinkSync(gate.file); let run = await start();
    await wait(() => child.exitCode !== null, "unlicensed_exit");
    check("actual protected Core independently refuses forged parent/env assertions before SDK startup", run.first.error === "activation_required" && child.exitCode === 78 && !run.messages.some((m) => m.type === "engine" || m.type === "ready")); await stop();
    gate.install(issue()); fs.mkdirSync(path.join(home, "secrets")); fs.writeFileSync(path.join(home, "secrets/deepseek_api_key"), "sk-protection-fixture-only"); fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ channels: { qq: { enabled: false } } }));
    const { startModelProxy } = await import(pathToFileURL(path.join(repo, "app/core/dev/model-proxy.mjs")));
    proxy = await startModelProxy({ reply: () => "仅用于回环的受保护回复。" }); process.env.FATFISH_DEV_DEEPSEEK_BASE_URL = proxy.url;
    run = await start(); check("actual protected Core accepts its own independent valid signature", run.first.type === "ready");
    child.send({ type: "chat_send", id: "protected-chat", text: "PROTECTED_CHAT_SENTINEL" });
    const reply = await wait(() => run.messages.find((m) => m.type === "chat_result" && m.id === "protected-chat"), "reply");
    check("protected entry, engine and real locked SDK complete a local conversation", reply.ok && proxy.requests.length === 1);
    const tools = require(path.join(core, "tool-contract.cjs"));
    check("protected local runtime retains its exact 21-tool contract and no private-upload fields", tools.localToolsMatch(proxy.requests[0]) && !JSON.stringify(proxy.requests[0]).includes("dsh_session_log") && !JSON.stringify(proxy.requests[0]).includes("dsh_plugin_packages"));
    fs.unlinkSync(gate.file); await wait(() => child.exitCode !== null, "revoked_exit");
    check("removing the license still stops the running protected Core and SDK", child.exitCode === 0); await stop();
    process.env.FATFISH_APPDATA = home;
    process.env.FATFISH_DSH_EXE = path.join(repo, "vendor/dsh/deepseek-harness-sdk-runtime-win-x64.exe");
    const { ModelService } = await import(pathToFileURL(path.join(core, "model-service.mjs"))), test = new ModelService({ root: home, instances: {} });
    assert.throws(() => test.test({ provider: "deepseek-official", model: "deepseek-flash", key: "sk-never-send" }), /activation_required/); await test.stop();
    check("protected standalone model test retains its local license gate", proxy.requests.length === 1);
    gate.install(issue());
    const activeTest = new ModelService({ root: home, instances: {} }), connected = await activeTest.test({ provider: "deepseek-official", model: "deepseek-flash", key: "sk-protection-fixture-only" }); await activeTest.stop();
    check("protected standalone test also succeeds through the real SDK with an actual empty tool list", connected.connected && proxy.requests.length === 2 && !proxy.requests.at(-1).tools?.length);
    fs.unlinkSync(gate.file);
    const { EngineHost } = await import(pathToFileURL(path.join(core, "engine-host.mjs"))), engine = new EngineHost({ name: "external", profile: "fatfish-external", dshHome: path.join(home, "dsh/external"), workspace: path.join(home, "workspace/external") });
    check("protected direct engine startup cannot bypass license enforcement", !await engine.start() && !engine.client && engine.state === "activation_required"); await engine.dispose();
    check("runtime metadata omits fixture credential, prompt, license and fingerprint", [valid.trim(), fingerprint, "sk-protection-fixture-only", "PROTECTED_CHAT_SENTINEL"].every((s) => !logs.join("").includes(s)));
    console.log(`${results.length}/${results.length} protection checks passed (resource fixture, real Core/SDK, no windows/installers/paid calls)`);
  } finally {
    await stop(); await proxy?.close();
    if (oldConfig === undefined) delete process.env.FATFISH_RELEASE_CONFIG; else process.env.FATFISH_RELEASE_CONFIG = oldConfig;
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "protection-report.json"), JSON.stringify({ results, manifest, nativeUI: false, realQQ: false, paidCalls: 0, installerBuilt: false, resourceFixture: true }, null, 2)); }
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "fatfish-protection-check-")) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
