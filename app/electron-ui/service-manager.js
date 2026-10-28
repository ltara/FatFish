/**
 * FatFish local service manager — start/stop backend (Win launcher) and core.
 * Core is forked with an IPC channel; its messages are cached here and re-emitted as "core-message".
 * User-facing strings must never name upstream components (see CLAUDE.md).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { spawn, fork, execFile } = require("node:child_process");

const channelConfig = require("../core/channel-config.cjs");

const CORE_SHUTDOWN_GRACE_MS = 8000;

const DEFAULT_LOGIN_PORT = 6099;
const DEFAULT_BACKEND_PORT = 3001;

/** @typedef {'idle'|'starting'|'running'|'degraded'|'stopped'|'error'} Phase */

/**
 * @returns {{
 *   phase: Phase,
 *   error: string|null,
 *   error_code: string|null,
 *   backend: boolean,
 *   core: boolean,
 *   login_port: number,
 *   backend_port: number,
 *   pids: { backend?: number, core?: number }
 * }}
 */
function emptyState() {
  return {
    phase: "idle",
    error: null,
    error_code: null,
    backend: false,
    core: false,
    login_port: DEFAULT_LOGIN_PORT,
    backend_port: DEFAULT_BACKEND_PORT,
    pids: {},
  };
}

/** Last-known Core snapshot, built from its IPC messages (see app/core/server.mjs header). */
function emptyCore() {
  return { engine: "stopped", engine_error: null, engines: {}, channels: {}, self: {}, stats: null, last_turn_error: null, paused: true };
}

class ServiceManager extends EventEmitter {
  /**
   * @param {{ appDataRoot: string, isPackaged?: boolean, resourcesPath?: string, electronExecPath?: string }} opts
   */
  constructor(opts) {
    super();
    this.appDataRoot = opts.appDataRoot;
    this.isPackaged = !!opts.isPackaged;
    this.resourcesPath = opts.resourcesPath || process.resourcesPath || "";
    this.electronExecPath = opts.electronExecPath || process.execPath;
    this._children = {
      backend: null,
      core: null,
    };
    this._pids = {};
    this._state = emptyState();
    this._core = emptyCore();
    this._coreRequests = new Map();
    this._chatRequests = new Map();
    this._startPromise = null;
  }

  getState() {
    return { ...this._state, pids: { ...this._pids } };
  }

  getCore() {
    return JSON.parse(JSON.stringify(this._core));
  }

  /** Send a command to Core; returns false when Core is not running. */
  sendCore(msg) {
    const c = this._children.core;
    if (!c || !c.connected) return false;
    try {
      c.send(msg);
      return true;
    } catch {
      return false;
    }
  }

