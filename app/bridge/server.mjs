/**
 * FatFish local bridge — private-chat reply engine.
 * Config/Key from %AppData%/FatFish (override root with FATFISH_APPDATA).
 * Binds/connects to 127.0.0.1 only. Never log API keys.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import WebSocket from "ws";
import { tryAgentReply, readAgentEngineFlag, isEngineAvailable } from "./agent-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveAppDataRoot() {
  if (process.env.FATFISH_APPDATA) return process.env.FATFISH_APPDATA;
  if (process.env.APPDATA) return join(process.env.APPDATA, "FatFish");
  // Linux/mac dev fallback
  return join(homedir(), ".fatfish");
}

const root = resolveAppDataRoot();
const secretsDir = join(root, "secrets");
const keyPath = join(secretsDir, "deepseek_api_key");
const tokenPath = join(secretsDir, "local_token");
const personaPath = join(root, "persona.txt");
const personasJsonPath = join(root, "personas.json");
const personaRevPath = join(root, "runtime", "persona_rev");
const outboundPausedPath = join(root, "runtime", "outbound_paused");
const configPath = join(root, "config.json");
const bundledPersona = join(__dirname, "persona.example.txt");
const defaultPersona =
  "你是温暖、简洁的私聊助手「肥鱼」。用简体中文回复，尽量简短。";
let lastPersonaRev = "";

const DEEPSEEK_URL = process.env.DEEPSEEK_URL || "https://api.deepseek.com/chat/completions";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const NO_KEY_REPLY = "请先在设置中填写 API Key";

const history = new Map();
const MAX_TURNS = 8;

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function redact(s) {
  if (s == null) return "";
  return String(s)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***");
}

function ensureDirs() {
  mkdirSync(secretsDir, { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });
}


function isOutboundPaused() {
  try {
    if (!existsSync(outboundPausedPath)) return false;
    return readFileSync(outboundPausedPath, "utf8").trim() === "1";
  } catch {
    return false;
  }
}

function loadKey() {
  try {
    if (!existsSync(keyPath)) return null;
    const k = readFileSync(keyPath, "utf8").trim();
    return k || null;
  } catch {
    return null;
  }
}

function loadToken() {
  try {
    if (!existsSync(tokenPath)) return "";
    return readFileSync(tokenPath, "utf8").trim();
  } catch {
    return "";
  }
}

function readPersonaRev() {
  try {
    if (existsSync(personaRevPath)) return readFileSync(personaRevPath, "utf8").trim();
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(personaPath)) {
      const st = statSync(personaPath);
      return String(st.mtimeMs);
    }
  } catch {
    /* ignore */
  }
  return "";
}

function loadPersona() {
  try {
    if (existsSync(personasJsonPath)) {
      const j = JSON.parse(readFileSync(personasJsonPath, "utf8"));
      const items = Array.isArray(j.items) ? j.items : [];
      const activeId = j.activePersonaId;
      const active = items.find((x) => x && x.id === activeId) || items[0];
      if (active && String(active.body || "").trim()) {
        return String(active.body).trim();
      }
    }
    if (existsSync(personaPath)) {
      const t = readFileSync(personaPath, "utf8").trim();
      if (t) return t;
    }
    if (existsSync(bundledPersona)) {
      return readFileSync(bundledPersona, "utf8").trim() || defaultPersona;
    }
  } catch {
    /* fallthrough */
  }
  return defaultPersona;
}

function maybeResetHistoryForPersonaChange() {
  const rev = readPersonaRev();
  if (rev && rev !== lastPersonaRev) {
    if (lastPersonaRev) {
      history.clear();
      log("persona_applied_reset_history", "rev=" + rev);
    }
    lastPersonaRev = rev;
  }
}

function loadConfig() {
  const defaults = {
    onebot_url: "ws://127.0.0.1:3001",
    onebot_host: "127.0.0.1",
    onebot_port: 3001,
    settings_port: 8787,
    login_ui_port: 6099,
    bind: "127.0.0.1",
    agent_engine: { enabled: false, timeout_ms: 45000, pinned_version: "0.2.1-rc.2" },
  };
  try {
    if (existsSync(configPath)) {
      const j = JSON.parse(readFileSync(configPath, "utf8"));
      return { ...defaults, ...j };
    }
  } catch (e) {
    log("config_read_error", redact(e.message));
  }
  return defaults;
}

function extractText(message) {
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return "";
  return message
    .filter((s) => s && s.type === "text" && s.data?.text)
    .map((s) => s.data.text)
    .join("")
    .trim();
}

async function deepseekReply(apiKey, persona, userId, text) {
  const prev = history.get(userId) || [];
  const messages = [
    { role: "system", content: persona },
    ...prev,
    { role: "user", content: text },
  ];
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 400,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`model_http_${res.status}: ${redact(body).slice(0, 200)}`);
  }
  const data = await res.json();
  const reply =
    data.choices?.[0]?.message?.content?.trim() ||
    "……我这边卡住了，稍后再试。";
  const next = [
    ...prev,
    { role: "user", content: text },
    { role: "assistant", content: reply },
  ];
  history.set(userId, next.slice(-MAX_TURNS * 2));
  return reply;
}

