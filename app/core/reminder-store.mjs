/** Durable reminder outbox. Only Core chooses source, destination and delivery phase. */
import { existsSync, lstatSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseSchedule, nextAfter, latestDue, parseCron } from "./reminder-time.mjs";
const textOK = (s) => typeof s === "string" && s.trim().length > 0 && s.length <= 1000;
const timeOK = (t) => Number.isSafeInteger(t) && t >= 0 && t < 8640000000000000;
const sourceOK = (s) => s && ["local", "external"].includes(s.instance) && typeof s.sessionId === "string" && s.sessionId.length <= 120 && (s.instance === "local" ? /^local-[\w-]+$/.test(s.sessionId) : /^owner-[\w-]+$/.test(s.sessionId) && s.channel === "qq" && /^\d{1,20}$/.test(s.account));
const routeOK = (r) => r && (r.kind === "local" || r.kind === "channel" && r.channel === "qq" && /^\d{1,20}$/.test(r.account));
const phaseOK = (p) => ["due", "generating", "generated", "sending", "uncertain"].includes(p);
export class ReminderStore {
  constructor({ root, now = Date.now }) { this.root = root; this.file = join(root, "reminders.json"); this.now = now; mkdirSync(root, { recursive: true }); this.#read(); }
  #read() {
    try {
      if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) throw new Error();
      if (!existsSync(this.file)) return { version: 1, lastActive: null, items: [] };
      if (lstatSync(this.file).size > 8 * 1024 * 1024) throw new Error();
      const data = JSON.parse(readFileSync(this.file, "utf8")), ids = new Set();
      if (data.version !== 1 || !Array.isArray(data.items) || data.items.length > 500 || data.lastActive !== null && (!routeOK(data.lastActive) || !timeOK(data.lastActive.at))) throw new Error();
      for (const r of data.items) {
        if (!r || typeof r.id !== "string" || !r.id || ids.has(r.id) || !textOK(r.text) || !sourceOK(r.source) || !timeOK(r.createdAt) || !timeOK(r.schedule?.first) || !["once", "interval", "cron"].includes(r.schedule.kind) || r.nextAt !== null && !timeOK(r.nextAt)) throw new Error();
        if (r.schedule.kind === "interval" && (!Number.isSafeInteger(r.schedule.every) || r.schedule.every < 60000)) throw new Error();
        if (r.schedule.kind === "cron") parseCron(r.schedule.expr);
        const p = r.pending;
        if (p !== null && (!p || typeof p !== "object" || Array.isArray(p))) throw new Error();
        if (p && (p.id !== `${r.id}:${p.dueAt}` || !timeOK(p.dueAt) || !phaseOK(p.phase) || p.text !== undefined && !textOK(p.text) || p.retryAt !== undefined && !timeOK(p.retryAt) || p.destination !== undefined && !routeOK(p.destination))) throw new Error();
        if (p && ["generated", "sending"].includes(p.phase) && !textOK(p.text)) throw new Error();
        if (r.last !== null && (!r.last || !["delivered", "uncertain"].includes(r.last.state) || !timeOK(r.last.dueAt) || r.last.id !== `${r.id}:${r.last.dueAt}` || r.last.state === "delivered" && !timeOK(r.last.deliveredAt))) throw new Error();
        ids.add(r.id);
      }
      return data;
    } catch { throw new Error("reminder_invalid"); }
  }
  #write(data) {
    if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) throw new Error("reminder_path_invalid");
    const temp = this.file + "." + randomUUID() + ".tmp"; let fd;
    try { fd = openSync(temp, "wx", 0o600); writeFileSync(fd, JSON.stringify(data) + "\n", "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, this.file); }
    catch { throw new Error("reminder_save_failed"); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch { /* only this transaction's file */ } }
  }
  #change(fn) { const data = this.#read(), result = fn(data); this.#write(data); return result; }
  create({ when, text, repeat, source }) {
    if (!textOK(text) || !sourceOK(source)) throw new Error("reminder_args_invalid");
    const now = this.now(), schedule = parseSchedule(when, repeat, now);
    return this.#change((data) => {
      if (data.items.length >= 500) throw new Error("reminder_limit");
      const row = { id: randomUUID(), text: text.trim(), source: { ...source }, createdAt: now, schedule, nextAt: schedule.first, pending: null, last: null };
      data.items.push(row); return row;
    });
  }
  list() { return this.#read().items.sort((a, b) => (a.nextAt ?? a.pending?.dueAt ?? Infinity) - (b.nextAt ?? b.pending?.dueAt ?? Infinity)); }
  get(id) { return this.#read().items.find((r) => r.id === id) || null; }
  remove(id) { return this.#change((data) => { const index = data.items.findIndex((r) => r.id === id); if (index < 0) throw new Error("reminder_not_found"); data.items.splice(index, 1); return true; }); }
  activeRoute() { return this.#read().lastActive; }
  setActive(route) {
    if (!routeOK(route)) throw new Error("reminder_args_invalid");
    return this.#change((data) => { data.lastActive = { ...route, at: this.now() }; });
  }
  /** Materialize the latest missed occurrence only. A currently dispatched one stays pinned. */
  collectDue(locked = new Set(), wake = false) {
    const data = this.#read(), now = this.now(); let changed = false;
    for (const r of data.items) {
      if (r.nextAt === null || r.nextAt > now || locked.has(r.id)) continue;
      const dueAt = latestDue(r.schedule, now);
      if (r.pending?.phase === "uncertain") r.last = { id: r.pending.id, dueAt: r.pending.dueAt, state: "uncertain" };
      r.pending = { id: `${r.id}:${dueAt}`, dueAt, phase: "due" }; r.nextAt = nextAfter(r.schedule, dueAt); changed = true;
    }
    if (changed) this.#write(data);
    return data.items.filter((r) => r.pending && r.pending.phase !== "uncertain" && (!r.pending.retryAt || r.pending.retryAt <= now || wake && r.pending.error === "destination_unavailable"));
  }
  patch(id, occurrenceId, change) {
    return this.#change((data) => { const r = data.items.find((item) => item.id === id); if (!r || r.pending?.id !== occurrenceId) return null; change(r, r.pending); return r; });
  }
  recover() {
    const data = this.#read(); let changed = false;
    for (const r of data.items) {
      if (r.pending?.phase === "generating") { r.pending.phase = "generated"; r.pending.text = ("提醒：" + r.text).slice(0, 1000); r.pending.fallback = true; r.pending.error = "generation_interrupted"; changed = true; }
      if (r.pending?.phase === "sending") { r.pending.phase = r.pending.destination?.kind === "local" ? "generated" : "uncertain"; r.pending.error = "delivery_interrupted"; changed = true; }
    }
    if (changed) this.#write(data);
  }
}
export function validateReminderTool(op, args) {
  const fields = { create: ["when", "text", "repeat"], list: [], delete: ["id"] }[op];
  if (!Array.isArray(fields) || !args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((k) => !fields.includes(k))) throw new Error("reminder_args_invalid");
  if (op === "create" && (!textOK(args.text) || typeof args.when !== "string" || args.repeat !== undefined && typeof args.repeat !== "string") || op === "delete" && (typeof args.id !== "string" || args.id.length > 100)) throw new Error("reminder_args_invalid");
}
