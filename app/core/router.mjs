/**
 * Router — decides which inbound messages reach the engine (docs/ARCHITECTURE.md §4).
 * v1: only the bound owner (config.owner_qq, matched on the backend-reported user_id) is answered;
 * everyone else is silently ignored and never enters DSH. Pause drops inbound and outbound.
 * Emits "stats" (today's counters) and "turn_error" ({ error }) for the UI. Metadata-only logs.
 */
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, loadConfig, isOutboundPaused, log } from "./paths.mjs";

// What the owner sees when a turn fails; keep it in the companion's voice, no technical terms.
const OWNER_ERROR_REPLY = {
  no_key: "我还没有拿到模型密钥，没法回你。请在电脑上打开肥鱼，在「设置」里填写。",
  missing_runtime: "我的智能引擎没有装好，请在电脑上重新安装肥鱼。",
  default: "我这边出了点状况，稍后再找我试试。",
};

const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
const mask = (id) => (id.length > 4 ? "***" + id.slice(-4) : "***");
const freshStats = () => ({ date: today(), inbound: 0, replies: 0, ignored: 0, errors: 0, lastReplyAt: 0 });
// Today's counters survive Core restarts (home page "今日互动"); counts only, no content.
const statsPath = join(paths.root, "runtime", "stats.json");

function loadStats() {
  try {
    const s = JSON.parse(readFileSync(statsPath, "utf8"));
    if (s.date === today()) return { ...freshStats(), ...s };
  } catch {
    /* missing or corrupt → start fresh */
  }
  return freshStats();
}

export class Router extends EventEmitter {
  constructor({ engine }) {
    super();
    this.engine = engine;
    this.paused = false;
    this.stats = loadStats();
  }

  getStats() {
    if (this.stats.date !== today()) this.stats = freshStats();
    return { ...this.stats };
  }

  attach(channel) {
    channel.on("message", (m) => this.#handle(channel, m).catch((e) => log("router_error", String(e.message).slice(0, 120))));
  }

  setPaused(paused) {
    this.paused = !!paused;
  }

  isPaused() {
    return this.paused || isOutboundPaused();
  }

  #bump(field) {
    if (this.stats.date !== today()) this.stats = freshStats();
    this.stats[field]++;
    if (field === "replies") this.stats.lastReplyAt = Date.now();
    try {
      writeFileSync(statsPath, JSON.stringify(this.stats));
    } catch {
      /* counters are best-effort */
    }
    this.emit("stats", { ...this.stats });
  }

  async #handle(channel, { from, text }) {
    const owner = String(loadConfig().owner_qq || "").trim();
    if (!owner || from !== owner) {
      log("msg_ignored", "channel=" + channel.id, "from=" + mask(from), owner ? "reason=not_owner" : "reason=no_owner");
      this.#bump("ignored");
      return;
    }
    if (this.isPaused()) {
      log("msg_dropped", "reason=paused");
      return;
    }
    log("msg_in", "channel=" + channel.id, "chars=" + text.length);
    this.#bump("inbound");

    const r = await this.engine.turn(`owner-${channel.id}-${owner}`, text);
    if (this.isPaused()) {
      log("reply_dropped", "reason=paused");
      return;
    }
    if (r.ok) {
      const sent = await channel.send(owner, r.text);
      log("msg_out", "channel=" + channel.id, "chars=" + r.text.length, "sent=" + sent);
      if (sent) this.#bump("replies");
      return;
    }
    this.#bump("errors");
    this.emit("turn_error", { error: r.error, detail: r.detail });
    await channel.send(owner, OWNER_ERROR_REPLY[r.error] || OWNER_ERROR_REPLY.default);
  }
}
