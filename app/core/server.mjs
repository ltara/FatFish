/**
 * FatFish Core — entry point. Wires isolated instances ↔ Router ↔ channels.
 * Started by Electron with an IPC channel (fork); also runs standalone for dev:
 *   FATFISH_APPDATA=/tmp/fatfish-dev node server.mjs
 *
 * IPC (when process.send exists)
 *   → parent: { type: "engine", instance, state } | { type: "channel", id, state } | { type: "self", id, userId, nickname }
 *             { type: "stats", ...counters } | { type: "turn_error", error } | { type: "approval", id, ...request }
 *             { type: "turn_end", instance, sessionId, ok, toolCalls }
 *             { type: "chat_event", instance: "local", sessionId, event }
 *             { type: "chat_result", id, instance: "local", sessionId, ok, text?, error? }
 *             { type: "owners", owners } | { type: "pairing", pairingId, status, expiresAt?, reason?, owner? }
 *             { type: "identity_result", requestId, ok, pairing?: {code, pairingId, expiresAt, status}, owners?, error? }
 *             { type: "ready" } (requests persisted pause state) | { type: "paused", paused }
 *             { type: "channel_result", requestId, ok, enabled?, error? }
 *             { type: "approval_closed", id, outcome, reason: "timeout" | "decided" }
 *             { type: "memory_result", requestId, ok, data?, error? } | { type: "memory_changed", generation?, kind? }
 *             { type: "reminder_delivery", deliveryId, reminderId, dueAt, sourceSession, text, fallback } (parent must persist idempotently before ack)
 *             { type: "reminder_changed", kind, state? }
 *             { type: "reminder_catalog", ids: string[] | null } (bounded active reminder IDs, no text)
 *             { type: "owner_reply", channel, generation, bindingHash } (only successful current-owner model reply + confirmed channel send; no content)
 *   ← parent: { type: "pause", paused } | { type: "reload" } | { type: "approval_answer", id, outcome } | { type: "shutdown" }
 *             { type: "chat_send", id, sessionId?: "local-main" | "local-...", text } (IPC ONLY; no channel entry)
 *             { type: "owners_get" | "pairing_start" | "pairing_cancel", requestId, pairingId? }
 *             { type: "owner_remove", requestId, channel, account } (IPC ONLY; never a model tool)
 *             { type: "channel_set", requestId, enabled } | { type: "chat_cancel" } (IPC ONLY)
 *             { type: "memory_ui", requestId, op: "list" | "export" | "public_get" | "public_set" | "forget" | "clear", args } (IPC ONLY)
 *             { type: "reminder_ack", deliveryId, ok } (IPC ONLY; local inbox acknowledgement)
 *             { type: "reminder_inbox_status", available } | { type: "reminder_catalog_request" } (IPC ONLY)
 *             { type: "workspace_ui", requestId, op: "get" | "set", args? } → workspace_result (IPC ONLY)
 *             { type: "model_ui", requestId, op: "get" | "save" | "test", args? } → model_result (IPC ONLY)
 */
import { InstanceManager } from "./instance-manager.mjs";
import workspaceConfig from "./workspace-config.cjs";
import { ModelService } from "./model-service.mjs";
import { Identity } from "./identity.mjs";
import { QQChannel } from "./channels/qq.mjs";
import { Router } from "./router.mjs";
import { ensureDirs, loadConfig, loadToken, log, paths, isOutboundPaused } from "./paths.mjs";
import channelConfig from "./channel-config.cjs";
import { MemoryStore } from "./memory-store.mjs";
import { MemoryService } from "./memory-service.mjs";
import { ReminderStore } from "./reminder-store.mjs";
import { ReminderService } from "./reminder-service.mjs";
import { ReminderDispatch } from "./reminder-dispatch.mjs";
import licenseModule from "./license-gate.cjs";

// This process reads its own embedded trust anchor, OS identity and license file.
// Parent IPC/env flags cannot assert that verification already happened elsewhere.
const licenseGate = new licenseModule.LicenseGate(paths.root);
const initialLicense = licenseGate.inspect();
if (!initialLicense.valid) {
  if (typeof process.send === "function" && process.connected) await new Promise((resolve) => process.send({ type: "license", ...initialLicense }, resolve));
  process.exit(78);
}

