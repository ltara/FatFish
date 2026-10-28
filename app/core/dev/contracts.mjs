/** Deterministic M3-A contracts, no real key, no external network, no test framework. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import toolContract from "../tool-contract.cjs";

const home = mkdtempSync(join(tmpdir(), "fatfish-contracts-"));
process.env.FATFISH_APPDATA = home; // Must precede dynamic imports of paths.mjs.
const { PluginGateway } = await import("../gateway.mjs");
const { InstanceManager } = await import("../instance-manager.mjs");
const { ensureDirs, instancePaths, migrateLegacySessions, CORE_DIR } = await import("../paths.mjs");
const { engineEnv, installProfile, resolveDshExe } = await import("../engine-host.mjs");
const { DshClient } = await import("../dsh-client.mjs");
const { startModelProxy } = await import("./model-proxy.mjs");
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let count = 0;
const check = (name, condition) => { assert.ok(condition, name); console.log("PASS " + name); count++; };
const body = { plugin: "fatfish-approval", op: "request", sessionId: "local-main", args: { toolName: "write", instance: "external" } };
let gateway, manager, proxy, client;

try {
  ensureDirs();
  const seen = [];
  gateway = new PluginGateway({ onApproval: async (req) => { seen.push(req); return "allowed-once"; }, timeoutMs: 50 });
  const local = gateway.register("local", (sid) => sid === "local-main");
  const external = gateway.register("external", () => true);
  await gateway.start();
  const call = async (token, payload = body, raw = false) => {
    const r = await fetch(gateway.url, { method: "POST", headers: { authorization: raw ? token : "Bearer " + token },
      body: typeof payload === "string" ? payload : JSON.stringify(payload) });
    return { status: r.status, ...await r.json() };
  };
  check("gateway tokens differ by instance", local !== external);
  check("gateway denies unknown credentials", (await call("bad")).status === 401);
  check("gateway requires Bearer authentication", (await call(local, body, true)).status === 401);
  check("external token cannot impersonate local", (await call(external, { ...body, instance: "local" })).status === 403);
  check("gateway denies unknown plugin", (await call(local, { ...body, plugin: "other" })).status === 403);
  check("gateway denies foreign session", (await call(local, { ...body, sessionId: "owner-main" })).status === 403);
  check("gateway rejects malformed JSON", (await call(local, "{")).status === 400);
  check("valid approval uses token identity, not args", (await call(local)).outcome === "allowed-once" &&
    seen.length === 1 && seen[0].instance === "local");
  gateway.onApproval = async () => "allow-always";
  check("unknown approval outcomes fail closed", (await call(local)).outcome === "rejected");
  gateway.onApproval = () => new Promise(() => {});
  check("approval timeout fails closed", (await call(local)).outcome === "rejected");
  await gateway.stop(); gateway = null;

  class FakeHost extends EventEmitter {
    constructor(opts) { super(); Object.assign(this, opts); this.starts = 0; this.stops = 0; this.reloads = 0; this.state = "stopped"; }
    async start() { this.starts++; this.client = {}; this.state = "ready"; return true; }
    async turn(sid) { if (!this.client) await this.start(); this.activeSessionId = sid; await sleep(50); this.activeSessionId = null; return { ok: true, text: "ok" }; }
    async stop() { this.stops++; await sleep(10); this.client = null; this.state = "stopped"; }
    async reload() { this.reloads++; }
    async dispose() { await this.stop(); }
  }
  manager = new InstanceManager({ idleMs: 30, createHost: (opts) => new FakeHost(opts) });
  check("new installation uses owner-main", manager.externalSessionId === "owner-main");
  await manager.start();
  const ext = manager.hosts.get("external"), loc = manager.hosts.get("local");
  check("only external prewarms", ext.starts === 1 && loc.starts === 0);
  check("instance homes and workspaces differ", ext.dshHome !== loc.dshHome && ext.workspace !== loc.workspace);
  await manager.reload();
  check("reload does not wake unused local", ext.reloads === 1 && loc.reloads === 0 && loc.starts === 0);
  check("external cannot address local session", (await manager.turn("external", "local-main", "x")).error === "invalid_session");
  check("local cannot address owner session", (await manager.turn("local", "owner-main", "x")).error === "invalid_session");
  const turn = manager.turn("local", "local-main", "x");
  await sleep(40);
  check("idle timer never interrupts active local turn", loc.starts === 1 && loc.stops === 0);
  await turn;
  await sleep(45);
  check("idle local stops after configured interval", loc.stops === 1 && loc.state === "stopped");
  await manager.turn("local", "local-new", "x");
  check("local restarts on demand after idle", loc.starts === 2);
  let chatEvents = 0;
  manager.on("chat_event", () => chatEvents++);
  ext.emit("event", {}); loc.emit("event", {});
  check("external events never become local chat events", chatEvents === 1);
  await manager.stop();
  check("shutdown blocks further turns", (await manager.turn("local", "local-main", "x")).error === "engine_unavailable");
  manager = null;

  const ServiceManager = require("../../electron-ui/service-manager.js").ServiceManager;
  const services = new ServiceManager({ appDataRoot: home });
  services._onCoreMessage({ type: "engine", instance: "external", state: "ready" });
  services._onCoreMessage({ type: "engine", instance: "local", state: "stopped" });
  check("local state does not overwrite remote status", services.getCore().engine === "ready" &&
    services.getCore().engines.local.state === "stopped");

  writeFileSync(join(home, "config.json"), JSON.stringify({ owner_qq: "10001" }));
  const legacy = join(home, "dsh", "sessions");
  mkdirSync(legacy, { recursive: true }); writeFileSync(join(legacy, "probe.jsonl"), "legacy");
  check("legacy sessions retain their route ID", migrateLegacySessions() === "owner-qq-10001");
  const copied = join(instancePaths("external").dshHome, "sessions", "probe.jsonl");
  check("migration copies sessions and retains original", readFileSync(copied, "utf8") === "legacy" && existsSync(join(legacy, "probe.jsonl")));
  writeFileSync(copied, "newer"); migrateLegacySessions();
  check("migration is idempotent and never overwrites newer data", readFileSync(copied, "utf8") === "newer");

  process.env.DSH_PERMISSION_MODE = "danger-full-access";
  process.env.DSH_HOME = "foreign-home";
  process.env.FATFISH_GATEWAY_TOKEN = "foreign-token";
  const env = engineEnv({ DSH_HOME: "owned-home" });
  check("inherited engine overrides and tokens are stripped", env.DSH_HOME === "owned-home" && !env.DSH_PERMISSION_MODE && !env.FATFISH_GATEWAY_TOKEN);

  if (process.platform !== "win32" || !resolveDshExe()) throw new Error("runtime validation requires Windows and vendor/dsh");
  proxy = await startModelProxy({ reply: () => "本地测试回复" });
  for (const name of ["external", "local"]) {
    const profile = "fatfish-" + name;
    const dshHome = join(home, "runtime-probes", name);
    installProfile(profile, dshHome);
    const args = ["--patch", join(CORE_DIR, "profiles", "common.patch.yml")];
    const childEnv = engineEnv({ DSH_HOME: dshHome, DEEPSEEK_API_KEY: "sk-local-fixture-not-a-key", DEEPSEEK_BASE_URL: proxy.url });
    const dump = execFileSync(resolveDshExe(), ["--profile", profile, ...args, "--dump-config"], { env: childEnv, encoding: "utf8", windowsHide: true });
    check(name + " patch enforces expected sandbox", new RegExp("- id: sandbox-policy[\\s\\S]*?mode: " + (name === "external" ? "read-only" : "workspace-write")).test(dump));
    check(name + " shared overlay keeps privacy disabled", /- id: session-log-deepseek[\s\S]*?enabled: false/.test(dump) &&
      /- id: plugin-package-inventory-deepseek[\s\S]*?enabled: false/.test(dump) && /mode: DISABLED/.test(dump) && /maxBytes: 0/.test(dump));
    const workspace = join(home, "runtime-probes", "workspace-" + name); mkdirSync(workspace, { recursive: true });
    client = new DshClient({ exe: resolveDshExe(), profile, args, env: childEnv, cwd: workspace });
    client.start();
    await client.request("initialize", { cwd: workspace, provider: "deepseek-official", model: "deepseek-flash" });
    const n = proxy.requests.length;
    const r = await client.prompt("probe-" + name, "你好");
    check(name + " real runtime accepts local SSE fixture", r.texts.length > 0 && r.endReason?.kind === "completed");
    check(name + " has no pending/error plugin entries", !/pending|did not activate|error/i.test(client.stderrTail));
    const requests = proxy.requests.slice(n);
    check(name + " actual request tool contract", requests.length > 0 && requests.every((p) => name === "external" ?
      toolContract.externalToolsMatch(p) : toolContract.localToolsMatch(p)));
    check(name + " actual requests contain no private upload fields", requests.every((p) => !("dsh_session_log" in p) && !("dsh_plugin_packages" in p)));
    await client.shutdown(); client = null;
  }
  console.log(count + "/" + count + " contracts passed (no paid calls)");
} finally {
  if (client) await client.shutdown();
  if (manager) await manager.stop();
  if (gateway) await gateway.stop();
  if (proxy) await proxy.close();
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-contracts-")) rmSync(home, { recursive: true, force: true });
}
