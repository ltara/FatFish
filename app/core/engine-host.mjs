/**
 * EngineHost — owns the DSH runtime process for Core.
 * - installs the fatfish profile into $DSH_HOME/profiles/fatfish on every start
 * - spawns the pinned runtime (stdio JSON-RPC), initializes the model route
 * - serializes turns, resumes persisted sessions on first use after a (re)start
 * - restarts on crash (backoff) and when key / persona / model change (sdk profile has no HMR)
 * - answers the fatfish-approval plugin over loopback HTTP, delegating to `onApproval`
 * Never logs message text or keys.
 */
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { DshClient, assistantText } from "./dsh-client.mjs";
import { CORE_DIR, paths, loadConfig, loadKey, loadPersona, log, redact } from "./paths.mjs";

const PROFILE = "fatfish";
const EXE_NAME = "deepseek-harness-sdk-runtime-win-x64.exe";
const TURN_TIMEOUT_MS = 180000;
const APPROVAL_TIMEOUT_MS = 120000;
const OUTCOMES = new Set(["allowed-once", "rejected", "cancelled"]);

export function resolveDshExe() {
  if (process.env.FATFISH_DSH_EXE) return process.env.FATFISH_DSH_EXE;
  const candidates = [
    join(CORE_DIR, "..", "..", "vendor", "dsh", EXE_NAME), // dev: <repo>/app/core
    join(CORE_DIR, "..", "vendor", "dsh", EXE_NAME), // packaged: <resources>/core
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

function installProfile() {
  const src = join(CORE_DIR, "profile");
  const dst = join(paths.dshHome, "profiles", PROFILE);
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) copyFileSync(join(src, f), join(dst, f));
}

/** Child env: drop inherited DSH_* / DEEPSEEK_* (e.g. a user-set DSH_PERMISSION_MODE) before adding ours. */
function engineEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(DSH_|DEEPSEEK_|FATFISH_)/i.test(k)) continue;
    env[k] = v;
  }
  // Dev-only redirect (e.g. a recording proxy); never set in production.
  if (process.env.FATFISH_DEV_DEEPSEEK_BASE_URL) env.DEEPSEEK_BASE_URL = process.env.FATFISH_DEV_DEEPSEEK_BASE_URL;
  return { ...env, ...extra };
}

export class EngineHost extends EventEmitter {
  constructor({ onApproval } = {}) {
    super();
    this.onApproval = onApproval || (async () => "rejected");
    this.state = "stopped"; // stopped | starting | ready | no_key | missing_runtime | crashed
    this.client = null;
    this.startedWith = null;
    this.opened = new Set();
    this.queue = Promise.resolve();
    this.restartDelay = 2000;
    this.stopping = false;
    this.approvalToken = randomBytes(24).toString("hex");
  }

