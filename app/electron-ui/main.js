/**
 * FatFish Electron shell — status / settings / login / about.
 * Auto-starts local services; never opens system browser.
 * Never log or echo full API keys. Login uses native shell (no webview).
 */
"use strict";

const { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, shell, dialog, clipboard } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { ServiceManager } = require("./service-manager");
const loginApi = require("./login-api");
const personaLib = require("./persona-lib");
const statusView = require("./renderer/status-view");
const chatStore = require("./chat-store");
const { ReminderInbox } = require("./reminder-inbox");
const { ReminderController } = require("./reminder-controller");
const modelConfig = require("../core/model-config.cjs");
const { LicenseGate } = require("../core/license-gate.cjs");
const activationDisplay = require("./activation-display");
const { OnboardingStore, modelToken, bindingHash } = require("./onboarding-store");
const channelConfig = require("../core/channel-config.cjs");
const dataClear = require("./data-clear");

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
const licenseGate = new LicenseGate(resolveAppDataRoot());
const onboarding = new OnboardingStore(resolveAppDataRoot());
function riskAccepted() { try { return fs.readFileSync(riskPath(resolveAppDataRoot()), "utf8").trim().length > 0; } catch { return false; } }
function onboardingFacts() {
  const root = resolveAppDataRoot(), model = modelConfig.read(root), config = channelConfig.readConfig(configPath(root)), core = services?.getCore() || {};
  if (config.owners !== undefined && !Array.isArray(config.owners)) throw new Error("onboarding_unavailable");
  return { riskAccepted: riskAccepted(), model: { generation: model.generation, token: modelToken(model) }, qq: {
    enabled: channelConfig.qqEnabled(config), online: core.channels?.qq === "online" && !!core.self?.qq?.userId, paused: core.paused === true,
    owners: (config.owners || []).filter((o) => o?.channel === "qq" && typeof o.account === "string" && o.account.length > 0 && o.account.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(o.account)).map((o) => bindingHash("qq", o.account)),
  } };
}
function notifyOnboarding() { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("onboarding-changed"); }
function recordOnboarding(kind, proof) {
  try { const state = onboarding.record(kind, proof, onboardingFacts()); notifyOnboarding(); return state; }
  catch { notifyOnboarding(); return null; } // Keep the in-memory receipt for a no-charge reread after disk recovery.
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

function readActivityBrief(root, remoteStats, remote = true) {
  const stats = remote ? remoteStats : chatStore.stats(root);
  const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  const valid = stats && stats.date === date;
  const meta = readOutboundPausedMeta(root);
  let paused_label = "";
  if (meta.paused && meta.since_ms) {
    const mins = Math.max(0, Math.floor((Date.now() - meta.since_ms) / 60000));
    if (mins < 1) paused_label = "不到 1 分钟";
    else if (mins < 60) paused_label = mins + " 分钟";
    else paused_label = Math.floor(mins / 60) + " 小时";
  }
  return {
    kind: remote ? "remote" : "local",
    has_data: !!valid && (stats.inbound > 0 || stats.replies > 0) || remote && !!paused_label,
    dm_today: valid ? String(stats.inbound || 0) : "",
    last_reply: valid && stats.lastReplyAt ? new Date(stats.lastReplyAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }) : "",
    paused_for: remote ? paused_label : "",
  };
}




