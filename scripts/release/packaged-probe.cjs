"use strict";
// Headless test harness only. Must be launched with ELECTRON_RUN_AS_NODE=1 after a fuse preflight.
const fs = require("node:fs"), path = require("node:path"), { createRequire } = require("node:module");
if (process.env.ELECTRON_RUN_AS_NODE !== "1" || process.versions.electron !== "33.4.11") process.exit(90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, name) { const end = Date.now() + 35000; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); } throw new Error("packaged_probe_timeout:" + name); }
let services;
process.once("message", async (cfg) => {
  try {
    const client = createRequire(path.join(cfg.resources, "app.asar/main.js"));
    const { LicenseGate } = client("../core/license-gate.cjs"), { ServiceManager } = client("./service-manager.js");
    const gate = new LicenseGate(cfg.home).inspect();
    const display = client("./activation-display.js");
    const dependencies = typeof client("qrcode").toDataURL === "function" && typeof client("./renderer/persona-actions.js").create === "function" && typeof client("./data-clear.js").clear === "function" && typeof display.read === "function";
    services = new ServiceManager({ appDataRoot: cfg.home, isPackaged: true, resourcesPath: cfg.resources, electronExecPath: process.execPath });
    let backendAttempts = 0, tcpAttempts = 0;
    // Safety fences fail the test before any accidental GUI/channel connection; zero attempts is required.
    services.spawnBackend = () => { backendAttempts++; throw new Error("unexpected_backend_start"); };
    services.probeTcp = async () => { tcpAttempts++; throw new Error("unexpected_channel_probe"); };
    const messages = []; services.on("core-message", (m) => messages.push(m));
    const state = await services.startAll(), child = services._children.core;
    if (!child) throw new Error("packaged_core_not_forked");
    const first = await wait(() => {
      const value = messages.find((m) => ["ready", "license"].includes(m.type));
      if (value) return value;
      if (child.exitCode !== null && !child.connected) throw new Error("packaged_core_exited_before_handshake:" + child.exitCode);
      return null;
    }, "core_init");
    if (cfg.mode !== "valid") {
      await wait(() => child.exitCode !== null || child.signalCode !== null, "refused_exit");
      process.send({ type: "result", mode: cfg.mode, electron: process.versions.electron, parentVerified: gate.valid, parentError: gate.error, dependencies, coreFirst: first.type, coreError: first.error, coreExit: child.exitCode,
        engineEvents: messages.filter((m) => m.type === "engine").length, dshDirectory: fs.existsSync(path.join(cfg.home, "dsh")), backendAttempts, tcpAttempts });
    } else {
      if (!gate.valid || first.type !== "ready") throw new Error("packaged_valid_license_rejected");
      const displayTailValid = display.save(cfg.home, "FF" + "A".repeat(32)) && display.read(cfg.home, gate) === "AAAA";
      services.sendCore({ type: "chat_send", id: "packaged-local", text: "PACKAGED_LOCAL_SENTINEL" });
      const result = await wait(() => messages.find((m) => m.type === "chat_result" && m.id === "packaged-local"), "local_chat");
      process.send({ type: "chat", ok: result.ok === true });
      await services.stopForDataReset();
      process.send({ type: "result", mode: cfg.mode, electron: process.versions.electron, parentVerified: gate.valid, dependencies, coreFirst: first.type, phase: state.phase, chatOK: result.ok === true, coreExit: child.exitCode,
        backendAttempts, tcpAttempts, displayTailValid, sdkOverrideUsed: !!process.env.FATFISH_DSH_EXE, sourceDependencyOverrideUsed: !!process.env.NODE_PATH });
    }
    await services.stopAll(); process.disconnect(); process.exit(0);
  } catch (e) {
    await services?.stopAll().catch(() => {}); process.send?.({ type: "failed", code: /^packaged_|^unexpected_/.test(e.message) ? e.message : "packaged_probe_failed" }); process.disconnect(); process.exit(1);
  }
});
process.send({ type: "ready" });
