/** One isolated DSH process. Core owns routing and the gateway; DSH owns permissions. */
import { EventEmitter } from "node:events";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { DshClient, assistantText } from "./dsh-client.mjs";
import { classifyTurnFailure } from "./turn-errors.mjs";
import { CORE_DIR, paths, loadPersona, log } from "./paths.mjs";
import workspaceConfig from "./workspace-config.cjs";
import modelConfig from "./model-config.cjs";
import licenseModule from "./license-gate.cjs";

const EXE_NAME = "deepseek-harness-sdk-runtime-win-x64.exe";
const TURN_TIMEOUT_MS = 180000;

export function resolveDshExe() {
  if (process.env.FATFISH_DSH_EXE) return process.env.FATFISH_DSH_EXE;
  return [join(CORE_DIR, "..", "..", "vendor", "dsh", EXE_NAME),
    join(CORE_DIR, "..", "vendor", "dsh", EXE_NAME)].find((p) => existsSync(p)) || null;
}

export function installProfile(profile, dshHome) {
  if (!["fatfish-external", "fatfish-local"].includes(profile)) throw new Error("unknown_profile");
  const base = resolve(dshHome, "profiles");
  const dst = resolve(base, profile);
  // Only replace our exact managed profile, never the home, sessions or user directories.
  if (!dst.startsWith(base + sep) || dst !== join(base, profile)) throw new Error("unsafe_profile_path");
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  cpSync(join(CORE_DIR, "profiles", profile), dst, { recursive: true });
  cpSync(join(CORE_DIR, "profiles", "plugins"), join(dst, "plugins"), { recursive: true });
}

/** Do not inherit permission overrides, host skill paths or another instance's credentials. */
export function engineEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DSH_|DEEPSEEK_|FATFISH_)/i.test(k)));
  if (process.env.FATFISH_DEV_DEEPSEEK_BASE_URL) env.DEEPSEEK_BASE_URL = process.env.FATFISH_DEV_DEEPSEEK_BASE_URL;
  return { ...env, ...extra };
}

const SUFFIX = {
  external: "你正在通过聊天渠道和主人说话。请用纯文本，不用标题、列表符号和代码块。你无法操作电脑；主人需要操作电脑时，请让他回到电脑前的肥鱼窗口。你和主人的对话连续保存，程序重启后依然在，不要说自己会忘记。主人明确要求长期记住时使用 memory_save，可能用得上以前事实时先 memory_search；范围由核心决定，公开资料只能读。主人设提醒时用 remind_create，查提醒用 remind_list，取消用 remind_delete；工具失败时不能声称已经设置成功。",
  local: "你正在肥鱼窗口里和主人对话。涉及电脑操作时遵守权限与审批结果。长期记忆请用 memory_save，以前的事实先 memory_search，不要自行创建记忆文件。工具被拒绝、超时或失败时不得声称已执行成功。对话连续保存，程序重启后依然在；删除记忆会从新的模型会话继续。主人设提醒时用 remind_create，查提醒用 remind_list，取消用 remind_delete，不要自行启动后台脚本来计时。",
};

export class EngineHost extends EventEmitter {
  constructor({ name, profile, dshHome, workspace, extraPatches = [], gatewayEnv = {} }) {
    super();
    if (!SUFFIX[name]) throw new Error("unknown_instance");
    Object.assign(this, { name, profile, dshHome, workspace, extraPatches, gatewayEnv });
    this.state = "stopped";
    this.client = null;
    this.startedWith = null;
    this.opened = new Set();
    this.queue = Promise.resolve();
    this.restartDelay = 2000;
    this.stopping = false;
    this.disposed = false;
    this.activeSessionId = null;
    this.activeContext = null;
    this.crashTimes = [];
    this.cancelEpoch = 0;
  }

