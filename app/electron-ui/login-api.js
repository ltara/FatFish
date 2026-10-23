/**
 * Local login-panel API helpers (main process only).
 * Talks to 127.0.0.1 login port; never surface vendor names in UI strings.
 */
"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const QRCode = require("qrcode");

/** Upstream auth salt — internal only, never shown in UI. */
const AUTH_SALT = ".napcat";

const DEFAULT_PORT = 6099;
const REQUEST_TIMEOUT_MS = 4000;

/**
 * @param {string} token
 * @returns {string} hex sha256
 */
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token) + AUTH_SALT, "utf8").digest("hex");
}

/**
 * @param {number} port
 * @param {string} pathname
 * @param {{ method?: string, body?: object|null, credential?: string|null }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, json: any }>}
 */
function requestJson(port, pathname, opts = {}) {
  const method = opts.method || "POST";
  const bodyStr = opts.body != null ? JSON.stringify(opts.body) : "";
  const headers = {
    Connection: "close",
    Accept: "application/json",
  };
  if (bodyStr) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    headers["Content-Length"] = Buffer.byteLength(bodyStr);
  }
  if (opts.credential) {
    headers.Authorization = "Bearer " + opts.credential;
  }

  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        timeout: REQUEST_TIMEOUT_MS,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode || 0, json });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, json: null });
    });
    req.on("error", () => resolve({ ok: false, status: 0, json: null }));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function unwrapData(json) {
  if (!json || typeof json !== "object") return null;
  if (json.data != null && typeof json.data === "object") return json.data;
  return json;
}

/**
 * Authenticate with login panel token → Credential string.
 * @param {string} token
 * @param {number} [port]
 * @returns {Promise<{ ok: boolean, credential: string|null, error?: string }>}
 */
async function authLogin(token, port = DEFAULT_PORT) {
  if (!token) return { ok: false, credential: null, error: "no_token" };
  const hash = hashToken(token);
  const res = await requestJson(port, "/api/auth/login", {
    method: "POST",
    body: { hash },
  });
  const data = unwrapData(res.json);
  const cred =
    data && typeof data.Credential === "string"
      ? data.Credential
      : data && typeof data.credential === "string"
        ? data.credential
        : null;
  if (res.ok && cred) return { ok: true, credential: cred };
  const code = res.json && res.json.code;
  return { ok: false, credential: null, error: code != null ? "auth_code_" + code : "auth_failed" };
}

/**
 * @param {string} credential
 * @param {number} [port]
 */
async function checkLoginStatus(credential, port = DEFAULT_PORT) {
  const res = await requestJson(port, "/api/QQLogin/CheckLoginStatus", {
    method: "POST",
    body: {},
    credential,
  });
  const data = unwrapData(res.json);
  if (!data) return { ok: false, raw: res.json };
  return {
    ok: true,
    isLogin: !!(data.isLogin || data.is_login),
    loginPhase: String(data.loginPhase || data.login_phase || "").trim(),
    qrcodeurl: data.qrcodeurl || data.qrcodeUrl || data.qrcode || null,
    loginError: data.loginError || data.login_error || data.message || null,
    qrLoginAccepted: !!(data.qrLoginAccepted || data.qr_login_accepted),
    raw: data,
  };
}

/**
 * @param {string} credential
 * @param {number} [port]
 */
async function getQQLoginQrcode(credential, port = DEFAULT_PORT) {
  const res = await requestJson(port, "/api/QQLogin/GetQQLoginQrcode", {
    method: "POST",
    body: {},
    credential,
  });
  const data = unwrapData(res.json);
  const url = data && (data.qrcode || data.qrcodeurl || data.qrcodeUrl);
  return { ok: !!url, qrcodeurl: url || null };
}

/**
 * @param {string} credential
 * @param {number} [port]
 */
async function refreshQRcode(credential, port = DEFAULT_PORT) {
  const res = await requestJson(port, "/api/QQLogin/RefreshQRcode", {
    method: "POST",
    body: {},
    credential,
  });
  const data = unwrapData(res.json);
  const url = data && (data.qrcodeurl || data.qrcodeUrl || data.qrcode);
  return { ok: !!url, qrcodeurl: url || null };
}

/**
 * @param {string} credential
 * @param {number} [port]
 */
async function getQQLoginInfo(credential, port = DEFAULT_PORT) {
  const res = await requestJson(port, "/api/QQLogin/GetQQLoginInfo", {
    method: "POST",
    body: {},
    credential,
  });
  const data = unwrapData(res.json);
  if (!data) return { ok: false, uin: null, nick: null };
  return {
    ok: true,
    uin: data.uin != null ? String(data.uin) : data.user_id != null ? String(data.user_id) : null,
    nick: data.nick || data.nickname || data.nickName || null,
  };
}

/**
 * Turn a QR payload (URL or already-dataURL) into an image data URL for the renderer.
 * @param {string} payload
 * @returns {Promise<string|null>}
 */
