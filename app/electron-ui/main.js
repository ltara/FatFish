/**
 * FatFish Electron shell — status / settings / login / about.
 * Auto-starts local services; never opens system browser.
 * Never log or echo full API keys. Login uses native shell (no webview).
 */
"use strict";

const { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const { ServiceManager } = require("./service-manager");
const loginApi = require("./login-api");
const personaLib = require("./persona-lib");

const isSmoke = process.env.FATFISH_SMOKE === "1";

function resolveAppDataRoot() {
  if (process.env.FATFISH_APPDATA) return process.env.FATFISH_APPDATA;
  if (process.env.APPDATA) return path.join(process.env.APPDATA, "FatFish");
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "FatFish");
  return path.join(os.homedir(), ".local", "share", "FatFish");
}

function keyPath(root) {
  return path.join(root, "secrets", "deepseek_api_key");
}

function riskPath(root) {
  return path.join(root, "runtime", "risk_ok");
}

function outboundPausedPath(root) {
  return path.join(root, "runtime", "outbound_paused");
}

function personaPath(root) {
  return path.join(root, "persona.txt");
}


function configPath(root) {
  return path.join(root, "config.json");
}

function readAgentEngineConfig(root) {
  const defaults = {
    enabled: false,
    remember_chat: false,
    use_tools: false,
    timeout_ms: 45000,
    pinned_version: "0.2.1-rc.2",
  };
  try {
    const p = configPath(root);
    if (!fs.existsSync(p)) return { ...defaults };
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const ae = j.agent_engine && typeof j.agent_engine === "object" ? j.agent_engine : {};
    return {
      enabled: ae.enabled === true,
      remember_chat: ae.remember_chat === true,
      use_tools: ae.use_tools === true,
      timeout_ms: Number(ae.timeout_ms) > 0 ? Number(ae.timeout_ms) : defaults.timeout_ms,
      pinned_version: String(ae.pinned_version || defaults.pinned_version),
    };
  } catch {
    return { ...defaults };
  }
}

function writeAgentEngineConfig(root, patch) {
  const p = configPath(root);
  let j = {};
  try {
    if (fs.existsSync(p)) j = JSON.parse(fs.readFileSync(p, "utf8")) || {};
  } catch {
    j = {};
  }
  const cur = readAgentEngineConfig(root);
  const next = {
    enabled: patch && Object.prototype.hasOwnProperty.call(patch, "enabled") ? !!patch.enabled : !!cur.enabled,
    remember_chat:
      patch && Object.prototype.hasOwnProperty.call(patch, "remember_chat")
        ? !!patch.remember_chat
        : !!cur.remember_chat,
    use_tools:
      patch && Object.prototype.hasOwnProperty.call(patch, "use_tools") ? !!patch.use_tools : !!cur.use_tools,
    timeout_ms: cur.timeout_ms,
    pinned_version: cur.pinned_version,
  };
  j.agent_engine = next;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
  return j.agent_engine;
}

function writeAgentEngineEnabled(root, enabled) {
  return writeAgentEngineConfig(root, { enabled: !!enabled });
}

