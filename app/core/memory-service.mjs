import { MEMORY_SCOPES, validateMemoryTool } from "./memory-store.mjs";
/** Routes trusted UI operations and authenticated active-session plugin operations. */
export class MemoryService {
  constructor({ store, instances, isOwner, changed = () => {} }) { Object.assign(this, { store, instances, isOwner, changed }); }
  #mutate(run) {
    const generation = this.store.advanceGeneration();
    this.instances.invalidateMemory(generation);
    const result = run(); this.changed({ generation }); return result;
  }
  tool({ instance, sessionId, op, args }) {
    try {
      const context = this.instances.contextFor(instance, sessionId);
      if (!context || context.scheduled || !["local", "external"].includes(instance) || instance === "external" && !this.isOwner(context.channel, context.account)) throw new Error("memory_forbidden");
      validateMemoryTool(op, args);
      let data;
      if (op === "save") { data = { item: this.store.saveOwner(args.text, args.tags || [], context.logicalSessionId) }; this.changed({ kind: "saved" }); }
      if (op === "search") data = { items: this.store.search(MEMORY_SCOPES, args.query) };
      if (op === "forget") {
        if (!this.store.has("owner", args.id)) throw new Error("memory_not_found");
        this.#mutate(() => this.store.forget("owner", args.id)); data = { deleted: true };
      }
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: ["memory_forbidden", "memory_args_invalid", "memory_not_found", "memory_limit"].includes(e.message) ? e.message : "memory_unavailable" };
    }
  }
  ui(op, args = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("memory_args_invalid");
    if (op === "list") return this.store.list(args.scope, { offset: args.offset || 0, limit: 100 });
    if (op === "export") return this.store.export();
    if (op === "public_get") return { text: this.store.publicText() };
    if (op === "public_set") {
      if (typeof args.text !== "string" || args.text.length > 4000) throw new Error("memory_args_invalid");
      this.#mutate(() => this.store.setPublic(args.text)); return { saved: true };
    }
    if (!["forget", "clear"].includes(op) || !MEMORY_SCOPES.includes(args.scope) || args.confirmed !== true) throw new Error("memory_args_invalid");
    if (op === "forget") {
      if (!this.store.has(args.scope, args.id)) throw new Error("memory_not_found");
      this.#mutate(() => this.store.forget(args.scope, args.id)); return { deleted: true };
    }
    if (args.expectedTotal !== undefined && (!Number.isInteger(args.expectedTotal) || args.expectedTotal < 0)) throw new Error("memory_args_invalid");
    if (args.expectedTotal !== undefined && this.store.list(args.scope).total !== args.expectedTotal) throw new Error("memory_changed");
    return { cleared: this.#mutate(() => this.store.clear(args.scope)) };
  }
}