async function toQrDataUrl(payload) {
  if (!payload || typeof payload !== "string") return null;
  const s = payload.trim();
  if (!s) return null;
  if (s.startsWith("data:image/")) return s;
  try {
    return await QRCode.toDataURL(s, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
      color: { dark: "#15202b", light: "#ffffff" },
    });
  } catch {
    return null;
  }
}

/**
 * One-shot: auth + status + ensure QR dataURL.
 * @param {{ token: string, port?: number, credential?: string|null }} opts
 */
async function getLoginSession(opts) {
  const port = opts.port || DEFAULT_PORT;
  let credential = opts.credential || null;
  if (!credential) {
    const auth = await authLogin(opts.token, port);
    if (!auth.ok) {
      return {
        ok: false,
        error: auth.error || "auth_failed",
        phase: "error",
        credential: null,
        qrDataUrl: null,
        message: "登录服务鉴权失败，请稍后重试。",
      };
    }
    credential = auth.credential;
  }

  let status = await checkLoginStatus(credential, port);
  if (!status.ok) {
    // credential may have expired — re-auth once
    const auth2 = await authLogin(opts.token, port);
    if (!auth2.ok) {
      return {
        ok: false,
        error: "status_failed",
        phase: "error",
        credential: null,
        qrDataUrl: null,
        message: "无法获取登录状态。",
      };
    }
    credential = auth2.credential;
    status = await checkLoginStatus(credential, port);
  }

  if (status.isLogin || status.loginPhase === "ready") {
    const info = await getQQLoginInfo(credential, port);
    return {
      ok: true,
      phase: "success",
      credential,
      isLogin: true,
      qrDataUrl: null,
      uin: info.uin,
      nick: info.nick,
      loginError: null,
      message: "登录成功",
    };
  }

  let qrUrl = status.qrcodeurl;
  if (!qrUrl) {
    const g = await getQQLoginQrcode(credential, port);
    if (g.ok) qrUrl = g.qrcodeurl;
  }

  const qrDataUrl = qrUrl ? await toQrDataUrl(String(qrUrl)) : null;
  const phase = mapPhase(status.loginPhase, status.qrLoginAccepted, status.loginError);

  return {
    ok: true,
    phase,
    credential,
    isLogin: false,
    qrDataUrl,
    uin: null,
    nick: null,
    loginError: status.loginError ? String(status.loginError) : null,
    message: phaseMessage(phase, status.loginError),
  };
}

/**
 * Poll status; refresh QR image if URL changed / missing.
 */
async function pollLoginStatus(opts) {
  const port = opts.port || DEFAULT_PORT;
  const credential = opts.credential;
  if (!credential) {
    return { ok: false, phase: "error", message: "会话失效，请刷新。" };
  }

  const status = await checkLoginStatus(credential, port);
  if (!status.ok) {
    return { ok: false, phase: "error", message: "无法获取登录状态。" };
  }

  if (status.isLogin || status.loginPhase === "ready") {
    const info = await getQQLoginInfo(credential, port);
    return {
      ok: true,
      phase: "success",
      isLogin: true,
      qrDataUrl: null,
      uin: info.uin,
      nick: info.nick,
      loginError: null,
      message: "登录成功",
    };
  }

  let qrUrl = status.qrcodeurl;
  if (!qrUrl && opts.wantQr) {
    const g = await getQQLoginQrcode(credential, port);
    if (g.ok) qrUrl = g.qrcodeurl;
  }
  const qrDataUrl = qrUrl ? await toQrDataUrl(String(qrUrl)) : opts.prevQrDataUrl || null;
  const phase = mapPhase(status.loginPhase, status.qrLoginAccepted, status.loginError);

  return {
    ok: true,
    phase,
    isLogin: false,
    qrDataUrl,
    uin: null,
    nick: null,
    loginError: status.loginError ? String(status.loginError) : null,
    message: phaseMessage(phase, status.loginError),
  };
}

async function refreshLoginQr(opts) {
  const port = opts.port || DEFAULT_PORT;
  const credential = opts.credential;
  if (!credential) return { ok: false, qrDataUrl: null, message: "会话失效，请刷新。" };

  let qrUrl = null;
  const r = await refreshQRcode(credential, port);
  if (r.ok) qrUrl = r.qrcodeurl;
  if (!qrUrl) {
    const g = await getQQLoginQrcode(credential, port);
    if (g.ok) qrUrl = g.qrcodeurl;
  }
  const qrDataUrl = qrUrl ? await toQrDataUrl(String(qrUrl)) : null;
  return {
    ok: !!qrDataUrl,
    phase: qrDataUrl ? "waiting" : "error",
    qrDataUrl,
    message: qrDataUrl ? "请使用手机 QQ 扫描二维码" : "二维码刷新失败，请稍后重试。",
  };
}

function mapPhase(loginPhase, qrAccepted, loginError) {
  const err = loginError ? String(loginError) : "";
  if (/验证|手机|确认|短信|二次/i.test(err)) return "verify";
  const p = String(loginPhase || "").toLowerCase();
  if (p === "ready" || p === "logged_in") return "success";
  if (qrAccepted || p === "qrcode_scanned" || p === "scanned" || p === "confirming") return "scanned";
  if (p === "initializing" || p === "reconnecting") return "scanned";
  if (/expire|过期|失效|fail|错误/i.test(err) || p === "error" || p === "failed") return "error";
  if (p === "waiting_qrcode" || p === "waiting" || !p) return "waiting";
  return "waiting";
}

