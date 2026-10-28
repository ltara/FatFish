import { validateReminderTool } from "./reminder-store.mjs";
const boundedText = (text) => String(text || "").trim().slice(0, 1000).replace(/[\uD800-\uDBFF]$/, "");
const summary = (r) => ({ id: r.id, text: r.text, nextAt: r.nextAt === null ? null : new Date(r.nextAt).toISOString(),
  repeat: r.schedule.kind === "cron" ? "cron: " + r.schedule.expr : r.schedule.kind === "interval" ? r.schedule.every + "ms" : null,
  state: r.pending?.phase || r.last?.state || "scheduled", lastDueAt: r.pending?.dueAt ?? r.last?.dueAt ?? null });
/** Synchronous tool ownership + serial scheduler. Generated text is persisted before sending. */
export class ReminderService {
  constructor({ store, instances, isOwner, isPaused = () => false, destinationFor, canDeliver = () => true,
    generate, deliver, changed = () => {}, onError = () => {}, now = Date.now, tickMs = 1000 }) {
    Object.assign(this, { store, instances, isOwner, isPaused, destinationFor, canDeliver, generate, deliver, changed, onError, now, tickMs });
    this.locked = new Set(); this.stopped = false; store.recover();
  }
  tool({ instance, sessionId, op, args }) {
    try {
      const ctx = this.instances.contextFor(instance, sessionId);
      if (!ctx || ctx.scheduled || !["local", "external"].includes(instance) || instance === "external" && !this.isOwner(ctx.channel, ctx.account)) throw new Error("reminder_forbidden");
      validateReminderTool(op, args);
      let data;
      if (op === "create") {
        const source = { instance, sessionId: ctx.logicalSessionId, ...(instance === "external" ? { channel: ctx.channel, account: ctx.account } : {}) };
        data = { item: summary(this.store.create({ ...args, source })) };
      } else if (op === "list") data = { items: this.store.list().map(summary), paused: this.isPaused() };
      else { this.store.remove(args.id); data = { deleted: true }; }
      if (op !== "list") this.changed({ kind: op });
      return { ok: true, data };
    } catch (e) { return { ok: false, error: ["reminder_forbidden", "reminder_args_invalid", "reminder_time_invalid", "reminder_not_found", "reminder_limit"].includes(e.message) ? e.message : "reminder_unavailable" }; }
  }
  start() { if (this.timer) return; this.stopped = false; this.timer = setInterval(() => this.tick(), this.tickMs); this.timer.unref?.(); this.tick(); }
  stop() { this.stopped = true; clearInterval(this.timer); this.timer = null; }
  wake() { this.wakeRequested = true; return this.tick(); }
  async drain() { await this.running; }
  tick() {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.#tick().catch(() => this.onError("reminder_unavailable")).finally(() => { this.running = null; }); return this.running;
  }
  async #tick() {
    const wake = this.wakeRequested; this.wakeRequested = false;
    const due = this.store.collectDue(this.locked, wake);
    if (this.isPaused()) return;
    for (const row of due) {
      if (this.stopped || this.isPaused()) return;
      this.locked.add(row.id);
      try { await this.#dispatch(row.id, row.pending.id); } finally { this.locked.delete(row.id); }
    }
  }
  #sourceAllowed(row) { return row.source.instance === "local" || this.isOwner(row.source.channel, row.source.account); }
  #defer(id, occurrenceId, error) { this.store.patch(id, occurrenceId, (_r, p) => { p.retryAt = this.now() + 30000; p.error = error; }); }
  async #dispatch(id, occurrenceId) {
    let row = this.store.get(id);
    if (!row || row.pending?.id !== occurrenceId) return;
    if (!this.#sourceAllowed(row)) { this.#defer(id, occurrenceId, "source_unbound"); return; }
    let destination = this.destinationFor(row);
    if (!destination || !this.canDeliver(destination)) { this.#defer(id, occurrenceId, "destination_unavailable"); return; }
    if (row.pending.phase === "due") {
      this.store.patch(id, occurrenceId, (_r, p) => { p.phase = "generating"; });
      let result;
      try { result = await this.generate(row); } catch { result = { ok: false, error: "generation_failed" }; }
      if (this.stopped) return;
      row = this.store.patch(id, occurrenceId, (r, p) => {
        p.fallback = !result?.ok || result.memoryReset || typeof result.text !== "string" || !result.text.trim();
        p.phase = "generated"; p.text = boundedText(p.fallback ? "提醒：" + r.text : result.text);
        if (p.fallback) p.error = "generation_unavailable";
      });
      if (!row) return; // Deleted during generation: no late delivery.
    }
    if (this.stopped || this.isPaused()) return;
    if (!this.#sourceAllowed(row)) { this.#defer(id, occurrenceId, "source_unbound"); return; }
    destination = this.destinationFor(row); // Use the newest trusted route, not a model argument.
    if (!destination || !this.canDeliver(destination)) { this.#defer(id, occurrenceId, "destination_unavailable"); return; }
    row = this.store.patch(id, occurrenceId, (_r, p) => { p.phase = "sending"; p.destination = destination; delete p.retryAt; });
    if (!row) return;
    let result;
    try { result = await this.deliver(row, destination); } catch { result = { state: "unknown" }; }
    this.store.patch(id, occurrenceId, (r, p) => {
      if (result?.state === "sent") { r.last = { id: occurrenceId, dueAt: p.dueAt, deliveredAt: this.now(), state: "delivered", fallback: !!p.fallback }; r.pending = null; }
      else if (["not_sent", "retryable"].includes(result?.state)) { p.phase = "generated"; p.retryAt = this.now() + 30000; p.error = "destination_unavailable"; }
      else { p.phase = "uncertain"; p.error = "delivery_unknown"; }
    });
    this.changed({ kind: "delivery", state: result?.state || "unknown" });
  }
}