ensureDirs();
const send = typeof process.send === "function" ? (m) => process.connected && process.send(m) : () => {};

// Approvals go to the Electron UI; with no UI attached they fail closed.
const approvalWaiters = new Map();
let approvalSeq = 0;
function askApproval(req, signal) {
  if (typeof process.send !== "function") return Promise.resolve("rejected");
  const id = String(++approvalSeq);
  return new Promise((resolve) => {
    const deadlineAt = req.deadlineAt || Date.now() + 120000;
    const done = (outcome) => {
      if (!approvalWaiters.has(id)) return;
      approvalWaiters.delete(id);
      signal?.removeEventListener("abort", cancel);
      const expired = Date.now() >= deadlineAt || signal?.reason === "timeout";
      const final = expired ? "rejected" : ["allowed-once", "rejected", "cancelled"].includes(outcome) ? outcome : "rejected";
      send({ type: "approval_closed", id, outcome: final, reason: expired ? "timeout" : "decided" });
      resolve(final);
    };
    const cancel = () => done("cancelled");
    approvalWaiters.set(id, { done, deadlineAt });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    else send({ type: "approval", id, ...req, deadlineAt });
  });
}

const identity = new Identity({ configPath: paths.config });
const cfg = loadConfig();
let remoteEnabled = cfg.qq_enabled, localInboxAvailable = false;
const memoryStore = new MemoryStore({ root: paths.root });
const reminderStore = new ReminderStore({ root: paths.root });
function publishReminderCatalog() {
  try { send({ type: "reminder_catalog", ids: reminderStore.list().map((r) => r.id) }); }
  catch { log("reminder_catalog_unavailable"); send({ type: "reminder_catalog", ids: null }); }
}
let memories, reminders;
const instances = new InstanceManager({ onApproval: askApproval, remoteEnabled, memoryGeneration: memoryStore.generation(),
  authorizeExternal: (context) => identity.isOwner(context.channel, context.account),
  onTool: (request) => request.plugin === "fatfish-memory" ? memories.tool(request) : reminders.tool(request),
  approvalTimeoutMs: Math.min(120000, Math.max(50, Number(process.env.FATFISH_DEV_APPROVAL_TIMEOUT_MS) || 120000)) });
const models = new ModelService({ root: paths.root, instances });
memories = new MemoryService({ store: memoryStore, instances, isOwner: (channel, account) => identity.isOwner(channel, account),
  changed: (event) => send({ type: "memory_changed", ...event }) });
// With a parent, do not dispatch until IPC provides the persisted pause state.
// Standalone diagnostics read it once; Router never polls a file per message.
const router = new Router({ instances, identity, initialPaused: typeof process.send === "function" ? true : isOutboundPaused() });
identity.on("pairing", (p) => send({ type: "pairing", ...p }));
identity.on("owners", (owners) => send({ type: "owners", owners }));
send({ type: "owners", owners: identity.list() });
const qq = new QQChannel({ url: cfg.onebot_url, token: loadToken() });
const reminderDispatch = new ReminderDispatch({ store: reminderStore, instances, isOwner: (channel, account) => identity.isOwner(channel, account),
  channel: qq, remoteEnabled: () => remoteEnabled, sendLocal: send, localAvailable: () => localInboxAvailable && typeof process.send === "function" && process.connected });
reminders = new ReminderService({ store: reminderStore, instances, isOwner: (channel, account) => identity.isOwner(channel, account),
  isPaused: () => remoteEnabled && router.isPaused(), destinationFor: () => reminderDispatch.destinationFor(),
  canDeliver: (destination) => reminderDispatch.canDeliver(destination), generate: (row) => reminderDispatch.generate(row), deliver: (row, destination) => reminderDispatch.deliver(row, destination),
  changed: (event) => { send({ type: "reminder_changed", ...event }); if (["create", "delete"].includes(event.kind)) publishReminderCatalog(); }, onError: (code) => log(code) });
router.on("owner_activity", (route) => { try { reminderStore.setActive(route); } catch { log("reminder_route_unavailable"); } });

