/** 操作按钮辨识度检查：真实源码/生成首帧/普通元素，不启动应用或网络。 */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const app = read("renderer-src/App.tsx"), html = read("renderer/index.html"), css = read("renderer/styles.css"), renderer = read("renderer/renderer.js"), memory = read("renderer/memory-view.js");
let count = 0;
const check = (name, ok) => { assert.ok(ok, name); count++; console.log("PASS " + name); };
const outlined = ["btn-activation-recheck", "btn-onboarding-read", "btn-relogin", "btn-restart", "btn-chat-onboarding", "btn-chat-new", "btn-public-retry", "btn-persona-delete", "btn-persona-delete-yes", "btn-memory-refresh", "btn-memory-prev", "btn-memory-next", "btn-memory-clear", "btn-model-reload", "btn-owner-relogin", "btn-owners-refresh", "btn-workspace-reset", "btn-workspace-retry", "btn-onboarding-resume", "btn-pairing-refresh"];
function tagAt(text, id, tag) { const result = text.match(new RegExp(`<${tag}\\b[^>]*\\bid="${id}"[^>]*>`)); assert.ok(result, "control exists: " + id); return result[0]; }
function element() {
  const classes = new Set(), listeners = new Map();
  return { textContent: "", className: "", disabled: false, children: [],
    classList: { toggle: (k, on) => on ? classes.add(k) : classes.delete(k) }, setAttribute() {}, focus() {},
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
    addEventListener(name, fn) { listeners.set(name, fn); }, emit(name) { return listeners.get(name)?.(); },
  };
}
(async () => {
  for (const id of outlined) {
    const source = tagAt(app, id, "Button"), built = tagAt(html, id, "button");
    check(id + " uses an actual outlined component in source and first frame", source.includes('variant="outline"') && built.includes('data-slot="button"') && built.includes('data-variant="outline"') && [source, built].every(t => t.includes("btn-secondary") && !t.includes("btn-ghost") && !t.includes("linkish")));
  }
  const weak = new Set(["btn-login-back", "btn-onboarding-back", "btn-onboarding-later", "btn-persona-back", "btn-persona-delete-no", "btn-import-cancel", "btn-qq-enable-cancel", "btn-clear-data-cancel", "btn-pairing-cancel"]);
  for (const match of app.matchAll(/<Button\b[^>]*>/g)) {
    const tag = match[0], id = tag.match(/\bid="([^"]+)"/)?.[1];
    if (!/className="[^"]*\bbtn-ghost\b/.test(tag)) continue;
    check(id + " keeps ghost only for a weak back/cancel/defer action", weak.has(id) && tag.includes('variant="ghost"'));
  }
  check("regular action boundaries use the existing neutral border token", /\.btn-secondary, \.btn-row-ghost\s*\{[^}]*background:\s*var\(--surface\);[^}]*border-color:\s*var\(--border-strong\)/.test(css));
  check("outlined actions retain hover feedback without movement", /\.btn-secondary:hover:not\(:disabled\), \.btn-row-ghost:hover:not\(:disabled\)\s*\{\s*background:\s*var\(--hover-fill\);\s*\}/.test(css));
  check("disabled and keyboard focus are retained", css.includes("button:disabled { opacity: .4; cursor: not-allowed; }") && css.includes(":where(button, input, textarea, select, summary):focus-visible"));
  check("danger actions retain their semantics without becoming primary", ["btn-persona-delete", "btn-persona-delete-yes", "btn-memory-clear"].every(id => tagAt(app, id, "Button").includes("danger-text")));
  check("navigation and window controls are not converted to outlined action buttons", (app.match(/className="nav-btn/g) || []).length === 6 && !/<Button\b[^>]*variant="outline"[^>]*className="(?:nav-btn|titlebar-btn|status-meter|home-object)/.test(app));
  check("primary save and per-operation approval hierarchy remains unchanged", tagAt(app, "btn-save-key", "Button").includes('variant="default"') && renderer.includes('["allowed-once", "允许这一次", "btn-primary"], ["rejected", "不允许", "btn-secondary"]'));

  const nodes = new Map(), $ = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const calls = [], messages = [], timers = [];
  const context = { $, ownerConfirmReset: null, ownerConfirmTimer: null, ownersVersion: 0,
    document: { createElement: element }, clearTimeout() {}, setTimeout: fn => { timers.push(fn); return timers.length; },
    ownerMessage: text => messages.push(text), identityError: () => "操作失败",
    api: { removeOwner: async (...args) => { calls.push(args); return { ok: true, owners: [] }; } },
  };
  vm.createContext(context);
  const ownersFunction = renderer.match(/  function renderOwners\(owners\) \{[\s\S]*?\n  \}/); assert.ok(ownersFunction);
  vm.runInContext(ownersFunction[0], context);
  context.renderOwners([{ channel: "qq", account: "fixture-account", accountMask: "***1234", boundAt: "2026-01-01T00:00:00Z" }]);
  const actions = $("#owners-list").children[0].children[1];
  check("dynamic owner row initially has a bordered danger action", actions.children[0].className === "btn-secondary btn-sm danger-text" && calls.length === 0);
  actions.children[0].emit("click");
  check("arming owner removal preserves the bordered confirmation and weak cancel", actions.children[1].className === "btn-secondary btn-sm danger-text" && actions.children[2].className === "btn-ghost btn-sm" && calls.length === 0);
  actions.children[2].emit("click");
  check("cancel redraws a bordered action without removing an owner", actions.children[0].className === "btn-secondary btn-sm danger-text" && calls.length === 0);
  actions.children[0].emit("click"); timers.at(-1)();
  check("confirmation timeout also redraws a bordered action", actions.children[0].className === "btn-secondary btn-sm danger-text" && calls.length === 0);
  actions.children[0].emit("click"); await actions.children[1].emit("click");
  check("only explicit confirmation invokes the unchanged removal contract", calls.length === 1 && calls[0].join("|") === "qq|fixture-account|true" && messages.at(-1).includes("已解除绑定"));
  const helper = memory.split("\n").find(line => line.includes("const button =")); assert.ok(helper);
  vm.runInContext(helper.replace("const button =", "globalThis.memoryButton ="), context);
  let clicked = 0; const edit = context.memoryButton("编辑公开资料", () => clicked++);
  check("dynamic memory actions default to the same bordered style", edit.className === "btn-secondary btn-sm" && edit.type === "button");
  edit.emit("click"); check("dynamic helper retains its click handler", clicked === 1);
  check("memory cancel explicitly keeps its weak style", memory.includes('button("取消", cancelConfirmation, "btn-ghost btn-sm")'));
  check("memory deletion retains the outlined danger style", memory.split("\n").find(line => line.includes('const remove = button("删除"')).includes('"btn-secondary btn-sm danger-text"'));
  console.log(`${count}/${count} action button checks passed (source/first frame/plain elements, no native UI/network)`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