function sendApi(ws, action, params) {
  const echo = `e-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  ws.send(JSON.stringify({ action, params, echo }));
  return echo;
}

function connect() {
  ensureDirs();
  const cfg = loadConfig();
  const token = loadToken();
  const persona = loadPersona();
  const apiKey = loadKey();

  let onebotUrl = cfg.onebot_url || `ws://${cfg.onebot_host || "127.0.0.1"}:${cfg.onebot_port || 3001}`;
  // force loopback
  if (!/127\.0\.0\.1|localhost/.test(onebotUrl)) {
    log("refuse_non_loopback", onebotUrl);
    onebotUrl = "ws://127.0.0.1:3001";
  }

  lastPersonaRev = readPersonaRev();
  const aeFlag = readAgentEngineFlag(cfg);
  log(
    "boot",
    "root=" + root,
    "key=" + (apiKey ? "present" : "MISSING"),
    "persona_chars=" + persona.length,
    "persona_rev=" + lastPersonaRev,
    "agent_engine=" + (aeFlag.enabled ? "on" : "off"),
    "agent_sidecar=" + (isEngineAvailable(join(__dirname, "..", "..")) ? "yes" : "no")
  );
  const url = token
    ? `${onebotUrl.replace(/\/$/, "")}/?access_token=${encodeURIComponent(token)}`
    : onebotUrl;
  log("connecting", onebotUrl);

  const ws = new WebSocket(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  ws.on("open", () => {
    log("connected");
    sendApi(ws, "get_login_info", {});
  });

  ws.on("message", async (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (msg.echo && msg.data?.nickname) {
      log("login_info", msg.data.user_id, msg.data.nickname);
      return;
    }
    if (msg.post_type === "meta_event") {
      if (msg.meta_event_type === "heartbeat") return;
      log("meta", msg.meta_event_type, msg.sub_type || "");
      return;
    }
    if (msg.post_type && msg.post_type !== "message") {
      log("event", msg.post_type, msg.notice_type || msg.request_type || "");
      return;
    }
    if (msg.post_type !== "message") return;
    if (msg.message_type !== "private") return;
    if (msg.user_id && msg.self_id && String(msg.user_id) === String(msg.self_id)) return;

    const text = extractText(msg.message);
    if (!text) return;
    const uid = String(msg.user_id);
    log("private_in", uid, text.slice(0, 80));

    if (isOutboundPaused()) {
      log("outbound_paused_skip", uid);
      return;
    }

    try {
      const keyNow = loadKey();
      let reply;
      if (!keyNow) {
        reply = NO_KEY_REPLY;
      } else {
        maybeResetHistoryForPersonaChange();
        const personaNow = loadPersona();
        const cfgNow = loadConfig();
        // Pause already gated above — also freezes engine path.
        const agent = await tryAgentReply({
          config: cfgNow,
          apiKey: keyNow,
          persona: personaNow,
          userText: text,
          bundleRoot: join(__dirname, "..", ".."),
          log,
        });
        if (agent.used && agent.text) {
          reply = agent.text;
          // Keep short history aligned for fallback continuity
          const prev = history.get(uid) || [];
          const next = [
            ...prev,
            { role: "user", content: text },
            { role: "assistant", content: reply },
          ];
          history.set(uid, next.slice(-MAX_TURNS * 2));
          log("private_out_engine", uid, reply.slice(0, 80));
        } else {
          reply = await deepseekReply(keyNow, personaNow, uid, text);
        }
      }
      sendApi(ws, "send_private_msg", { user_id: Number(uid), message: reply });
      log("private_out", uid, reply.slice(0, 80));
    } catch (e) {
      log("reply_error", redact(e.message));
      sendApi(ws, "send_private_msg", {
        user_id: Number(uid),
        message: "我这边模型暂时不可用，稍后再试一下。",
      });
    }
  });

  ws.on("close", (c, r) => {
    log("closed", c, redact(r?.toString?.() || ""));
    setTimeout(connect, 3000);
  });
  ws.on("error", (e) => log("ws_error", redact(e.message)));
}

// write default config if missing (dev convenience)
ensureDirs();
if (!existsSync(configPath)) {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        onebot_url: "ws://127.0.0.1:3001",
        onebot_host: "127.0.0.1",
        onebot_port: 3001,
        settings_port: 8787,
        login_ui_port: 6099,
        bind: "127.0.0.1",
        agent_engine: { enabled: false, timeout_ms: 45000, pinned_version: "0.2.1-rc.2" },
      },
      null,
      2
    ),
    "utf8"
  );
}

connect();
