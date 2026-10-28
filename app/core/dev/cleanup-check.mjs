import licenseFixture from "./license-fixture.cjs";
import { pathToFileURL } from "node:url";
/** M3-C: real Core / pinned runtime, fake channel and local model, no real account or key. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { startModelProxy } from "./model-proxy.mjs";
import toolContract from "../tool-contract.cjs";
import { verifyCleanup } from "../../../scripts/verify-m3-cleanup.mjs";

const require = createRequire(import.meta.url);
const { ServiceManager } = require("../../electron-ui/service-manager.js");
const persona = require("../../electron-ui/persona-lib.js");
const coreDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "fatfish-cleanup-"));
const licensed = licenseFixture.licensedFixture(home); Object.assign(process.env, licensed.env);
const pausePath = join(home, "runtime", "outbound_paused");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (predicate, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = predicate(); if (v) return v; await sleep(30); }
  throw new Error("cleanup_fixture_timeout");
};
let count = 0;
const check = (name, pass) => { assert.ok(pass, name); count++; console.log("PASS " + name); };
let services, backend, proxy;
const sent = [], ipc = [];
let socket;
const marker = "persona-reload-fixture";
try {
  check("all source and package legacy references removed", verifyCleanup() > 0);
  services = new ServiceManager({ appDataRoot: home, electronExecPath: process.env.E2E_EXEC_PATH || process.execPath });
  const realFork = services.forkCore.bind(services); services.forkCore = () => realFork(licensed.entry, licensed.core);
  services.killBackendHelpers = () => {}; // Never inspect or terminate the user's running helpers.
  services.ensureAppData();
  const defaults = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  check("fresh defaults include owners and bundled persona", Array.isArray(defaults.owners) && persona.getActiveBody(home).length > 0);
  check("only channel and login ports are used", Object.keys(services.readPorts()).sort().join() === "backend,login");

  backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  backend.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (buf) => {
      const m = JSON.parse(buf);
      if (m.action === "get_login_info") ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: m.echo, data: { user_id: 90000, nickname: "肥鱼" } }));
      if (m.action === "send_private_msg") {
        sent.push(m.params.message.map((s) => s.data.text).join(""));
        ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: m.echo, data: { message_id: sent.length } }));
      }
    });
  });
  await once(backend, "listening");
  const port = backend.address().port;
  writeFileSync(join(home, "config.json"), JSON.stringify({ onebot_url: `ws://127.0.0.1:${port}`, onebot_port: port,
    login_ui_port: port, owners: [{ channel: "qq", account: "10001", boundAt: new Date().toISOString(), label: "" }] }));
  writeFileSync(join(home, "secrets", "deepseek_api_key"), "sk-cleanup-fixture-not-a-key");
  writeFileSync(pausePath, "1\n");
  proxy = await startModelProxy({ reply: (body) => JSON.stringify([body.system, body.messages]).includes(marker) ? marker : "原人格回复" });
  process.env.FATFISH_DEV_DEEPSEEK_BASE_URL = proxy.url;
  services.on("core-message", (m) => ipc.push(m));
  const boot = async () => {
    const n = ipc.length;
    const state = await services.startAll();
    await wait(() => ipc.slice(n).some((m) => m.type === "engine" && m.state === "ready") && socket, 60000);
    return state;
  };
  const inbound = (text) => socket.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend",
    self_id: 90000, user_id: 10001, message: [{ type: "text", data: { text } }] }));
  const state = await boot();
  check("startup is running with only Core and channel backend", state.phase === "running" && state.core && state.backend);
  await wait(() => services.getCore().paused === true);
  inbound("暂停时不应回复"); await sleep(120);
  check("persisted pause is applied by startup IPC", proxy.requests.length === 0 && sent.length === 0);
  unlinkSync(pausePath);
  inbound("删文件也不应绕过暂停"); await sleep(120);
  check("router no longer reads a pause file per message", proxy.requests.length === 0 && services.getCore().paused);
  services.sendCore({ type: "pause", paused: false }); await wait(() => services.getCore().paused === false);
  inbound("你好"); await wait(() => sent.length === 1);
  check("IPC resume restores remote conversation", sent[0] === "原人格回复");

  const previousPid = ipc.findLast((m) => m.type === "engine" && m.state === "ready").pid;
  const item = persona.createPersona(home, { title: "重载验证", body: "你是肥鱼。人格验证标记：" + marker });
  persona.applyPersona(home, item.item.id);
  services.sendCore({ type: "reload" });
  await wait(() => ipc.some((m) => m.type === "engine" && m.state === "ready" && m.pid !== previousPid), 60000);
  inbound("换人格后的下一句"); await wait(() => sent.length === 2);
  if (sent[1] !== marker) console.log("persona_reload_diagnostics", JSON.stringify({
    activeFileHasMarker: readFileSync(join(home, "personas.json"), "utf8").includes(marker),
    activeBodyHasMarker: persona.getActiveBody(home).includes(marker),
    requests: proxy.requests.map((r) => ({ systemType: typeof r.system, systemHasMarker: JSON.stringify(r.system)?.includes(marker),
      messagesHaveMarker: JSON.stringify(r.messages).includes(marker), keys: Object.keys(r) })),
  }));
  check("persona reload takes effect on the next existing-session turn", sent[1] === marker);
  check("existing session history is retained after persona reload", proxy.requests[1].messages.some((m) => JSON.stringify(m).includes("原人格回复")));
  check("external requests retain the exact non-host memory whitelist", proxy.requests.length >= 2 && proxy.requests.every(toolContract.externalToolsMatch));

  writeFileSync(pausePath, "1\n"); services.sendCore({ type: "pause", paused: true });
  await wait(() => services.getCore().paused);
  await services.stopAll(); socket = null;
  const before = proxy.requests.length;
  await boot(); inbound("重启后仍需暂停"); await sleep(150);
  check("pause survives a Core/service-manager restart", services.getCore().paused && proxy.requests.length === before);
  check("pause marker is retained as persistence", existsSync(pausePath));
  console.log(`${count}/${count} cleanup checks passed (no paid calls)`);
} finally {
  if (services) await services.stopAll();
  if (backend) await new Promise((r) => { for (const c of backend.clients) c.terminate(); backend.close(r); });
  if (proxy) await proxy.close();
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-cleanup-")) rmSync(home, { recursive: true, force: true });
}