instances.on("state", (s) => {
  log("engine_state", "instance=" + s.instance, s.state, s.error || "");
  send({ type: "engine", ...s });
});
instances.on("turn_end", (s) => send({ type: "turn_end", ...s }));
instances.on("chat_event", (s) => send({ type: "chat_event", ...s }));
qq.on("status", (state) => { send({ type: "channel", id: qq.id, state: remoteEnabled ? state : "disabled" }); if (state === "online") reminders.wake(); });
send({ type: "channel", id: qq.id, state: remoteEnabled ? "connecting" : "disabled" });
send({ type: "stats", ...router.getStats() });
qq.on("self", (s) => send({ type: "self", id: qq.id, ...s }));
router.on("stats", (s) => send({ type: "stats", ...s }));
router.on("turn_error", (e) => send({ type: "turn_error", ...e }));
router.on("owner_reply", (event) => send({ type: "owner_reply", ...event }));
router.attach(qq);

let shuttingDown = false;
let channelQueue = Promise.resolve();
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("core_shutdown", reason);
  reminders.stop(); reminderDispatch.stop();
  for (const { done } of [...approvalWaiters.values()]) done("cancelled");
  qq.stop();
  identity.stop();
  await models.stop();
  await instances.stop().catch(() => {});
  await reminders.drain();
  process.exit(0);
}

