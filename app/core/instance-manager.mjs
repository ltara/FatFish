/** Two v1 instances; the auto instance and its data are deliberately absent until v2. */
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { EngineHost } from "./engine-host.mjs";
import { PluginGateway } from "./gateway.mjs";
import { CORE_DIR, paths, instancePaths, migrateLegacySessions } from "./paths.mjs";
import workspaceConfig from "./workspace-config.cjs";
import modelConfig from "./model-config.cjs";

export class InstanceManager extends EventEmitter {
  constructor({ onApproval, onTool = null, memoryGeneration = 0, authorizeExternal = () => true, approvalTimeoutMs = 120000, remoteEnabled = true, idleMs = 10 * 60 * 1000, createHost = (opts) => new EngineHost(opts) } = {}) {
    super();
    this.idleMs = idleMs;
    this.activeLocalTurns = 0;
    this.stopped = false;
    this.remoteEnabled = !!remoteEnabled;
    this.memoryGeneration = memoryGeneration;
    this.authorizeExternal = authorizeExternal;
    this.externalSessionId = migrateLegacySessions();
    this.gateway = new PluginGateway({ onApproval: (request, signal) => onApproval?.({ ...request,
      sessionId: this.hosts.get(request.instance)?.activeContext?.logicalSessionId || request.sessionId }, signal), onTool, timeoutMs: approvalTimeoutMs });
    this.hosts = new Map();
    for (const name of ["external", "local"]) {
      const token = this.gateway.register(name, (sid) => {
        const h = this.hosts.get(name);
        return h?.activeSessionId === sid && !h.activeContext?.scheduled && h.activeContext?.memoryGeneration === this.memoryGeneration &&
          (name !== "external" || this.authorizeExternal(h.activeContext));
      });
      const host = createHost({ name, profile: `fatfish-${name}`, ...instancePaths(name),
        extraPatches: [join(CORE_DIR, "profiles", "common.patch.yml")], gatewayEnv: { FATFISH_GATEWAY_TOKEN: token } });
      this.hosts.set(name, host);
      host.on("state", (s) => this.emit("state", s));
      host.on("turn_end", (s) => this.emit("turn_end", s));
      host.on("event", (s) => { if (name === "local") this.emit("chat_event", s); });
    }
  }

