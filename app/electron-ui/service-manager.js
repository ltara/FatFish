/**
 * FatFish local service manager — start/stop local-server, backend (Win launcher), core.
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

const CORE_SHUTDOWN_GRACE_MS = 8000;

const DEFAULT_SETTINGS_PORT = 8787;
const DEFAULT_LOGIN_PORT = 6099;
const DEFAULT_BACKEND_PORT = 3001;

/** @typedef {'idle'|'starting'|'running'|'degraded'|'stopped'|'error'} Phase */

/**
 * @returns {{
 *   phase: Phase,
 *   error: string|null,
 *   error_code: string|null,
 *   local_server: boolean,
 *   backend: boolean,
 *   core: boolean,
 *   settings_port: number,
 *   login_port: number,
 *   backend_port: number,
 *   pids: { local_server?: number, backend?: number, core?: number }
 * }}
 */
function emptyState() {
  return {
    phase: "idle",
    error: null,
    error_code: null,
    local_server: false,
    backend: false,
    core: false,
    settings_port: DEFAULT_SETTINGS_PORT,
    login_port: DEFAULT_LOGIN_PORT,
    backend_port: DEFAULT_BACKEND_PORT,
    pids: {},
  };
}

/** Last-known Core snapshot, built from its IPC messages (see app/core/server.mjs header). */
function emptyCore() {
  return { engine: "stopped", engine_error: null, channels: {}, self: {}, stats: null, last_turn_error: null };
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
      local_server: null,
      backend: null,
      core: null,
    };
    this._pids = {};
    this._state = emptyState();
    this._core = emptyCore();
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

  _onCoreMessage(m) {
    if (!m || typeof m !== "object") return;
    const core = this._core;
    if (m.type === "engine") {
      core.engine = m.state;
      core.engine_error = m.error || null;
    } else if (m.type === "channel") {
      core.channels[m.id] = m.state;
    } else if (m.type === "self") {
      core.self[m.id] = { userId: m.userId, nickname: m.nickname };
    } else if (m.type === "stats") {
      const { type, ...stats } = m;
      core.stats = stats;
    } else if (m.type === "turn_error") {
      core.last_turn_error = { error: m.error, at: Date.now() };
    } else if (m.type === "approval" && this.listenerCount("approval") === 0) {
      // No approval UI attached yet (M4): fail closed.
      this.sendCore({ type: "approval_answer", id: m.id, outcome: "rejected" });
    }
    if (m.type === "approval") this.emit("approval", m);
    this.emit("core-message", m);
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
        settings_port: DEFAULT_SETTINGS_PORT,
        login_ui_port: DEFAULT_LOGIN_PORT,
        bind: "127.0.0.1",
      };
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    }

    try {
      const personaLib = require("./persona-lib");
      personaLib.ensurePersonaLib(root);
    } catch {
      const personaPath = path.join(root, "persona.txt");
      if (!fs.existsSync(personaPath)) {
        const ex = path.join(this.resolveBundleRoot(), "bridge", "persona.example.txt");
        const exDev = path.join(this.resolveBundleRoot(), "app", "bridge", "persona.example.txt");
        const src = fs.existsSync(ex) ? ex : fs.existsSync(exDev) ? exDev : null;
        if (src) {
          try {
            fs.copyFileSync(src, personaPath);
          } catch {
            /* ignore */
          }
        }
      }
    }

    return this.readPorts();
  }

  readPorts() {
    let settings = DEFAULT_SETTINGS_PORT;
    let login = DEFAULT_LOGIN_PORT;
    let backend = DEFAULT_BACKEND_PORT;
    try {
      const configPath = path.join(this.appDataRoot, "config.json");
      if (fs.existsSync(configPath)) {
        const j = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (j.settings_port) settings = Number(j.settings_port) || settings;
        if (j.login_ui_port) login = Number(j.login_ui_port) || login;
        if (j.onebot_port) backend = Number(j.onebot_port) || backend;
      }
    } catch {
      /* ignore */
    }
    if (process.env.FATFISH_SETTINGS_PORT) {
      const n = Number(process.env.FATFISH_SETTINGS_PORT);
      if (n) settings = n;
    }
    if (process.env.FATFISH_LOGIN_PORT) {
      const n = Number(process.env.FATFISH_LOGIN_PORT);
      if (n) login = n;
    }
    this._state.settings_port = settings;
    this._state.login_port = login;
    this._state.backend_port = backend;
    return { settings, login, backend };
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
   *   Dev:  <repo>/app/shell/local-server.mjs, <repo>/app/core/server.mjs, <repo>/vendor/{napcat,dsh}
   *   Prod: <resources>/shell/..., <resources>/core/..., <resources>/vendor/{napcat,dsh}
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

    const localServer = candidates(
      packaged
        ? ["shell/local-server.mjs", "app/shell/local-server.mjs"]
        : ["app/shell/local-server.mjs", "shell/local-server.mjs"]
    );

    const coreJs = candidates(
      packaged
        ? ["core/server.mjs", "app/core/server.mjs"]
        : ["app/core/server.mjs", "core/server.mjs"]
    );

    const coreDir = coreJs ? path.dirname(coreJs) : null;
    const shellDir = localServer ? path.dirname(localServer) : null;

    const napcatDir = this.resolveBackendDir(root);
    const nodeExe = this.resolveNodeExe(root);

    return { root, localServer, coreJs, coreDir, shellDir, napcatDir, nodeExe };
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
   * Spawn a .mjs with Electron-as-Node (preferred) or portable node.exe.
   */
  spawnNodeScript(scriptPath, cwd, logName) {
    const logs = path.join(this.appDataRoot, "logs");
    fs.mkdirSync(logs, { recursive: true });
    const outPath = path.join(logs, `${logName}.log`);
    const errPath = path.join(logs, `${logName}.err.log`);
    const outFd = fs.openSync(outPath, "a");
    const errFd = fs.openSync(errPath, "a");

    const env = {
      ...process.env,
      FATFISH_APPDATA: this.appDataRoot,
      FATFISH_SETTINGS_PORT: String(this._state.settings_port),
      FATFISH_LOGIN_PORT: String(this._state.login_port),
    };

    /** @type {import('child_process').ChildProcess} */
    let child;
    // Prefer ELECTRON_RUN_AS_NODE so we do not require a separate Node install.
    if (this.electronExecPath && fs.existsSync(this.electronExecPath)) {
      child = spawn(this.electronExecPath, [scriptPath], {
        cwd,
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", outFd, errFd],
        windowsHide: true,
        detached: false,
      });
    } else {
      const nodeExe = this.resolvePaths().nodeExe || "node";
      child = spawn(nodeExe, [scriptPath], {
        cwd,
        env,
        stdio: ["ignore", outFd, errFd],
        windowsHide: true,
        detached: false,
      });
    }

    try {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    } catch {
      /* ignore */
    }

    return child;
  }

  /**
   * Fork Core with an IPC channel (Electron-as-Node preferred, portable node.exe fallback).
   */
  forkCore(scriptPath, cwd) {
    const logs = path.join(this.appDataRoot, "logs");
    fs.mkdirSync(logs, { recursive: true });
    const outFd = fs.openSync(path.join(logs, "core.log"), "a");
    const errFd = fs.openSync(path.join(logs, "core.err.log"), "a");
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
    try {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    } catch {
      /* ignore */
    }
    child.on("message", (m) => this._onCoreMessage(m));
    return child;
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
      stdOut = "ignore";
      stdErr = "ignore";
    }
    const child = spawn("cmd.exe", ["/c", launcher], {
      cwd: napcatDir,
      env: { ...process.env, FATFISH_APPDATA: this.appDataRoot },
      stdio: ["ignore", stdOut, stdErr],
      windowsHide: true,
      detached: false,
    });
    return child;
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
      try {
        execFile(
          "taskkill",
          ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true },
          () => {}
        );
      } catch {
        /* ignore */
      }
      return;
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

  /**
   * Best-effort: stop Win boot helper by name (never kill QQ itself).
   */
  killBackendHelpers() {
    if (process.platform !== "win32") return;
    try {
      execFile(
        "taskkill",
        ["/IM", "NapCatWinBootMain.exe", "/F"],
        { windowsHide: true },
        () => {}
      );
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

    // --- 1) local-server (8787) ---
    if (!(await this.probeTcp(ports.settings))) {
      if (!paths.localServer) {
        this._fail(
          "missing_local_server",
          "本机设置服务文件缺失。请重新安装客户端，或联系卖家获取完整安装包。"
        );
        return this.getState();
      }
      try {
        const child = this.spawnNodeScript(paths.localServer, paths.shellDir, "local-server");
        this._children.local_server = child;
        if (child && child.pid) this.writePid("local-server", child.pid);
        child.on("exit", () => {
          this._children.local_server = null;
          this.clearPidFile("local-server");
        });
      } catch (e) {
        this._fail(
          "spawn_local_server",
          "无法启动本机设置服务。" + String(e && e.message ? e.message : e).slice(0, 80)
        );
        return this.getState();
      }
      const up = await this.waitForPort(ports.settings, 12000, "settings");
      if (!up) {
        // Port may be occupied by another instance
        if (await this.probeTcp(ports.settings)) {
          /* somehow up */
        } else {
          this._fail(
            "port_settings",
            `本机设置服务未就绪（端口 ${ports.settings}）。请检查是否被其他程序占用，关闭冲突程序后重新打开肥鱼。`
          );
          return this.getState();
        }
      }
    }
    this._state.local_server = await this.probeTcp(ports.settings);

    // --- 2) backend login service (vendor launcher → login UI + ws :3001) ---
    const backendAlready = await this.probeTcp(ports.backend);
    const loginAlready = await this.probeTcp(ports.login);

    if (!backendAlready && !loginAlready) {
      if (!paths.napcatDir) {
        this._fail(
          "missing_backend",
          "后台服务目录缺失。请重新安装完整客户端（安装包须包含后台组件）。"
        );
        // Still try bridge/local; mark degraded
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

    // --- 3) core (engine + channels; connects ws://127.0.0.1:3001, reads AppData key/token) ---
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

    // Final phase
    this._state.local_server = await this.probeTcp(ports.settings);
    const loginUp = await this.probeTcp(ports.login);
    const backendUp = await this.probeTcp(ports.backend);
    this._state.backend = backendUp || loginUp;

    if (this._state.phase === "error") {
      return this.getState();
    }
    if (this._state.local_server && this._state.core && this._state.backend) {
      this._state.phase = "running";
      this._state.error = null;
      this._state.error_code = null;
    } else if (this._state.local_server) {
      if (this._state.phase !== "degraded") this._state.phase = "degraded";
      if (!this._state.backend && !this._state.error) {
        this._state.error_code = this._state.error_code || "backend_down";
        this._state.error =
          this._state.error ||
          "本机设置服务已启动，但后台登录服务未就绪。请确认已安装官方 QQ 后，点「刷新状态」或重启肥鱼。";
      }
    } else {
      this._fail(
        "local_down",
        `本机服务未能启动（端口 ${ports.settings}）。请检查端口占用后重开应用。`
      );
    }

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
      local_server: "local-server",
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
      this.killTree(killPid, child);
      this._children[name] = null;
      this.clearPidFile(fileKey);
    }

    this.killBackendHelpers();

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
    this._state.local_server = false;
    this._state.backend = false;
    this._state.core = false;
    this._core = emptyCore();
    return this.getState();
  }

  /**
   * Refresh live probes into state (without restarting).
   */
  async refreshProbes() {
    const ports = this.readPorts();
    this._state.local_server = await this.probeTcp(ports.settings);
    const loginUp = await this.probeTcp(ports.login);
    const backendUp = await this.probeTcp(ports.backend);
    this._state.backend = backendUp || loginUp;
    this._state.core = !!(this._children.core && this._children.core.exitCode === null);
    return this.getState();
  }
}

module.exports = {
  ServiceManager,
  DEFAULT_SETTINGS_PORT,
  DEFAULT_LOGIN_PORT,
  DEFAULT_BACKEND_PORT,
};
