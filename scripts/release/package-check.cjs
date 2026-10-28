"use strict";
// User-authorized temporary unpacked package, never an installer/release and never a GUI launch.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { fork, execFileSync } = require("node:child_process"), { createHash, generateKeyPairSync, sign } = require("node:crypto"), { pathToFileURL } = require("node:url");
const { safeEnv, run, inside, hash } = require("./package-fixture.cjs"), protection = require("./protection.cjs");
const repo = path.resolve(__dirname, "../.."), args = process.argv.slice(2), results = []; let probe, proxy, state, evidence, manifest;
function check(name, ok) { results.push({ name, pass: !!ok }); if (!ok) throw new Error("package_assertion_failed:" + name); console.log("PASS " + name); }
function nodeFuse(exe) {
  // Read-only V1 wire check from Electron's public fuse format; no fuse or binary is modified.
  const bytes = fs.readFileSync(exe), sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"), index = bytes.indexOf(sentinel), at = index + sentinel.length;
  if (index < 0 || bytes.indexOf(sentinel, index + 1) !== -1 || bytes[at] !== 1 || bytes[at + 1] < 1 || bytes[at + 2] !== 0x31) throw new Error("package_node_mode_not_guaranteed");
  return { version: bytes[at], count: bytes[at + 1], runAsNode: true };
}
async function launch(exe, resources, home, mode, baseURL) {
  const messages = [];
  probe = fork(path.join(__dirname, "packaged-probe.cjs"), [], { execPath: exe, windowsHide: true, env: safeEnv({ ELECTRON_RUN_AS_NODE: "1", FATFISH_APPDATA: home, FATFISH_LICENSE_VALID: "1", ...(baseURL ? { FATFISH_DEV_DEEPSEEK_BASE_URL: baseURL } : {}) }), stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const fd = fs.openSync(path.join(evidence, "probe-" + mode + ".log"), "a"); probe.stdout.on("data", (b) => fs.writeSync(fd, b)); probe.stderr.on("data", (b) => fs.writeSync(fd, b));
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (probe?.exitCode === null) probe.kill(); reject(new Error("packaged_probe_host_timeout")); }, 90000);
    probe.on("message", (m) => { messages.push(m); if (m.type === "ready") probe.send({ resources, home, mode }); });
    probe.once("error", () => { clearTimeout(timer); reject(new Error("packaged_probe_spawn_failed")); });
    probe.once("exit", (code) => { clearTimeout(timer); const result = messages.find((m) => m.type === "result"); code === 0 && result ? resolve(result) : reject(new Error("packaged_probe_exit_failed:" + (messages.find((m) => m.type === "failed")?.code || code))); });
  });
  try { return await done; } finally { fs.closeSync(fd); probe = null; }
}
(async () => {
  if (args.length !== 3 || args[0] !== "--allow-local-package" || args[1] !== "--evidence" || !path.isAbsolute(args[2])) throw new Error("package_authorization_required");
  evidence = path.resolve(args[2]); state = JSON.parse(fs.readFileSync(path.join(evidence, "package-preparation.json")));
  if (state.version !== 1 || !state.prepared || !path.resolve(state.root).startsWith(path.resolve(os.tmpdir()) + path.sep + "fatfish-package-") || state.source !== path.join(state.root, "source")) throw new Error("package_fixture_invalid");
  for (const m of state.copies) if (hash(inside(state.root, path.join(state.source, m.path))) !== m.sha256 || hash(path.join(repo, m.path)) !== m.sha256) throw new Error("package_source_changed:" + m.path);
  check("isolated application sources exactly match current worktree without copying user data", true);
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), config = { version: 1, publicKey, activationURL: "https://activation.fatfish.test/activate" };
  const publicFile = inside(state.root, path.join(state.root, "public-release.json")); fs.writeFileSync(publicFile, JSON.stringify(config));
  const cli = path.join(state.ui, "node_modules/electron-builder/cli.js");
  console.log("package_build: real electron-builder --dir, local Electron distribution, signing discovery/publishing disabled");
  await run(process.execPath, [path.join(state.source, "scripts/ensure-crlf.js")], { cwd: state.ui, log: path.join(evidence, "build.log") });
  await run(process.execPath, [cli, "--dir", "--win", "--x64", "--publish", "never", "--config.electronDist=" + state.electronDist, "--config.npmRebuild=false"], { cwd: state.ui, env: safeEnv({ FATFISH_RELEASE_CONFIG: publicFile }), log: path.join(evidence, "build.log") });
  const appDir = inside(state.root, path.join(state.ui, "dist/win-unpacked")), resources = path.join(appDir, "resources");
  manifest = JSON.parse(fs.readFileSync(path.join(resources, "protection-manifest.json")));
  protection.inspect(resources, manifest); protection.inspectExecutable(appDir, manifest);
  const exe = inside(appDir, path.join(appDir, manifest.executable.file));
  check("real builder default output contains protected modules and matching ASAR/PE integrity", manifest.modules.length === 8 && manifest.executable.finalizedAfterSign === true);
  check("only an unpacked test app exists, not an installer", !fs.readdirSync(path.join(state.ui, "dist")).some((name) => /^FatFish-Setup-.*\.exe$/i.test(name)));
  check("test signing anchor is public-only and original production trust is still null", manifest.publicKeySha256 === protection.hash(Buffer.from(publicKey, "base64")) && require(path.join(repo, "app/core/license-trust.cjs")).publicKey === null);
  const fuse = nodeFuse(exe); check("read-only fuse check guarantees the test executable honors Node-only mode before any launch", fuse.runAsNode);
  for (const p of ["vendor/dsh/deepseek-harness-sdk-runtime-win-x64.exe", "vendor/dsh/deepseek-harness-sdk-runtime-win-x64-rg.exe", "vendor/node/node.exe", "vendor/napcat/NapCatWinBootMain.exe", "core/node_modules/ws/package.json"]) check("packaged resource exists: " + p, fs.statSync(path.join(resources, p)).isFile());
  check("packaged runtime bytes remain the locked source bytes", hash(path.join(resources, "vendor/dsh/deepseek-harness-sdk-runtime-win-x64.exe")) === state.vendors.dshExe && JSON.parse(fs.readFileSync(path.join(resources, "core/node_modules/ws/package.json"))).version === "8.22.0");
  execFileSync(process.execPath, [path.join(__dirname, "verify-artifact.cjs"), "--app-dir", appDir, "--config", publicFile], { windowsHide: true, stdio: "pipe" });
  check("standalone artifact verifier accepts the actual builder output", true);
  const { startModelProxy } = await import(pathToFileURL(path.join(repo, "app/core/dev/model-proxy.mjs")));
  proxy = await startModelProxy({ reply: () => "实际测试包的本机回复。" });
  const fingerprint = require(path.join(repo, "app/core/device-fingerprint.cjs")).fingerprint();
  const bytes = Buffer.from(JSON.stringify({ version: 1, product: "fatfish", code_hash: createHash("sha256").update("FF" + "A".repeat(32)).digest("hex"), fingerprint, issued_at: new Date().toISOString(), edition: "v1" }));
  const license = { payload: bytes.toString("base64url"), signature: sign(null, bytes, keys.privateKey).toString("base64url") }, serialized = JSON.stringify(license) + "\n";
  const runtimeRoot = fs.mkdtempSync(inside(state.root, path.join(state.root, "runtime-run-")));
  for (const mode of ["missing", "tampered", "valid"]) {
    const home = inside(state.root, path.join(runtimeRoot, "appdata-" + mode)); fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ channels: { qq: { enabled: false } } }));
    fs.mkdirSync(path.join(home, "secrets")); fs.writeFileSync(path.join(home, "secrets/deepseek_api_key"), "sk-packaged-fixture-only");
    if (mode !== "missing") fs.writeFileSync(path.join(home, "license.json"), mode === "valid" ? serialized : serialized.replace(/.$/m, "!"));
    const before = proxy.requests.length, result = await launch(exe, resources, home, mode, proxy.url);
    check("actual packaged ASAR/dependencies and sibling Core resolve without source overrides: " + mode, result.dependencies && result.electron === "33.4.11" && result.backendAttempts === 0 && result.tcpAttempts === 0);
    if (mode !== "valid") check("actual packaged parent/Core independently reject " + mode + " license before any engine/model call", !result.parentVerified && result.coreFirst === "license" && result.coreExit === 78 && result.engineEvents === 0 && !result.dshDirectory && proxy.requests.length === before);
    else {
      const contract = require(path.join(repo, "app/core/tool-contract.cjs"));
      check("actual packaged Core and SDK finish one local fixture conversation without path overrides", result.parentVerified && result.coreFirst === "ready" && result.chatOK && result.coreExit === 0 && !result.sdkOverrideUsed && !result.sourceDependencyOverrideUsed && proxy.requests.length === before + 1);
      check("actual packaged display module persists only the license-bound code tail", result.displayTailValid);
      const body = proxy.requests.at(-1);
      check("actual packaged local request retains 21 tools and no private-upload fields", contract.localToolsMatch(body) && !JSON.stringify(body).includes("dsh_session_log") && !JSON.stringify(body).includes("dsh_plugin_packages"));
    }
    const logs = ["core.log", "core.err.log"].map((name) => { try { return fs.readFileSync(path.join(home, "logs", name), "utf8"); } catch { return ""; } }).join("\n");
    check("actual package logs omit key, prompt, license and fingerprint: " + mode, ["sk-packaged-fixture-only", "PACKAGED_LOCAL_SENTINEL", serialized.trim(), fingerprint].every((s) => !logs.includes(s)));
  }
  fs.writeFileSync(path.join(appDir, "LOCAL-TEST-ONLY.txt"), "Local unpacked test only. No formal signing key. Do not distribute or launch the GUI without separate approval.\n");
  console.log(`${results.length}/${results.length} actual package checks passed; app preserved at ${appDir}`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(async () => {
  if (probe?.exitCode === null) probe.kill(); await proxy?.close();
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "package-report.json"), JSON.stringify({ results, appDir: state ? path.join(state.ui, "dist/win-unpacked") : null, manifest, nativeUI: false, installed: false, published: false, realQQ: false, actualUserData: false, paidCalls: 0, formalKeys: false, realBuilder: true }, null, 2)); }
});