function phaseMessage(phase, loginError) {
  if (phase === "success") return "登录成功";
  if (phase === "scanned") return "已扫码，请在手机上确认登录";
  if (phase === "verify") return "请在手机上完成验证或确认";
  if (phase === "error") {
    const e = loginError ? String(loginError) : "";
    if (/验证|手机|确认/i.test(e)) return "请在手机上完成验证或确认";
    if (/过期|失效|expire/i.test(e)) return "二维码已失效，请点击刷新";
    return e ? "登录遇到问题，请刷新二维码重试" : "登录失败，请刷新重试";
  }
  return "请使用手机 QQ 扫描二维码";
}

function looksLikePhoneVerify(loginError, message) {
  // Only inspect upstream loginError. Friendly UI copy (e.g.「请使用手机 QQ 扫描…」)
  // must NOT flip phase to verify, or the QR pane never shows.
  const s = String(loginError || "").trim();
  if (!s) return false;
  if (/短信|二次|设备锁|密保/i.test(s)) return true;
  if (/验证/i.test(s) && /手机|设备|安全/i.test(s)) return true;
  // ignore bare「确认」in scan-confirm flows — those are phase "scanned"
  return false;
}


/**
 * After QQ login: ensure local WS server :3001 is enabled so the reply bridge can connect.
 * Uses AppData local_token as WS token. Idempotent. Never logs secrets.
 * @param {{ credential: string, port?: number, localToken: string, host?: string, wsPort?: number }} opts
 * @returns {Promise<{ ok: boolean, changed?: boolean, error?: string }>}
 */
async function ensureOnebotWsServer(opts) {
  const port = opts.port || DEFAULT_PORT;
  const credential = opts.credential;
  const localToken = String(opts.localToken || "").trim();
  const host = opts.host || "127.0.0.1";
  const wsPort = Number(opts.wsPort) || 3001;
  if (!credential) return { ok: false, error: "no_credential" };
  if (!localToken) return { ok: false, error: "no_local_token" };

  const getRes = await requestJson(port, "/api/OB11Config/GetConfig", {
    method: "POST",
    body: {},
    credential,
  });
  if (!getRes.ok || !getRes.json || getRes.json.code !== 0) {
    return { ok: false, error: "get_config_failed" };
  }
  let cfg = getRes.json.data;
  if (typeof cfg === "string") {
    try {
      cfg = JSON.parse(cfg);
    } catch {
      return { ok: false, error: "config_parse_failed" };
    }
  }
  if (!cfg || typeof cfg !== "object") return { ok: false, error: "config_empty" };
  if (!cfg.network || typeof cfg.network !== "object") cfg.network = {};
  const net = cfg.network;
  if (!Array.isArray(net.websocketServers)) net.websocketServers = [];
  if (!Array.isArray(net.httpServers)) net.httpServers = [];
  if (!Array.isArray(net.httpClients)) net.httpClients = [];
  if (!Array.isArray(net.httpSseServers)) net.httpSseServers = [];
  if (!Array.isArray(net.websocketClients)) net.websocketClients = [];
  if (!Array.isArray(net.plugins)) net.plugins = [];

  const wantName = "fatfish-ws";
  const existing = net.websocketServers.find(
    (s) => s && (s.name === wantName || Number(s.port) === wsPort)
  );
  const alreadyOk =
    existing &&
    existing.enable !== false &&
    String(existing.host || "") === host &&
    Number(existing.port) === wsPort &&
    String(existing.token || "") === localToken;
  if (alreadyOk) return { ok: true, changed: false };

  const entry = {
    enable: true,
    name: wantName,
    host,
    port: wsPort,
    reportSelfMessage: false,
    enableForcePushEvent: true,
    messagePostFormat: "array",
    token: localToken,
    debug: false,
    heartInterval: 30000,
  };
  net.websocketServers = [
    ...net.websocketServers.filter(
      (s) => s && s.name !== wantName && Number(s.port) !== wsPort
    ),
    entry,
  ];
  cfg.network = net;

  const setRes = await requestJson(port, "/api/OB11Config/SetConfig", {
    method: "POST",
    body: { config: JSON.stringify(cfg) },
    credential,
  });
  if (!setRes.ok || !setRes.json || setRes.json.code !== 0) {
    return { ok: false, error: "set_config_failed" };
  }
  return { ok: true, changed: true };
}

module.exports = {
  hashToken,
  authLogin,
  checkLoginStatus,
  getQQLoginQrcode,
  refreshQRcode,
  getQQLoginInfo,
  toQrDataUrl,
  getLoginSession,
  pollLoginStatus,
  refreshLoginQr,
  looksLikePhoneVerify,
  ensureOnebotWsServer,
  DEFAULT_PORT,
};