process.on("message", (m) => {
  if (!m || typeof m !== "object") return;
  if (m.type !== "shutdown" && !licenseGate.inspect().valid) { shutdown("license_invalid"); return; }
  if (m.type === "reminder_catalog_request" && !shuttingDown) publishReminderCatalog();
  else if (m.type === "model_ui" && !shuttingDown) {
    Promise.resolve().then(() => {
      if (m.op === "get") return models.get();
      if (m.op === "save") return models.save(m.args);
      if (m.op === "test") return models.test(m.args);
      throw new Error("model_args_invalid");
    }).then((data) => {
      send({ type: "model_result", requestId: m.requestId, ok: true, data });
      if (m.op === "save" && data.changed) send({ type: "model_changed" });
    }, (e) => {
      const known = ["model_args_invalid", "model_provider_invalid", "model_name_invalid", "model_api_invalid", "model_endpoint_invalid", "model_preset_override", "model_capacity_invalid", "model_key_invalid", "model_config_invalid", "model_save_failed", "model_busy", "model_test_busy", "model_test_invalid_response", "model_test_timeout", "model_test_failed", "model_stale", "no_key", "invalid_key", "insufficient_balance", "rate_limited", "network", "model_unavailable", "missing_runtime", "config_invalid"];
      send({ type: "model_result", requestId: m.requestId, ok: false, error: known.includes(e.message) ? e.message : "model_unavailable" });
    });
  }
  else if (m.type === "workspace_ui" && !shuttingDown) {
    Promise.resolve().then(async () => {
      if (m.op === "get") return workspaceConfig.read(paths.root);
      if (m.op === "set") return instances.setLocalWorkspace(m.args);
      throw new Error("workspace_args_invalid");
    }).then((data) => {
      send({ type: "workspace_result", requestId: m.requestId, ok: true, data });
      if (m.op === "set" && data.changed) send({ type: "workspace_changed" });
    }, (e) => send({ type: "workspace_result", requestId: m.requestId, ok: false, error:
      ["workspace_invalid", "workspace_unavailable", "workspace_args_invalid", "local_busy", "config_invalid", "config_save_failed"].includes(e.message) ? e.message : "workspace_unavailable" }));
  }
  else if (m.type === "reminder_inbox_status" && !shuttingDown && typeof m.available === "boolean") { localInboxAvailable = m.available; if (m.available) reminders.wake(); }
  else if (m.type === "reminder_ack" && !shuttingDown) reminderDispatch.acknowledge(m.deliveryId, m.ok);
  else if (m.type === "memory_ui" && !shuttingDown) {
    try { send({ type: "memory_result", requestId: m.requestId, ok: true, data: memories.ui(m.op, m.args) }); }
    catch (e) { send({ type: "memory_result", requestId: m.requestId, ok: false, error: ["memory_args_invalid", "memory_not_found", "memory_changed"].includes(e.message) ? e.message : "memory_unavailable" }); }
  }
  else if (m.type === "channel_set" && !shuttingDown) {
    channelQueue = channelQueue.then(async () => {
      try {
        channelConfig.setQQEnabled(paths.config, m.enabled);
        if (m.enabled === remoteEnabled) {
          send({ type: "channel_result", requestId: m.requestId, ok: true, enabled: remoteEnabled });
          return;
        }
        remoteEnabled = m.enabled;
        if (!remoteEnabled) { qq.stop(); identity.cancel(); }
        await instances.setRemoteEnabled(remoteEnabled);
        if (remoteEnabled) qq.start();
        send({ type: "channel", id: "qq", state: remoteEnabled ? qq.state : "disabled" });
        send({ type: "channel_result", requestId: m.requestId, ok: true, enabled: remoteEnabled });
        reminders.wake();
      } catch (e) {
        send({ type: "channel_result", requestId: m.requestId, ok: false, error: ["config_invalid", "config_save_failed", "invalid_channel_setting"].includes(e.message) ? e.message : "channel_unavailable" });
      }
    });
  }
  else if (["owners_get", "pairing_start", "pairing_cancel", "owner_remove"].includes(m.type) && !shuttingDown) {
    try {
      let pairing;
      if (m.type === "pairing_start") {
        if (!remoteEnabled) throw new Error("channel_disabled");
        pairing = identity.start();
      }
      if (m.type === "pairing_cancel") identity.cancel(m.pairingId);
      if (m.type === "owner_remove") identity.remove(m.channel, m.account);
      send({ type: "identity_result", requestId: m.requestId, ok: true, owners: identity.list(), ...(pairing ? { pairing } : {}) });
    } catch (e) {
      send({ type: "identity_result", requestId: m.requestId, ok: false,
        error: ["invalid_owner", "identity_config_invalid", "identity_save_failed", "pairing_code_unavailable", "channel_disabled"].includes(e.message) ? e.message : "identity_unavailable" });
    }
  }
  else if (m.type === "pause") {
    router.setPaused(m.paused);
    send({ type: "paused", paused: router.isPaused() });
    reminders.wake();
  }
  else if (m.type === "reload") instances.reload().catch(() => log("reload_error"));
  else if (m.type === "chat_cancel" && !shuttingDown) instances.cancelLocal().catch(() => log("chat_cancel_error"));
  else if (m.type === "chat_send" && !shuttingDown) {
    const sessionId = typeof m.sessionId === "string" ? m.sessionId : "local-main";
    if (typeof m.text !== "string" || !m.text.trim() || m.text.length > 100000) {
      send({ type: "chat_result", id: m.id, instance: "local", sessionId, ok: false, error: "invalid_message" });
    } else {
      if (/^local-[A-Za-z0-9_-]{1,100}$/.test(sessionId)) { try { reminderStore.setActive({ kind: "local" }); } catch { log("reminder_route_unavailable"); } }
      instances.turn("local", sessionId, m.text).then(
      (r) => { send({ type: "chat_result", id: m.id, instance: "local", sessionId, ...r }); reminders.wake(); },
      () => send({ type: "chat_result", id: m.id, instance: "local", sessionId, ok: false, error: "engine_unavailable" }),
      );
    }
  }
  else if (m.type === "approval_answer") {
    approvalWaiters.get(String(m.id))?.done(m.outcome);
  } else if (m.type === "shutdown") shutdown("ipc");
});
// Parent gone → do not leave the DSH runtime orphaned.
process.on("disconnect", () => shutdown("parent_disconnect"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log("core_boot", "owners=" + identity.list().length);
publishReminderCatalog();
send({ type: "ready" });
if (remoteEnabled) qq.start();
// Warm the engine so the first message does not pay the cold start; no key → stays "no_key".
instances.start().catch(() => log("engine_start_error"));
reminders.start();
const licenseWatch = setInterval(() => { if (!shuttingDown && !licenseGate.inspect().valid) shutdown("license_invalid"); }, 1000);
licenseWatch.unref();
