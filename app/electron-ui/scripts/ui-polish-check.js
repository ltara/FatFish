/** 真实导航/空库函数的普通元素检查与样式契约检查。不启动窗口、后台或网络。 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const read = (name) => fs.readFileSync(path.join(__dirname, "../renderer", name), "utf8");
const html = read("index.html"), source = read("renderer.js"), css = read("styles.css");
let count = 0;
function check(name, value) { assert.ok(value, name); count++; console.log("PASS " + name); }
function element() {
  const classes = new Set(), attrs = new Map();
  return { dataset: {}, textContent: "", innerHTML: "", attrs,
    classList: { add: (s) => classes.add(s), remove: (s) => classes.delete(s), contains: (s) => classes.has(s), toggle: (s, on) => on ? classes.add(s) : classes.delete(s) },
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) };
}
function actual(name) {
  const match = source.match(new RegExp("(?:async )?function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}"));
  assert.ok(match, "actual function exists: " + name);
  return match[0];
}
function token(name) {
  const match = css.match(new RegExp("--" + name + ":\\s*([^;]+);"));
  assert.ok(match, "token exists: " + name);
  const value = match[1].trim();
  return value.startsWith("var(") ? token(value.slice(6, -1)) : value;
}
function luminance(hex) {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return channels.reduce((n, value, i) => n + value * [.2126, .7152, .0722][i], 0);
}
function contrast(a, b) { const values = [luminance(a), luminance(b)].sort((x, y) => x - y); return (values[1] + .05) / (values[0] + .05); }
(async () => {
  const names = ["home", "chat", "persona", "memory", "channels", "settings"];
  const pages = names.map(name => Object.assign(element(), { id: "page-" + name }));
  const buttons = names.map(page => Object.assign(element(), { dataset: { page } }));
  const calls = [];
  const context = { $$: selector => selector === ".page" ? pages : buttons,
    $: selector => pages.find(page => selector === "#" + page.id),
    personaActions: { reset: () => calls.push("reset") }, memoryView: { enter: () => {} }, modelView: { enter: () => {} } };
  for (const name of ["refreshStatus", "loadPersona", "loadChat", "loadAbout", "loadAutostart", "loadOwners", "loadWorkspace"]) context[name] = () => calls.push(name);
  vm.createContext(context); vm.runInContext(actual("showPage"), context);
  for (const name of names) {
    context.showPage(name);
    check(name + " keeps exactly one visible page", pages.filter(p => p.classList.contains("active")).length === 1 && pages.find(p => p.id === "page-" + name).classList.contains("active"));
    check(name + " synchronizes current navigation for assistive technology", buttons.filter(b => b.attrs.has("aria-current")).length === 1 && buttons.find(b => b.dataset.page === name).attrs.get("aria-current") === "page");
  }
  check("navigation retains persona invalidation and all existing settings reads", calls.filter(n => n === "reset").length === names.length && ["loadAbout", "loadAutostart", "loadOwners", "loadWorkspace"].every(n => calls.includes(n)));
  const homeButton = element(), pauseButton = element();
  const homeContext = { $: selector => selector === "#btn-home-chat" ? homeButton : pauseButton,
    updateHomeTodo: () => {}, updateHomeToday: () => {}, updateHomePersonaCard: () => {},
    window: { fatfishStatusView: require("../renderer/status-view.js") } };
  vm.createContext(homeContext); vm.runInContext(actual("updateHomeFill"), homeContext);
  const baseStatus = { core_running: true, key_saved: true, engine_state: "ready", qq_enabled: false };
  homeContext.updateHomeFill(baseStatus);
  check("local-only mode keeps chat primary and optional QQ out of the way", homeButton.textContent === "和它聊聊" && homeButton.classList.contains("btn-primary") && pauseButton.classList.contains("hidden"));
  homeContext.updateHomeFill({ ...baseStatus, qq_enabled: true, qq_online: false });
  check("optional QQ failure does not downgrade independent local chat", homeButton.classList.contains("btn-primary") && homeButton.textContent === "和它聊聊");
  homeContext.updateHomeFill({ ...baseStatus, last_turn_error: { error: "invalid_key" } });
  check("model failure makes chat a neutral navigation entry, not a success promise", homeButton.textContent === "打开本机对话" && homeButton.classList.contains("btn-secondary") && !homeButton.classList.contains("btn-primary"));
  homeContext.updateHomeFill({ ...baseStatus, approval_pending: true });
  check("pending approval points the primary entry at the existing confirmation context", homeButton.textContent === "查看待确认操作");
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  let reply = { items: [], activeTitle: "", activePersonaId: "" }, rendered = null;
  const personaContext = { $: node, document: { querySelector: node }, api: { personaList: async () => { if (reply instanceof Error) throw reply; return reply; } },
    showPersonaPanel: () => {}, setPersonaMsg: (el, message) => { el.textContent = message; }, renderPersonaList: rows => { rendered = rows; } };
  vm.createContext(personaContext); vm.runInContext(actual("loadPersona"), personaContext);
  node(".persona-toolbar").classList.add("hidden");
  await personaContext.loadPersona();
  check("empty library retains its only create/import toolbar", !node(".persona-toolbar").classList.contains("hidden"));
  check("empty library shows inline guidance and no stale rows", !node("#persona-empty").classList.contains("hidden") && node("#persona-list").innerHTML === "");
  reply = { items: [{ id: "local-one" }], activeTitle: "小肥", activePersonaId: "local-one" };
  await personaContext.loadPersona();
  check("populated library retains normal rendering and current name", rendered === reply.items && node("#persona-empty").classList.contains("hidden") && node("#persona-current-name").textContent === "小肥");
  reply = new Error("PRIVATE_ERROR"); await personaContext.loadPersona();
  check("read failure stays inline and does not expose raw errors", node("#persona-msg").textContent === "无法读取人格库。");
  check("duplicate home actions are removed but original module entries remain", !/id="(?:btn-goto-persona|btn-toggle-diag)"/.test(html) && html.includes('id="btn-home-change-persona"') && html.includes('id="diag-fold"'));
  check("empty state does not duplicate create/import buttons", !html.includes('id="btn-persona-empty-') && html.includes('id="btn-persona-new"') && html.includes('id="btn-persona-import"'));
  check("search has an accessible name and object status can announce changes", /id="persona-list-search"[^>]*aria-label="搜索人格库"/.test(html) && /id="chip-qq-text"[^>]*aria-live="polite"/.test(html));
  check("conversation no longer wraps approval cards in an outer card", html.includes('class="chat-panel"') && !html.includes('class="card chat-panel"'));
  check("activation remains locked on the first frame", html.includes('<body class="activation-locked">') && css.includes('body.activation-locked #main-app'));
  check("shared boolean hiding retains its precedence", css.includes('[hidden]:not([hidden="until-found" i]), .hidden { display: none !important; }'));
  check("settings groups no longer add bottom borders or a trailing separator", /\.settings-block\s*\{[^}]*border:\s*0;/.test(css) && !/\.settings-block\s*\{[^}]*border-bottom:/.test(css));
  check("only adjacent major settings groups receive one shared separator", css.includes('#page-settings > .settings-block + .settings-block { border-top: 1px solid var(--border); }'));
  check("settings rows retain spacing but no longer stack their own dividers", css.includes('.settings-block .feat-row { border-bottom: 0; }') && /\.feat-row\s*\{[^}]*padding:\s*var\(--space-4\) 0;/.test(css));
  check("risk disclosure no longer adds its own top gap or frame", css.includes('#settings-risk { margin-top: 0; padding: 0 0 var(--space-5); border: 0; }') && /<details\b[^>]*class="diag-fold settings-legal"[^>]*id="settings-risk"/.test(html));
  check("nested model capacity disclosure retains its independent boundary", /\.settings-fold\s*\{[^}]*border-top:\s*1px solid var\(--border\);/.test(css));
  check("button outlines remain visible after separator reduction", /\.btn-secondary, \.btn-row-ghost\s*\{[^}]*border-color:\s*var\(--border-strong\);/.test(css));
  check("separator changes do not remove memory and persona list boundaries", /\.memory-row\s*\{[^}]*border-bottom:\s*1px solid var\(--border\);/.test(css) && /\.persona-item\s*\{[^}]*border-bottom:\s*1px solid var\(--border\);/.test(css));
  check("current reference palette uses monochrome actions without copying mail structure", token("primary") === "#18181B" && token("sidebar") === token("surface-2") && !html.includes('data-page="inbox"'));
  for (const [foreground, background] of [["primary-ink", "primary-action"], ["danger-ink", "canvas"], ["success-ink", "canvas"], ["warn-ink", "canvas"], ["muted", "canvas"]]) {
    check(foreground + " on " + background + " reaches 4.5:1", contrast(token(foreground), token(background)) >= 4.5);
  }
  check("pause feedback has no positional movement", !/\.btn-pause:active[^}]*transform/.test(css));
  check("all controls have shared focus and disabled styling", css.includes(':where(button, input, textarea, select, summary):focus-visible') && css.includes('button:disabled { opacity: .4; cursor: not-allowed; }'));
  check("reduced motion disables animations without removing status colors", /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after/.test(css) && css.includes('transition-property: color, background-color, border-color !important;'));
  check("chat and memory use the same vertical padding contract", (css.match(/height: var\(--page-h\)/g) || []).length === 2);
  check("production renderer does not reference local design workspace", ![html, source, css].some(s => s.includes('.oil-ui')));
  console.log(`${count}/${count} UI polish checks passed (plain elements and source contracts, no native UI/network)`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