function keyIsSaved(root) {
  try {
    return !!modelConfig.read(root).key;
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

let wsChannelEnsuredFor = "";

async function maybeEnsureChannel(credential) {
  if (!credential || !services || !services.readQqEnabled()) return;
  const root = resolveAppDataRoot();
  const token = readLocalToken(root);
  if (!token) return;
  const mark = credential.slice(0, 16) + ":" + token.slice(0, 8);
  if (wsChannelEnsuredFor === mark) return;
  try {
    const ports = services.readPorts ? services.readPorts() : { login: 6099, backend: 3001 };
    const r = await loginApi.ensureOnebotWsServer({
      credential,
      port: ports.login || 6099,
      localToken: token,
      wsPort: ports.backend || 3001,
    });
    if (r && r.ok) wsChannelEnsuredFor = mark;
  } catch {
    /* the channel retries its loopback connection */
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

let mainWindow = null;
/** @type {import("electron").Tray|null} */
let tray = null;
/** @type {ServiceManager|null} */
let services = null;
let dataClearLocked = false, dataClearing = false, activeCommands = 0, dataClearState = "idle";
let stopping = false;
/** Cached login credential for this process (never sent as user-facing text). */
let loginCredential = null;
/** Last known QQ info after successful login. */
let lastQqInfo = { uin: null, nick: null };
let chatJob = null;
let reminderController = null;
let workspacePickerOpen = false;
const pendingApprovals = new Map();
const chatFailureText = (code) => ({
  no_key: "还没有模型密钥，请到设置里填写。", invalid_key: "模型密钥未通过验证，请到设置里检查。",
  insufficient_balance: "模型账户余额不足，请检查账户。", rate_limited: "模型暂时繁忙，请稍后再试。",
  network: "暂时连不上模型，请检查网络后重试。", model_unavailable: "当前模型不可用，请检查模型设置。",
  cancelled: "已停止这次回复。", core_unavailable: "本机服务已断开，请稍后再试。",
  workspace_unavailable: "本机工作区暂时不可用，请到设置里重新选择文件夹。", local_busy: "工作区正在调整，请稍后再试。",
  model_config_invalid: "模型设置暂时不可用，请到设置里检查。", model_busy: "模型设置正在调整，请稍后再试。",
  turn_timeout: "这次回复等待太久，已停止，请稍后再试。", engine_crashed: "伙伴意外中断，请稍后再试。",
}[code] || "这次回复未能完成，请稍后再试。");

function notifyChat() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("chat-changed");
  notifyStatus();
}

function approvalArrived(request) {
  if (!mainWindow || mainWindow.isDestroyed() || !chatJob || request.instance !== "local" || request.sessionId !== chatJob.sessionId) {
    services.sendCore({ type: "approval_answer", id: request.id, outcome: "rejected" }); return;
  }
  const titles = { read: "读取一个文件", write: "写入一个文件", edit: "修改一个文件", glob: "查找文件", grep: "搜索文件内容", pwsh: "运行一条命令", bash: "运行一条命令" };
  const firstLine = String(request.displayReason?.zh || "").split("\n")[0];
  const approval = { id: String(request.id), sessionId: request.sessionId,
    summary: /^它想/.test(firstLine) ? firstLine.slice(0, 220) : "它想" + (titles[request.toolName] || "执行一项操作"),
    detail: (String(request.toolName || "") + "\n" + String(request.displayReason?.zh || request.reason || "")).slice(0, 16000),
    deadlineAt: Math.min(Number(request.deadlineAt) || Date.now() + 120000, Date.now() + 120000) };
  pendingApprovals.set(approval.id, approval);
  showMainWindow(); notifyChat();
}

function approvalClosed(message) {
  const approval = pendingApprovals.get(String(message.id));
  if (!approval) return;
  pendingApprovals.delete(approval.id);
  const text = message.reason === "timeout" ? "已超时，没有执行。" : message.outcome === "allowed-once" ? "你允许了：" + approval.summary.replace(/^它想/, "") : "你没有允许这次操作。";
  try { chatStore.append(resolveAppDataRoot(), approval.sessionId, { role: "approval", text, outcome: message.outcome }); }
  catch { /* Display state can recover; never auto-retry an operation because recording failed. */ }
  notifyChat();
}

function configureAppIdentity() {
  if (process.platform === "win32" && typeof app.setAppUserModelId === "function") {
    app.setAppUserModelId("com.fatfish.client");
  }
}

function resolveTrayIcon(kind) {
  const stateFile = ["ok", "warn", "bad", "info"].includes(kind) ? `tray-${kind}.png` : "tray.png";
  const candidates = [
    path.join(__dirname, "assets", stateFile),
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
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function stateTrayIcon(kind) {
  // Keep the brand visible; state colours live in the small corner badge.
  return resolveTrayIcon(["ok", "warn", "bad", "info"].includes(kind) ? kind : "info");
}

function statusSnapshot() {
  const license = licenseGate.inspect();
  if (dataClearLocked) {
    const label = dataClearState === "stopping" ? "正在停止" : dataClearState === "stop_failed" ? "需退出" : dataClearState === "cleared" ? "已清理" : "已停止";
    return { phase: dataClearState === "stop_failed" ? "error" : "stopped", qq_enabled: false, qq_online: false, data_clear_locked: true, license,
      presentation: { label, kind: dataClearState === "stop_failed" ? "bad" : "warn", issues: [], objectText: "伙伴 · " + label, trayText: "肥鱼 · " + label } };
  }
  if (!license.valid || !riskAccepted()) {
    const snapshot = { phase: license.valid ? "risk_confirmation_required" : "activation_required", license, core_running: false, qq_enabled: false, qq_online: false };
    return { ...snapshot, presentation: statusView.build(snapshot) };
  }
  const root = resolveAppDataRoot();
  const svc = services?.getState() || { phase: "idle", core: false, backend: false };
  const core = services?.getCore() || {};
  const self = core.self?.qq || {};
  const qqEnabled = services?.readQqEnabled() || false;
  const primary = qqEnabled ? { state: core.engine, error: core.engine_error, crashCount: core.engines?.external?.crashCount } : core.engines?.local;
  const meta = personaLib.getActiveMeta(root);
  const reminderState = reminderController?.status();
  const snapshot = {
    key_saved: keyIsSaved(root), login_reachable: !!svc.login_reachable_hint,
    login_port: svc.login_port || 6099, appdata: root, phase: svc.phase,
    service_error: svc.error || null, service_error_code: svc.error_code || null,
    core_running: !!svc.core, backend_ready: !!svc.backend,
    qq_enabled: qqEnabled,
    engine_error: primary?.error || null,
    engine_state: primary?.state || "idle", engine_crash_count: primary?.crashCount || 0,
    channel_state: core.channels?.qq || "offline", core_stats: core.stats || null,
    last_turn_error: (qqEnabled ? core.last_turn_error : core.last_local_turn_error) || null,
    approval_pending: pendingApprovals.size > 0,
    reminder_unshown: reminderState?.unshown ?? null,
    reminder_error: reminderState?.error || null,
    qq_online: qqEnabled && core.channels?.qq === "online" && !!self.userId,
    qq_uin_mask: maskUin(self.userId), qq_nick_mask: maskNick(self.nickname),
    outbound_paused: readOutboundPausedMeta(root).paused,
    active_persona_title: meta.activeTitle || "", active_persona_id: meta.activePersonaId || "",
    active_persona_summary: meta.summary || "", activity: readActivityBrief(root, core.stats, qqEnabled),
  };
  return { ...snapshot, license, presentation: statusView.build(snapshot) };
}

let statusNotifyTimer;
function notifyStatus() {
  clearTimeout(statusNotifyTimer);
  statusNotifyTimer = setTimeout(() => {
    if (tray?._rebuild) tray._rebuild();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("status-changed");
  }, 30);
  statusNotifyTimer.unref?.();
}

function createTray() {
  if (tray || isSmoke) return;
  const icon = resolveTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip("肥鱼");
  const rebuild = () => {
    const snapshot = statusSnapshot();
    const paused = snapshot.outbound_paused;
    const loggedIn = snapshot.qq_online;
    const tip = snapshot.presentation.trayText;
    const statusLabel = "状态：" + snapshot.presentation.label;
    try {
      tray.setToolTip(tip);
      tray.setImage(stateTrayIcon(snapshot.presentation.kind));
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
        visible: snapshot.qq_enabled,
        enabled: loggedIn,
        click: async () => {
          if (!licenseGate.inspect().valid) { notifyStatus(); return; }
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
          if (services) services.sendCore({ type: "pause", paused: !paused });
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
    icon: path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
    show: !isSmoke,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#FFFFFF",
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

function notifyPersona(result) {
  if (result?.ok && services) services.sendCore({ type: "reload" });
  return result;
}

function registerIpc() {
  const fromMainFrame = (event) => mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame;
  const publicChannels = new Set(["get-license", "activate-license", "get-about", "get-status", "window-minimize", "window-maximize-toggle", "window-close"]);
  const consentChannels = new Set(["is-risk-accepted", "accept-risk", "get-onboarding"]);
  const handle = (name, listener) => ipcMain.handle(name, async (event, ...args) => {
    if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
    const clearing = name === "clear-local-data" || name === "get-data-clear-plan";
    if (dataClearLocked && !clearing && !["get-license", "get-about", "get-status", "window-minimize", "window-maximize-toggle", "window-close"].includes(name)) return { ok: false, error: "data_reset_locked" };
    if (!publicChannels.has(name)) {
      const state = licenseGate.inspect();
      if (!state.valid) { if (services) await services.stopAll(); return { ok: false, error: state.error, license: state }; }
      if (!consentChannels.has(name) && !riskAccepted() && !(dataClearLocked && clearing)) return { ok: false, error: "risk_confirmation_required" };
    }
    const tracked = !publicChannels.has(name) && !clearing;
    if (tracked) activeCommands++;
    try { return await listener(event, ...args); }
    finally { if (tracked) activeCommands--; }
  });
  handle("get-license", () => {
    const state = licenseGate.inspect(), codeTail = activationDisplay.read(resolveAppDataRoot(), state);
    return codeTail ? { ...state, codeTail } : state;
  });
  handle("activate-license", async (_event, code) => {
    if (typeof code !== "string" || code.length > 1024) return { ok: false, error: "invalid_code" };
    try {
      const state = await licenseGate.activate(code);
      activationDisplay.save(resolveAppDataRoot(), code);
      if (services && !isSmoke && riskAccepted()) services.startAll().then(notifyStatus, notifyStatus);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("license-changed");
      notifyStatus(); return { ok: true, ...state };
    } catch (e) {
      const known = ["activation_busy", "invalid_code", "device_limit", "rate_limited", "activation_network", "activation_response_invalid", "activation_unavailable", "license_unconfigured", "license_invalid", "license_wrong_device", "license_save_failed", "device_unavailable"];
      return { ok: false, error: known.includes(e.message) ? e.message : "activation_unavailable" };
    }
  });
  const memoryScopes = ["owner", "owner_public", "diary"];
  const onboardingRequest = (op, arg) => {
    try {
      const facts = onboardingFacts();
      return { ok: true, data: op === "get" ? onboarding.snapshot(facts) : op === "defer" ? onboarding.setDeferred(arg, facts) : onboarding.startQQ(facts) };
    } catch (e) { return { ok: false, error: ["onboarding_invalid", "onboarding_save_failed", "onboarding_base_incomplete", "onboarding_args_invalid"].includes(e.message) ? e.message : "onboarding_unavailable" }; }
  };
  handle("get-onboarding", () => onboardingRequest("get"));
  handle("defer-onboarding", (_event, deferred) => onboardingRequest("defer", deferred));
  handle("start-qq-onboarding", () => onboardingRequest("qq"));
  const modelRequest = (event, op, args) => {
    if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
    try { if (op !== "get" && (!args || typeof args !== "object" || Array.isArray(args) || JSON.stringify(args).length > 16000)) return { ok: false, error: "model_args_invalid" }; }
    catch { return { ok: false, error: "model_args_invalid" }; }
    let receipt = null;
    if (op === "test") { try { const draft = modelConfig.draft(resolveAppDataRoot(), args); if (!draft.changed && riskAccepted()) receipt = { generation: draft.current.generation, token: modelToken(draft.current) }; } catch { /* Core reports validation errors */ } }
    return services ? services.requestCore("model_ui", { op, ...(args ? { args } : {}) }, 60000).then((result) => {
      if (result?.ok && result.data?.connected && receipt) {
        const state = recordOnboarding("model", receipt);
        return { ...result, data: { ...result.data, onboarding_saved: !!state, onboarding_model_ready: !!state?.modelReady } };
      }
      return result;
    }) : { ok: false, error: "core_unavailable" };
  };
  handle("model-get", (event) => modelRequest(event, "get"));
  handle("model-save", (event, args) => modelRequest(event, "save", args));
  handle("model-test", (event, args) => modelRequest(event, "test", args));
  handle("workspace-get", (event) => {
    if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
    return services ? services.requestCore("workspace_ui", { op: "get" }) : { ok: false, error: "core_unavailable" };
  });
  handle("workspace-choose", async (event) => {
    if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
    if (!services) return { ok: false, error: "core_unavailable" };
    if (chatJob || workspacePickerOpen) return { ok: false, error: "local_busy" };
    workspacePickerOpen = true;
    try {
      const picked = await dialog.showOpenDialog(mainWindow, { title: "选择本机工作区", buttonLabel: "使用此文件夹", properties: ["openDirectory"] });
      if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
      if (picked.canceled) return { ok: true, cancelled: true };
      if (chatJob) return { ok: false, error: "local_busy" };
      if (!Array.isArray(picked.filePaths) || picked.filePaths.length !== 1 || typeof picked.filePaths[0] !== "string") return { ok: false, error: "workspace_unavailable" };
      return await services.requestCore("workspace_ui", { op: "set", args: { path: picked.filePaths[0] } });
    } catch { return { ok: false, error: "workspace_unavailable" }; }
    finally { workspacePickerOpen = false; }
  });
  handle("workspace-reset", (event) => {
    if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
    if (chatJob || workspacePickerOpen) return { ok: false, error: "local_busy" };
    return services ? services.requestCore("workspace_ui", { op: "set", args: { reset: true } }) : { ok: false, error: "core_unavailable" };
  });
  const memoryRequest = (event, op, args = {}) => {
    if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
    return services ? services.requestCore("memory_ui", { op, args }) : { ok: false, error: "core_unavailable" };
  };
  handle("memory-list", (event, scope, offset = 0) => {
    if (!memoryScopes.includes(scope) || !Number.isInteger(offset) || offset < 0) return { ok: false, error: "memory_args_invalid" };
    return memoryRequest(event, "list", { scope, offset });
  });
  handle("memory-forget", (event, scope, id, confirmed) => {
    if (!memoryScopes.includes(scope) || typeof id !== "string" || id.length > 100 || confirmed !== true) return { ok: false, error: "memory_args_invalid" };
    return memoryRequest(event, "forget", { scope, id, confirmed: true });
  });
  handle("memory-clear", (event, scope, expectedTotal, confirmed) => {
    if (!memoryScopes.includes(scope) || !Number.isInteger(expectedTotal) || expectedTotal < 0 || confirmed !== true) return { ok: false, error: "memory_args_invalid" };
    return memoryRequest(event, "clear", { scope, expectedTotal, confirmed: true });
  });
  handle("public-profile-get", (event) => memoryRequest(event, "public_get"));
  handle("public-profile-save", (event, text) => {
    if (typeof text !== "string" || text.length > 4000) return { ok: false, error: "memory_args_invalid" };
    return memoryRequest(event, "public_set", { text });
  });
  handle("memory-export", async (event) => {
    if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
    const result = await memoryRequest(event, "export");
    if (!result.ok) return result;
    try {
      const saved = await dialog.showSaveDialog(mainWindow, { title: "导出全部记忆", defaultPath: "fatfish-memory.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (saved.canceled || !saved.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(saved.filePath, JSON.stringify(result.data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      return { ok: true };
    } catch { return { ok: false, error: "memory_export_failed" }; }
  });
  handle("chat-get", (event) => {
    if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
    try {
      const base = chatStore.get(resolveAppDataRoot());
      return { ok: true, ...(reminderController ? reminderController.view(base) : base), busy: !!chatJob,
        approvals: [...pendingApprovals.values()] };
    } catch { return { ok: false, error: "chat_store_invalid" }; }
  });
  handle("reminders-shown", (event, ids) => {
    if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
    if (!Array.isArray(ids) || ids.length > 2000) return { ok: false, error: "invalid_request" };
    if (!reminderController) return { ok: false, error: "core_unavailable" };
    try { return reminderController.markShown(ids, chatStore.get(resolveAppDataRoot()).sessionId, mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused()); }
    catch { return { ok: false, error: "chat_store_invalid" }; }
  });
  handle("chat-new", (event) => {
    if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
    if (chatJob) return { ok: false, error: "chat_busy" };
    try { const result = chatStore.create(resolveAppDataRoot()); notifyChat(); return { ok: true, ...result }; }
    catch { return { ok: false, error: "chat_save_failed" }; }
  });
  handle("chat-send", async (event, text) => {
    if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
    if (chatJob) return { ok: false, error: "chat_busy" };
    if (typeof text !== "string" || !text.trim() || text.length > 16000) return { ok: false, error: "invalid_message" };
    if (!services) return { ok: false, error: "core_unavailable" };
    const root = resolveAppDataRoot();
    let trialReceipt; try { const state = modelConfig.read(root); trialReceipt = { generation: state.generation, token: modelToken(state) }; } catch { /* Chat reports its own model error. */ }
    let sessionId;
    try { sessionId = chatStore.get(root).sessionId; chatStore.append(root, sessionId, { role: "user", text: text.trim() }); }
    catch { return { ok: false, error: "chat_save_failed" }; }
    try { chatStore.bump(root, "inbound"); } catch { /* metadata counter is best-effort */ }
    chatJob = { sessionId }; notifyChat();
    try {
      const result = await services.chatTurn(sessionId, text.trim());
      chatStore.append(root, sessionId, { role: result.ok ? "assistant" : "status", text: result.ok ? result.text : chatFailureText(result.error) });
      if (result.ok) { try { chatStore.bump(root, "replies"); } catch { /* metadata counter is best-effort */ } }
      const setup = result.ok && trialReceipt?.token ? recordOnboarding("local", trialReceipt) : null;
      return { ...result, accepted: true, ...(result.ok ? { onboarding_saved: !!setup, onboarding_base_complete: !!setup?.baseComplete } : {}) };
    } catch { return { ok: false, error: "chat_save_failed", accepted: true }; }
    finally { chatJob = null; notifyChat(); }
  });
  handle("chat-cancel", (event) => {
    if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
    return { ok: !!chatJob && services.sendCore({ type: "chat_cancel" }) };
  });
  handle("approval-answer", (event, id, outcome) => {
    if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
    const pending = pendingApprovals.get(String(id));
    if (!pending || !["allowed-once", "rejected"].includes(outcome)) return { ok: false, error: "approval_unavailable" };
    if (Date.now() >= pending.deadlineAt) return { ok: false, error: "approval_expired" };
    return { ok: services.sendCore({ type: "approval_answer", id: pending.id, outcome }) };
  });
  handle("copy-text", (event, text) => {
    if (!fromMainFrame(event) || typeof text !== "string" || text.length > 8192) return { ok: false };
    clipboard.writeText(text); return { ok: true };
  });
  // Only the main window's top frame may administer owner bindings.
  const identityRequest = (event, type, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      return { ok: false, error: "forbidden" };
    }
    return services ? services.requestCore(type, payload) : { ok: false, error: "core_unavailable" };
  };
  handle("owners-get", (event) => identityRequest(event, "owners_get"));
  handle("pairing-start", async (event) => {
    const result = await identityRequest(event, "pairing_start");
    if (!result.ok) return result;
    const snapshot = services.getCore();
    const self = snapshot.channels.qq === "online" && snapshot.self.qq;
    return { ...result, receiver: self && /^\d+$/.test(self.userId) ? { channel: "qq", account: self.userId } : null };
  });
  handle("pairing-cancel", (event, pairingId) => identityRequest(event, "pairing_cancel", { pairingId }));
  handle("owner-remove", (event, channel, account, confirmed) => confirmed === true ?
    identityRequest(event, "owner_remove", { channel, account }) : { ok: false, error: "confirm_required" });
  handle("set-qq-enabled", async (event, enabled, confirmed) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { ok: false, error: "forbidden" };
    if (typeof enabled !== "boolean") return { ok: false, error: "invalid_channel_setting" };
    if (enabled && confirmed !== true) return { ok: false, error: "risk_confirmation_required" };
    if (!services) return { ok: false, error: "core_unavailable" };
    const result = await services.setQqEnabled(enabled);
    if (!enabled) { loginCredential = null; lastQqInfo = { uin: null, nick: null }; wsChannelEnsuredFor = ""; }
    notifyStatus();
    return result;
  });
  handle("get-status", async () => {
    if (dataClearLocked) return statusSnapshot();
    if (!licenseGate.inspect().valid || !riskAccepted()) return statusSnapshot();
    if (services) await services.refreshProbes();
    return statusSnapshot();
  });

  handle("get-ports", async () => {
    const ports = services ? services.readPorts() : { login: 6099 };
    return {
      login_port: ports.login,
    };
  });

  handle("get-service-state", async () => {
    if (!services) return { phase: "idle" };
    return services.getState();
  });

  handle("restart-services", async () => {
    if (!services || isSmoke) return { ok: false };
    loginCredential = null;
    await services.stopAll();
    const st = await services.startAll();
    return { ok: st.phase === "running" || st.phase === "degraded", state: st };
  });

  handle("save-api-key", async (event, key) => {
    if (!fromMainFrame(event)) return { ok: false, error: "forbidden" };
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (!trimmed) return { ok: false, error: "empty_key" };
    if (trimmed.length > 4096) return { ok: false, error: "model_key_invalid" };
    try {
      const current = await modelRequest(event, "get"); if (!current?.ok) return current;
      const args = Object.fromEntries(["provider", "model", "api", "baseURL", "contextWindow", "maxTokens"].filter((k) => current.data[k] !== undefined).map((k) => [k, current.data[k]]));
      return await modelRequest(event, "save", { ...args, key: trimmed, expectedGeneration: current.data.generation });
    } catch { return { ok: false, error: "model_save_failed" }; }
  });

  handle("is-risk-accepted", async () => {
    const p = riskPath(resolveAppDataRoot());
    try {
      return fs.existsSync(p) && fs.readFileSync(p, "utf8").trim().length > 0;
    } catch {
      return false;
    }
  });

  handle("accept-risk", async () => {
    const root = resolveAppDataRoot();
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(riskPath(root), "1\n", { encoding: "utf8" });
    if (services && !isSmoke) services.startAll().then(notifyStatus, notifyStatus);
    return true;
  });

  handle("get-login-session", async () => {
    if (services && !services.readQqEnabled()) return { ok: false, phase: "disabled", message: "QQ 未接入。你仍可在本机使用肥鱼。" };
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
      maybeEnsureChannel(loginCredential || session.credential);
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

  handle("poll-login-status", async () => {
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
      maybeEnsureChannel(loginCredential);
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

  handle("refresh-login-qr", async () => {
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

  handle("get-about", async () => {
    let version = "0.1.0";
    try {
      const pkg = require("./package.json");
      if (pkg && pkg.version) version = String(pkg.version);
    } catch {
      /* ignore */
    }
    return { name: "肥鱼", version };
  });

  handle("get-autostart", async () => {
    try {
      const s = app.getLoginItemSettings();
      return { ok: true, enabled: !!(s && s.openAtLogin) };
    } catch (e) {
      return { ok: false, enabled: false, error: String(e && e.message ? e.message : e) };
    }
  });

  handle("set-autostart", async (_evt, enabled) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath });
      const s = app.getLoginItemSettings();
      return { ok: true, enabled: !!(s && s.openAtLogin) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  handle("open-data-folder", async () => {
    const root = resolveAppDataRoot();
    try {
      fs.mkdirSync(root, { recursive: true });
      const r = await shell.openPath(root);
      return { ok: !r, error: r || "" };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  handle("export-settings", async () => {
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

  handle("get-data-clear-plan", (_evt, args) => {
    try { return { ok: true, data: dataClear.preview(resolveAppDataRoot(), args) }; }
    catch (e) { return { ok: false, error: ["clear_args_invalid", "clear_model_invalid", "clear_path_invalid"].includes(e.message) ? e.message : "clear_unavailable" }; }
  });
  handle("clear-local-data", async (_evt, args) => {
    if (dataClearing || activeCommands) return { ok: false, error: "clear_busy" };
    try { dataClear.options(args, true); dataClear.preview(resolveAppDataRoot(), { includeKeys: args.includeKeys, includeLicense: args.includeLicense }); }
    catch (e) { return { ok: false, error: ["clear_args_invalid", "clear_model_invalid", "clear_path_invalid"].includes(e.message) ? e.message : "clear_unavailable" }; }
    dataClearing = true; dataClearLocked = true; dataClearState = "stopping";
    notifyStatus();
    reminderController?.dispose(); reminderController = null;
    try {
      try { if (services) await services.stopForDataReset(); dataClearState = "stopped"; } catch { dataClearState = "stop_failed"; return { ok: false, error: "clear_stop_failed" }; }
      const data = dataClear.clear(resolveAppDataRoot(), args);
      onboarding.pending.clear(); loginCredential = null; lastQqInfo = { uin: null, nick: null };
      dataClearState = "cleared";
      setTimeout(() => app.quit(), 200);
      return { ok: true, data, exiting: true };
    } catch { return { ok: false, error: "clear_failed" }; }
    finally { dataClearing = false; notifyStatus(); }
  });

  handle("window-minimize", async () => {
    if (mainWindow) mainWindow.minimize();
    return true;
  });

  handle("window-maximize-toggle", async () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });

  handle("window-close", async () => {
    if (mainWindow) mainWindow.close();
    return true;
  });

  handle("get-outbound-paused", async () => {
    const root = resolveAppDataRoot();
    try {
      const p = outboundPausedPath(root);
      return fs.existsSync(p) && fs.readFileSync(p, "utf8").trim() === "1";
    } catch {
      return false;
    }
  });

  handle("set-outbound-paused", async (_evt, paused) => {
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

  handle("persona-list", async () => {
    try {
      return personaLib.listPersonas(resolveAppDataRoot());
    } catch {
      return { ok: false, items: [], activePersonaId: "", activeTitle: "" };
    }
  });

  handle("persona-get", async (_evt, id) => {
    try {
      return personaLib.getPersona(resolveAppDataRoot(), id);
    } catch {
      return { ok: false, error: "read_failed" };
    }
  });

  handle("persona-create", async (_evt, payload) => {
    try {
      return notifyPersona(personaLib.createPersona(resolveAppDataRoot(), payload || {}));
    } catch {
      return { ok: false, error: "create_failed" };
    }
  });

  handle("persona-update", async (_evt, id, payload) => {
    try {
      return notifyPersona(personaLib.updatePersona(resolveAppDataRoot(), id, payload || {}));
    } catch {
      return { ok: false, error: "update_failed" };
    }
  });

  handle("persona-delete", async (_evt, id, confirmed) => {
    try {
      return notifyPersona(personaLib.deletePersona(resolveAppDataRoot(), id, !!confirmed));
    } catch {
      return { ok: false, error: "delete_failed" };
    }
  });

  handle("persona-apply", async (_evt, id) => {
    try {
      return notifyPersona(personaLib.applyPersona(resolveAppDataRoot(), id));
    } catch {
      return { ok: false, error: "apply_failed" };
    }
  });

  handle("persona-import-text", async (_evt, text) => {
    try {
      return personaLib.importFromText(text);
    } catch {
      return { ok: false, error: "import_failed" };
    }
  });

  // 兼容首次设置：把文本建成库条目并应用
  handle("save-persona", async (_evt, text) => {
    const root = resolveAppDataRoot();
    try {
      personaLib.ensurePersonaLib(root);
      const body = String(text || "");
      if (!body.trim()) return { ok: true };
      const created = personaLib.createPersona(root, {
        title: "我的人格",
        body,
      });
      if (created && created.ok && created.item) {
        return notifyPersona(personaLib.applyPersona(root, created.item.id));
      }
      return { ok: false };
    } catch {
      return { ok: false };
    }
  });

  handle("get-persona", async () => {
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
  reminderController?.dispose(); reminderController = null;
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
    configureAppIdentity();
    registerIpc();
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

    const root = resolveAppDataRoot();
    services = new ServiceManager({
      appDataRoot: root,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      electronExecPath: process.execPath,
    });
    reminderController = new ReminderController({ services, inbox: new ReminderInbox({ root, currentSession: () => chatStore.get(root).sessionId }), changed: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("reminders-changed");
      notifyStatus();
    } });
    services.on("identity-event", (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("identity-event", event);
    });
    services.on("approval", approvalArrived);
    services.on("approval-closed", approvalClosed);

    createWindow();
    createTray();
    services.on("core-message", (m) => {
      if (dataClearLocked) return;
      if (m.type === "owner_reply" && m.channel === "qq" && typeof m.bindingHash === "string" && /^[0-9a-f]{64}$/.test(m.bindingHash) && Number.isSafeInteger(m.generation)) recordOnboarding("remote", { bindingHash: m.bindingHash, generation: m.generation });
      if (["self", "channel", "owners", "ready", "paused"].includes(m.type)) notifyOnboarding();
      if (["ready", "model_changed", "unavailable"].includes(m.type) && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("model-changed");
      if (["ready", "workspace_changed", "unavailable"].includes(m.type) && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("workspace-changed");
      if (["ready", "memory_changed", "unavailable"].includes(m.type) && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("memory-changed");
      if (["license", "engine", "channel", "self", "stats", "turn_error", "turn_end", "chat_result", "paused", "unavailable"].includes(m.type)) notifyStatus();
      if (m.type === "unavailable") {
        for (const a of [...pendingApprovals.values()]) approvalClosed({ id: a.id, outcome: "cancelled" });
      }
    });

    if (!isSmoke && licenseGate.inspect().valid && riskAccepted()) {
      services.startAll().then((st) => {
        notifyStatus();
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