  requestCore(type, payload = {}, timeoutMs = 10000) {
    if (!["owners_get", "pairing_start", "pairing_cancel", "owner_remove", "channel_set", "memory_ui", "workspace_ui", "model_ui"].includes(type)) {
      return Promise.resolve({ ok: false, error: "invalid_request" });
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const finish = (result) => {
        clearTimeout(timer);
        this._coreRequests.delete(requestId);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: "core_timeout" }), timeoutMs);
      this._coreRequests.set(requestId, finish);
      if (!this.sendCore({ ...payload, type, requestId })) finish({ ok: false, error: "core_unavailable" });
    });
  }

  _identityUnavailable() {
    for (const finish of this._coreRequests.values()) finish({ ok: false, error: "core_unavailable" });
    this.emit("identity-event", { type: "unavailable" });
    for (const finish of this._chatRequests.values()) finish({ ok: false, error: "core_unavailable" });
  }

  _onCoreMessage(m) {
    if (!m || typeof m !== "object") return;
    const core = this._core;
    if (m.type === "ready") {
      this.sendCore({ type: "pause", paused: this.readPaused() });
    } else if (m.type === "paused") {
      core.paused = !!m.paused;
    } else if (m.type === "identity_result" || m.type === "channel_result" || m.type === "memory_result" || m.type === "workspace_result" || m.type === "model_result") {
      this._coreRequests.get(m.requestId)?.(m);
    } else if (m.type === "owners" || m.type === "pairing") {
      this.emit("identity-event", m);
    } else if (m.type === "engine") {
      const instance = m.instance || "external";
      core.engines[instance] = { state: m.state, error: m.error || null, crashCount: m.crashCount || 0, pid: m.pid || null };
      // Preserve the existing home-page contract: it represents remote companionship.
      if (instance === "external") {
        core.engine = m.state;
        core.engine_error = m.error || null;
        if (m.state === "ready" && core.last_turn_error?.error === "engine_crashed") core.last_turn_error = null;
      }
    } else if (m.type === "channel") {
      core.channels[m.id] = m.state;
    } else if (m.type === "self") {
      core.self[m.id] = { userId: m.userId, nickname: m.nickname };
    } else if (m.type === "stats") {
      const { type, ...stats } = m;
      core.stats = stats;
    } else if (m.type === "turn_error") {
      core.last_turn_error = { error: m.error, at: Date.now() };
    } else if (m.type === "turn_end" && m.instance === "external" && m.ok) {
      core.last_turn_error = null;
    } else if (m.type === "chat_result") {
      core.last_local_turn_error = m.ok ? null : { error: m.error, at: Date.now() };
      this._chatRequests.get(m.id)?.(m);
    } else if (m.type === "approval" && this.listenerCount("approval") === 0) {
      // No approval UI attached yet (M4): fail closed.
      this.sendCore({ type: "approval_answer", id: m.id, outcome: "rejected" });
    }
    if (m.type === "approval") this.emit("approval", m);
    if (m.type === "approval_closed") this.emit("approval-closed", m);
    this.emit("core-message", m);
  }

  chatTurn(sessionId, text) {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const finish = (result) => { clearTimeout(timer); this._chatRequests.delete(id); resolve(result); };
      const timer = setTimeout(() => {
        this.sendCore({ type: "chat_cancel" });
        finish({ ok: false, error: "turn_timeout" });
      }, 185000);
      this._chatRequests.set(id, finish);
      if (!this.sendCore({ type: "chat_send", id, sessionId, text })) finish({ ok: false, error: "core_unavailable" });
    });
  }

  /** Repo root (dev) or resources root (prod). */
  resolveBundleRoot() {
    if (this.isPackaged && this.resourcesPath) {
      return this.resourcesPath;
    }
    // app/electron-ui → repo root
    return path.resolve(__dirname, "..", "..");
  }

  resolveAppDataRoot() {
    return this.appDataRoot;
  }

  ensureAppData() {
    const root = this.appDataRoot;
    const secrets = path.join(root, "secrets");
    const logs = path.join(root, "logs");
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(secrets, { recursive: true });
    fs.mkdirSync(logs, { recursive: true });
    fs.mkdirSync(runtime, { recursive: true });

    const tokenPath = path.join(secrets, "local_token");
    if (!fs.existsSync(tokenPath) || !fs.readFileSync(tokenPath, "utf8").trim()) {
      fs.writeFileSync(tokenPath, crypto.randomBytes(16).toString("hex") + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
    }

    const configPath = path.join(root, "config.json");
    if (!fs.existsSync(configPath)) {
      const cfg = {
        onebot_url: "ws://127.0.0.1:3001",
        onebot_host: "127.0.0.1",
        onebot_port: DEFAULT_BACKEND_PORT,
        login_ui_port: DEFAULT_LOGIN_PORT,
        owners: [],
        channels: { qq: { enabled: false } },
        bind: "127.0.0.1",
      };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    }

    require("./persona-lib").ensurePersonaLib(root);
    return this.readPorts();
  }

  readPaused() {
    try {
      const file = path.join(this.appDataRoot, "runtime", "outbound_paused");
      return fs.existsSync(file) && fs.readFileSync(file, "utf8").trim() === "1";
    } catch { return true; }
  }

  readQqEnabled() {
    try { return channelConfig.qqEnabled(channelConfig.readConfig(path.join(this.appDataRoot, "config.json"))); }
    catch { return false; }
  }

  async setQqEnabled(enabled) {
    const run = async () => {
      const result = await this.requestCore("channel_set", { enabled }, 60000);
      if (!result.ok) return result;
      if (enabled) await this.startAll();
      else {
        const child = this._children.backend;
        if (child) await this.killTree(child.pid, child);
        this._children.backend = null;
        this.clearPidFile("napcat");
        this._state.backend = false;
        this._state.login_reachable_hint = false;
        if (this._state.core) { this._state.phase = "running"; this._state.error = null; this._state.error_code = null; }
      }
      return { ok: true, enabled, state: this.getState() };
    };
    const pending = (this._channelChange || Promise.resolve()).then(run, run);
    this._channelChange = pending.catch(() => {});
    return pending;
  }

  readPorts() {
    let login = DEFAULT_LOGIN_PORT;
    let backend = DEFAULT_BACKEND_PORT;
    try {
      const configPath = path.join(this.appDataRoot, "config.json");
      if (fs.existsSync(configPath)) {
        const j = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (j.login_ui_port) login = Number(j.login_ui_port) || login;
        if (j.onebot_port) backend = Number(j.onebot_port) || backend;
      }
    } catch {
      /* ignore */
    }
    if (process.env.FATFISH_LOGIN_PORT) {
      const n = Number(process.env.FATFISH_LOGIN_PORT);
      if (n) login = n;
    }
    this._state.login_port = login;
    this._state.backend_port = backend;
    return { login, backend };
  }

  /**
   * Read login-panel token from backend config or recent spawn logs.
   * Never expose vendor product names in user-facing strings.
   * @returns {string|null}
   */
  readWebUiToken() {
    const paths = [];
    try {
      const root = this.resolveBundleRoot();
      const napcatDir = this.resolveBackendDir(root);
      if (napcatDir) {
        paths.push(path.join(napcatDir, "config", "webui.json"));
      }
      // Also common runtime copies beside resources
      if (this.resourcesPath) {
        paths.push(path.join(this.resourcesPath, "vendor", "napcat", "config", "webui.json"));
      }
    } catch {
      /* ignore */
    }

    for (const p of paths) {
      try {
        if (!fs.existsSync(p)) continue;
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        const t = j && typeof j.token === "string" ? j.token.trim() : "";
        if (t) return t;
      } catch {
        /* ignore */
      }
    }

    // Fallback: parse recent backend spawn logs (WebUi Token: xxx / webui?token=)
    try {
      const logDir = path.join(this.appDataRoot, "logs");
      if (fs.existsSync(logDir)) {
        const files = fs
          .readdirSync(logDir)
          .filter((n) => /\.log$/i.test(n))
          .map((n) => {
            const full = path.join(logDir, n);
            try {
              return { full, mtime: fs.statSync(full).mtimeMs };
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 12);
        const reToken = /WebUi Token:\s*([A-Za-z0-9_-]+)/i;
        const reUrl = /webui\/?\?token=([A-Za-z0-9_-]+)/i;
        for (const f of files) {
          try {
            const body = fs.readFileSync(f.full, "utf8");
            let m = body.match(reToken) || body.match(reUrl);
            if (m && m[1]) return m[1].trim();
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /**
   * Login panel URL with token so the embedded view skips the manual token form.
   * Prefer /webui?token=… (matches backend log URL).
   */
  buildLoginUrl() {
    const ports = this.readPorts();
    const port = ports.login || DEFAULT_LOGIN_PORT;
    const token = this.readWebUiToken();
    if (token) {
      return `http://127.0.0.1:${port}/webui?token=${encodeURIComponent(token)}`;
    }
    return `http://127.0.0.1:${port}/webui`;
  }


  /**
   * Paths layout:
   *   Dev:  <repo>/app/core/server.mjs and vendor runtime assets
   *   Prod: <resources>/core/server.mjs and vendor runtime assets
   */
  resolvePaths() {
    const root = this.resolveBundleRoot();
    const packaged = this.isPackaged;

    const candidates = (relList) => {
      for (const rel of relList) {
        const p = path.join(root, rel);
        if (fs.existsSync(p)) return p;
      }
      return null;
    };

    const coreJs = candidates(
      packaged
        ? ["core/server.mjs", "app/core/server.mjs"]
        : ["app/core/server.mjs", "core/server.mjs"]
    );

    const coreDir = coreJs ? path.dirname(coreJs) : null;

    const napcatDir = this.resolveBackendDir(root);
    const nodeExe = this.resolveNodeExe(root);

    return { root, coreJs, coreDir, napcatDir, nodeExe };
  }

  resolveBackendDir(root) {
    const dirs = [
      path.join(root, "vendor", "napcat"),
      path.join(root, "bin", "napcat"),
      path.join(root, "napcat"),
    ];
    for (const d of dirs) {
      if (
        fs.existsSync(path.join(d, "launcher-user.bat")) ||
        fs.existsSync(path.join(d, "NapCatWinBootMain.exe")) ||
        fs.existsSync(path.join(d, "launcher.bat"))
      ) {
        return d;
      }
    }
    return null;
  }

  resolveNodeExe(root) {
    const candidates = [
      path.join(root, "vendor", "node", "node.exe"),
      path.join(root, "bin", "node", "node.exe"),
      path.join(root, "vendor", "node", "bin", "node"),
      path.join(root, "vendor", "node", "node"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  probeTcp(port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.on("connect", () => finish(true));
      socket.on("timeout", () => finish(false));
      socket.on("error", () => finish(false));
    });
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  writePid(name, pid) {
    if (!pid) return;
    this._pids[name] = pid;
    try {
      const runtime = path.join(this.appDataRoot, "runtime");
      fs.mkdirSync(runtime, { recursive: true });
      fs.writeFileSync(path.join(runtime, `${name}.pid`), String(pid) + "\n", "utf8");
    } catch {
      /* ignore */
    }
  }

  clearPidFile(name) {
    delete this._pids[name];
    try {
      const f = path.join(this.appDataRoot, "runtime", `${name}.pid`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }

  /**
   * Fork Core with an IPC channel (Electron-as-Node preferred, portable node.exe fallback).
   */
  forkCore(scriptPath, cwd) {
    const logs = path.join(this.appDataRoot, "logs");
    fs.mkdirSync(logs, { recursive: true });
    let outFd, errFd;
    try {
      outFd = fs.openSync(path.join(logs, "core.log"), "a");
      errFd = fs.openSync(path.join(logs, "core.err.log"), "a");
      const useElectron = this.electronExecPath && fs.existsSync(this.electronExecPath);
      const execPath = useElectron ? this.electronExecPath : this.resolvePaths().nodeExe || "node";
      const env = { ...process.env, FATFISH_APPDATA: this.appDataRoot };
      if (useElectron) env.ELECTRON_RUN_AS_NODE = "1";

      const child = fork(scriptPath, [], {
        cwd,
        env,
        execPath,
        stdio: ["ignore", outFd, errFd, "ipc"],
        windowsHide: true,
      });
      child.on("message", (m) => this._onCoreMessage(m));
      child.once("disconnect", () => { if (this._children.core === child) this._identityUnavailable(); });
      return child;
    } finally { for (const fd of [outFd, errFd]) if (typeof fd === "number") { try { fs.closeSync(fd); } catch {} } }
  }

  /**
   * Backend must use its own Win launcher — never Electron-as-Node.
   */
  spawnBackend(napcatDir) {
    if (process.platform !== "win32") {
      // Cross-platform skeleton: skip Win launcher on Linux box.
      return null;
    }
    let launcher = path.join(napcatDir, "launcher-user.bat");
    if (!fs.existsSync(launcher)) {
      launcher = path.join(napcatDir, "launcher.bat");
    }
    if (!fs.existsSync(launcher)) {
      return null;
    }
    // Capture launcher/boot stdout for diagnosis (timeouts, QQ path, inject).
    let stdOut = "ignore";
    let stdErr = "ignore";
    try {
      const logDir = path.join(this.appDataRoot, "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const outPath = path.join(logDir, "backend-spawn.log");
      const errPath = path.join(logDir, "backend-spawn.err.log");
      stdOut = fs.openSync(outPath, "w");
      stdErr = fs.openSync(errPath, "w");
    } catch {
      for (const fd of [stdOut, stdErr]) if (typeof fd === "number") { try { fs.closeSync(fd); } catch {} }
      stdOut = "ignore";
      stdErr = "ignore";
    }
    try {
      return spawn("cmd.exe", ["/c", launcher], {
        cwd: napcatDir,
        env: { ...process.env, FATFISH_APPDATA: this.appDataRoot },
        stdio: ["ignore", stdOut, stdErr],
        windowsHide: true,
        detached: false,
      });
    } finally { for (const fd of [stdOut, stdErr]) if (typeof fd === "number") { try { fs.closeSync(fd); } catch {} } }
  }

  /**
   * Kill a process tree. On Windows prefer taskkill /T.
   * @param {number} pid
   * @param {import('child_process').ChildProcess|null} child
   */
  killTree(pid, child) {
    if (!pid && child) {
      try {
        pid = child.pid;
      } catch {
        /* ignore */
      }
    }
    if (!pid) return;

    if (process.platform === "win32") {
      return new Promise((resolve) => {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      });
    }

    try {
      if (child && !child.killed) child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }

  async waitForPort(port, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.probeTcp(port, 500)) return true;
      await this.sleep(400);
    }
    return false;
  }

  /**
   * Start all services. Safe to call concurrently — coalesces.
   */
  async startAll() {
    if (this._dataResetLocked) throw new Error("data_reset_locked");
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._startAllImpl().finally(() => {
      this._startPromise = null;
    });
    return this._startPromise;
  }

  async _startAllImpl() {
    this._state.phase = "starting";
    this._state.error = null;
    this._state.error_code = null;

    const ports = this.ensureAppData();
    const paths = this.resolvePaths();

    const qqEnabled = this.readQqEnabled();
    if (qqEnabled) {
    // --- 1) backend login service (vendor launcher → login UI + ws :3001) ---
    const backendAlready = await this.probeTcp(ports.backend);
    const loginAlready = await this.probeTcp(ports.login);

    if (!backendAlready && !loginAlready) {
      if (!paths.napcatDir) {
        this._fail(
          "missing_backend",
          "后台服务目录缺失。请重新安装完整客户端（安装包须包含后台组件）。"
        );
        // Still start Core; channel setup remains available in degraded mode.
        this._state.phase = "degraded";
      } else if (process.platform !== "win32") {
        // Dev on Linux: cannot run Win launcher — leave backend down, not a hard fail for smoke
        this._state.error_code = "backend_win_only";
        this._state.error =
          "后台登录服务仅在 Windows 上随客户端自动启动。当前环境已跳过。";
        this._state.phase = "degraded";
      } else {
        try {
          const child = this.spawnBackend(paths.napcatDir);
          if (!child) {
            this._fail(
              "spawn_backend",
              "无法启动后台登录服务（启动器缺失）。请重新安装客户端。"
            );
          } else {
            this._children.backend = child;
            if (child.pid) this.writePid("napcat", child.pid);
            child.on("exit", () => {
              if (this._children.backend !== child) return;
              this._children.backend = null;
              this.clearPidFile("napcat");
            });
            // Wait for either login UI or backend WS port
            const ready =
              (await this.waitForPort(ports.login, 45000, "login")) ||
              (await this.probeTcp(ports.backend));
            if (!ready) {
              this._state.error_code = "backend_timeout";
              this._state.error =
                "后台登录服务启动超时。请确认已安装官方 QQ，先完全退出 QQ 后以管理员重新打开肥鱼；仍失败请到「登录」页查看提示，或把 logs\\backend-spawn.log 发给客服。";
              this._state.phase = "degraded";
            }
          }
        } catch (e) {
          this._fail(
            "spawn_backend",
            "启动后台登录服务失败。" + String(e && e.message ? e.message : e).slice(0, 80)
          );
        }
      }
    }

    this._state.backend =
      (await this.probeTcp(ports.backend)) || (await this.probeTcp(ports.login));
    this._state.login_reachable_hint = await this.probeTcp(ports.login);

    } else {
      this._state.backend = false;
      this._state.login_reachable_hint = false;
    }

    // --- 2) core (engine + channels; connects ws://127.0.0.1:3001, reads AppData key/token) ---
    if (!paths.coreJs) {
      if (this._state.phase !== "degraded" && this._state.phase !== "error") {
        this._fail(
          "missing_core",
          "智能回复组件缺失。请重新安装客户端。"
        );
      }
    } else {
      // Core has no listen port — track by child only.
      if (!this._children.core || this._children.core.exitCode !== null) {
        try {
          const child = this.forkCore(paths.coreJs, paths.coreDir);
          this._children.core = child;
          this._core = emptyCore();
          if (child && child.pid) this.writePid("core", child.pid);
          child.on("exit", () => {
            if (this._children.core !== child) return;
            this._children.core = null;
            this.clearPidFile("core");
            this._state.core = false;
            this._core.engine = "stopped";
            this._identityUnavailable();
            this.emit("core-message", { type: "unavailable" });
          });
          this._state.core = true;
        } catch (e) {
          this._state.core = false;
          if (!this._state.error) {
            this._state.error_code = "spawn_core";
            this._state.error =
              "智能回复引擎启动失败。" + String(e && e.message ? e.message : e).slice(0, 80);
            this._state.phase = "degraded";
          }
        }
      } else {
        this._state.core = true;
      }
    }

    // No channel is a valid local-only state; never probe or launch a disabled backend.
    const loginUp = qqEnabled ? await this.probeTcp(ports.login) : false;
    const backendUp = qqEnabled ? await this.probeTcp(ports.backend) : false;
    this._state.backend = backendUp || loginUp;
    this._state.login_reachable_hint = loginUp;
    if (this._state.core && (!qqEnabled || this._state.backend)) {
      this._state.phase = "running"; this._state.error = null; this._state.error_code = null;
    } else if (this._state.core) {
      this._state.phase = "degraded";
      this._state.error_code ||= "backend_down";
      this._state.error ||= "伙伴核心已启动，后台登录服务还没就绪。请确认已安装官方 QQ 后重试。";
    } else this._fail("core_down", "伙伴核心未能启动，请重新打开肥鱼。");

    return this.getState();
  }

  _fail(code, message) {
    this._state.phase = "error";
    this._state.error_code = code;
    this._state.error = message;
  }

  /**
   * Stop all managed children. Idempotent.
   */
  async stopAll() {
    this._identityUnavailable();
    // Let Core shut its engine down cleanly (flushes session logs) before tree-killing.
    const core = this._children.core;
    if (core && core.exitCode === null && this.sendCore({ type: "shutdown" })) {
      await Promise.race([
        new Promise((r) => core.once("exit", r)),
        this.sleep(CORE_SHUTDOWN_GRACE_MS),
      ]);
    }

    const fileMap = {
      core: "core",
      backend: "napcat",
    };

    for (const name of Object.keys(fileMap)) {
      const child = this._children[name];
      const fileKey = fileMap[name];
      let filePid = null;
      try {
        const f = path.join(this.appDataRoot, "runtime", `${fileKey}.pid`);
        if (fs.existsSync(f)) {
          const t = fs.readFileSync(f, "utf8").trim();
          if (/^\d+$/.test(t)) filePid = Number(t);
        }
      } catch {
        /* ignore */
      }
      const killPid =
        (child && child.pid) || filePid || this._pids[fileKey] || this._pids[name] || null;
      await this.killTree(killPid, child);
      this._children[name] = null;
      this.clearPidFile(fileKey);
    }



    // "bridge" kept for pid files left by pre-Core installs.
    for (const key of ["core", "bridge", "local-server", "napcat"]) {
      try {
        const f = path.join(this.appDataRoot, "runtime", `${key}.pid`);
        if (fs.existsSync(f)) {
          const t = fs.readFileSync(f, "utf8").trim();
          if (/^\d+$/.test(t)) this.killTree(Number(t), null);
          fs.unlinkSync(f);
        }
      } catch {
        /* ignore */
      }
    }

    this._pids = {};
    this._state.phase = "stopped";
    this._state.backend = false;
    this._state.core = false;
    this._core = emptyCore();
    return this.getState();
  }

  async stopForDataReset() {
    this._dataResetLocked = true;
    // An already-starting backend must finish before stopping; no later start is permitted in this process.
    if (this._startPromise) await this._startPromise.catch(() => {});
    const children = Object.values(this._children).filter(Boolean);
    await this.stopAll();
    const deadline = Date.now() + 2000;
    const alive = (child) => {
      if (!child.pid) return false;
      try { process.kill(child.pid, 0); return true; } catch (e) { if (e.code === "ESRCH") return false; throw e; }
    };
    while (children.some(alive) && Date.now() < deadline) await this.sleep(25);
    if (children.some(alive)) throw new Error("data_reset_stop_failed");
    return true;
  }

  /**
   * Refresh live probes into state (without restarting).
   */
  async refreshProbes() {
    const ports = this.readPorts();
    const enabled = this.readQqEnabled();
    const loginUp = enabled ? await this.probeTcp(ports.login) : false;
    const backendUp = enabled ? await this.probeTcp(ports.backend) : false;
    this._state.backend = backendUp || loginUp;
    this._state.login_reachable_hint = loginUp;
    this._state.core = !!(this._children.core && this._children.core.exitCode === null);
    return this.getState();
  }
}

module.exports = {
  ServiceManager,
  DEFAULT_LOGIN_PORT,
  DEFAULT_BACKEND_PORT,
};
