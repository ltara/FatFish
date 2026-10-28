/**
 * Router — decides which inbound messages reach the engine (docs/ARCHITECTURE.md §4).
 * v1: only owners matched on (channel, backend-reported user_id) are answered;
 * everyone else is silently ignored and never enters DSH. Pause drops inbound and outbound.
 * Emits "stats" (today's counters) and "turn_error" ({ error }) for the UI. Metadata-only logs.
 */
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import modelConfig from "./model-config.cjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, log } from "./paths.mjs";

// What the owner sees when a turn fails; keep it in the companion's voice, no technical terms.
const OWNER_ERROR_REPLY = {
  no_key: "我还没有拿到模型密钥，没法回你。请在电脑上打开肥鱼，在「设置」里填写。",
  missing_runtime: "我的智能引擎没有装好，请在电脑上重新安装肥鱼。",
  invalid_key: "我的模型密钥好像不对，暂时没法回你。请在电脑上打开肥鱼，检查「设置」里的模型密钥。",
  insufficient_balance: "模型账户的余额不够了，我暂时没法继续聊。请检查一下你使用的模型账户。",
  rate_limited: "现在有点忙不过来，稍等一会儿再跟我说吧。",
  network: "我这边暂时连不上，没能把话说完。等网络恢复后再跟我说吧。",
  model_unavailable: "现在用的模型暂时联系不上。请在电脑上打开肥鱼，检查模型设置。",
  engine_crashed: "我刚刚意外中断了一下，正在恢复。稍后再跟我说吧。",
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
  constructor({ instances, identity, initialPaused = false }) {
    super();
    this.instances = instances;
    this.identity = identity;
    this.queue = Promise.resolve();
    this.paused = !!initialPaused;
    this.stats = loadStats();
  }

  getStats() {
    if (this.stats.date !== today()) this.stats = freshStats();
    return { ...this.stats };
  }

  attach(channel) {
    channel.on("message", (m) => this.#handle(channel, m).catch(() => log("router_error")));
  }

  setPaused(paused) {
    this.paused = !!paused;
  }

  isPaused() {
    return this.paused;
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
    const receivedAt = Date.now();
    const pairing = this.identity.consume({ channel: channel.id, account: from, text });
    if (pairing.consumed) {
      log("pairing_attempt", "channel=" + channel.id, "ok=" + pairing.ok);
      if (pairing.ok) await channel.send(from, "配对成功，现在可以和我说话了。");
      return;
    }
    const run = () => this.#dispatch(channel, { from, text, receivedAt });
    const pending = this.queue.then(run, run);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async #dispatch(channel, { from, text, receivedAt }) {
    if (!this.identity.isOwner(channel.id, from)) {
      log("msg_ignored", "channel=" + channel.id, "from=" + mask(from), "reason=not_owner");
      this.#bump("ignored");
      return;
    }
    if (this.isPaused()) {
      log("msg_dropped", "reason=paused");
      return;
    }
    log("msg_in", "channel=" + channel.id, "chars=" + text.length);
    this.#bump("inbound");
    this.emit("owner_activity", { kind: "channel", channel: channel.id, account: from });
    let generation; try { generation = modelConfig.read(paths.root).generation; } catch { generation = null; }

    // The channel identity is supplied by Core; remote text can NEVER select local.
    const r = await this.instances.turn("external", this.instances.externalSessionId, `[来自 ${channel.id === "qq" ? "QQ" : channel.id}]\n${text}`, { channel: channel.id, account: from });
    if (this.isPaused() || !this.identity.isOwner(channel.id, from)) {
      log("reply_dropped", "reason=paused_or_unbound");
      return;
    }
    if (r.ok) {
      const sent = await channel.send(from, r.text);
      log("msg_out", "channel=" + channel.id, "chars=" + r.text.length, "sent=" + sent, "latency_ms=" + (Date.now() - receivedAt));
      if (sent) {
        this.#bump("replies");
        if (this.identity.isOwner(channel.id, from) && Number.isSafeInteger(generation)) this.emit("owner_reply", { channel: channel.id, generation, bindingHash: createHash("sha256").update(channel.id + "\0" + from).digest("hex") });
      }
      return;
    }
    this.#bump("errors");
    this.emit("turn_error", { error: r.error });
    await channel.send(from, OWNER_ERROR_REPLY[r.error] || OWNER_ERROR_REPLY.default);
  }
}