function agentEngineSidecarPresent(root) {
  const candidates = [
    process.env.FATFISH_AGENT_ENGINE,
    path.join(root, "agent-engine"),
    path.join(root, "vendor", "agent-engine"),
  ].filter(Boolean);
  if (services && services.resolveBundleRoot) {
    try {
      const br = services.resolveBundleRoot();
      candidates.push(path.join(br, "vendor", "agent-engine"));
    } catch {
      /* ignore */
    }
  }
  for (const c of candidates) {
    try {
      if (
        fs.existsSync(path.join(c, "run-headless.mjs")) ||
        fs.existsSync(path.join(c, "run-headless.js")) ||
        fs.existsSync(path.join(c, "node_modules", "@deepseek-ai", "dsh", "package.json")) ||
        fs.existsSync(path.join(c, "dsh.cmd")) ||
        fs.existsSync(path.join(c, "dsh"))
      ) {
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

function readOutboundPausedMeta(root) {
  try {
    const p = outboundPausedPath(root);
    if (!fs.existsSync(p)) return { paused: false, since_ms: 0 };
    const paused = fs.readFileSync(p, "utf8").trim() === "1";
    const st = fs.statSync(p);
    return { paused, since_ms: paused ? st.mtimeMs : 0 };
  } catch {
    return { paused: false, since_ms: 0 };
  }
}

function readActivityBrief(root) {
  // 本轮无可靠私聊计数；有暂停时长则填一格，否则空态
  const meta = readOutboundPausedMeta(root);
  let paused_label = "";
  if (meta.paused && meta.since_ms) {
    const mins = Math.max(0, Math.floor((Date.now() - meta.since_ms) / 60000));
    if (mins < 1) paused_label = "不到 1 分钟";
    else if (mins < 60) paused_label = mins + " 分钟";
    else paused_label = Math.floor(mins / 60) + " 小时";
  }
  return {
    has_data: !!paused_label,
    dm_today: "",
    last_reply: "",
    paused_for: paused_label,
  };
}




function keyIsSaved(root) {
  try {
    const p = keyPath(root);
    return fs.existsSync(p) && fs.readFileSync(p, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function readLocalToken(root) {
  try {
    const p = path.join(root, "secrets", "local_token");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
  } catch {
    return "";
  }
}

let wsBridgeEnsuredFor = "";

async function maybeEnsureWsBridge(credential) {
  if (!credential || !services) return;
  const root = resolveAppDataRoot();
  const token = readLocalToken(root);
  if (!token) return;
  const mark = credential.slice(0, 16) + ":" + token.slice(0, 8);
  if (wsBridgeEnsuredFor === mark) return;
  try {
    const ports = services.readPorts ? services.readPorts() : { login: 6099, backend: 3001 };
    const r = await loginApi.ensureOnebotWsServer({
      credential,
      port: ports.login || 6099,
      localToken: token,
      wsPort: ports.backend || 3001,
    });
    if (r && r.ok) wsBridgeEnsuredFor = mark;
  } catch {
    /* ignore — bridge will keep retrying connect */
  }
}


function maskUin(uin) {
  const s = String(uin || "");
  if (s.length <= 4) return s ? "****" : "";
  return s.slice(0, 2) + "***" + s.slice(-2);
}

function maskNick(nick) {
  const s = String(nick || "").trim();
  if (!s) return "";
  if (s.length <= 1) return "*";
  if (s.length === 2) return s[0] + "*";
  return s[0] + "*".repeat(Math.min(s.length - 2, 4)) + s[s.length - 1];
}

function httpGetJson(port, pathname) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        timeout: 800,
        headers: { Connection: "close" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({ ok: res.statusCode === 200, json: JSON.parse(body) });
          } catch {
            resolve({ ok: false, json: null });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, json: null });
    });
    req.on("error", () => resolve({ ok: false, json: null }));
  });
}

function writeKeyLocal(root, key) {
  const dir = path.join(root, "secrets");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyPath(root), key + "\n", { encoding: "utf8", mode: 0o600 });
}

function postSaveKey(port, key) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ key });
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/save-key",
        method: "POST",
        timeout: 2000,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          Connection: "close",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(!!(j && j.ok));
          } catch {
            resolve(res.statusCode === 200);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.write(body);
    req.end();
  });
}

let mainWindow = null;
/** @type {import("electron").Tray|null} */
let tray = null;
/** @type {ServiceManager|null} */
let services = null;
let stopping = false;
/** Cached login credential for this process (never sent as user-facing text). */
let loginCredential = null;
/** Last known QQ info after successful login. */
let lastQqInfo = { uin: null, nick: null };

