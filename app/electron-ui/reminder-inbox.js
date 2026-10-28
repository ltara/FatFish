/** Durable local inbox. Reminder text is display-only, never local model input. */
"use strict";
const fs = require("node:fs"), path = require("node:path"), { randomUUID, createHash } = require("node:crypto");
const idOK = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(s);
const localOK = (s) => typeof s === "string" && /^local-[A-Za-z0-9_-]{1,100}$/.test(s);
const sourceOK = (s) => typeof s === "string" && /^(local|owner)-[A-Za-z0-9_-]{1,110}$/.test(s);
const timeOK = (t) => Number.isSafeInteger(t) && t >= 0 && t < 8640000000000000;
const textOK = (s) => typeof s === "string" && s.trim().length > 0 && s.length <= 1000;
const hash = (m) => createHash("sha256").update(JSON.stringify([m.deliveryId, m.sourceSession, m.text, m.fallback])).digest("hex");
const stat = (file) => { try { return fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const deliveryOK = (m) => m && idOK(m.reminderId) && timeOK(m.dueAt) && m.deliveryId === `${m.reminderId}:${m.dueAt}` && sourceOK(m.sourceSession) && textOK(m.text) && typeof m.fallback === "boolean";

class ReminderInbox {
  constructor({ root, currentSession, now = Date.now, maxMessages = 2000, historyKeep = 400 }) {
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 2000 || !Number.isInteger(historyKeep) || historyKeep < 0 || historyKeep > maxMessages) throw new Error("reminder_inbox_args_invalid");
    Object.assign(this, { root, currentSession, now, maxMessages, historyKeep }); this.dir = path.join(root, "inbox"); this.file = path.join(this.dir, "reminders.json"); this.allowed = null;
  }
  #guard() {
    const dir = stat(this.dir), file = stat(this.file);
    if (dir && (dir.isSymbolicLink() || !dir.isDirectory()) || file && (file.isSymbolicLink() || !file.isFile())) throw new Error("reminder_inbox_path_invalid");
    return file;
  }
  #read() {
    try {
      const file = this.#guard();
      if (!file) return { version: 1, receipts: [], messages: [] };
      if (file.size > 8 * 1024 * 1024) throw new Error();
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.receipts) || data.receipts.length > 500 || !Array.isArray(data.messages) || data.messages.length > this.maxMessages) throw new Error();
      const ids = new Set(), receipts = new Set();
      for (const r of data.receipts) { if (!r || !idOK(r.reminderId) || receipts.has(r.reminderId) || !timeOK(r.through) || !/^[a-f0-9]{64}$/.test(r.hash)) throw new Error(); receipts.add(r.reminderId); }
      for (const m of data.messages) {
        if (!deliveryOK(m) || ids.has(m.deliveryId) || !localOK(m.targetSession) || !timeOK(m.at) || typeof m.shown !== "boolean" || m.hash !== hash(m)) throw new Error(); ids.add(m.deliveryId);
      }
      return data;
    } catch { throw new Error("reminder_inbox_invalid"); }
  }
  #write(data) {
    this.#guard(); fs.mkdirSync(this.dir, { recursive: true }); this.#guard();
    const temp = this.file + "." + randomUUID() + ".tmp"; let fd;
    try { fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, JSON.stringify(data) + "\n", "utf8"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temp, this.file); }
    catch { throw new Error("reminder_inbox_save_failed"); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch { /* only this transaction's temp */ } }
  }
  syncCatalog(ids) {
    this.allowed = null;
    if (!Array.isArray(ids) || ids.length > 500 || ids.some((id) => !idOK(id)) || new Set(ids).size !== ids.length) throw new Error("reminder_catalog_invalid");
    const allowed = new Set(ids), data = this.#read(), kept = data.receipts.filter((r) => allowed.has(r.reminderId));
    if (kept.length !== data.receipts.length) { data.receipts = kept; this.#write(data); }
    this.allowed = allowed;
  }
  disconnect() { this.allowed = null; }
  probeWrite() { const data = this.#read(); this.#write(data); }
  status() {
    try { const data = this.#read(), unshown = data.messages.filter((m) => !m.shown).length; return { ready: this.allowed !== null, available: this.allowed !== null && unshown < this.maxMessages, unshown, error: null }; }
    catch { return { ready: false, available: false, unshown: null, error: "reminder_inbox_unavailable" }; }
  }
  receive(payload) {
    if (payload?.type !== "reminder_delivery" || !deliveryOK(payload)) throw new Error("reminder_inbox_args_invalid");
    if (this.allowed === null) throw new Error("reminder_inbox_not_ready");
    if (!this.allowed.has(payload.reminderId)) throw new Error("reminder_not_active");
    const data = this.#read(), digest = hash(payload), receipt = data.receipts.find((r) => r.reminderId === payload.reminderId);
    if (receipt && payload.dueAt <= receipt.through) {
      if (payload.dueAt === receipt.through && digest !== receipt.hash) throw new Error("reminder_inbox_conflict");
      return { added: false, duplicate: true };
    }
    const existing = data.messages.find((m) => m.deliveryId === payload.deliveryId);
    if (existing) { if (digest !== existing.hash) throw new Error("reminder_inbox_conflict"); return { added: false, duplicate: true }; }
    const targetSession = this.currentSession(); if (!localOK(targetSession)) throw new Error("reminder_inbox_args_invalid");
    const shown = data.messages.filter((m) => m.shown), keep = new Set((this.historyKeep ? shown.slice(-this.historyKeep) : []).map((m) => m.deliveryId));
    data.messages = data.messages.filter((m) => !m.shown || this.historyKeep > 0 && keep.has(m.deliveryId));
    while (data.messages.length >= this.maxMessages) { const at = data.messages.findIndex((m) => m.shown); if (at < 0) throw new Error("reminder_inbox_full"); data.messages.splice(at, 1); }
    data.messages.push({ deliveryId: payload.deliveryId, reminderId: payload.reminderId, dueAt: payload.dueAt, sourceSession: payload.sourceSession,
      text: payload.text, fallback: payload.fallback, hash: digest, targetSession, at: this.now(), shown: false });
    if (receipt) Object.assign(receipt, { through: payload.dueAt, hash: digest }); else data.receipts.push({ reminderId: payload.reminderId, through: payload.dueAt, hash: digest });
    this.#write(data); return { added: true, duplicate: false };
  }
  display(base) {
    const data = this.#read(); if (!localOK(base.sessionId) || !Array.isArray(base.messages)) throw new Error("reminder_inbox_args_invalid");
    const reminders = data.messages.filter((m) => m.targetSession === base.sessionId || !m.shown).map((m) => ({ id: "reminder-" + m.deliveryId, role: "assistant", at: m.at,
      text: /^提醒[：:]/.test(m.text) ? m.text : "提醒：" + m.text, reminderDeliveryId: m.deliveryId, reminderShown: m.shown }));
    return { ...base, messages: [...base.messages, ...reminders].sort((a, b) => (a.at || 0) - (b.at || 0)), reminderUnshown: data.messages.filter((m) => !m.shown).length, reminderError: null };
  }
  markShown(ids, sessionId) {
    if (!Array.isArray(ids) || ids.length > this.maxMessages || ids.some((id) => typeof id !== "string" || id.length > 150) || !localOK(sessionId)) throw new Error("reminder_inbox_args_invalid");
    const data = this.#read(), set = new Set(ids); let changed = false;
    for (const m of data.messages) if (set.has(m.deliveryId) && !m.shown) { m.shown = true; m.targetSession = sessionId; changed = true; }
    if (changed) this.#write(data); return changed;
  }
}
module.exports = { ReminderInbox };
