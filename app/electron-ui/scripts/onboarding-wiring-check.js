/** Execute actual renderer mount/login functions with plain element objects, never a DOM/native shell. */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), { join } = require("node:path");
const html = fs.readFileSync(join(__dirname, "../renderer/index.html"), "utf8"), renderer = fs.readFileSync(join(__dirname, "../renderer/renderer.js"), "utf8"), modelConfig = require("../../core/model-config.cjs");
const modelStart = html.indexOf('id="settings-model"'), modelEnd = html.indexOf('id="settings-workspace"', modelStart), modelIds = [...html.slice(modelStart, modelEnd).matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const nodes = [], clones = [], calls = [], nav = []; let count = 0, setupOptions;
function node(id, attrs = {}) {
  const classes = new Set((attrs.class || "").split(/\s+/));
  return { id, attrs: { ...attrs }, value: attrs.value || "", checked: false, disabled: false, textContent: "", handlers: {}, children: [],
    setAttribute(n, value) { this.attrs[n] = String(value); }, getAttribute(n) { return this.attrs[n]; },
    addEventListener(n, fn) { this.handlers[n] = fn; }, removeEventListener(n, fn) { if (this.handlers[n] === fn) delete this.handlers[n]; },
    focus() {}, click() { this.handlers.click?.(); },
    classList: { add: (...names) => names.forEach((n) => classes.add(n)), remove: (...names) => names.forEach((n) => classes.delete(n)), toggle: (n, on) => on ? classes.add(n) : classes.delete(n), contains: (n) => classes.has(n) },
    querySelectorAll(selector) { return this.children.filter((n) => selector === "[id]" ? !!n.id : selector === "[aria-describedby]" ? n.attrs["aria-describedby"] : false); },
    querySelector(selector) { return selector === "h3" ? { remove() {} } : this.children.find((n) => "#" + n.id === selector); },
    cloneNode() { const c = node(this.id, this.attrs); c.value = this.value; c.children = this.children.map((n) => { const child = node(n.id, n.attrs); child.value = n.value; return child; }); clones.push(c); return c; },
    replaceChildren(...values) { this.children = values; },
  };
}
for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) { const attrs = Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]])); nodes.push(node(match[1], attrs)); }
const all = () => [...nodes, ...clones.flatMap((n) => [n, ...n.children])], $ = (selector) => all().find((n) => "#" + n.id === selector);
$("#settings-model").children = modelIds.slice(1).map((id) => $("#" + id)); $("#api-key").value = "sk-unsaved-source-draft";
const check = (name, ok) => { assert.ok(ok, name); count++; console.log("PASS " + name); };
const api = {
  onOnboardingChanged: () => () => {}, onModelChanged: () => () => {},
  getOnboarding: async () => { calls.push("progress-read"); return { ok: true, data: { phase: "model", step: 3, total: 4, branch: "local", modelReady: false, baseComplete: false } }; },
  getModel: async () => { calls.push("model-read"); return { ok: true, data: { ...modelConfig.normalize(), generation: 0, key_saved: false, presets: Object.entries(modelConfig.presets).map(([provider, values]) => ({ provider, ...values })), apis: [...modelConfig.apis] } }; },
};
const context = vm.createContext({ api, $, onboardingView: null, onboardingWasComplete: null, onboardingCompletionNotice: false, bootPhase: "main", window: { fatfishModelView: require("../renderer/model-view"), fatfishOnboardingView: { create: (client, options) => { setupOptions = options; return require("../renderer/onboarding-view").create(client, { query: $, ...options }); } } }, showOnboard: (id) => nav.push(id), enterMain: () => nav.push("main"), showPage: (id) => nav.push(id), prepareLogin() {}, setupRisk: async () => true });
(async () => {
  const start = renderer.indexOf("  function mountOnboarding()"), end = renderer.indexOf("  let pollTimer", start); assert.ok(start >= 0 && end > start);
  vm.runInContext(renderer.slice(start, end) + "\nmountOnboarding();", context);
  check("actual mount does not test a model or contact a channel", calls.length === 0);
  const openPlatform = renderer.match(/function openPlatform\(id\) \{[\s\S]*?\n  \}/)[0];
  vm.runInContext(openPlatform, context);
  const pairAt = nav.length; let pairClicks = 0; $("#btn-pairing-start").handlers.click = () => { pairClicks++; };
  setupOptions.pair();
  check("actual setup pairing opens QQ in the platform page before clicking the existing entry", nav.slice(pairAt).includes("channels") && $("#channel-qq").open === true && pairClicks === 1 && calls.length === 0);
  const clone = clones[0];
  check("every cloned model ID is namespaced without colliding with static markup", clone.id === "onboarding-settings-model" && clone.children.every((n) => n.id.startsWith("onboarding-")) && new Set(all().map((n) => n.id)).size === all().length);
  check("a typed settings credential is neither copied into wizard nor discarded from its source", $("#api-key").value === "sk-unsaved-source-draft" && $("#onboarding-api-key").value === "");
  check("all cloned descriptions still resolve to a real namespaced target", clone.children.filter((n) => n.attrs["aria-describedby"]).every((n) => n.attrs["aria-describedby"].split(/\s+/).every((id) => !!$("#" + id))));
  check("wizard has one primary footer action, not a second primary model-save", $("#onboarding-btn-save-key").className === "btn-secondary");
  await vm.runInContext("onboardingView.open()", context); for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  check("actual mounted model controller reads saved metadata into the correct scoped fields", $("#onboarding-model-name").value === "deepseek-flash" && !$("#onboarding-model-provider").disabled && $("#onboarding-api-key").value === "");
  check("mount/open performs only metadata reads, with no automatic paid request", calls.every((s) => s === "model-read" || s === "progress-read"));
  const loginStart = renderer.indexOf("  async function prepareLogin()"), loginEnd = renderer.indexOf("  async function afterLoginContinue()", loginStart);
  let latest = { qq_enabled: true, login_reachable: false, phase: "running" }, loginCalls = 0;
  const login = vm.createContext({ api: { getStatus: async () => latest, getLoginSession: async () => { loginCalls++; throw new Error("unexpected_login"); } }, $, lastStatus: { qq_enabled: false }, bootPhase: "main", showPage: (p) => nav.push(p), showOnboard: (p) => nav.push(p), stopLoginPoll() {}, hideAllLoginStates() {}, applyLoginView() {}, activationView: { ensure: async () => {} }, bootFlow() {} });
  vm.runInContext(openPlatform + "\n" + renderer.slice(loginStart, loginEnd) + "\nthis.openLogin = prepareLogin;", login);
  const at = nav.length; await login.openLogin();
  check("fresh enabled state wins over a stale disabled status when entering login", nav.slice(at).includes("login-flow") && !nav.slice(at).includes("channels") && loginCalls === 0);
  latest = { qq_enabled: false }; $("#channel-qq").open = false; const disabledAt = nav.length; await login.openLogin();
  check("fresh disabled state reveals QQ settings without opening or polling login", nav.slice(disabledAt).includes("channels") && $("#channel-qq").open === true && !nav.slice(disabledAt).includes("login-flow") && loginCalls === 0);
  vm.runInContext("onboardingView.dispose()", context);
  console.log(`${count}/${count} onboarding wiring checks passed (plain objects, no DOM/native UI)`);
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
