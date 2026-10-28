/** Actual model-view module with a small element/event fixture. No browser, Electron, or paid calls. */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), { join } = require("node:path");
const model = require("../../core/model-config.cjs"), { create } = require("../renderer/model-view.js");
let count = 0;
const check = (name, ok) => { assert.ok(ok, name); count++; console.log("PASS " + name); };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
function fixture(options = {}) {
  const elements = new Map(), calls = [];
  const $ = (id) => {
    if (!elements.has(id)) { const classes = new Set(); elements.set(id, { value: "", textContent: "", className: "", disabled: false, attrs: {}, listeners: new Map(),
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, fn) { this.listeners.set(k, fn); },
      classList: { toggle: (s, on) => on ? classes.add(s) : classes.delete(s), contains: (s) => classes.has(s) } }); }
    return elements.get(id);
  };
  let current = { ...model.normalize(), generation: 0, key_saved: true, key_tail: "ABCD", key_error: false }, notice = null, getError = null, saveError = null, testError = null, holdTest = null, off = 0;
  const api = {
    getModel: async () => { calls.push({ op: "get" }); return getError || { ok: true, data: { ...current, presets: Object.entries(model.presets).map(([provider, p]) => ({ provider, ...p })), apis: [...model.apis] } }; },
    saveModel: async (args) => { calls.push({ op: "save", args }); if (saveError) return saveError; current = { ...model.normalize(args), generation: current.generation + 1, key_saved: true, key_tail: "WXYZ", key_error: false, changed: true }; return { ok: true, data: current }; },
    testModel: async (args) => { calls.push({ op: "test", args }); return holdTest ? new Promise((r) => { holdTest.resolve = r; }) : testError || { ok: true, data: { connected: true, durationMs: 1 } }; },
    onModelChanged: (fn) => { notice = fn; return () => { off++; }; },
  };
  const view = create(api, { query: $, ...options }); view.wire();
  const input = (id, value, type = "input") => { $(id).value = value; $(id).listeners.get(type)?.(); };
  return { $, view, calls, input, notify: () => notice(), setGetError: (v) => { getError = v; }, setSaveError: (v) => { saveError = v; }, setTestError: (v) => { testError = v; }, setHold: (v) => { holdTest = v; }, off: () => off };
}
(async () => {
  const f = fixture(), { $, view, calls, input } = f;
  check("initial controls are disabled and wiring never tests a connection", $("#btn-model-test").disabled && calls.length === 0);
  view.enter("home"); check("other pages do not load or test model settings", calls.length === 0);
  view.enter("settings"); await settle();
  check("saved route is shown without putting any key into the password input", $("#model-provider").value === "deepseek-official" && $("#model-name").value === "deepseek-flash" && $("#api-key").value === "" && $("#key-mask-hint").textContent.includes("ABCD"));
  check("pristine settings can be tested but not saved redundantly", !$("#btn-model-test").disabled && $("#btn-save-key").disabled && calls.every((c) => c.op === "get"));
  check("pristine form has no redundant status or reread warning", $("#model-action-hint").textContent === "" && $("#model-reload-note").classList.contains("hidden"));
  check("saved key hint only gives short masked metadata and reuse guidance", $("#key-mask-hint").textContent === "已保存（尾号 ABCD），留空沿用。");
  input("#model-provider", "custom", "change");
  check("custom endpoint fields appear and a new model must be named explicitly", !$("#model-custom-fields").classList.contains("hidden") && !$("#model-advanced").classList.contains("hidden") && $("#model-name").value === "" && $("#btn-model-test").disabled);
  input("#model-base-url", "http://127.0.0.1:34567/v1"); input("#model-name", "custom-model");
  check("a different interface cannot silently reuse the saved key", $("#btn-model-test").disabled && $("#model-action-hint").textContent.includes("请填写当前接口的密钥") && $("#key-mask-hint").textContent === "");
  check("dirty draft reveals the reread discard warning", !$("#model-reload-note").classList.contains("hidden"));
  check("plain HTTP credential risk has a visible warning", !$("#model-http-warning").classList.contains("hidden"));
  input("#api-key", "sk-form-fixture-WXYZ");
  check("complete custom draft enables explicit save and test", !$("#btn-save-key").disabled && !$("#btn-model-test").disabled);
  check("typed key does not add a second explanatory paragraph", $("#key-mask-hint").textContent === "");
  await view.test();
  check("test carries the draft plus expected version without saving or clearing it", calls.at(-1).op === "test" && calls.at(-1).args.api === "openai-completions" && calls.at(-1).args.expectedGeneration === 0 && $("#api-key").value.length > 0 && $("#settings-msg").textContent.includes("尚未保存"));
  f.setTestError({ ok: false, error: "invalid_key" }); await view.test();
  check("test failure retains every current setting and the password draft", $("#model-name").value === "custom-model" && $("#model-base-url").value.includes("34567") && $("#api-key").value === "sk-form-fixture-WXYZ" && $("#settings-msg").textContent.includes("未通过验证")); f.setTestError(null);
  f.setSaveError({ ok: false, error: "model_save_failed" }); await view.save();
  check("failed save also retains the password input", $("#api-key").value === "sk-form-fixture-WXYZ" && $("#settings-msg").textContent.includes("输入已保留")); f.setSaveError(null);
  await view.save();
  check("acknowledged save clears only the submitted password and updates metadata", $("#api-key").value === "" && $("#key-mask-hint").textContent.includes("WXYZ") && $("#btn-save-key").disabled && $("#settings-msg").textContent.includes("下一句使用新设置"));
  check("save hides the discard warning without hiding result feedback", $("#model-reload-note").classList.contains("hidden") && $("#settings-msg").textContent.includes("已保存"));
  input("#model-name", "another-model");
  check("same endpoint/model edit can use its saved key without retyping", !$("#btn-model-test").disabled && $("#api-key").value === "");
  const name = $("#model-name").value; f.notify(); await settle();
  check("background change preserves a dirty draft and blocks stale save/test", $("#model-name").value === name && $("#btn-save-key").disabled && $("#btn-model-test").disabled && $("#settings-msg").textContent.includes("当前输入已保留"));
  await view.reload();
  check("explicit reread replaces the draft only after a successful read", $("#model-name").value === "custom-model" && !$("#btn-model-test").disabled);
  input("#api-key", "sk-form-fixture-NEWKEY"); input("#model-base-url", "https://different.example/v1");
  check("editing an authentication destination clears an unsubmitted old key", $("#api-key").value === "" && $("#settings-msg").textContent.includes("重新填写对应密钥"));
  input("#api-key", "sk-form-fixture-NEWKEY"); input("#model-api", "anthropic-messages", "change");
  check("changing protocol also clears the old typed key", $("#api-key").value === "" && $("#btn-model-test").disabled);
  input("#api-key", "sk-form-fixture-NEWKEY"); input("#model-provider", "openai", "change");
  check("provider changes never auto-select a model or carry a typed key", $("#model-name").value === "" && $("#api-key").value === "" && $("#model-custom-fields").classList.contains("hidden"));
  input("#model-name", "owner-provided-model"); input("#api-key", "sk-form-fixture-NEWKEY");
  const hold = {}; f.setHold(hold); const testing = view.test(), beforeDouble = calls.length;
  await view.test(); await view.save();
  check("busy form blocks duplicate paid tests and simultaneous saves", calls.length === beforeDouble && $("#btn-save-key").disabled && $("#model-provider").disabled);
  hold.resolve({ ok: true, data: { connected: true } }); await testing; f.setHold(null);
  f.setTestError({ ok: false, error: "model_test_timeout" }); await view.test();
  check("timeout warns about possible charges rather than encouraging blind retries", $("#settings-msg").textContent.includes("可能已产生费用") && $("#settings-msg").textContent.includes("先检查服务商记录")); f.setTestError(null);
  f.setSaveError({ ok: false, error: "model_stale" }); await view.save();
  check("Core version conflict keeps the draft and requires reread", $("#api-key").value.length > 0 && $("#btn-save-key").disabled && $("#settings-msg").textContent.includes("当前输入已保留")); f.setSaveError(null);
  f.setGetError({ ok: false, error: "core_unavailable" }); await view.reload();
  check("reread failure does not discard unsaved inputs", $("#model-name").value === "owner-provided-model" && $("#api-key").value.length > 0); f.setGetError(null);
  check("failed reread retains the draft's discard warning", !$("#model-reload-note").classList.contains("hidden"));
  await view.reload(); input("#model-context", "1024"); input("#model-max-tokens", "2048");
  check("invalid output capacity is explained without making a model call", $("#btn-model-test").disabled && $("#model-action-hint").textContent.includes("不能超过容量"));
  check("status text never echoes the complete typed key", ["#key-mask-hint", "#settings-msg", "#model-action-hint"].every((s) => !$(s).textContent.includes("sk-form-fixture")));
  view.dispose(); check("view releases the model notification subscription", f.off() === 1);
  const html = fs.readFileSync(join(__dirname, "../renderer/index.html"), "utf8");
  check("actual markup provides a masked key field and explicit fee/context notices", /<input\b[^>]*type="password"[^>]*id="api-key"/.test(html) && html.includes("可能产生少量模型费用") && html.includes("不发送已有对话、人格或记忆") && html.includes("重新读取会丢弃未保存的修改"));
  check("model view loads before the renderer and is packaged by the renderer glob", html.indexOf('src="model-view.js"') < html.indexOf('src="renderer.js"') && JSON.parse(fs.readFileSync(join(__dirname, "../package.json"), "utf8")).build.files.includes("renderer/**/*"));
  const wizard = fixture({ requireSavedForTest: true }); wizard.view.enter("settings"); await settle(); wizard.input("#model-name", "unsaved-change");
  const wizardAt = wizard.calls.length; await wizard.view.test();
  check("wizard cannot test an unsaved model draft even through a direct method call", wizard.calls.length === wizardAt && wizard.$("#btn-model-test").disabled && wizard.$("#settings-msg").textContent.includes("请先保存"));
  await wizard.view.save(); check("acknowledged wizard save enables an explicit test without retaining the key", !wizard.$("#btn-model-test").disabled && wizard.$("#api-key").value === "");
  wizard.setTestError({ ok: true, data: { connected: true, onboarding_saved: false } }); await wizard.view.test();
  check("successful paid test with progress-write failure warns against retesting", wizard.$("#settings-msg").textContent.includes("不要重复测试"));
  wizard.setTestError({ ok: true, data: { connected: true, onboarding_saved: true, onboarding_model_ready: false } }); await wizard.view.test();
  check("a completed test of superseded settings cannot enable a blind duplicate test", wizard.$("#btn-model-test").disabled && wizard.$("#settings-msg").textContent.includes("不会自动重测")); wizard.view.dispose();
  console.log(`${count}/${count} model form contracts passed (plain Node, no DOM/browser/native UI/paid calls)`);
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