  #initialize() {
    if (!this.initializing) this.initializing = this.gateway.start().then(() => {
      for (const host of this.hosts.values()) host.gatewayEnv.FATFISH_GATEWAY_URL = this.gateway.url;
    });
    return this.initializing;
  }

  async start() {
    await this.#initialize();
    if (this.stopped) return false;
    return this.remoteEnabled ? this.hosts.get("external").start() : true;
  }

  async setRemoteEnabled(enabled) {
    this.remoteEnabled = !!enabled;
    if (this.stopped) return;
    if (enabled) await this.start();
    else await this.hosts.get("external").stop();
  }

  #armIdle() {
    clearTimeout(this.idleTimer);
    if (this.stopped || this.activeLocalTurns) return;
    this.idleTimer = setTimeout(() => {
      this.idleStop = this.hosts.get("local").stop().finally(() => { this.idleStop = null; });
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  async turn(name, sessionId, text, actor = {}) {
    if (this.memoryReset) await this.memoryReset;
    if (this.stopped) return { ok: false, error: "engine_unavailable" };
    if (this.modelChange) return { ok: false, error: "model_busy" };
    if (name === "local" && this.workspaceChange) return { ok: false, error: "local_busy" };
    if ((name === "external" && sessionId !== this.externalSessionId) ||
        (name === "local" && !/^local-[A-Za-z0-9_-]{1,100}$/.test(sessionId)) || !this.hosts.has(name)) {
      return { ok: false, error: "invalid_session" };
    }
    const generation = this.memoryGeneration;
    let physicalSession = generation ? sessionId + "-g" + generation : sessionId;
    if (name === "local") { try { physicalSession += workspaceConfig.contextSuffix(paths.root); } catch { return { ok: false, error: "workspace_unavailable" }; } }
    try { physicalSession += modelConfig.contextSuffix(paths.root); } catch { return { ok: false, error: "model_config_invalid" }; }
    const context = { ...actor, logicalSessionId: sessionId, memoryGeneration: generation };
    const run = async () => {
      // A turn may have waited for startup/idle shutdown while a deletion reset the context.
      if (generation !== this.memoryGeneration) return { ok: true, text: "记忆已经调整好了。我们从新的一句继续聊。", memoryReset: true };
      const result = await this.hosts.get(name).turn(physicalSession, text, context);
      return generation === this.memoryGeneration ? result : { ok: true, text: "记忆已经调整好了。我们从新的一句继续聊。", memoryReset: true };
    };
    if (name !== "local") {
      if (!this.remoteEnabled) return { ok: false, error: "channel_disabled" };
      this.activeExternalTurns = (this.activeExternalTurns || 0) + 1;
      try {
        await this.#initialize();
        if (this.stopped) return { ok: false, error: "engine_unavailable" };
        return await run();
      } finally { this.activeExternalTurns--; }
    }
    this.activeLocalTurns++;
    clearTimeout(this.idleTimer);
    try {
      await this.#initialize();
      if (this.idleStop) await this.idleStop;
      if (this.stopped) return { ok: false, error: "engine_unavailable" };
      return await run();
    } finally {
      this.activeLocalTurns--;
      this.#armIdle();
    }
  }

  async reload() {
    if (this.stopped) return;
    await this.#initialize();
    clearTimeout(this.idleTimer);
    if (this.idleStop) await this.idleStop;
    if (this.stopped) return;
    try {
      await Promise.all([...this.hosts].filter(([n, h]) => (n === "external" && this.remoteEnabled) || h.client || (n === "local" && this.activeLocalTurns))
        .map(([, h]) => h.reload()));
    } finally {
      if (this.hosts.get("local").client) this.#armIdle();
    }
  }

  async cancelLocal() {
    clearTimeout(this.idleTimer);
    await this.hosts.get("local").cancel();
  }

  async setLocalWorkspace(args) {
    if (this.stopped) throw new Error("engine_unavailable");
    if (this.workspaceChange || this.modelChange || this.activeLocalTurns) throw new Error("local_busy");
    const planned = workspaceConfig.plan(paths.root, args); // Validate before stopping the old local instance.
    if (!planned.changed) return { ...planned.before, path: planned.path, changed: false };
    const change = (async () => {
      clearTimeout(this.idleTimer);
      if (this.idleStop) await this.idleStop;
      await this.hosts.get("local").cancel();
      if (this.stopped) throw new Error("engine_unavailable");
      return workspaceConfig.save(paths.root, args); // Reread config after await; preserve concurrent owner/channel updates.
    })();
    this.workspaceChange = change;
    try { return await change; } finally { if (this.workspaceChange === change) this.workspaceChange = null; }
  }

  async setModel(args) {
    if (this.stopped) throw new Error("engine_unavailable");
    if (this.modelChange || this.workspaceChange || this.activeLocalTurns || this.activeExternalTurns) throw new Error("model_busy");
    const planned = modelConfig.draft(paths.root, args);
    if (!planned.changed) return { ...modelConfig.describe(planned.current), changed: false };
    const change = (async () => {
      clearTimeout(this.idleTimer);
      await this.memoryReset?.catch(() => {});
      if (this.idleStop) await this.idleStop;
      await Promise.all([...this.hosts.values()].map((h) => h.cancel()));
      if (this.stopped) throw new Error("engine_unavailable");
      const saved = modelConfig.save(paths.root, args);
      if (this.remoteEnabled) await this.start(); // Warm only the enabled remote instance; no inference call.
      return saved;
    })();
    this.modelChange = change;
    try { return await change; } finally { if (this.modelChange === change) this.modelChange = null; }
  }

  contextFor(instance, sessionId) {
    const host = this.hosts.get(instance);
    return host?.activeSessionId === sessionId && host.activeContext?.memoryGeneration === this.memoryGeneration ? host.activeContext : null;
  }

  invalidateMemory(generation) {
    this.memoryGeneration = generation;
    clearTimeout(this.idleTimer);
    // Reply to a forgetting tool before stopping its transport. Old outputs are suppressed by run().
    const reset = (this.memoryReset || Promise.resolve()).then(async () => {
      await new Promise((r) => setImmediate(r));
      await Promise.all([...this.hosts.values()].map((h) => h.cancel()));
    });
    this.memoryReset = reset.finally(() => { if (this.memoryReset === settled) this.memoryReset = null; });
    const settled = this.memoryReset;
    settled.catch(() => {});
  }

  async stop() {
    this.stopped = true;
    await this.modelChange?.catch(() => {});
    await this.workspaceChange?.catch(() => {});
    await this.memoryReset?.catch(() => {});
    clearTimeout(this.idleTimer);
    await this.initializing?.catch(() => {});
    await this.gateway.stop();
    if (this.idleStop) await this.idleStop;
    await Promise.all([...this.hosts.values()].map((h) => h.dispose()));
  }
}
