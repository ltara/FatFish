import licenseFixture from "./license-fixture.cjs";
import { pathToFileURL } from "node:url";
/** Actual Core + production inbox/controller, with loopback model and no native shell. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ReminderStore } from "../reminder-store.mjs";
import { startModelProxy } from "./model-proxy.mjs";
const require = createRequire(import.meta.url);
const { ReminderInbox } = require("../../electron-ui/reminder-inbox.js");
const { ReminderController } = require("../../electron-ui/reminder-controller.js");
const home = mkdtempSync(join(tmpdir(), "fatfish-inbox-runtime-"));
const licensed = licenseFixture.licensedFixture(home); Object.assign(process.env, licensed.env);
const evidenceArg = process.argv.indexOf("--evidence"), evidence = evidenceArg < 0 ? null : resolve(process.argv[evidenceArg + 1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, label) {
  const end = Date.now() + 25000;
  while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(25); }
  throw new Error("inbox_runtime_timeout:" + label);
}
let core, proxy, controller, dropAck = true;
const results = [], received = [], messages = [], logs = [], commands = [], services = new EventEmitter();
const check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
const inbox = new ReminderInbox({ root: home, currentSession: () => "local-main", maxMessages: 2, historyKeep: 0 });
services.sendCore = (m) => { commands.push(m); return dropAck && m.type === "reminder_ack" && m.ok ? true : core?.connected ? core.send(m) : false; };
async function start() {
  const from = messages.length;
  core = fork(licensed.entry, [], {
    execPath: process.env.E2E_EXEC_PATH || process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FATFISH_APPDATA: home, FATFISH_DEV_DEEPSEEK_BASE_URL: proxy.url },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  core.stdout.on("data", (b) => logs.push(b.toString())); core.stderr.on("data", (b) => logs.push(b.toString()));
  core.on("message", (m) => { messages.push(m); if (m.type === "reminder_delivery") received.push(m); services.emit("core-message", m); });
  await wait(() => messages.slice(from).some((m) => m.type === "ready"), "core_ready");
}
async function stop() {
  if (!core) return;
  const child = core; child.send({ type: "shutdown" });
  await wait(() => child.exitCode !== null || child.signalCode !== null, "core_exit");
  assert.equal(child.exitCode, 0); services.emit("core-message", { type: "unavailable" }); core = null;
}
try {
  mkdirSync(join(home, "secrets")); writeFileSync(join(home, "secrets/deepseek_api_key"), "sk-inbox-fixture-not-a-key");
  writeFileSync(join(home, "config.json"), JSON.stringify({ channels: { qq: { enabled: false } }, owners: [] }));
  const store = new ReminderStore({ root: home });
  const create = (text) => store.create({ when: "1s", text, source: { instance: "local", sessionId: "local-main" } });
  const first = create("回执丢失仍只展示一次");
  proxy = await startModelProxy({ reply: () => "该休息一下啦。" });
  await start();
  await wait(() => store.get(first.id).pending?.error === "destination_unavailable", "no_parent_handshake");
  check("Core without an inbox handshake does not generate or deliver", proxy.requests.length === 0 && received.length === 0);
  check("Core publishes bounded catalog metadata without reminder text", messages.some((m) => m.type === "reminder_catalog" && m.ids?.includes(first.id) && Object.keys(m).every((k) => ["type", "ids"].includes(k))));
  controller = new ReminderController({ services, inbox }); services.emit("core-message", { type: "ready" });
  await wait(() => inbox.status().unshown === 1, "first_durable_receipt");
  check("production controller persists the first delivery before a lost ack", store.get(first.id).pending.phase === "sending" && proxy.requests.length === 1 && JSON.parse(readFileSync(inbox.file)).receipts.length === 1);
  const deliveryId = received[0].deliveryId;
  await stop();
  check("Core shutdown keeps generated delivery text for replay", store.get(first.id).pending.phase === "generated" && store.get(first.id).pending.text === "该休息一下啦。");
  dropAck = false; await start();
  await wait(() => store.get(first.id).last?.state === "delivered", "replay_ack");
  check("restarting Core replays the same occurrence id", received.length === 2 && received[1].deliveryId === deliveryId);
  check("lost ack recovery neither duplicates the inbox nor regenerates", inbox.status().unshown === 1 && proxy.requests.length === 1);
  const valid = readFileSync(inbox.file, "utf8"); writeFileSync(inbox.file, "broken-json");
  controller.view({ sessionId: "local-main", messages: [] });
  const second = create("损坏期间先保留计划"); core.send({ type: "reminder_catalog_request" });
  await wait(() => store.get(second.id).pending?.error === "destination_unavailable", "corrupt_inbox_gate");
  check("corrupt inbox prevents new generation and preserves invalid bytes", proxy.requests.length === 1 && readFileSync(inbox.file, "utf8") === "broken-json");
  writeFileSync(inbox.file, valid); controller.retry();
  await wait(() => store.get(second.id).last?.state === "delivered", "disk_recovery");
  check("disk repair automatically restores catalog and delivery", inbox.status().unshown === 2 && proxy.requests.length === 2);
  const third = create("收件箱满先排队"); core.send({ type: "reminder_catalog_request" });
  await wait(() => store.get(third.id).pending?.error === "destination_unavailable", "full_inbox_gate");
  check("full unshown inbox applies backpressure before generation", !inbox.status().available && proxy.requests.length === 2 && inbox.status().unshown === 2);
  check("display marking opens capacity without losing other unshown data", controller.markShown([deliveryId], "local-main", true).ok && inbox.status().unshown === 1);
  await wait(() => store.get(third.id).last?.state === "delivered", "capacity_recovery");
  check("reclaimed capacity wakes the queued occurrence exactly once", inbox.status().unshown === 2 && proxy.requests.length === 3 && received.filter((m) => m.reminderId === third.id).length === 1);
  services.emit("core-message", received[0]);
  check("receipt high-water still deduplicates after shown history is trimmed", inbox.status().unshown === 2 && inbox.display({ sessionId: "local-main", messages: [] }).messages.length === 2);
  check("pure local reminder recovery never starts the external engine or approvals", !messages.some((m) => m.type === "engine" && m.instance === "external" && m.state !== "stopped" || m.type === "approval"));
  check("controller sends only inbox protocol, not new human model commands", commands.every((m) => ["reminder_ack", "reminder_inbox_status", "reminder_catalog_request"].includes(m.type)));
  check("Core logs contain neither reminder text nor the fixture key", !logs.join("").includes(first.text) && !logs.join("").includes("sk-inbox-fixture-not-a-key"));
  await stop(); controller.dispose(); controller = null;
  check("controller releases its listener after real Core shutdown", services.listenerCount("core-message") === 0);
  console.log(`${results.length}/${results.length} inbox runtime checks passed (actual Core, production inbox, no windows/paid calls)`);
} finally {
  try { if (core) await stop(); } finally {
    controller?.dispose(); await proxy?.close();
    if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, "inbox-runtime-report.json"), JSON.stringify({ results, paidCalls: 0, model: "loopback-fixture", nativeUI: false, fixtureCapacity: 2, ackLoss: "first positive ack suppressed", modelRequests: proxy?.requests.length || 0 }, null, 2)); }
    if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-inbox-runtime-")) rmSync(home, { recursive: true, force: true });
  }
}
