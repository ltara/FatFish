import licenseFixture from "./license-fixture.cjs";
import { pathToFileURL } from "node:url";
/** Real Core/rc2/plugin/timer and production inbox/controller + loopback QQ/model. Never opens a window. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { startModelProxy } from "./model-proxy.mjs";
import toolContract from "../tool-contract.cjs";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
const require = createRequire(import.meta.url);
const { ReminderInbox } = require("../../electron-ui/reminder-inbox.js");
const { ReminderController } = require("../../electron-ui/reminder-controller.js");
const chatStore = require("../../electron-ui/chat-store.js");
const home = mkdtempSync(join(tmpdir(), "fatfish-reminder-runtime-"));
const licensed = licenseFixture.licensedFixture(home); Object.assign(process.env, licensed.env);
const evidenceArg = process.argv.indexOf("--evidence"), evidence = evidenceArg < 0 ? null : resolve(process.argv[evidenceArg + 1]);
const fast = process.argv.includes("--fast"); // Diagnostic only; the acceptance mode really waits sixty seconds.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, ms = 25000, label = "condition") => { const end = Date.now() + ms; while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(20); } throw new Error("reminder_runtime_timeout:" + label); };
let core, proxy, backend, socket, nextTool = null, reply = "提醒已经设置好了。", dropReceipt = false, sequence = 0, count = 0;
const sent = [], ipc = [], logs = [], inbox = new Map(), approvals = [], results = [], metrics = {};
const services = new EventEmitter(); services.sendCore = (m) => core?.connected ? core.send(m) : false;
const productionInbox = new ReminderInbox({ root: home, currentSession: () => chatStore.get(home).sessionId });
const inboxController = new ReminderController({ services, inbox: productionInbox });
const check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); count++; console.log("PASS " + name); };
const rows = () => existsSync(join(home, "reminders.json")) ? JSON.parse(readFileSync(join(home, "reminders.json"), "utf8")).items : [];
async function start(paused = false) {
  const from = ipc.length;
  core = fork(licensed.entry, [], { execPath: process.env.E2E_EXEC_PATH || process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FATFISH_APPDATA: home, FATFISH_DEV_DEEPSEEK_BASE_URL: proxy.url }, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  core.stdout.on("data", (b) => logs.push(b.toString())); core.stderr.on("data", (b) => logs.push(b.toString()));
  core.on("message", (m) => {
    ipc.push(m);
    if (m.type === "ready") core.send({ type: "pause", paused });
    if (m.type === "approval") { approvals.push(m); core.send({ type: "approval_answer", id: m.id, outcome: "allowed-once" }); }
    if (m.type === "reminder_delivery") inbox.set(m.deliveryId, m);
    services.emit("core-message", m);
  });
  await wait(() => ipc.slice(from).some((m) => m.type === "ready")); await wait(() => socket?.readyState === 1);
}
async function stop() { if (!core) return; core.send({ type: "shutdown" }); await wait(() => core.exitCode !== null || core.signalCode !== null); assert.equal(core.exitCode, 0); services.emit("core-message", { type: "unavailable" }); core = null; socket = null; }
const inbound = (text) => socket.send(JSON.stringify({ post_type: "message", message_type: "private", self_id: 90000, user_id: 10001, message: [{ type: "text", data: { text } }] }));
async function remoteTool(name, input) { const before = sent.length; nextTool = { name, input }; inbound("提醒工具验收"); await wait(() => sent.length > before, 25000, "remote_reply_" + name); }
async function local(text) { const id = "local-" + ++sequence; core.send({ type: "chat_send", id, sessionId: "local-main", text }); return wait(() => ipc.find((m) => m.type === "chat_result" && m.id === id)); }
async function channel(enabled) { const requestId = "channel-" + ++sequence; core.send({ type: "channel_set", requestId, enabled }); return wait(() => ipc.find((m) => m.type === "channel_result" && m.requestId === requestId), 25000, "channel_result_" + enabled); }
try {
  mkdirSync(join(home, "secrets")); writeFileSync(join(home, "secrets/deepseek_api_key"), "sk-reminder-runtime-not-a-key");
  backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  backend.on("connection", (ws) => { socket = ws; ws.on("message", (buf) => {
    const m = JSON.parse(buf);
    if (m.action === "send_private_msg") { sent.push({ at: Date.now(), text: m.params.message[0].data.text }); if (dropReceipt && m.params.message[0].data.text === "未知送达内容") return; }
    ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: m.echo, data: m.action === "get_login_info" ? { user_id: 90000, nickname: "肥鱼" } : { message_id: sent.length } }));
  }); }); await once(backend, "listening");
  writeFileSync(join(home, "config.json"), JSON.stringify({ onebot_url: `ws://127.0.0.1:${backend.address().port}`, channels: { qq: { enabled: true } }, owners: [{ channel: "qq", account: "10001" }] }));
  proxy = await startModelProxy({ reply: () => reply, tool: () => { const call = nextTool; nextTool = null; return call; } });
  await start();
  await remoteTool("remind_create", { when: fast ? "5s" : "1m", text: "喝水" });
  const minute = rows().find((r) => r.text === "喝水");
  check("actual external tool persists its trusted owner source", minute?.source.instance === "external" && minute.source.account === "10001" && minute.source.sessionId === "owner-main" && minute.nextAt - minute.createdAt === (fast ? 5000 : 60000));
  await remoteTool("remind_list", {});
  check("real runtime renders the reminder list result", JSON.stringify(proxy.requests.at(-1).messages).includes(minute.id));
  await remoteTool("remind_create", { when: "1m", text: "伪造范围不得保存", instance: "local" });
  check("real model cannot select local instance or recipient", !rows().some((r) => r.text === "伪造范围不得保存"));
  reply = "该喝水啦。"; nextTool = { name: "memory_save", input: { text: "定时提示不得静默写入记忆" } };
  const beforeDue = sent.length;
  await wait(() => sent.length > beforeDue, 70000);
  const received = sent.at(-1), memoryFile = join(home, "memory/owner.jsonl");
  metrics.deadlineAfterCreateMs = minute.nextAt - minute.createdAt; metrics.receivedLagMs = received.at - minute.nextAt;
  check((fast ? "diagnostic five-second" : "real sixty-second") + " deadline reaches the fixture QQ channel on time", received.text === reply && received.at >= minute.nextAt && received.at - minute.nextAt < 6000);
  check("scheduled external prompts cannot mutate memory through plugins", !existsSync(memoryFile) || !readFileSync(memoryFile, "utf8").includes("定时提示不得静默写入记忆"));
  check("external model requests contain exactly the six non-host tools", proxy.requests.every(toolContract.externalToolsMatch));
  check("one-off confirmation is durable", await wait(() => rows().find((r) => r.id === minute.id).last?.state === "delivered"));
  reply = "设置完成。"; await remoteTool("remind_create", { when: "2s", text: "重启后补发" }); await stop(); await sleep(2200);
  const beforeRestart = sent.length, modelBefore = proxy.requests.length; await start(true); await sleep(1700);
  check("paused restart materializes but does not generate or send", sent.length === beforeRestart && proxy.requests.length === modelBefore && rows().find((r) => r.text === "重启后补发").pending.phase === "due");
  reply = "重启后的提醒到了。"; core.send({ type: "pause", paused: false }); await wait(() => sent.length > beforeRestart);
  check("unpause delivers a persisted overdue one-off", sent.at(-1).text === reply);
  reply = "设置完成。"; await remoteTool("remind_create", { when: "2s", text: "回到本机接收" });
  check("human local chat updates the destination without changing source", (await local("我回到电脑前了")).ok);
  reply = "这条在本机提醒。"; await wait(() => [...inbox.values()].some((m) => m.text === reply));
  const localDelivery = [...inbox.values()].find((m) => m.text === reply);
  check("remote-sourced reminder uses the original external session and parent inbox", localDelivery.sourceSession === "owner-main" && rows().find((r) => r.text === "回到本机接收").source.instance === "external");
  check("parent ack commits local delivery", await wait(() => rows().find((r) => r.text === "回到本机接收").last?.state === "delivered"));
  check("production inbox persists the remote-sourced display message", productionInbox.display(chatStore.get(home)).messages.some((m) => m.reminderDeliveryId === localDelivery.deliveryId));
  services.emit("core-message", localDelivery);
  check("production controller suppresses replay without another model turn", productionInbox.display(chatStore.get(home)).messages.filter((m) => m.reminderDeliveryId === localDelivery.deliveryId).length === 1);
  check("QQ can be disabled without losing reminders", (await channel(false)).ok);
  core.send({ type: "pause", paused: true }); // A disabled channel's old pause must not block local reminders.
  const target = join(home, "workspace/local/reminder-must-not-write.txt");
  nextTool = { name: "write", input: { file_path: target, content: "allowed-human-turn" } }; await local("先做一次明确允许的工作区写入");
  check("human permission setup really writes the temporary target", existsSync(target) && readFileSync(target, "utf8") === "allowed-human-turn"); unlinkSync(target);
  reply = "本机提醒已设好。"; nextTool = { name: "remind_create", input: { when: "1s", text: "没有 QQ 的本机提醒" } }; check("real local reminder tool uses ordinary user approval", (await local("稍后提醒我")).ok && approvals.some((a) => a.toolName === "remind_create"));
  const approvalCount = approvals.length;
  nextTool = { name: "write", input: { file_path: target, content: "must-not-execute" } }; reply = "只提醒，不操作电脑。";
  await wait(() => [...inbox.values()].some((m) => m.text === reply));
  check("scheduled local tools are denied without opening an approval window", !existsSync(target) && approvals.length === approvalCount);
  check("local-only reminder never wakes the external engine", ipc.slice(ipc.findLastIndex((m) => m.type === "channel_result" && m.enabled === false)).filter((m) => m.type === "engine" && m.instance === "external").every((m) => m.state === "stopped"));
  const enabledAgain = await channel(true); check("re-enabling the fixture channel succeeds", enabledAgain.ok);
  core.send({ type: "pause", paused: false });
  await wait(() => socket?.readyState === 1, 25000, "re-enabled_backend_socket");
  reply = "设置完成。"; await remoteTool("remind_create", { when: "1s", text: "未知回执提醒" });
  dropReceipt = true; reply = "未知送达内容"; await wait(() => rows().find((r) => r.text === "未知回执提醒").pending?.phase === "uncertain", 20000);
  const unknownCount = sent.filter((r) => r.text === "未知送达内容").length, unknownModel = proxy.requests.length;
  await stop(); dropReceipt = false; await start(); await sleep(1800);
  check("unknown backend receipt is not resent or regenerated after restart", unknownCount === 1 && sent.filter((r) => r.text === "未知送达内容").length === 1 && proxy.requests.length === unknownModel);
  check("inbox messages survive a real Core restart", productionInbox.display(chatStore.get(home)).messages.filter((m) => m.reminderDeliveryId).length === 2);
  check("metadata logs contain neither reminder text nor the key", !logs.join("").includes("没有 QQ 的本机提醒") && !logs.join("").includes("sk-reminder-runtime-not-a-key"));
  console.log(`${count}/${count} runtime reminder checks passed (local fixtures, no paid calls)`);
} finally {
  if (core) await stop(); inboxController.dispose(); if (proxy) await proxy.close();
  if (backend) await new Promise((r) => { for (const c of backend.clients) c.terminate(); backend.close(r); });
  if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, "reminder-runtime-report.json"), JSON.stringify({ results, metrics, fast, paidCalls: 0, model: "loopback-fixture", channel: "loopback-fixture", inbox: "production-data-controller-in-Node-not-Electron-UI",
    protocol: ipc.filter((m) => ["engine", "channel", "channel_result", "paused"].includes(m.type)).map((m) => ({ type: m.type, instance: m.instance, state: m.state, enabled: m.enabled, ok: m.ok, error: m.error })) }, null, 2)); }
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-reminder-runtime-")) rmSync(home, { recursive: true, force: true });
}