  #setState(state, extra = {}) {
    this.state = state;
    this.emit("state", { state, ...extra });
  }

  async #startApprovalServer() {
    if (this.approvalServer) return;
    this.approvalServer = http.createServer((req, res) => {
      if (req.method !== "POST" || req.headers.authorization !== `Bearer ${this.approvalToken}`) {
        res.writeHead(401).end();
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let outcome = "rejected";
        try {
          const p = JSON.parse(body || "{}");
          log("approval_request", "tool=" + p.toolName, "session=" + p.sessionId);
          const answer = await Promise.race([
            this.onApproval(p),
            new Promise((r) => setTimeout(() => r("rejected"), APPROVAL_TIMEOUT_MS)),
          ]);
          if (OUTCOMES.has(answer)) outcome = answer;
        } catch {
          /* fail closed */
        }
        log("approval_answer", outcome);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ outcome }));
      });
    });
    await new Promise((r) => this.approvalServer.listen(0, "127.0.0.1", r));
  }

  #wanted() {
    const cfg = loadConfig();
    return { key: loadKey(), persona: loadPersona(), provider: cfg.model.provider, model: cfg.model.model };
  }

  async start() {
    this.stopping = false;
    const want = this.#wanted();
    if (!want.key) {
      this.#setState("no_key");
      return false;
    }
    const exe = resolveDshExe();
    if (!exe) {
      this.#setState("missing_runtime");
      return false;
    }
    this.#setState("starting");
    installProfile();
    await this.#startApprovalServer();

    const client = new DshClient({
      exe,
      profile: PROFILE,
      cwd: paths.workspace,
      env: engineEnv({
        DSH_HOME: paths.dshHome,
        DEEPSEEK_API_KEY: want.key,
        TZ: "Asia/Shanghai",
        FATFISH_PERSONA: want.persona,
        FATFISH_APPROVAL_URL: `http://127.0.0.1:${this.approvalServer.address().port}/approval`,
        FATFISH_APPROVAL_TOKEN: this.approvalToken,
        FATFISH_APPROVAL_TIMEOUT_MS: String(APPROVAL_TIMEOUT_MS),
      }),
    });
    client.start();
    this.client = client;
    this.opened = new Set();
    client.exited.then(({ code, sig }) => this.#onExit(client, code, sig));

    const t0 = Date.now();
    try {
      await client.request("initialize", { cwd: paths.workspace, provider: want.provider, model: want.model }, 60000);
    } catch (e) {
      log("engine_init_failed", redact(e.message), redact(client.stderrTail.slice(-600)));
      await client.shutdown();
      this.#setState("crashed", { error: "init_failed" });
      return false;
    }
    this.startedWith = want;
    this.restartDelay = 2000;
    log("engine_ready", "pid=" + client.child.pid, "init_ms=" + (Date.now() - t0), "model=" + want.model);
    this.#setState("ready");
    return true;
  }

  #onExit(client, code, sig) {
    if (client !== this.client) return;
    this.client = null;
    if (this.stopping) return;
    log("engine_exit", "code=" + code, "sig=" + sig, redact(client.stderrTail.slice(-400)));
    this.#setState("crashed", { error: "exited" });
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 30000);
    setTimeout(() => {
      if (!this.client && !this.stopping) this.start().catch((e) => log("engine_restart_error", redact(e.message)));
    }, delay);
  }

  async stop() {
    this.stopping = true;
    const c = this.client;
    this.client = null;
    if (c) await c.shutdown();
    this.#setState("stopped");
  }

  /** Restart if key / persona / model changed since this runtime started (config is startup-only). */
  async #ensureFresh() {
    const want = this.#wanted();
    const w = this.startedWith;
    const stale = !this.client || !w || w.key !== want.key || w.persona !== want.persona ||
      w.provider !== want.provider || w.model !== want.model;
    if (!stale) return this.state === "ready";
    if (this.client) {
      log("engine_reload", "reason=config_changed");
      await this.stop();
    }
    return this.start();
  }

  async #ensureSession(sessionId) {
    if (this.opened.has(sessionId)) return;
    try {
      await this.client.request("session/resume", { sessionId }, 30000);
      log("session_resumed", sessionId);
    } catch {
      // Unknown id: the first session/prompt creates it.
    }
    this.opened.add(sessionId);
  }

  /**
   * Run one turn. Resolves { ok: true, text } with the final assistant text,
   * or { ok: false, error } where error ∈ no_key | missing_runtime | engine_unavailable | turn_timeout | engine_exited | turn_failed.
   */
  turn(sessionId, text) {
    const run = async () => {
      if (!(await this.#ensureFresh())) {
        return { ok: false, error: ["no_key", "missing_runtime"].includes(this.state) ? this.state : "engine_unavailable" };
      }
      await this.#ensureSession(sessionId);
      const t0 = Date.now();
      try {
        const r = await this.client.prompt(sessionId, text, TURN_TIMEOUT_MS);
        const final = r.texts.length ? r.texts[r.texts.length - 1] : "";
        const kind = r.endReason?.kind || "unknown";
        log("turn_end", "session=" + sessionId, "kind=" + kind, "ms=" + (Date.now() - t0), "chars=" + final.length);
        if (!final) return { ok: false, error: "turn_failed", detail: kind };
        return { ok: true, text: final };
      } catch (e) {
        log("turn_error", "session=" + sessionId, redact(e.message));
        return { ok: false, error: e.message === "turn_timeout" || e.message === "engine_exited" ? e.message : "turn_failed" };
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

export { assistantText };
