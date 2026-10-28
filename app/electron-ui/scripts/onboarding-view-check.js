/** Actual wizard controller with plain elements. No browser/DOM, native windows, QQ or model calls. */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), { join } = require("node:path"), { create } = require("../renderer/onboarding-view");
const elements = new Map(), calls = [], nav = [], counts = { login: 0, pair: 0, risk: 0, off: 0 };
const $ = (id) => { if (!elements.has(id)) { const classes = new Set(); elements.set(id, { checked: false, textContent: "", className: "", disabled: false, handlers: {}, addEventListener(n, f) { this.handlers[n] = f; }, classList: { toggle: (c, on) => on ? classes.add(c) : classes.delete(c), contains: (c) => classes.has(c) } }); } return elements.get(id); };
let data = { phase: "model", step: 3, total: 4, branch: "local", baseComplete: false, modelReady: false, qqActive: false, qqComplete: false, deferred: false, needsWizard: true }, dirty = false, modelBusy = false, getError = null, deferError = null, notice, hold;
let count = 0; const check = (name, ok) => { assert.ok(ok, name); count++; console.log("PASS " + name); };
const api = {
  getOnboarding: async () => { calls.push("get"); return getError || { ok: true, data: { ...data } }; },
  deferOnboarding: async (v) => { calls.push("defer"); if (deferError) return deferError; data.deferred = v; return { ok: true, data: { ...data } }; },
  startQqOnboarding: async () => { calls.push("start-qq"); data = { ...data, branch: "qq", phase: "qq-risk", step: 1, qqActive: true }; return { ok: true, data: { ...data } }; },
  setQqEnabled: async (enabled, confirmed) => { calls.push("enable-qq"); assert.equal(enabled && confirmed, true); if (hold) return new Promise((r) => { hold.resolve = r; }); data.phase = "qq-login"; data.step = 2; return { ok: true }; },
  setOutboundPaused: async (paused) => { calls.push("resume-replies"); assert.equal(paused, false); data.qqPaused = false; return true; },
  onOnboardingChanged: (fn) => { notice = fn; return () => { counts.off++; }; },
};
const model = { enter: (p) => calls.push("model-view:" + p), isDirty: () => dirty, isBusy: () => modelBusy };
const view = create(api, { query: $, model, show: () => nav.push("show"), leave: (page) => nav.push(page), login: () => counts.login++, pair: () => counts.pair++, risk: () => counts.risk++ });
const settle = () => new Promise((r) => setImmediate(r));
(async () => {
  view.wire(); view.wire(); await view.open();
  check("initial resume only reads metadata and never tests or enables anything", calls.every((c) => c === "get" || c.startsWith("model-view:")) && $("#onboarding-step").textContent.includes("第 3 步，共 4 步"));
  check("unverified model cannot advance", $("#btn-onboarding-next").disabled); await view.next();
  check("direct next call cannot invent a successful test", $("#onboarding-msg").textContent.includes("显式测试") && view.getData().phase === "model");
  data.phase = "local"; data.step = 4; data.modelReady = true; await view.refresh();
  check("test receipt does not force navigation before explicit next", $("#onboarding-title").textContent === "模型与密钥" && !$("#btn-onboarding-next").disabled);
  dirty = true; view.controls(); const beforeDirty = calls.length; await view.next();
  check("dirty model input cannot be abandoned by next", $("#btn-onboarding-next").disabled && calls.length === beforeDirty);
  dirty = false; modelBusy = true; view.controls(); check("in-flight model action blocks navigation", $("#btn-onboarding-next").disabled); modelBusy = false;
  await view.next(); check("explicit next opens the local trial step", $("#onboarding-title").textContent === "本机试聊" && $("#btn-onboarding-next").textContent === "去试聊");
  await view.next(); check("local trial opens the normal chat without auto-sending a model prompt", nav.at(-1) === "chat" && !calls.includes("send-chat"));
  data.baseComplete = true; data.phase = "done"; data.qqActive = false; await view.open();
  check("local completion offers QQ only as an optional action", !$("#btn-onboarding-qq").classList.contains("hidden") && calls.filter((c) => c === "enable-qq").length === 0);
  await view.startQQ(); check("choosing optional QQ opens a separate four-step branch without enabling", $("#onboarding-step").textContent.includes("QQ 接入") && $("#onboarding-step").textContent.includes("第 1 步，共 4 步") && !calls.includes("enable-qq"));
  await view.next(); check("QQ risk cannot be skipped by a direct next call", !calls.includes("enable-qq") && $("#btn-onboarding-next").disabled);
  $("#onboarding-qq-risk-ok").checked = true; $("#onboarding-qq-risk-ok").handlers.change(); hold = {};
  const enabling = view.next(), beforeDuplicate = calls.length; await view.next();
  check("explicit QQ enable is serialized", calls.length === beforeDuplicate && $("#btn-onboarding-next").disabled);
  data.phase = "qq-login"; data.step = 2; hold.resolve({ ok: true }); await enabling; hold = null;
  await view.next(); check("login window opens only after a click and remembers return context", counts.login === 1 && view.resumeExternal());
  data.phase = "qq-pair"; data.step = 3; await view.resume(); await view.next();
  check("pairing reuses the existing pairing entry only after a click", counts.pair === 1 && view.resumeExternal());
  data.phase = "qq-trial"; data.step = 4; await view.resume(); const atCheck = calls.length; await view.next();
  check("remote trial button only rereads, never sends a QQ message", calls.slice(atCheck).every((c) => c === "get" || c.startsWith("model-view:")) && !data.qqComplete);
  data.qqPaused = true; await view.refresh(); check("paused replies have a distinct explicit recovery action", $("#btn-onboarding-next").textContent === "恢复回复");
  await view.next(); check("recovery is an explicit pause command rather than a fabricated trial", calls.includes("resume-replies") && !data.qqComplete);
  deferError = { ok: false, error: "onboarding_save_failed" }; await view.later();
  check("postpone failure is not presented as saved completion", $("#onboarding-msg").textContent.includes("不要重复发送") && nav.at(-1) === "show"); deferError = null;
  await view.later(); check("postpone saves unfinished state and returns to main", data.deferred && !data.qqComplete && nav.at(-1) === "home");
  getError = { ok: false, error: "onboarding_invalid" }; await view.open();
  check("corrupt progress shows fixed feedback instead of auto-resetting", $("#onboarding-msg").textContent.includes("原文件没有改动")); getError = null;
  data.phase = "done"; data.qqActive = false; data.qqComplete = true; await view.refresh(true);
  check("only backend completion metadata enables the done screen", $("#onboarding-title").textContent === "设置完成");
  data.phase = "risk"; await view.refresh(true); check("missing consent returns to the consent entry", counts.risk === 1);
  view.dispose(); check("wizard detaches its metadata subscription", counts.off === 1);
  const html = fs.readFileSync(join(__dirname, "../renderer/index.html"), "utf8"), ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  check("static markup has no duplicate IDs and script loads before renderer", new Set(ids).size === ids.length && html.indexOf('src="onboarding-view.js"') < html.indexOf('src="renderer.js"'));
  console.log(`${count}/${count} onboarding view checks passed (plain elements, no native UI)`);
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
