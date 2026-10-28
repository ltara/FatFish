import licenseFixture from "./license-fixture.cjs";
import { pathToFileURL } from "node:url";
/** Optional channel lifecycle + real local runtime. No real account or paid calls. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { startModelProxy } from "./model-proxy.mjs";
import toolContract from "../tool-contract.cjs";
const require = createRequire(import.meta.url);
const { ServiceManager } = require("../../electron-ui/service-manager.js");
const { qqEnabled } = require("../channel-config.cjs");
const home = mkdtempSync(join(tmpdir(), "fatfish-optional-channel-"));
const licensed = licenseFixture.licensedFixture(home); Object.assign(process.env, licensed.env);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, ms = 30000) => { const until = Date.now() + ms; while (Date.now() < until) { const v = fn(); if (v) return v; await sleep(20); } throw new Error("optional_channel_timeout"); };
let n = 0, services, backend, proxy, socket, probes = 0, spawns = 0, kills = 0;
const check = (name, value) => { assert.ok(value, name); n++; console.log("PASS " + name); };
const ipc = [], sent = [];
try {
  services = new ServiceManager({ appDataRoot: home, electronExecPath: process.env.E2E_EXEC_PATH || process.execPath });
  const realFork = services.forkCore.bind(services); services.forkCore = () => realFork(licensed.entry, licensed.core);
  services.ensureAppData();
  const file = join(home, "config.json"), cfg = JSON.parse(readFileSync(file, "utf8"));
  check("new installation defaults to local-only", !qqEnabled(cfg) && cfg.channels.qq.enabled === false);
  check("legacy configured channel is preserved", qqEnabled({ onebot_url: "ws://127.0.0.1:3001" }));
  check("explicit false overrides old bindings and URL", !qqEnabled({ ...cfg, owners: [{ channel: "qq", account: "10001" }] }));
  const probe = services.probeTcp.bind(services);
  services.probeTcp = (...args) => { probes++; return probe(...args); };
  services.spawnBackend = () => { spawns++; throw new Error("real_backend_forbidden"); };
  services.killTree = async () => { kills++; }; // Core exits through its own IPC; never terminate another process.
  const paths = services.resolvePaths(); services.resolvePaths = () => ({ ...paths, napcatDir: null });
  backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  backend.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (buffer) => {
      const m = JSON.parse(buffer);
      if (m.action === "send_private_msg") sent.push(m.params.message.map((p) => p.data.text).join(""));
      ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: m.echo,
        data: m.action === "get_login_info" ? { user_id: 90000, nickname: "肥鱼" } : { message_id: sent.length } }));
    });
  });
  await once(backend, "listening");
  const port = backend.address().port;
  cfg.onebot_url = `ws://127.0.0.1:${port}`; cfg.onebot_port = port; cfg.login_ui_port = port;
  cfg.owners = [{ channel: "qq", account: "10001", boundAt: "", label: "" }];
  writeFileSync(file, JSON.stringify(cfg));
  writeFileSync(join(home, "secrets/deepseek_api_key"), "sk-optional-fixture-not-a-key");
  proxy = await startModelProxy({ reply: () => "本机和远程相互独立" });
  process.env.FATFISH_DEV_DEEPSEEK_BASE_URL = proxy.url;
  services.on("core-message", (m) => ipc.push(m));
  const state = await services.startAll();
  await wait(() => ipc.some((m) => m.type === "ready"));
  check("no QQ installation is needed for a running Core", state.phase === "running" && state.core && !state.backend);
  check("disabled channel has no probes, launch or connection", probes === 0 && spawns === 0 && !socket && services.getCore().channels.qq === "disabled");
  check("local-only startup prewarms neither model instance", !ipc.some((m) => m.type === "engine" && m.state === "ready"));
  const paired = await services.requestCore("pairing_start");
  check("disabled channel cannot issue an unusable pairing code", !paired.ok && paired.error === "channel_disabled");
  services.sendCore({ type: "chat_send", id: "local-first", sessionId: "local-main", text: "本机独立请求" });
  const local = await wait(() => ipc.find((m) => m.type === "chat_result" && m.id === "local-first"));
  check("local chat works without QQ or any owner binding requirement", local.ok && local.text === "本机和远程相互独立");
  check("local use does not wake the external engine", !ipc.some((m) => m.type === "engine" && m.instance === "external" && m.state === "ready"));
  const enabled = await services.setQqEnabled(true);
  await wait(() => socket && services.getCore().engine === "ready");
  check("explicit enable starts only the configured fixture channel", enabled.ok && services.readQqEnabled() && spawns === 0);
  check("channel setting retains unrelated owner data", JSON.parse(readFileSync(file, "utf8")).owners[0].account === "10001");
  socket.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend", self_id: 90000, user_id: 10001,
    message: [{ type: "text", data: { text: "远程夹具请求" } }] }));
  await wait(() => sent.length === 1);
  check("enabled channel still uses the exact non-host memory whitelist", toolContract.externalToolsMatch(proxy.requests.at(-1)) && sent[0] === "本机和远程相互独立");
  const off = await services.setQqEnabled(false);
  await wait(() => services.getCore().channels.qq === "disabled");
  check("disable stops external but leaves local ready", off.ok && services.getCore().engine === "stopped" && services.getCore().engines.local.state === "ready");
  check("disable never kills an unowned backend", kills === 0 && backend.address() && !services.getState().backend);
  const old = readFileSync(file, "utf8"); writeFileSync(file, "invalid-json");
  const invalid = await services.setQqEnabled(true);
  check("corrupt configuration fails without being overwritten", !invalid.ok && invalid.error === "config_invalid" && readFileSync(file, "utf8") === "invalid-json");
  writeFileSync(file, old);
  const before = ipc.length; services.sendCore({ type: "reload" }); await sleep(150);
  check("reload does not wake a disabled external instance", !ipc.slice(before).some((m) => m.type === "engine" && m.instance === "external" && m.state === "ready"));
  await services.stopAll();
  const probesBeforeRestart = probes, baseline = ipc.length;
  await services.startAll(); await wait(() => ipc.slice(baseline).some((m) => m.type === "ready"));
  check("local-only choice persists across Core restart", !services.readQqEnabled() && probes === probesBeforeRestart);
  services.sendCore({ type: "chat_send", id: "local-restart", sessionId: "local-main", text: "重启后继续" });
  check("local conversation resumes without channel startup", (await wait(() => ipc.find((m) => m.type === "chat_result" && m.id === "local-restart"))).ok && proxy.requests.at(-1).messages.some((m) => JSON.stringify(m).includes("本机独立请求")));
  console.log(`${n}/${n} optional channel checks passed (no paid calls)`);
} finally {
  if (services) await services.stopAll();
  if (backend) await new Promise((r) => { for (const c of backend.clients) c.terminate(); backend.close(r); });
  if (proxy) await proxy.close();
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-optional-channel-")) rmSync(home, { recursive: true, force: true });
}
