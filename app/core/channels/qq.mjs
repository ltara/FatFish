/**
 * QQ channel — OneBot v11 forward WebSocket to the local backend (loopback + token only).
 * Emits: "status" ("connecting" | "online" | "offline"), "self" ({ userId, nickname }),
 *        "message" ({ from, text }) for private text messages from others.
 * Logs metadata only.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { log, redact } from "../paths.mjs";

const RECONNECT_MS = 3000;
const SEND_TIMEOUT_MS = 10000;
const CHUNK = 1500; // QQ renders very long single messages poorly

function extractText(message) {
  if (typeof message === "string") return message.trim();
  if (!Array.isArray(message)) return "";
  return message
    .filter((s) => s && s.type === "text" && s.data?.text)
    .map((s) => s.data.text)
    .join("")
    .trim();
}

export function splitForQQ(text) {
  const out = [];
  let rest = String(text || "").trim();
  while (rest.length > CHUNK) {
    let cut = rest.lastIndexOf("\n", CHUNK);
    if (cut < CHUNK / 2) cut = CHUNK;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export class QQChannel extends EventEmitter {
  constructor({ url, token }) {
    super();
    this.id = "qq";
    // Force loopback: never talk to a non-local OneBot endpoint.
    this.url = /^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url || "") ? url : "ws://127.0.0.1:3001";
    if (this.url !== url) log("qq_refuse_non_loopback");
    this.token = token;
    this.ws = null;
    this.selfId = "";
    this.pending = new Map();
    this.state = "offline";
    this.closed = false;
    this.reconnectTimer = null;
  }

  #setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit("status", s);
  }

  start() {
    clearTimeout(this.reconnectTimer);
    this.closed = false;
    this.#connect();
  }

  stop() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.selfId = "";
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  #connect() {
    if (this.closed) return;
    this.#setState("connecting");
    const url = this.token ? `${this.url.replace(/\/$/, "")}/?access_token=${encodeURIComponent(this.token)}` : this.url;
    const ws = new WebSocket(url, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    this.ws = ws;
    ws.on("open", () => {
      log("qq_connected");
      this.#setState("online");
      this.#call("get_login_info", {}).then((r) => {
        if (r?.data?.user_id) {
          this.selfId = String(r.data.user_id);
          this.emit("self", { userId: this.selfId, nickname: r.data.nickname || "" });
        }
      }, () => {});
    });
    ws.on("message", (buf) => this.#onFrame(buf));
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      log("qq_closed", "code=" + code);
      for (const p of this.pending.values()) p.resolve(null);
      this.pending.clear();
      this.#setState("offline");
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.#connect(); }, RECONNECT_MS);
        this.reconnectTimer.unref?.();
      }
    });
    ws.on("error", (e) => log("qq_ws_error", redact(e.message)));
  }

  #onFrame(buf) {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (msg.echo && this.pending.has(msg.echo)) {
      const p = this.pending.get(msg.echo);
      this.pending.delete(msg.echo);
      p.resolve(msg);
      return;
    }
    // Pinned backend's heartbeat reports account state even while WS stays connected.
    if (msg.post_type === "meta_event" && msg.meta_event_type === "heartbeat" && typeof msg.status?.online === "boolean") {
      this.#setState(msg.status.online ? "online" : "offline");
      return;
    }
    if (msg.post_type !== "message" || msg.message_type !== "private") return;
    const from = String(msg.user_id || "");
    if (!from || from === String(msg.self_id || this.selfId)) return;
    const text = extractText(msg.message);
    if (!text) return;
    this.emit("message", { from, text });
  }

  #call(action, params) {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return resolve(null);
      const echo = `ff-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const t = setTimeout(() => (this.pending.delete(echo), resolve(null)), SEND_TIMEOUT_MS);
      this.pending.set(echo, { resolve: (v) => (clearTimeout(t), resolve(v)) });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  /** Send plain text as message segments (never CQ-code parsed). Resolves true when every chunk was accepted. */
  async sendConfirmed(to, text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.state !== "online" || !Number.isSafeInteger(Number(to)) || splitForQQ(text).length !== 1) return { state: "not_sent" };
    try {
      const r = await this.#call("send_private_msg", { user_id: Number(to), message: [{ type: "text", data: { text } }] });
      if (!r) return { state: "unknown" }; // Sent frame, but no definitive receipt: never blindly resend.
      if (r.status === "ok" && r.retcode === 0 && r.data?.message_id != null) return { state: "sent" };
      return { state: r.status === "failed" ? "not_sent" : "unknown" };
    } catch { return { state: "unknown" }; }
  }

  async send(to, text) {
    let ok = true;
    for (const part of splitForQQ(text)) {
      const r = await this.#call("send_private_msg", {
        user_id: Number(to),
        message: [{ type: "text", data: { text: part } }],
      });
      if (!r || r.status !== "ok") ok = false;
    }
    return ok;
  }
}