function resolveTrayIcon() {
  const candidates = [
    path.join(__dirname, "assets", "tray.png"),
    path.join(__dirname, "assets", "icon.png"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const img = nativeImage.createFromPath(c);
      if (!img.isEmpty()) return img;
    }
  }
  // 16x16 blue pixel fallback
  const buf = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVQ4T2NkYGD4z0ABYBw1gGE0DAB+DAF9mWnF9QAAAABJRU5ErkJggg==",
    "base64"
  );
  return nativeImage.createFromBuffer(buf);
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray || isSmoke) return;
  const icon = resolveTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip("肥鱼");
  const rebuild = () => {
    let paused = false;
    let loggedIn = false;
    try {
      const root = resolveAppDataRoot();
      const p = outboundPausedPath(root);
      paused = fs.existsSync(p) && fs.readFileSync(p, "utf8").trim() === "1";
      loggedIn = !!(lastQqInfo && lastQqInfo.uin);
    } catch {
      paused = false;
      loggedIn = false;
    }
    // 与首页胶囊一致：在线 / 已暂停 / 需登录
    let tip = "肥鱼 · 需登录";
    let statusLabel = "状态：需登录";
    if (loggedIn && paused) {
      tip = "肥鱼 · 已暂停";
      statusLabel = "状态：已暂停";
    } else if (loggedIn) {
      tip = "肥鱼 · 在线";
      statusLabel = "状态：在线";
    }
    try {
      tray.setToolTip(tip);
    } catch {
      /* ignore */
    }
    const menu = Menu.buildFromTemplate([
      {
        label: "显示肥鱼",
        click: () => showMainWindow(),
      },
      {
        label: statusLabel,
        enabled: false,
      },
      {
        label: paused ? "恢复自动回复" : "暂停自动回复",
        enabled: loggedIn,
        click: async () => {
          const root = resolveAppDataRoot();
          const runtime = path.join(root, "runtime");
          fs.mkdirSync(runtime, { recursive: true });
          const p = outboundPausedPath(root);
          if (!paused) {
            fs.writeFileSync(p, "1\n", { encoding: "utf8" });
          } else {
            try {
              if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch {
              fs.writeFileSync(p, "0\n", { encoding: "utf8" });
            }
          }
          rebuild();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("outbound-paused-changed", !paused);
          }
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };
  rebuild();
  tray.on("double-click", () => showMainWindow());
  tray._rebuild = rebuild;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 800,
    minHeight: 560,
    title: "肥鱼",
    show: !isSmoke,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#0F1419",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
    }
  });

  mainWindow.on("close", (e) => {
    // 关闭窗口时隐藏到托盘（退出走托盘菜单）
    if (!stopping && tray && process.platform === "win32" && !isSmoke) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  if (isSmoke) {
    mainWindow.webContents.once("did-finish-load", () => {
      console.log("smoke: window_ready");
      setTimeout(() => app.quit(), 200);
    });
  }
}

function loginPort() {
  if (!services) return 6099;
  const ports = services.readPorts();
  return ports.login || 6099;
}

function registerIpc() {
  ipcMain.handle("get-status", async () => {
    const root = resolveAppDataRoot();
    const outboundPaused = (() => {
      try {
        const p = outboundPausedPath(root);
        return fs.existsSync(p) && fs.readFileSync(p, "utf8").trim() === "1";
      } catch {
        return false;
      }
    })();

    if (!services) {
      return {
        key_saved: keyIsSaved(root),
        settings_reachable: false,
        login_reachable: false,
        settings_port: 8787,
        login_port: 6099,
        appdata: root,
        phase: "idle",
        service_error: null,
        service_error_code: null,
        bridge_running: false,
        qq_online: false,
        qq_uin_mask: "",
        qq_nick_mask: "",
        outbound_paused: outboundPaused,
        active_persona_title: personaLib.getActiveMeta(root).activeTitle || "",
        active_persona_id: personaLib.getActiveMeta(root).activePersonaId || "",
        active_persona_summary: personaLib.getActiveMeta(root).summary || "",
        agent_engine_enabled: !!readAgentEngineConfig(root).enabled,
        agent_remember_chat: !!readAgentEngineConfig(root).remember_chat,
        agent_use_tools: !!readAgentEngineConfig(root).use_tools,
        activity: readActivityBrief(root),
      };
    }

    const svc = await services.refreshProbes();
    let keySaved = keyIsSaved(root);
    if (svc.local_server) {
      const st = await httpGetJson(svc.settings_port, "/api/status");
      if (st.ok && st.json) {
        keySaved = st.json.key === "present" || keySaved;
      }
    }
    const loginReachable = await services.probeTcp(svc.login_port);
    const core = services.getCore();

    return {
      key_saved: keySaved,
      settings_reachable: !!svc.local_server,
      login_reachable: !!loginReachable,
      settings_port: svc.settings_port,
      login_port: svc.login_port,
      appdata: root,
      phase: svc.phase,
      service_error: svc.error,
      service_error_code: svc.error_code,
      bridge_running: !!svc.core,
      engine_state: core.engine,
      channel_state: core.channels.qq || "offline",
      core_stats: core.stats,
      last_turn_error: core.last_turn_error,
      backend_ready: !!svc.backend,
      qq_online: !!(lastQqInfo.uin),
      qq_uin_mask: maskUin(lastQqInfo.uin),
      qq_nick_mask: maskNick(lastQqInfo.nick),
      outbound_paused: outboundPaused,
      active_persona_title: personaLib.getActiveMeta(root).activeTitle || "",
      active_persona_id: personaLib.getActiveMeta(root).activePersonaId || "",
      active_persona_summary: personaLib.getActiveMeta(root).summary || "",
      agent_engine_enabled: !!readAgentEngineConfig(root).enabled,
      agent_remember_chat: !!readAgentEngineConfig(root).remember_chat,
      agent_use_tools: !!readAgentEngineConfig(root).use_tools,
      activity: readActivityBrief(root),
    };
  });

  ipcMain.handle("get-ports", async () => {
    const ports = services ? services.readPorts() : { settings: 8787, login: 6099 };
    return {
      settings_port: ports.settings,
      login_port: ports.login,
    };
  });

  ipcMain.handle("get-service-state", async () => {
    if (!services) return { phase: "idle" };
    return services.getState();
  });

  ipcMain.handle("restart-services", async () => {
    if (!services || isSmoke) return { ok: false };
    loginCredential = null;
    await services.stopAll();
    const st = await services.startAll();
    return { ok: st.phase === "running" || st.phase === "degraded", state: st };
  });

  ipcMain.handle("save-api-key", async (_evt, key) => {
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (!trimmed) return { ok: false, error: "empty_key" };
    const root = resolveAppDataRoot();
    const ports = services ? services.readPorts() : { settings: 8787 };
    let posted = false;
    if (services && (await services.probeTcp(ports.settings))) {
      posted = await postSaveKey(ports.settings, trimmed);
    }
    try {
      writeKeyLocal(root, trimmed);
      console.log(new Date().toISOString(), "key_saved", posted ? "via_api_and_fs" : "via_fs");
      // Warm the engine with the new key now instead of on the next message.
      if (services) services.sendCore({ type: "reload" });
      return { ok: true };
    } catch (e) {
      console.log(
        new Date().toISOString(),
        "save_key_error",
        String(e && e.message ? e.message : e).slice(0, 120)
      );
      return { ok: false, error: "save_failed" };
    }
  });

  ipcMain.handle("is-risk-accepted", async () => {
    const p = riskPath(resolveAppDataRoot());
    try {
      return fs.existsSync(p) && fs.readFileSync(p, "utf8").trim().length > 0;
    } catch {
      return false;
    }
  });

  ipcMain.handle("accept-risk", async () => {
    const root = resolveAppDataRoot();
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(riskPath(root), "1\n", { encoding: "utf8" });
    return true;
  });

  ipcMain.handle("get-login-session", async () => {
    if (!services) {
      return { ok: false, phase: "waiting_service", message: "本机服务尚未就绪。" };
    }
    const port = loginPort();
    const reachable = await services.probeTcp(port);
    if (!reachable) {
      return {
        ok: false,
        phase: "waiting_service",
        message: "登录服务尚未就绪。请确认已安装官方 QQ，稍后重试。",
      };
    }
    const token = services.readWebUiToken();
    if (!token) {
      return {
        ok: false,
        phase: "error",
        message: "无法自动准备登录，请稍后点「刷新二维码」重试。",
      };
    }
    const session = await loginApi.getLoginSession({
      token,
      port,
      credential: loginCredential,
    });
    if (session.credential) loginCredential = session.credential;
    if (session.phase === "success" && session.uin) {
      lastQqInfo = { uin: session.uin, nick: session.nick };
      if (tray && typeof tray._rebuild === "function") tray._rebuild();
    }
    if (session.isLogin || session.phase === "success") {
      maybeEnsureWsBridge(loginCredential || session.credential);
    }
    const needVerify =
      !session.qrDataUrl &&
      session.phase !== "waiting" &&
      session.phase !== "scanned" &&
      session.phase !== "success" &&
      loginApi.looksLikePhoneVerify(session.loginError, session.message);
    return {
      ok: session.ok,
      phase: needVerify ? "verify" : session.phase,
      qrDataUrl: session.qrDataUrl || null,
      message: session.message || "",
      uin_mask: maskUin(session.uin),
      nick_mask: maskNick(session.nick),
      isLogin: !!session.isLogin,
      key_saved: keyIsSaved(resolveAppDataRoot()),
    };
  });

  ipcMain.handle("poll-login-status", async () => {
    if (!loginCredential || !services) {
      return { ok: false, phase: "error", message: "会话未建立。" };
    }
    const port = loginPort();
    const result = await loginApi.pollLoginStatus({
      credential: loginCredential,
      port,
      wantQr: true,
    });
    if (result.phase === "success" && result.uin) {
      lastQqInfo = { uin: result.uin, nick: result.nick };
      if (tray && typeof tray._rebuild === "function") tray._rebuild();
    }
    if (result.isLogin || result.phase === "success") {
      maybeEnsureWsBridge(loginCredential);
    }
    const needVerify =
      !result.qrDataUrl &&
      result.phase !== "waiting" &&
      result.phase !== "scanned" &&
      result.phase !== "success" &&
      loginApi.looksLikePhoneVerify(result.loginError, result.message);
    return {
      ok: result.ok,
      phase: needVerify ? "verify" : result.phase,
      qrDataUrl: result.qrDataUrl || null,
      message: result.message || "",
      uin_mask: maskUin(result.uin),
      nick_mask: maskNick(result.nick),
      isLogin: !!result.isLogin,
      key_saved: keyIsSaved(resolveAppDataRoot()),
    };
  });

  ipcMain.handle("refresh-login-qr", async () => {
    if (!services) {
      return { ok: false, phase: "waiting_service", message: "本机服务尚未就绪。" };
    }
    const port = loginPort();
    const token = services.readWebUiToken();
    if (!loginCredential) {
      if (!token) {
        return { ok: false, phase: "error", message: "无法自动准备登录。" };
      }
      const session = await loginApi.getLoginSession({ token, port });
      if (session.credential) loginCredential = session.credential;
      return {
        ok: session.ok,
        phase: session.phase,
        qrDataUrl: session.qrDataUrl || null,
        message: session.message || "",
      };
    }
    const result = await loginApi.refreshLoginQr({ credential: loginCredential, port });
    return {
      ok: result.ok,
      phase: result.phase,
      qrDataUrl: result.qrDataUrl || null,
      message: result.message || "",
    };
  });

  ipcMain.handle("get-about", async () => {
    let version = "0.1.0";
    try {
      const pkg = require("./package.json");
      if (pkg && pkg.version) version = String(pkg.version);
    } catch {
      /* ignore */
    }
    const root = resolveAppDataRoot();
    const ae = readAgentEngineConfig(root);
    const sidecar = agentEngineSidecarPresent(root);
    return {
      name: "肥鱼",
      version,
      agent_engine_enabled: !!ae.enabled,
      agent_engine_sidecar: !!sidecar,
      agent_engine_label: "本机助手",
    };
  });

  ipcMain.handle("get-agent-engine", async () => {
    const root = resolveAppDataRoot();
    const ae = readAgentEngineConfig(root);
    return {
      ok: true,
      enabled: !!ae.enabled,
      remember_chat: !!ae.remember_chat,
      use_tools: !!ae.use_tools,
      sidecar: agentEngineSidecarPresent(root),
      timeout_ms: ae.timeout_ms,
      pinned_version: ae.pinned_version,
      label: "本机助手",
    };
  });

  ipcMain.handle("set-agent-engine-enabled", async (_evt, enabled) => {
    const root = resolveAppDataRoot();
    const ae = writeAgentEngineEnabled(root, !!enabled);
    return {
      ok: true,
      enabled: !!ae.enabled,
      remember_chat: !!ae.remember_chat,
      use_tools: !!ae.use_tools,
      sidecar: agentEngineSidecarPresent(root),
      label: "本机助手",
    };
  });

  ipcMain.handle("set-agent-engine-options", async (_evt, patch) => {
    const root = resolveAppDataRoot();
    const p = patch && typeof patch === "object" ? patch : {};
    // 使用本机工具需二次确认：由渲染进程确认后再传来 use_tools:true
    const ae = writeAgentEngineConfig(root, p);
    return {
      ok: true,
      enabled: !!ae.enabled,
      remember_chat: !!ae.remember_chat,
      use_tools: !!ae.use_tools,
      sidecar: agentEngineSidecarPresent(root),
      label: "本机助手",
    };
  });

  ipcMain.handle("get-autostart", async () => {
    try {
      const s = app.getLoginItemSettings();
      return { ok: true, enabled: !!(s && s.openAtLogin) };
    } catch (e) {
      return { ok: false, enabled: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("set-autostart", async (_evt, enabled) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath });
      const s = app.getLoginItemSettings();
      return { ok: true, enabled: !!(s && s.openAtLogin) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("open-data-folder", async () => {
    const root = resolveAppDataRoot();
    try {
      fs.mkdirSync(root, { recursive: true });
      const r = await shell.openPath(root);
      return { ok: !r, error: r || "" };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("export-settings", async () => {
    const root = resolveAppDataRoot();
    try {
      let cfg = {};
      try {
        const cp = configPath(root);
        if (fs.existsSync(cp)) cfg = JSON.parse(fs.readFileSync(cp, "utf8")) || {};
      } catch {
        cfg = {};
      }
      // 不导出密钥明文
      const payload = {
        exported_at: new Date().toISOString(),
        app: "肥鱼",
        config: cfg,
        personas: null,
        note: "不含模型密钥明文；密钥仍仅保存在本机 secrets 目录。",
      };
      try {
        const jp = path.join(root, "personas.json");
        if (fs.existsSync(jp)) payload.personas = JSON.parse(fs.readFileSync(jp, "utf8"));
      } catch {
        /* ignore */
      }
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      const saved = await dialog.showSaveDialog(win || undefined, {
        title: "导出设置",
        defaultPath: "fatfish-settings.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (saved.canceled || !saved.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(saved.filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
      return { ok: true, path: saved.filePath };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("clear-local-data", async (_evt, confirmed) => {
    if (!confirmed) return { ok: false, error: "confirm_required" };
    const root = resolveAppDataRoot();
    try {
      // 清人设库、配置、运行时标记；保留安装目录；密钥文件一并删
      const targets = [
        path.join(root, "personas.json"),
        path.join(root, "persona.txt"),
        path.join(root, "config.json"),
        path.join(root, "secrets", "deepseek_api_key"),
        path.join(root, "runtime", "outbound_paused"),
        path.join(root, "runtime", "risk_ok"),
        path.join(root, "runtime", "persona_rev"),
      ];
      for (const t of targets) {
        try {
          if (fs.existsSync(t)) fs.unlinkSync(t);
        } catch {
          /* ignore */
        }
      }
      return { ok: true, message: "已清空本机设置与人设数据。请重新配置密钥与人设。" };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("window-minimize", async () => {
    if (mainWindow) mainWindow.minimize();
    return true;
  });

  ipcMain.handle("window-maximize-toggle", async () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });

  ipcMain.handle("window-close", async () => {
    if (mainWindow) mainWindow.close();
    return true;
  });

  ipcMain.handle("get-outbound-paused", async () => {
    const root = resolveAppDataRoot();
    try {
      const p = outboundPausedPath(root);
      return fs.existsSync(p) && fs.readFileSync(p, "utf8").trim() === "1";
    } catch {
      return false;
    }
  });

  ipcMain.handle("set-outbound-paused", async (_evt, paused) => {
    const root = resolveAppDataRoot();
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(runtime, { recursive: true });
    const p = outboundPausedPath(root);
    if (paused) {
      fs.writeFileSync(p, "1\n", { encoding: "utf8" });
    } else {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        fs.writeFileSync(p, "0\n", { encoding: "utf8" });
      }
    }
    if (services) services.sendCore({ type: "pause", paused: !!paused });
    if (tray && typeof tray._rebuild === "function") tray._rebuild();
    return true;
  });

  ipcMain.handle("persona-list", async () => {
    try {
      return personaLib.listPersonas(resolveAppDataRoot());
    } catch {
      return { ok: false, items: [], activePersonaId: "", activeTitle: "" };
    }
  });

  ipcMain.handle("persona-get", async (_evt, id) => {
    try {
      return personaLib.getPersona(resolveAppDataRoot(), id);
    } catch {
      return { ok: false, error: "read_failed" };
    }
  });

  ipcMain.handle("persona-create", async (_evt, payload) => {
    try {
      return personaLib.createPersona(resolveAppDataRoot(), payload || {});
    } catch {
      return { ok: false, error: "create_failed" };
    }
  });

  ipcMain.handle("persona-update", async (_evt, id, payload) => {
    try {
      return personaLib.updatePersona(resolveAppDataRoot(), id, payload || {});
    } catch {
      return { ok: false, error: "update_failed" };
    }
  });

  ipcMain.handle("persona-delete", async (_evt, id, confirmed) => {
    try {
      return personaLib.deletePersona(resolveAppDataRoot(), id, !!confirmed);
    } catch {
      return { ok: false, error: "delete_failed" };
    }
  });

  ipcMain.handle("persona-apply", async (_evt, id) => {
    try {
      return personaLib.applyPersona(resolveAppDataRoot(), id);
    } catch {
      return { ok: false, error: "apply_failed" };
    }
  });

  ipcMain.handle("persona-import-text", async (_evt, text) => {
    try {
      return personaLib.importFromText(text);
    } catch {
      return { ok: false, error: "import_failed" };
    }
  });

  // 兼容首次设置：把文本建成库条目并应用
  ipcMain.handle("save-persona", async (_evt, text) => {
    const root = resolveAppDataRoot();
    try {
      personaLib.ensurePersonaLib(root);
      const body = String(text || "");
      if (!body.trim()) return { ok: true };
      const created = personaLib.createPersona(root, {
        title: "我的人设",
        body,
      });
      if (created && created.ok && created.item) {
        return personaLib.applyPersona(root, created.item.id);
      }
      return { ok: false };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle("get-persona", async () => {
    try {
      const meta = personaLib.getActiveMeta(resolveAppDataRoot());
      const body = personaLib.getActiveBody(resolveAppDataRoot());
      return { ok: true, text: body, ...meta };
    } catch {
      return { ok: false, text: "" };
    }
  });
}

async function shutdownServices() {
  if (stopping) return;
  stopping = true;
  if (tray) {
    try {
      tray.destroy();
    } catch {
      /* ignore */
    }
    tray = null;
  }
  if (services) {
    try {
      await services.stopAll();
    } catch (e) {
      console.error("stopAll failed", String(e && e.message ? e.message : e).slice(0, 120));
    }
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    registerIpc();
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

    const root = resolveAppDataRoot();
    services = new ServiceManager({
      appDataRoot: root,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      electronExecPath: process.execPath,
    });

    createWindow();
    createTray();

    if (!isSmoke) {
      services.startAll().then((st) => {
        console.log(
          new Date().toISOString(),
          "services_phase",
          st.phase,
          st.error_code || "",
          st.error ? String(st.error).slice(0, 80) : ""
        );
      });
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (e) => {
    if (!stopping && services) {
      e.preventDefault();
      shutdownServices().finally(() => {
        app.exit(0);
      });
    }
  });

  app.on("will-quit", () => {
    if (services && !stopping) {
      try {
        const st = services.getState();
        const pids = st.pids || {};
        for (const pid of Object.values(pids)) {
          if (pid) {
            try {
              process.kill(Number(pid));
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  });
}
