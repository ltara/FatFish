/** 设置局部分组和实际事件绑定检查。只用普通元素与假接口，不启动应用或访问数据。 */
"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), vm = require("node:vm");
const { create } = require("../renderer/data-clear-view.js");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("renderer-src/App.tsx"), html = read("renderer/index.html"), source = read("renderer/renderer.js"), css = read("renderer/styles.css");
let count = 0;
const check = (name, ok) => { assert.ok(ok, name); count++; console.log("PASS " + name); };
const section = (from, to) => { const start = app.indexOf('id="' + from + '"'), end = app.indexOf('id="' + to + '"'); assert.ok(start >= 0 && end > start); return app.slice(start, end); };
class Element {
  constructor() { this.textContent = ""; this.className = ""; this.checked = false; this.disabled = false; this.hidden = false; this.handlers = new Map(); }
  addEventListener(type, fn) { this.handlers.set(type, fn); } removeEventListener(type) { this.handlers.delete(type); } focus() { this.focused = true; }
  emit(type) { return this.handlers.get(type)?.(); }
}
(async () => {
  const startup = section("settings-startup", "settings-data"), data = section("settings-data", "settings-about"), footer = app.slice(app.indexOf('id="settings-about"'));
  check("startup has its own heading, adjacent switch and local feedback", startup.includes('id="settings-startup-title">开机启动</h3>') && startup.includes('id="autostart-enabled"') && startup.includes('id="settings-startup-msg"') && !startup.includes("feat-row"));
  check("startup switch keeps an accessible label and its nearby note", startup.includes('aria-labelledby="settings-startup-title"') && startup.includes('aria-describedby="settings-startup-note"'));
  check("data management no longer repeats action labels in separated rows", data.includes('>数据管理</h3>') && !data.includes("feat-row") && !data.includes("feat-title"));
  check("ordinary data actions have complete button names", /id="btn-open-data"[^>]*>打开数据文件夹<\/Button>/.test(data) && /id="btn-export-settings"[^>]*>导出设置<\/Button>/.test(data));
  check("dangerous clear is a labelled subregion below the normal actions", data.indexOf('id="settings-clear"') > data.indexOf('id="settings-data-msg"') && data.includes('aria-labelledby="settings-clear-title"') && data.includes('<h4 className="settings-danger-title"'));
  check("clear entry retains a visible irreversible-data notice", data.includes('aria-describedby="data-clear-warning"') && data.includes("会话、记忆等不可恢复") && data.includes("默认保留模型密钥和激活信息"));
  check("clear confirmation keeps both independent unchecked options", ["data-clear-confirm", "data-clear-keys", "data-clear-license", "btn-clear-data-confirm", "btn-clear-data-cancel", "data-clear-msg"].every(id => data.includes('id="' + id + '"')) && !/id="data-clear-(?:keys|license)"[^>]*checked/.test(data));
  check("risk disclosure is after about, not nested under the clear operation", footer.indexOf('id="settings-risk"') > footer.indexOf('id="btn-onboarding-resume"') && !data.includes('id="settings-risk"') && /className="diag-fold settings-legal" id="settings-risk"/.test(footer));
  check("group and subgroup spacing reuse existing tokens without a danger card", css.includes('.settings-compact { padding-block: var(--space-4); }') && css.includes('.settings-danger { margin-top: var(--space-5); }') && !/\.settings-danger\s*\{[^}]*(?:background|border)/.test(css));
  check("danger heading is a secondary type level, not another full group title", /\.settings-danger-title\s*\{[^}]*font-size:\s*14px;[^}]*font-weight:\s*600;/.test(css));
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1])), nodes = new Map();
  const $ = selector => { assert.ok(ids.has(selector.slice(1)), "real first-frame target: " + selector); if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  let autoResult = { ok: true }, openResult = { ok: true }, exportResult = { ok: true }, clearResult = { ok: false, error: "clear_failed" };
  const calls = [], api = {
    setAutostart: async enabled => { calls.push({ op: "startup", enabled }); return autoResult; },
    openDataFolder: async () => { calls.push({ op: "open" }); return openResult; },
    exportSettings: async () => { calls.push({ op: "export" }); return exportResult; },
    getDataClearPlan: async args => { calls.push({ op: "plan", args }); return { ok: true, data: { count: 7 } }; },
    clearLocalData: async args => { calls.push({ op: "clear", args }); return clearResult; },
  };
  const begin = source.indexOf('    const auto = $("#autostart-enabled");'), end = source.indexOf('    window.fatfishDataClearView.create(api);', begin);
  assert.ok(begin >= 0 && end > begin, "actual startup/data event wiring exists");
  vm.runInNewContext(source.slice(begin, end), { $, api });
  check("mounting actual event handlers performs no operation", calls.length === 0);
  $("#autostart-enabled").checked = true; await $("#autostart-enabled").emit("change");
  check("startup success stays under the startup switch", calls.at(-1).enabled === true && $("#settings-startup-msg").textContent === "已开启开机启动。" && $("#settings-data-msg").textContent === "" && $("#data-clear-msg").textContent === "");
  autoResult = { ok: false }; await $("#autostart-enabled").emit("change");
  check("startup failure remains local without touching data feedback", $("#settings-startup-msg").textContent === "切换失败" && $("#settings-startup-msg").className.includes("err") && $("#settings-data-msg").textContent === "");
  await $("#btn-open-data").emit("click");
  check("open-folder feedback stays with the compact data actions", calls.at(-1).op === "open" && $("#settings-data-msg").textContent === "已打开数据文件夹。" && $("#settings-startup-msg").textContent === "切换失败" && $("#data-clear-msg").textContent === "");
  exportResult = { canceled: true }; await $("#btn-export-settings").emit("click");
  check("cancelled export only clears its own feedback", $("#settings-data-msg").textContent === "" && $("#settings-startup-msg").textContent === "切换失败");
  exportResult = { ok: false }; await $("#btn-export-settings").emit("click");
  check("export failure is shown beside the data actions", $("#settings-data-msg").textContent === "导出失败" && $("#settings-data-msg").className.includes("err") && $("#data-clear-msg").textContent === "");
  const beforeClear = calls.length, clearView = create(api, { query: $ });
  check("mounting the real clear controller cannot preview or delete automatically", calls.length === beforeClear && $("#data-clear-confirm").hidden);
  await clearView.open();
  check("opening clear reads its scope without deleting or overwriting ordinary status", calls.at(-1).op === "plan" && !calls.some(c => c.op === "clear") && $("#settings-data-msg").textContent === "导出失败");
  await clearView.clear();
  check("clear failure is isolated inside the danger region", $("#data-clear-msg").textContent.includes("部分数据可能已删除") && $("#settings-data-msg").textContent === "导出失败" && $("#settings-startup-msg").textContent === "切换失败");
  check("presentation changes preserve explicit scope and single request semantics", calls.filter(c => c.op === "clear").length === 1 && JSON.stringify(calls.find(c => c.op === "clear").args) === JSON.stringify({ confirmed: true, includeKeys: false, includeLicense: false }));
  clearView.cancel();
  check("cancel restores the clear entry without discarding other section results", $("#data-clear-confirm").hidden && !$("#btn-clear-data").hidden && $("#data-clear-msg").textContent === "" && $("#settings-data-msg").textContent === "导出失败");
  clearView.dispose();
  console.log(`${count}/${count} settings hierarchy checks passed (first frame/actual handlers/plain elements, no native UI/network)`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
