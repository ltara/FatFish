/**
 * Box / CI smoke: load main.js under ELECTRON_RUN_AS_NODE-like checks,
 * or spawn electron with FATFISH_SMOKE=1 if electron binary exists.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const mainJs = path.join(root, "main.js");
const preload = path.join(root, "preload.js");
const html = path.join(root, "renderer", "index.html");

for (const p of [mainJs, preload, html]) {
  if (!fs.existsSync(p)) {
    console.error("missing", p);
    process.exit(1);
  }
}

// Syntax check main + preload via node --check
const serviceMgr = path.join(root, "service-manager.js");
if (!fs.existsSync(serviceMgr)) {
  console.error("missing", serviceMgr);
  process.exit(1);
}

const coreDir = path.join(root, "..", "core");
const coreFiles = ["server.mjs", "engine-host.mjs", "router.mjs", "dsh-client.mjs", "paths.mjs", "channels/qq.mjs"]
  .map((f) => path.join(coreDir, f));

for (const p of [mainJs, preload, serviceMgr, path.join(root, "renderer", "renderer.js"), ...coreFiles]) {
  const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error("syntax fail", p, r.stderr || r.stdout);
    process.exit(1);
  }
  console.log("syntax_ok", path.relative(root, p));
}

const electronBin = path.join(root, "node_modules", "electron", "cli.js");
if (!fs.existsSync(electronBin)) {
  console.log("electron_not_installed: run npm install; syntax checks passed");
  process.exit(0);
}

const env = {
  ...process.env,
  FATFISH_SMOKE: "1",
  FATFISH_APPDATA: process.env.FATFISH_APPDATA || path.join(require("node:os").tmpdir(), "fatfish-smoke"),
};
// Prefer xvfb when no DISPLAY
let cmd = process.execPath;
let args = [electronBin, root];
let useXvfb = false;
if (!process.env.DISPLAY) {
  const which = spawnSync("which", ["xvfb-run"], { encoding: "utf8" });
  if (which.status === 0) {
    useXvfb = true;
    cmd = "xvfb-run";
    args = ["-a", process.execPath, electronBin, root];
  }
}

console.log("smoke_spawn", useXvfb ? "xvfb-run electron" : "electron", "FATFISH_SMOKE=1");
const r = spawnSync(cmd, args, {
  cwd: root,
  env,
  encoding: "utf8",
  timeout: 45000,
});
const out = (r.stdout || "") + (r.stderr || "");
console.log(out.slice(0, 4000));
if (out.includes("smoke: window_ready") || r.status === 0) {
  console.log("smoke_ok");
  process.exit(0);
}
// Headless without xvfb may fail — still report syntax ok
if (!process.env.DISPLAY && !useXvfb) {
  console.log("smoke_skip_no_display: syntax ok; run npm start on Windows");
  process.exit(0);
}
console.error("smoke_failed status=", r.status);
process.exit(r.status || 1);
