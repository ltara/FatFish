"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { create } = require("../renderer/data-clear-view.js"), results = [];
const check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
class Element {
  constructor() { this.hidden = false; this.disabled = false; this.checked = false; this.textContent = ""; this.handlers = new Map(); }
  addEventListener(type, fn) { this.handlers.set(type, fn); } removeEventListener(type) { this.handlers.delete(type); } focus() { this.focused = true; }
}
function make() {
  const nodes = new Map(), plans = [], requests = []; let nextPlan = null, response = { ok: true, exiting: true };
  const query = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const api = { getDataClearPlan: (args) => { plans.push(args); return nextPlan || Promise.resolve({ ok: true, data: { count: 12 } }); }, clearLocalData: async (args) => { requests.push(args); return response; } };
  const view = create(api, { query }); return { view, nodes, plans, requests, el: (id) => query("#" + id), plan: (p) => { nextPlan = p; }, response: (r) => { response = r; } };
}
(async () => {
  let m = make();
  check("mounting cannot preview, delete, select key/license scopes or open a confirmation automatically", m.plans.length === 0 && m.requests.length === 0 && m.el("data-clear-confirm").hidden && !m.el("data-clear-keys").checked && !m.el("data-clear-license").checked);
  await m.view.open();
  check("explicit open only reads a trusted count and retains both sensitive scopes", m.plans.length === 1 && m.requests.length === 0 && m.plans[0].includeKeys === false && m.plans[0].includeLicense === false && m.el("data-clear-count").textContent.includes("12") && !m.el("btn-clear-data-confirm").disabled);
  m.el("data-clear-keys").checked = true; await m.view.refresh();
  check("changing key scope rereads a plan without performing deletion", m.plans.at(-1).includeKeys === true && m.plans.at(-1).includeLicense === false && m.requests.length === 0);
  m.el("data-clear-license").checked = true; m.view.cancel();
  check("cancel hides the group, resets independent consents and returns focus", m.el("data-clear-confirm").hidden && !m.el("data-clear-keys").checked && !m.el("data-clear-license").checked && m.el("btn-clear-data").focused && m.requests.length === 0);
  let late; m.plan(new Promise((r) => { late = r; })); const opened = m.view.open(); m.view.cancel(); late({ ok: true, data: { count: 99 } }); await opened;
  check("a late preview cannot re-open a cancelled destructive action", m.el("data-clear-confirm").hidden && m.el("btn-clear-data-confirm").disabled && m.requests.length === 0);
  m.plan(null); await m.view.open(); m.el("data-clear-keys").checked = true; m.el("data-clear-license").checked = false; await m.view.refresh(); await m.view.clear(); await m.view.clear();
  check("only explicit confirmation sends strict selected scopes and cannot double-submit", m.requests.length === 1 && JSON.stringify(m.requests[0]) === JSON.stringify({ confirmed: true, includeKeys: true, includeLicense: false }));
  check("successful clear waits for Main exit, without restarting or testing a model", m.el("data-clear-msg").textContent.includes("正在退出") && m.el("btn-clear-data-confirm").disabled && m.el("btn-clear-data-cancel").disabled);
  m.view.dispose(); check("dispose removes all event handlers", [...m.nodes.values()].every((n) => n.handlers.size === 0));
  for (const [error, wanted] of [["clear_busy", "操作正在进行"], ["clear_stop_failed", "未开始清理"], ["clear_failed", "部分数据可能已删除"], ["clear_model_invalid", "无法安全保留"], ["UNTRUSTED_SERVER_BODY", "无法确认"]]) {
    m = make(); m.response({ ok: false, error }); await m.view.open(); await m.view.clear();
    check("fixed feedback and no automatic retry: " + error, m.el("data-clear-msg").textContent.includes(wanted) && !m.el("data-clear-msg").textContent.includes("UNTRUSTED_SERVER_BODY") && m.requests.length === 1 && !m.el("btn-clear-data-confirm").disabled);
    m.view.dispose();
  }
  m = make(); m.plan(Promise.resolve({ ok: false, error: "RAW_PRIVATE_ERROR" })); await m.view.open(); await m.view.clear();
  check("failed preview prevents deletion and does not echo raw errors", m.requests.length === 0 && m.el("btn-clear-data-confirm").disabled && !m.el("data-clear-msg").textContent.includes("RAW_PRIVATE_ERROR")); m.view.dispose();
  m = make(); let first; m.plan(new Promise((r) => { first = r; })); const p = m.view.open(); m.el("data-clear-keys").checked = true; m.plan(Promise.resolve({ ok: true, data: { count: 20 } })); await m.view.refresh(); first({ ok: true, data: { count: 1 } }); await p;
  check("an older preview cannot overwrite a newer scope's count", m.el("data-clear-count").textContent.includes("20") && !m.el("btn-clear-data-confirm").disabled); m.view.dispose();
  const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8"), renderer = fs.readFileSync(path.join(__dirname, "../renderer/renderer.js"), "utf8");
  check("real markup has distinct unchecked scopes, inline confirmation and a single exit action", ["data-clear-keys", "data-clear-license", "btn-clear-data-confirm", "btn-clear-data-cancel"].every((id) => (html.match(new RegExp('id="'+id+'"', 'g')) || []).length === 1) && !/id="data-clear-(?:keys|license)"[^>]*checked/.test(html) && html.includes("清空并退出") && html.indexOf('src="data-clear-view.js"') < html.indexOf('src="renderer.js"'));
  const clearSource = fs.readFileSync(path.join(__dirname, "../renderer/data-clear-view.js"), "utf8");
  check("data-clear wiring uses the real scoped controller without system confirmation dialogs", renderer.includes("window.fatfishDataClearView.create(api)") && !/window\.confirm\(|window\.alert\(|window\.prompt\(/.test(clearSource) && !renderer.includes("确定清空本机数据？"));
  console.log(`${results.length}/${results.length} data-clear view checks passed (plain elements, no DOM/native UI/paid calls)`);
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
