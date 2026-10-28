"use strict";
const { create } = require("../renderer/persona-actions.js");
function fixture(overrides = {}) {
  const nodes = new Map(), timers = new Map(), calls = [], drafts = [], deletions = [];
  const state = { mode: "editor", clock: 1000, active: null, deleteResponse: { ok: true }, importResponse: { ok: true, draft: { title: "草稿", summary: "简介", body: "素材" } } };
  let timerId = 0, controller;
  function element(id) {
    const classes = new Set(), handlers = new Map();
    const value = { id, value: "", textContent: "", hidden: false, disabled: false, handlers, children: [], className: "",
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle(c, value) { if (value === undefined) value = !classes.has(c); if (value) classes.add(c); else classes.delete(c); } },
      addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); },
      removeEventListener(type, fn) { handlers.get(type)?.delete(fn); },
      focus() { if (!this.disabled) state.active = this; }, contains(node) { return this.children.includes(node); },
      async fire(type, event = {}) { for (const fn of handlers.get(type) || []) await fn(event); },
    }; return value;
  }
  const query = (selector) => { if (!nodes.has(selector)) nodes.set(selector, element(selector.slice(1))); return nodes.get(selector); };
  const api = overrides.api || {
    personaDelete: async (...args) => { calls.push({ op: "delete", args }); return typeof state.deleteResponse === "function" ? state.deleteResponse(...args) : state.deleteResponse; },
    personaImportText: async (...args) => { calls.push({ op: "import", args }); return typeof state.importResponse === "function" ? state.importResponse(...args) : state.importResponse; },
  };
  controller = create(api, { query, view: () => state.mode, now: () => state.clock, activeElement: () => state.active,
    setTimer: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimer: (id) => timers.delete(id),
    deleted: async (value) => { deletions.push(value); if (overrides.deleted) return overrides.deleted(value); if (value.current) { state.mode = "list"; controller.reset(); } },
    draft: async (value) => { drafts.push(value); if (overrides.draft) return overrides.draft(value); state.mode = "editor"; controller.reset(); query("#persona-edit-id").value = ""; query("#persona-edit-body").value = value.body; },
  });
  query("#persona-edit-id").value = "fixture-one"; query("#persona-delete-confirm").children = [query("#btn-persona-delete-yes"), query("#btn-persona-delete-no")];
  return { controller, nodes, timers, calls, state, drafts, deletions, query, el: (id) => query("#" + id), enter(mode, id) { controller.reset(); state.mode = mode; if (id !== undefined) query("#persona-edit-id").value = id; } };
}
module.exports = { fixture };