  #setState(state, extra = {}) {
    this.state = state;
    this.emit("state", { instance: this.name, state, crashCount: this.crashTimes.length, ...extra });
  }

  #wanted() {
    const license = new licenseModule.LicenseGate(paths.root).inspect();
    if (!license.valid) return { licenseError: license.error };
    let model, modelError = false;
    try { model = modelConfig.read(paths.root); } catch { modelError = true; }
    let workspace = this.workspace, workspaceError = false;
    if (this.name === "local") { try { workspace = workspaceConfig.forEngine(paths.root).path; } catch { workspaceError = true; } }
    return { licenseError: license.valid ? null : license.error, key: model?.key, persona: loadPersona(), provider: model?.route.provider, model: model?.route.model, modelState: model,
      modelIdentity: model ? JSON.stringify([model.route, model.generation]) : null, modelError, workspace, workspaceError };
  }

  start() {
    if (this.disposed) return Promise.resolve(false);
    if (this.starting) return this.starting;
    if (this.client && this.state === "ready") return Promise.resolve(true);
    this.starting = this.#start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async #start() {
    this.stopping = false;
    const want = this.#wanted();
    if (want.licenseError) { this.#setState("activation_required", { error: want.licenseError }); return false; }
    if (want.modelError) { this.#setState("model_config_invalid", { error: "model_config_invalid" }); return false; }
    if (!want.key) { this.#setState("no_key"); return false; }
    if (want.workspaceError) { this.#setState("workspace_unavailable", { error: "workspace_unavailable" }); return false; }
    const exe = resolveDshExe();
    if (!exe) { this.#setState("missing_runtime"); return false; }
    this.#setState("starting");
    this.workspace = want.workspace;
    if (this.name !== "local") mkdirSync(this.workspace, { recursive: true });
    installProfile(this.profile, this.dshHome);
    const selected = modelConfig.runtime(want.modelState), modelPatch = join(this.dshHome, "model.patch.json");
    const tempPatch = modelPatch + "." + randomUUID() + ".tmp";
    try {
      if (existsSync(modelPatch) && (lstatSync(modelPatch).isSymbolicLink() || !lstatSync(modelPatch).isFile())) throw new Error("model_patch_invalid");
      writeFileSync(tempPatch, JSON.stringify(selected.patch) + "\n", { mode: 0o600, flag: "wx" }); renameSync(tempPatch, modelPatch);
    } catch { this.#setState("model_config_invalid", { error: "model_patch_invalid" }); return false; }
    finally { try { unlinkSync(tempPatch); } catch { /* only our generated metadata temp */ } }
    const client = new DshClient({
      exe, profile: this.profile, args: [...this.extraPatches.flatMap((p) => ["--patch", resolve(p)]), "--patch", modelPatch], cwd: this.workspace,
      env: engineEnv({ DSH_HOME: this.dshHome, ...selected.env, TZ: "Asia/Shanghai",
        FATFISH_PERSONA: want.persona, FATFISH_PERSONA_SUFFIX: SUFFIX[this.name], ...this.gatewayEnv }),
    });
    client.start();
    this.client = client;
    this.opened = new Set();
    client.onNotification((method, p) => {
      if (method === "session.event") this.emit("event", { instance: this.name,
        sessionId: p.sessionId === this.activeSessionId ? this.activeContext?.logicalSessionId || p.sessionId : p.sessionId, event: p.event });
    });
    client.exited.then(({ code, sig }) => this.#onExit(client, code, sig));
    const t0 = Date.now();
    try {
      await client.request("initialize", { cwd: this.workspace, provider: selected.provider, model: selected.model }, 60000);
      if (this.stopping || this.disposed || this.client !== client) return false;
    } catch {
      // Never persist raw stderr or model errors: they may contain message text or credentials.
      log("engine_init_failed", "instance=" + this.name, "stderr_chars=" + client.stderrTail.length);
      if (this.client === client) this.client = null;
      await client.shutdown();
      if (!this.stopping && !this.disposed) this.#setState("crashed", { error: "init_failed" });
      return false;
    }
    this.startedWith = want;
    if (!this.crashTimes.length) this.restartDelay = 2000;
    log("engine_ready", "instance=" + this.name, "pid=" + client.child.pid, "init_ms=" + (Date.now() - t0));
    this.#setState("ready", { pid: client.child.pid });
    if (this.crashTimes.length) {
      this.stableTimer = setTimeout(() => {
        if (this.client !== client || this.state !== "ready") return;
        this.crashTimes = [];
        this.restartDelay = 2000;
        this.#setState("ready", { pid: client.child.pid });
      }, 60000);
      this.stableTimer.unref?.();
    }
    return true;
  }

  #onExit(client, code, sig) {
    if (client !== this.client) return;
    this.client = null;
    if (this.stopping || this.disposed) return;
    log("engine_exit", "instance=" + this.name, "code=" + code, "sig=" + sig);
    this.crashTimes = this.crashTimes.filter((at) => at > Date.now() - 60000);
    this.crashTimes.push(Date.now());
    this.#setState("crashed", { error: "engine_crashed" });
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 30000);
    clearTimeout(this.restartTimer);
    clearTimeout(this.stableTimer);
    this.restartTimer = setTimeout(() => {
      if (!this.client && !this.stopping && !this.disposed) this.start().catch(() => this.#setState("crashed", { error: "restart_failed" }));
    }, delay);
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.stableTimer);
    const c = this.client;
    this.client = null;
    if (c) await c.shutdown();
    if (this.starting) await this.starting;
    this.#setState("stopped");
  }

  async dispose() { this.disposed = true; await this.stop(); }

  async cancel() { this.cancelEpoch++; await this.stop(); }

  async #ensureFresh() {
    if (this.disposed) return false;
    if (this.starting) await this.starting;
    if (this.disposed) return false;
    const want = this.#wanted();
    if (want.licenseError) { await this.stop(); this.#setState("activation_required", { error: want.licenseError }); return false; }
    if (want.modelError) { await this.stop(); this.#setState("model_config_invalid", { error: "model_config_invalid" }); return false; }
    if (want.workspaceError) { await this.stop(); this.#setState("workspace_unavailable", { error: "workspace_unavailable" }); return false; }
    const w = this.startedWith;
    const stale = !this.client || !w || w.key !== want.key || w.persona !== want.persona ||
      w.modelIdentity !== want.modelIdentity || w.workspace !== want.workspace;
    if (!stale) return this.state === "ready";
    if (this.client || this.starting) await this.stop();
    return this.start();
  }

  #enqueue(run) {
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  reload() { return this.#enqueue(() => this.#ensureFresh()); }

  turn(sessionId, text, context = {}) {
    const epoch = this.cancelEpoch;
    return this.#enqueue(async () => {
      if (epoch !== this.cancelEpoch) return { ok: false, error: "cancelled" };
      const fresh = await this.#ensureFresh();
      if (epoch !== this.cancelEpoch) return { ok: false, error: "cancelled" };
      if (!fresh) return { ok: false, error: ["no_key", "missing_runtime", "workspace_unavailable", "model_config_invalid"].includes(this.state) ? this.state : "engine_unavailable" };
      const client = this.client;
      if (!this.opened.has(sessionId)) {
        try { await client.request("session/resume", { sessionId }, 30000); }
        catch { /* first prompt creates an unknown session */ }
        this.opened.add(sessionId);
      }
      this.activeSessionId = sessionId;
      this.activeContext = context;
      const t0 = Date.now();
      let result;
      let toolCalls = 0;
      // Ignore stale stderr from an earlier turn when considering transport fallback.
      client.stderrTail = "";
      try {
        const r = await client.prompt(sessionId, text, TURN_TIMEOUT_MS);
        const final = r.texts.at(-1) || "";
        toolCalls = r.events.filter((e) => e.type === "tool/call").length;
        result = final && r.endReason?.kind === "completed" ? { ok: true, text: final } :
          { ok: false, error: classifyTurnFailure({ ...r, stderr: client.stderrTail }) };
      } catch (e) {
        if (e.message === "turn_timeout") await this.stop();
        result = { ok: false, error: classifyTurnFailure({ exception: e, stderr: client.stderrTail }) };
      } finally {
        this.activeSessionId = null;
        this.activeContext = null;
      }
      if (epoch !== this.cancelEpoch) result = { ok: false, error: "cancelled" };
      log("turn_end", "instance=" + this.name, "ok=" + result.ok, "error=" + (result.error || "none"), "kind=" + (result.detail || "none"), "tool_calls=" + toolCalls, "ms=" + (Date.now() - t0));
      if (result.ok && this.crashTimes.length) {
        this.crashTimes = [];
        this.restartDelay = 2000;
        this.#setState("ready", { pid: client.child.pid });
      }
      this.emit("turn_end", { instance: this.name, sessionId: context.logicalSessionId || sessionId, ok: result.ok, error: result.error, toolCalls });
      return result;
    });
  }
}

export { assistantText };
