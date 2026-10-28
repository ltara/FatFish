"use strict";
// Authorized local test preparation only. Never copied into the client; no signing key or user data.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process"), { createHash } = require("node:crypto");
const repo = path.resolve(__dirname, "../.."), hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function safeEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:DSH_|DEEPSEEK_|FATFISH_|CSC_|WIN_CSC_|GH_TOKEN$|GITHUB_TOKEN$|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$|NPM_TOKEN$|CLOUDFLARE_|CF_API_)/i.test(k)));
  return { ...env, CSC_IDENTITY_AUTO_DISCOVERY: "false", ...extra };
}
function inside(root, file) { const p = path.resolve(file); if (!p.startsWith(path.resolve(root) + path.sep)) throw new Error("package_fixture_path_invalid"); return p; }
function run(exe, args, { cwd, env = safeEnv(), log, timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(log, "a"), child = cp.spawn(exe, args, { cwd, env, windowsHide: true, stdio: ["ignore", fd, fd] }); fs.closeSync(fd);
    let alive = true;
    const timer = setTimeout(() => { if (alive) cp.execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {}); }, timeout);
    child.once("error", () => { alive = false; clearTimeout(timer); reject(new Error("package_fixture_spawn_failed")); });
    child.once("exit", (code) => { alive = false; clearTimeout(timer); code === 0 ? resolve() : reject(new Error("package_fixture_command_failed:" + code)); });
  });
}
async function extract(root, zip, destination, log) {
  inside(root, destination); fs.mkdirSync(destination, { recursive: true });
  const command = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $dest=[IO.Path]::GetFullPath($env:FF_PACKAGE_DEST); $z=[IO.Compression.ZipFile]::OpenRead($env:FF_PACKAGE_ZIP); try { foreach($e in $z.Entries){ $p=[IO.Path]::GetFullPath([IO.Path]::Combine($dest,$e.FullName)); if($p -ne $dest -and -not $p.StartsWith($dest+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'zip_path_invalid'} } } finally {$z.Dispose()}; [IO.Compression.ZipFile]::ExtractToDirectory($env:FF_PACKAGE_ZIP,$dest)";
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { env: safeEnv({ FF_PACKAGE_ZIP: zip, FF_PACKAGE_DEST: destination }), log });
}
async function prepare(evidence) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fatfish-package-")), source = inside(root, path.join(root, "source")), ui = path.join(source, "app/electron-ui");
  fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync(ui, { recursive: true });
  const log = path.join(evidence, "prepare.log"), copies = [];
  const copy = (from, to) => { inside(root, to); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };
  const uiSource = path.join(repo, "app/electron-ui"), config = JSON.parse(fs.readFileSync(path.join(uiSource, "package.json")));
  for (const item of [...config.build.files, "package-lock.json"]) {
    const rel = item.replace(/\/\*\*\/\*$/, ""); if (rel.includes("*") || !path.resolve(uiSource, rel).startsWith(uiSource + path.sep)) throw new Error("package_fixture_ui_manifest_invalid");
    copy(path.join(uiSource, rel), path.join(ui, rel));
  }
  const coreSource = path.join(repo, "app/core"), core = path.join(source, "app/core"); fs.mkdirSync(core, { recursive: true });
  for (const entry of fs.readdirSync(coreSource, { withFileTypes: true })) {
    if (entry.isDirectory() && ["profiles", "channels"].includes(entry.name) || entry.isFile() && /\.(?:mjs|cjs|json|ya?ml)$/.test(entry.name)) copy(path.join(coreSource, entry.name), path.join(core, entry.name));
  }
  copy(path.join(coreSource, "node_modules/ws"), path.join(core, "node_modules/ws"));
  const release = path.join(source, "scripts/release"); fs.mkdirSync(release, { recursive: true });
  for (const entry of fs.readdirSync(__dirname, { withFileTypes: true })) if (entry.isFile() && /\.(?:cjs|json|md)$/.test(entry.name)) copy(path.join(__dirname, entry.name), path.join(release, entry.name));
  copy(path.join(__dirname, "node_modules"), path.join(release, "node_modules"));
  copy(path.join(repo, "scripts/ensure-crlf.js"), path.join(source, "scripts/ensure-crlf.js"));
  // Never copy a development backend's config/cache/logs/login state into the package.
  const pins = [["NapCat.Shell.zip", "6801f93e533846cea05f4f531874a0e84371ab2331c5585b57cd7e3b869cf96b"], ["node-v20.20.2-win-x64.zip", "dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77"]];
  for (const [name, expected] of pins) if (hash(path.join(repo, "vendor", name)) !== expected) throw new Error("package_fixture_vendor_hash_mismatch");
  console.log("package_prepare: extract verified clean backend and portable runtime");
  await extract(root, path.join(repo, "vendor/NapCat.Shell.zip"), path.join(source, "vendor/napcat"), log);
  const nodeExtract = path.join(root, "node-extract"); await extract(root, path.join(repo, "vendor/node-v20.20.2-win-x64.zip"), nodeExtract, log);
  const nodeFrom = inside(root, path.join(nodeExtract, "node-v20.20.2-win-x64")), nodeTo = inside(root, path.join(source, "vendor/node")); fs.renameSync(nodeFrom, nodeTo);
  const dsh = path.join(source, "vendor/dsh"); fs.mkdirSync(dsh, { recursive: true });
  for (const entry of fs.readdirSync(path.join(repo, "vendor/dsh"), { withFileTypes: true })) if (entry.isFile() && (/\.exe$/.test(entry.name) || ["LICENSE", "THIRD_PARTY_NOTICES.md"].includes(entry.name))) copy(path.join(repo, "vendor/dsh", entry.name), path.join(dsh, entry.name));
  console.log("package_prepare: install locked build dependencies in isolated source (scripts disabled/offline)");
  const npmCli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"); if (!fs.existsSync(npmCli)) throw new Error("package_fixture_npm_missing");
  const userConfig = path.join(root, "empty-user.npmrc"), globalConfig = path.join(root, "empty-global.npmrc"); fs.writeFileSync(userConfig, ""); fs.writeFileSync(globalConfig, "");
  const lockBefore = hash(path.join(ui, "package-lock.json"));
  await run(process.execPath, [npmCli, "ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--userconfig", userConfig, "--globalconfig", globalConfig], { cwd: ui, log });
  if (hash(path.join(ui, "package-lock.json")) !== lockBefore) throw new Error("package_fixture_lock_changed");
  function snapshot(dir, prefix) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (["node_modules", "dist", "out"].includes(e.name)) continue; const file = path.join(dir, e.name), rel = prefix + e.name; if (e.isDirectory()) snapshot(file, rel + "/"); else if (e.isFile()) copies.push({ path: rel, sha256: hash(file) }); else throw new Error("package_fixture_source_link"); } }
  snapshot(path.join(source, "app"), "app/");
  const state = { version: 1, prepared: true, root, source, ui, log, electronDist: path.join(repo, "app/electron-ui/node_modules/electron/dist"), copies,
    vendors: { napcatZip: pins[0][1], nodeZip: pins[1][1], dshExe: hash(path.join(dsh, "deepseek-harness-sdk-runtime-win-x64.exe")) }, nativeUI: false, actualUserData: false, formalKeys: false };
  fs.writeFileSync(path.join(root, "fixture-state.json"), JSON.stringify(state, null, 2)); fs.writeFileSync(path.join(evidence, "package-preparation.json"), JSON.stringify(state, null, 2));
  console.log("package_prepare_complete " + root); return state;
}
module.exports = { prepare, safeEnv, run, inside, hash };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== "--allow-local-package" || args[1] !== "--evidence" || !path.isAbsolute(args[2])) { console.error("package_fixture_authorization_required"); process.exitCode = 1; }
  else prepare(args[2]).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
