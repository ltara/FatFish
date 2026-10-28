"use strict";
// User-invoked only: real development app/model routing, a local DEVELOPMENT license issuer only.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { spawn } = require("node:child_process");
const { createPublicKey, verify } = require("node:crypto"), dev = require("./development-activation.cjs");
const { startDevelopmentUiSync } = require("./development-ui-sync.cjs");
const repo = path.resolve(__dirname, "../../.."), args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--data-root" || !path.isAbsolute(args[1]))) throw Error("usage: npm run dev -- [--data-root ABSOLUTE_PATH]");
const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"), "FatFishDevelopment");
const serverRoot = path.join(base, "activation-server"), runsRoot = path.join(base, "client-runs"), dataRoot = path.resolve(args[1] || path.join(base, "data"));
function inside(root, file) { const r = path.relative(path.resolve(root), path.resolve(file)); return r === "" || r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r); }
if (process.platform !== "win32" || inside(repo, base) || inside(serverRoot, dataRoot) || inside(runsRoot, dataRoot) || dataRoot === path.parse(dataRoot).root) throw Error("development_paths_invalid");
if (args.length && !fs.existsSync(path.join(dataRoot, "config.json"))) throw Error("existing_development_config_required");
for (const dir of [base, serverRoot, runsRoot, dataRoot]) { fs.mkdirSync(dir, { recursive: true }); if (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory()) throw Error("development_paths_invalid"); }
const actualRepo = fs.realpathSync.native(repo), actualBase = fs.realpathSync.native(base), actualData = fs.realpathSync.native(dataRoot);
if (inside(actualRepo, actualBase) || inside(fs.realpathSync.native(serverRoot), actualData) || inside(fs.realpathSync.native(runsRoot), actualData)) throw Error("development_paths_invalid");
let activation, child, runRoot, uiSync, uiSyncStarting, stopping = false;
const exit = () => !child?.pid || child.exitCode !== null || child.signalCode !== null;
function cleanCodeCopy() {
  if (!runRoot || path.dirname(runRoot) !== runsRoot || !path.basename(runRoot).startsWith("client-") || fs.lstatSync(runRoot).isSymbolicLink()) return;
  const actualBase = fs.realpathSync.native(runsRoot), actualRun = fs.realpathSync.native(runRoot);
  if (path.dirname(actualRun).toLowerCase() !== actualBase.toLowerCase() || inside(actualRun, actualData)) throw Error("development_cleanup_path_invalid");
  fs.rmSync(actualRun, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); // Only this verified code copy, never server keys/app data.
  runRoot = null;
}
async function finish() {
  if (stopping) return; stopping = true;
  await (uiSync || await uiSyncStarting?.catch(() => null))?.close();
  if (!exit()) { fs.writeFileSync(path.join(runRoot, "stop-request.json"), JSON.stringify({ type: "shutdown" })); await new Promise(resolve => child.once("exit", resolve)); }
  await activation?.close();
  try { cleanCodeCopy(); } catch { console.warn("开发代码副本未能清理；请稍后只清理 client-runs 中对应副本，不要删除数据或激活服务端密钥。"); }
}
(async () => {
  activation = await dev.startDevelopmentActivation(serverRoot);
  if (stopping) { await activation.close(); return; }
  const licenseFile = path.join(dataRoot, "license.json");
  if (fs.existsSync(licenseFile)) {
    const stat = fs.lstatSync(licenseFile); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw Error("existing_license_is_not_development");
    const envelope = JSON.parse(fs.readFileSync(licenseFile, "utf8")), key = createPublicKey({ key: Buffer.from(activation.publicKey, "base64"), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(envelope.payload, "base64url"), key, Buffer.from(envelope.signature, "base64url"))) throw Error("existing_license_is_not_development");
  }
  runRoot = fs.mkdtempSync(path.join(runsRoot, "client-")); const copy = dev.copyDevelopmentClient(repo, runRoot, activation), configFile = path.join(runRoot, "development-config.json");
  console.log("正在编译界面并启用开发热更新…");
  uiSync = await (uiSyncStarting = startDevelopmentUiSync({ sourceUi: path.join(repo, "app/electron-ui"), sourceCore: path.join(repo, "app/core"), copyUi: copy.ui, runRoot, dataRoot, log: message => console.log(message) }));
  if (stopping) { await uiSync.close(); cleanCodeCopy(); return; }
  fs.writeFileSync(configFile, JSON.stringify({ repo, runRoot, dataRoot, ui: copy.ui }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:FATFISH_|DSH_|DEEPSEEK_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(name)));
  env.FATFISH_DEVELOPMENT_CONFIG = configFile; env.FATFISH_DSH_EXE = path.join(repo, "vendor/dsh/deepseek-harness-sdk-runtime-win-x64.exe");
  console.log("开发专用固定激活码：FF 3333 3333 3333 3333 3333 3333 3333 9A7C");
  console.log("只在「肥鱼 · 开发版」中使用。不会自动激活、试聊或测试模型；实际对话仍按模型配置计费。");
  console.log("热更新已启用：样式直接替换；界面代码空闲后刷新；主进程和后台改动请手动重开。");
  child = spawn(require("electron"), [path.join(__dirname, "development-client-host.js")], { cwd: path.join(repo, "app/electron-ui"), env, windowsHide: false, stdio: "inherit" });
  child.once("error", async () => { process.exitCode = 1; await finish(); });
  child.once("exit", async code => { if (code) process.exitCode = code; await finish(); });
})().catch(async () => { console.error("开发启动未完成。请确认依赖已安装、路径非链接，并且没有在覆盖其他许可证；检查现有开发服务密钥，勿自动删除重建。"); process.exitCode = 1; await finish(); });
process.once("SIGINT", () => finish().catch(() => { process.exitCode = 1; }));
process.once("SIGTERM", () => finish().catch(() => { process.exitCode = 1; }));
