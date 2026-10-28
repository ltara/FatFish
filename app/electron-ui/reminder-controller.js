/** Electron-independent adapter: persist before ack; no reminder text enters a model command. */
"use strict";
class ReminderController {
  constructor({ services, inbox, changed = () => {}, retryMs = 5000 }) {
    Object.assign(this, { services, inbox, changed }); this.lastAvailable = undefined; this.error = null; this.lastCatalogRequest = 0; this.connected = false; this.needsRetry = false;
    this.listener = (m) => this.#message(m); services.on("core-message", this.listener);
    this.timer = setInterval(() => this.retry(), retryMs); this.timer.unref?.();
  }
  #send(m) { try { return this.services.sendCore(m); } catch { return false; } }
  #notify() { try { this.changed(this.status()); } catch { /* UI absence never invalidates durable receipt. */ } }
  status() { const state = this.inbox.status(); return { ...state, error: state.error || this.error, available: state.available && !this.error }; }
  refresh(force = false) {
    const state = this.status();
    if (force || state.available !== this.lastAvailable) { this.#send({ type: "reminder_inbox_status", available: !!state.available }); this.lastAvailable = !!state.available; }
    if (!state.ready && Date.now() - this.lastCatalogRequest >= 1000) { this.lastCatalogRequest = Date.now(); this.#send({ type: "reminder_catalog_request" }); }
    return state;
  }
  #message(m) {
    if (m?.type === "unavailable") { this.connected = false; this.inbox.disconnect(); this.lastAvailable = undefined; this.#notify(); return; }
    if (m?.type === "ready") { this.connected = true; this.needsRetry = !this.status().available; this.refresh(true); return; }
    if (m?.type === "reminder_catalog") {
      this.connected = true;
      try { this.inbox.syncCatalog(m.ids); this.error = null; this.needsRetry = false; }
      catch { this.inbox.disconnect(); this.error = "reminder_inbox_unavailable"; this.needsRetry = true; }
      this.refresh(); this.#notify(); return;
    }
    if (m?.type !== "reminder_delivery") return;
    let ok = false, added = false;
    try { const result = this.inbox.receive(m); added = result.added; ok = true; this.error = null; this.needsRetry = false; }
    catch (e) { this.error = "reminder_inbox_unavailable"; this.needsRetry = e.message !== "reminder_inbox_full"; }
    this.#send({ type: "reminder_ack", deliveryId: typeof m.deliveryId === "string" ? m.deliveryId : "", ok });
    this.refresh(); if (added || !ok) this.#notify();
  }
  view(base) {
    try { const result = this.inbox.display(base); this.error = null; this.needsRetry = !this.inbox.status().ready; this.refresh(); return result; }
    catch { this.error = "reminder_inbox_unavailable"; this.needsRetry = true; this.refresh(); return { ...base, reminderUnshown: null, reminderError: this.error }; }
  }
  retry() {
    if (!this.connected || !this.needsRetry) return;
    try { this.inbox.probeWrite(); this.error = null; this.needsRetry = !this.inbox.status().ready; this.refresh(true); this.#notify(); }
    catch { this.refresh(); }
  }
  markShown(ids, sessionId, visible) {
    if (!visible) return { ok: false, error: "window_not_visible" };
    try { const changed = this.inbox.markShown(ids, sessionId); this.error = null; this.needsRetry = !this.inbox.status().ready; this.refresh(); if (changed) this.#notify(); return { ok: true, changed }; }
    catch { this.error = "reminder_inbox_unavailable"; this.needsRetry = true; this.refresh(); return { ok: false, error: this.error }; }
  }
  dispose() { clearInterval(this.timer); this.#send({ type: "reminder_inbox_status", available: false }); this.services.off("core-message", this.listener); this.inbox.disconnect(); }
}
module.exports = { ReminderController };
