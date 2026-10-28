/** Human-assisted acceptance entry. Real UI/services, isolated app data, metadata only. */
"use strict";
const fs = require("node:fs");
const { join, resolve, sep } = require("node:path");
const { tmpdir } = require("node:os");
const { app } = require("electron");
const home = resolve(process.env.FATFISH_LIVE_TEST_HOME || "");
if (!home.startsWith(resolve(tmpdir()) + sep + "fatfish-m3e-live-")) throw new Error("isolated live home required");
if (!fs.existsSync(join(home, "config.json"))) throw new Error("prepare the live home first");
process.env.FATFISH_APPDATA = home;
delete process.env.FATFISH_SMOKE;
delete process.env.FATFISH_DEV_DEEPSEEK_BASE_URL;
app.setPath("userData", join(home, "window-profile"));
const moduleRef = require("../service-manager"), Original = moduleRef.ServiceManager;
const chatStore = require("../chat-store");
let services;
moduleRef.ServiceManager = class extends Original {
  constructor(opts) {
    super(opts); services = this;
  }
};
require("../main");
const timer = setInterval(() => {
  if (!services) return;
  const core = services.getCore(), state = services.getState();
  let config;
  try { config = JSON.parse(fs.readFileSync(join(home, "config.json"), "utf8")); }
  catch { return; }
  const snapshot = { at: new Date().toISOString(), phase: state.phase, error_code: state.error_code,
    desktopPid: process.pid, qq_enabled: services.readQqEnabled(),
    core: state.core, backend: state.backend, engines: core.engines, channels: core.channels,
    paused: core.paused, stats: core.stats, local_stats: chatStore.stats(home), last_turn_error: core.last_turn_error,
    owners: (config.owners || []).map((o) => ({ channel: o.channel, accountMask: "***" + String(o.account).slice(-4) })) };
  fs.writeFileSync(join(home, "runtime/live-status.json"), JSON.stringify(snapshot));
}, 1500);
timer.unref();
app.on("before-quit", () => clearInterval(timer));
