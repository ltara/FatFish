/** Local-only owner administration; platform-reported (channel, account) is the identity. */
import { EventEmitter } from "node:events";
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_BUCKETS = 4096;
const validAddress = (channel, account) => typeof channel === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(channel) &&
  typeof account === "string" && account.length > 0 && account.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(account);
export const maskAccount = (account) => "***" + (account.length > 4 ? account.slice(-4) : "");

export class Identity extends EventEmitter {
  constructor({ configPath, now = Date.now, code = () => String(randomInt(1000000)).padStart(6, "0"), ttlMs = WINDOW_MS } = {}) {
    super();
    Object.assign(this, { configPath, now, code, ttlMs });
    this.attempts = new Map();
    this.retired = new Map();
    this.active = null;
    this.#migrate();
  }

  #read() {
    try {
      if (!existsSync(this.configPath)) return {};
      const cfg = JSON.parse(readFileSync(this.configPath, "utf8"));
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error();
      return cfg;
    } catch { throw new Error("identity_config_invalid"); }
  }

  #write(cfg) {
    mkdirSync(dirname(this.configPath), { recursive: true });
    const temp = this.configPath + "." + randomUUID() + ".tmp";
    let fd;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, this.configPath);
    } catch { throw new Error("identity_save_failed"); }
    finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch { /* only our unique temporary file */ }
    }
  }

  #owners(cfg) {
    if (cfg.owners !== undefined && !Array.isArray(cfg.owners)) throw new Error("identity_config_invalid");
    const seen = new Set();
    return (cfg.owners || []).filter((o) => {
      if (!o || !validAddress(o.channel, o.account)) return false;
      const key = JSON.stringify([o.channel, o.account]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).map((o) => ({ channel: o.channel, account: o.account, boundAt: o.boundAt || "", label: String(o.label || "").slice(0, 80) }));
  }

  #migrate() {
    const cfg = this.#read();
    this.#owners(cfg); // Corrupt owner data must never fall back to the legacy field.
    if (!Object.hasOwn(cfg, "owner_qq")) return;
    if (!Object.hasOwn(cfg, "owners")) {
      const legacy = String(cfg.owner_qq || "").trim();
      cfg.owners = validAddress("qq", legacy) ? [{ channel: "qq", account: legacy, boundAt: new Date(this.now()).toISOString(), label: "" }] : [];
    }
    delete cfg.owner_qq;
    this.#write(cfg);
  }

  list() { return this.#owners(this.#read()).map((o) => ({ ...o, accountMask: maskAccount(o.account) })); }

  isOwner(channel, account) {
    try { return this.list().some((o) => o.channel === channel && o.account === account); }
    catch { return false; }
  }

  #prune() {
    for (const [key, value] of this.attempts) if (this.now() >= value.until) this.attempts.delete(key);
    for (const [key, until] of this.retired) if (this.now() >= until) this.retired.delete(key);
  }

  #retire() {
    clearTimeout(this.timer);
    if (this.active?.code) this.retired.set(this.active.code, this.now() + WINDOW_MS);
  }

  #expire() {
    if (this.active?.status !== "waiting" || this.now() < this.active.expiresAt) return;
    this.#retire();
    const { pairingId, expiresAt } = this.active;
    this.active = { pairingId, expiresAt, status: "expired" };
    this.emit("pairing", { pairingId, expiresAt, status: "expired" });
  }

  start() {
    this.list(); // Do not offer a challenge when persistence is already known to be invalid.
    this.#prune();
    let code;
    for (let i = 0; i < 32; i++) {
      const candidate = this.code();
      if (typeof candidate === "string" && /^\d{6}$/.test(candidate) && candidate !== this.active?.code && !this.retired.has(candidate)) { code = candidate; break; }
    }
    if (!code) throw new Error("pairing_code_unavailable");
    this.#retire();
    this.active = { code, pairingId: randomUUID(), expiresAt: this.now() + this.ttlMs, status: "waiting" };
    this.timer = setTimeout(() => this.#expire(), this.ttlMs);
    this.timer.unref?.();
    return { ...this.active };
  }

  cancel(pairingId) {
    if (!this.active || pairingId && pairingId !== this.active.pairingId) return false;
    this.#retire();
    const current = this.active;
    this.active = null;
    this.emit("pairing", { pairingId: current.pairingId, status: "cancelled" });
    return true;
  }

  /** Numeric pairing messages are always consumed here, including old/expired codes. */
  consume({ channel, account, text }) {
    if (typeof text !== "string" || !/^\d{6}$/.test(text.trim())) return { consumed: false };
    this.#prune(); this.#expire();
    if (!validAddress(channel, account) || this.active?.status !== "waiting") return { consumed: true, ok: false };
    const key = JSON.stringify([channel, account]);
    let bucket = this.attempts.get(key);
    const failure = (reason) => {
      this.emit("pairing", { pairingId: this.active.pairingId, expiresAt: this.active.expiresAt, status: "failed", reason });
      return { consumed: true, ok: false, reason };
    };
    if (!bucket) {
      if (this.attempts.size >= MAX_BUCKETS) return failure("too_many_attempts");
      this.attempts.set(key, bucket = { count: 0, until: this.now() + WINDOW_MS });
    }
    if (bucket.count >= MAX_ATTEMPTS) return failure("too_many_attempts");
    bucket.count++;
    if (text.trim() !== this.active.code) return failure(bucket.count >= MAX_ATTEMPTS ? "too_many_attempts" : "invalid_code");
    let owners;
    try {
      const cfg = this.#read();
      owners = this.#owners(cfg);
      if (!owners.some((o) => o.channel === channel && o.account === account)) {
        owners.push({ channel, account, boundAt: new Date(this.now()).toISOString(), label: "" });
      }
      delete cfg.owner_qq;
      cfg.owners = owners;
      this.#write(cfg);
    } catch { return failure("identity_save_failed"); }
    const { pairingId } = this.active;
    this.#retire(); this.active = null;
    const owner = owners.find((o) => o.channel === channel && o.account === account);
    this.emit("owners", this.list());
    this.emit("pairing", { pairingId, status: "success", owner: { ...owner, accountMask: maskAccount(account) } });
    return { consumed: true, ok: true };
  }

  remove(channel, account) {
    if (!validAddress(channel, account)) throw new Error("invalid_owner");
    const cfg = this.#read();
    const owners = this.#owners(cfg);
    cfg.owners = owners.filter((o) => o.channel !== channel || o.account !== account);
    delete cfg.owner_qq; // An empty owners table must never re-import the old owner.
    this.#write(cfg);
    this.emit("owners", this.list());
    return cfg.owners.length !== owners.length;
  }

  stop() { clearTimeout(this.timer); this.active = null; this.attempts.clear(); this.retired.clear(); }
}
