/**
 * FatFish Core — entry point. Wires EngineHost (DSH) ↔ Router ↔ channels.
 * Started by Electron with an IPC channel (fork); also runs standalone for dev:
 *   FATFISH_APPDATA=/tmp/fatfish-dev node server.mjs
 *
 * IPC (when process.send exists)
 *   → parent: { type: "engine", state } | { type: "channel", id, state } | { type: "self", id, userId, nickname }
 *             { type: "stats", ...counters } | { type: "turn_error", error } | { type: "approval", id, ...request }
 *   ← parent: { type: "pause", paused } | { type: "reload" } | { type: "approval_answer", id, outcome } | { type: "shutdown" }
 */
import { EngineHost } from "./engine-host.mjs";
import { QQChannel } from "./channels/qq.mjs";
import { Router } from "./router.mjs";
import { ensureDirs, loadConfig, loadToken, log, redact } from "./paths.mjs";

ensureDirs();
const send = typeof process.send === "function" ? (m) => process.connected && process.send(m) : () => {};

// Approvals go to the Electron UI; with no UI attached they fail closed.
const approvalWaiters = new Map();
let approvalSeq = 0;
function askApproval(req) {
  if (typeof process.send !== "function") return Promise.resolve("rejected");
  const id = String(++approvalSeq);
  send({ type: "approval", id, ...req });
  return new Promise((resolve) => approvalWaiters.set(id, resolve));
}

const engine = new EngineHost({ onApproval: askApproval });
const router = new Router({ engine });
const cfg = loadConfig();
const qq = new QQChannel({ url: cfg.onebot_url, token: loadToken() });

engine.on("state", (s) => {
  log("engine_state", s.state, s.error || "");
  send({ type: "engine", ...s });
});
qq.on("status", (state) => send({ type: "channel", id: qq.id, state }));
send({ type: "stats", ...router.getStats() });
qq.on("self", (s) => send({ type: "self", id: qq.id, ...s }));
router.on("stats", (s) => send({ type: "stats", ...s }));
router.on("turn_error", (e) => send({ type: "turn_error", ...e }));
router.attach(qq);

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("core_shutdown", reason);
  for (const resolve of approvalWaiters.values()) resolve("cancelled");
  qq.stop();
  await engine.stop().catch(() => {});
  process.exit(0);
}

process.on("message", (m) => {
  if (!m || typeof m !== "object") return;
  if (m.type === "pause") router.setPaused(m.paused);
  else if (m.type === "reload") engine.stop().then(() => engine.start()).catch((e) => log("reload_error", redact(e.message)));
  else if (m.type === "approval_answer") {
    const resolve = approvalWaiters.get(String(m.id));
    approvalWaiters.delete(String(m.id));
    resolve?.(m.outcome);
  } else if (m.type === "shutdown") shutdown("ipc");
});
// Parent gone → do not leave the DSH runtime orphaned.
process.on("disconnect", () => shutdown("parent_disconnect"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log("core_boot", "owner=" + (cfg.owner_qq ? "set" : "unset"), "model=" + cfg.model.model);
qq.start();
// Warm the engine so the first message does not pay the cold start; no key → stays "no_key".
engine.start().catch((e) => log("engine_start_error", redact(e.message)));
