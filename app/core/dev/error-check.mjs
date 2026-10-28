import licenseFixture from "./license-fixture.cjs";
import { pathToFileURL } from "node:url";
/** Real rc2 + loopback failures, then Router and desktop snapshot policy. No paid calls. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { startModelProxy } from "./model-proxy.mjs";
import toolContract from "../tool-contract.cjs";
const home = mkdtempSync(join(tmpdir(), "fatfish-errors-"));
const licensed = licenseFixture.licensedFixture(home); Object.assign(process.env, licensed.env);
process.env.FATFISH_APPDATA = home;
const require = createRequire(import.meta.url);
const { build } = require("../../electron-ui/renderer/status-view.js");
const { ServiceManager } = require("../../electron-ui/service-manager.js");
const { EngineHost } = await import(pathToFileURL(join(licensed.core, "engine-host.mjs")));
const { Router } = await import("../router.mjs");
const { classifyTurnFailure } = await import("../turn-errors.mjs");
const { ensureDirs, instancePaths, CORE_DIR } = await import("../paths.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, ms = 15000) => { const until = Date.now() + ms; while (Date.now() < until) { if (fn()) return; await sleep(20); } throw new Error("error_check_timeout"); };
let count = 0, fault = null;
const check = (name, value) => { assert.ok(value, name); count++; console.log("PASS " + name); };
ensureDirs();
writeFileSync(join(home, "secrets/deepseek_api_key"), "sk-error-check-not-a-key");
const patch = join(home, "no-retry.patch.yml");
writeFileSync(patch, "- id: llm-retry\n  disabled: true\n");
const proxy = await startModelProxy({ reply: () => "恢复后的回复", failure: () => fault });
process.env.FATFISH_DEV_DEEPSEEK_BASE_URL = proxy.url;
const host = new EngineHost({ name: "external", profile: "fatfish-external", ...instancePaths("external"), extraPatches: [join(CORE_DIR, "profiles/common.patch.yml"), patch] });
const states = [], channel = new EventEmitter(), replies = [], errors = [];
channel.id = "qq"; channel.send = async (_id, text) => { replies.push(text); return true; };
host.on("state", (s) => states.push(s));
const router = new Router({ identity: { consume: () => ({ consumed: false }), isOwner: () => true },
  instances: { externalSessionId: "error-owner", turn: (_instance, sid, text) => host.turn(sid, text) } });
router.on("turn_error", (e) => errors.push(e)); router.attach(channel);
const manager = new ServiceManager({ appDataRoot: home });
const snapshot = () => ({ key_saved: true, core_running: true, qq_online: true, engine_state: host.state,
  engine_crash_count: manager.getCore().engines.external?.crashCount || 0, last_turn_error: manager.getCore().last_turn_error });
host.on("state", (s) => manager._onCoreMessage({ type: "engine", ...s }));
host.on("turn_end", (s) => manager._onCoreMessage({ type: "turn_end", ...s }));
router.on("turn_error", (s) => manager._onCoreMessage({ type: "turn_error", ...s }));
try {
  check("runtime starts with the test-only retry overlay", await host.start());
  for (const [mode, expected, wording] of [[401, "invalid_key", "密钥"], [402, "insufficient_balance", "余额"], [429, "rate_limited", "稍等"], [404, "model_unavailable", "模型"], ["network", "network", "连不上"]]) {
    fault = mode;
    const before = replies.length;
    channel.emit("message", { from: "10001", text: "合成错误请求" });
    await wait(() => replies.length > before);
    check(`actual runtime ${mode} maps to ${expected}`, errors.at(-1).error === expected);
    check(`${expected} gives the owner a safe companion reply`, replies.at(-1).includes(wording) && !/LOCAL_|401|402|429|DSH/.test(replies.at(-1)));
    check(`${expected} is actionable in the shared desktop policy`, build(snapshot()).issues.some((i) => i.id === expected));
  }
  fault = "hold";
  const before = replies.length, requests = proxy.requests.length, oldPid = host.client.child.pid;
  channel.emit("message", { from: "10001", text: "中断中的合成请求" });
  await wait(() => proxy.requests.length > requests);
  host.client.child.kill();
  await wait(() => replies.length > before);
  check("killing the runtime is classified and explained", errors.at(-1).error === "engine_crashed" && replies.at(-1).includes("恢复"));
  await wait(() => states.some((s) => s.state === "ready" && s.pid !== oldPid));
  check("runtime restarts automatically after an unexpected exit", host.state === "ready" && host.client.child.pid !== oldPid);
  check("recovered engine clears only the crash warning", !manager.getCore().last_turn_error);
  fault = null;
  channel.emit("message", { from: "10001", text: "恢复后再试" });
  await wait(() => replies.length > before + 1);
  check("successful reply clears the prior failure and crash streak", replies.at(-1) === "恢复后的回复" && build(snapshot()).label === "在线" && !host.crashTimes.length);
  check("stats count real attempts and only successful model replies", router.getStats().inbound === 7 && router.getStats().replies === 1 && router.getStats().errors === 6);
  const attempt = { type: "assistant/attempt", data: { stream: [{ type: "chunk", chunk: { type: "finish", reason: { kind: "error", failure: { code: "AUTH", status: 401 } } } }] } };
  check("observed assistant attempt is a fallback when end reason is absent", classifyTurnFailure({ events: [attempt] }) === "invalid_key");
  check("unknown prose is not mistaken for a typed provider error", classifyTurnFailure({ endReason: { kind: "error", error: { message: "401 in arbitrary prose" } } }) === "turn_failed");
  check("repeated crashes remain visible even between restarts", build({ ...snapshot(), engine_crash_count: 3 }).issues.some((i) => i.id === "repeated_crash"));
  check("channel offline defeats stale login assumptions", build({ ...snapshot(), qq_online: false }).label === "QQ 未连接");
  check("home and tray labels use the same policy", build(snapshot()).trayText === "肥鱼 · " + build(snapshot()).label);
  check("all observed model requests retain the exact non-host memory whitelist", proxy.requests.length > 0 && proxy.requests.every(toolContract.externalToolsMatch));
  console.log(`${count}/${count} error checks passed (no paid calls)`);
} finally {
  await host.dispose(); await proxy.close();
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-errors-")) rmSync(home, { recursive: true, force: true });
}
