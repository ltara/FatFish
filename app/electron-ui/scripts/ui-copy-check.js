/** 文案精简与普通元素状态检查。不启动应用、后台、浏览器或模型。 */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const app = read("renderer-src/App.tsx"), html = read("renderer/index.html");
let count = 0;
const check = (name, ok) => { assert.ok(ok, name); count++; console.log("PASS " + name); };
const textAt = id => {
  const match = html.match(new RegExp(`<([a-z]+)\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)<\\/\\1>`));
  assert.ok(match, "notice exists: " + id); return match[2].replace(/<[^>]*>/g, "");
};
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function element() {
  const classes = new Set(), listeners = new Map();
  return { value: "", textContent: "", children: [], dataset: {}, disabled: false, scrollTop: 0,
    classList: { add: k => classes.add(k), remove: k => classes.delete(k), contains: k => classes.has(k), toggle: (k, on) => on ? classes.add(k) : classes.delete(k) },
    setAttribute() {}, focus() {}, scrollIntoView() {}, querySelectorAll: () => [],
    append(...nodes) { this.children.push(...nodes); }, prepend(...nodes) { this.children.unshift(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(name, fn) { listeners.set(name, fn); }, emit(name) { return listeners.get(name)?.(); },
  };
}
(async () => {
  check("redundant settings and memory introductions are gone", !app.includes("模型、远程陪伴与本机数据") && !app.includes("你可以查看、删除，或留一份导出"));
  check("model idle explanation is not repeated in the controller", !read("renderer/model-view.js").includes("当前没有尚未保存的修改"));
  check("model change notice remains short and preserves context and privacy boundaries", textAt("model-change-note").length <= 44 && ["新会话", "旧聊天记录保留", "人格和相关记忆", "所选服务商"].every(s => textAt("model-change-note").includes(s)));
  check("test notice keeps fees, excluded private context and no-save semantics", textAt("model-test-note").length <= 44 && ["模型费用", "不发送已有对话、人格或记忆", "不保存设置"].every(s => textAt("model-test-note").includes(s)));
  check("reread discard warning is initially hidden but retained", /id="model-reload-note" class="hint hidden"/.test(html) && textAt("model-reload-note").includes("丢弃未保存"));
  check("save and test controls remain associated with their notices", /id="btn-save-key"[^>]*aria-describedby="model-change-note"/.test(html) && /id="btn-model-test"[^>]*aria-describedby="model-test-note"/.test(html));
  check("public profile still warns against publishing private content", textAt("public-profile-warning").includes("对外公开") && textAt("public-profile-warning").includes("隐私") && textAt("public-profile-reset").includes("旧聊天记录保留"));
  check("workspace warning preserves approval, reset and no-move semantics", app.includes("操作仍需逐次确认") && ["新会话", "旧聊天记录保留", "文件不移动"].every(s => textAt("workspace-change-note").includes(s)));
  check("duplicate risk summary is a closed native disclosure", /<details\b[^>]*id="settings-risk">\s*<summary>风险与隐私<\/summary>/.test(html));
  check("data-clear scope and separate sensitive confirmations remain explicit", app.includes("默认保留模型设置、密钥和激活信息") && app.includes("保留工作区文件和 QQ 登录状态") && app.includes("同时清除模型密钥") && app.includes("重新联网激活") && read("renderer/data-clear-view.js").includes("项应用数据，不可恢复"));
  check("basic consent retains fees, off-device content, key protection and approval", ["费用由你的密钥承担", "不要输入不愿外发的信息", "请保管好密钥", "电脑操作需逐次确认"].every(s => app.includes(s)));
  check("optional channel consent retains account risk and remote boundary", app.includes("风控或封号，风险由你承担") && app.includes("不能操作电脑") && app.includes('id="onboarding-qq-risk-ok"') && app.includes('id="qq-risk-ok"'));
  check("activation still discloses limited data submission", app.includes("仅发送激活码和设备标识哈希"));
  check("setup still warns against duplicate paid or computer operations", app.includes("中断后先查记录，不要重复提交") && app.includes("试聊会产生模型费用，不会自动发送或重试"));
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  check("all accessible description references still resolve", [...html.matchAll(/aria-describedby="([^"]+)"/g)].every(m => m[1].split(/\s+/).every(id => ids.has(id))));
  check("empty status messages collapse without layout gaps", read("renderer/styles.css").includes(".hint:empty { display: none; }"));
  check("source and generated first frame have the same concise notices", ["更改后开启新会话", "测试可能产生少量模型费用", "电脑操作需逐次确认"].every(s => app.includes(s) && html.includes(s)));

  const nodes = new Map(), $ = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const scopes = ["owner", "owner_public", "diary"].map(scope => Object.assign(element(), { dataset: { memoryScope: scope } }));
  let saved = "公开资料夹具", reads = 0, writes = 0;
  const api = {
    getPublicProfile: async () => { reads++; return { ok: true, data: { text: saved } }; },
    savePublicProfile: async text => { writes++; saved = text; return { ok: true }; },
    memoryList: async () => ({ ok: true, data: { items: [], total: 0 } }), onMemoryChanged() {},
  };
  const context = { window: {}, document: { querySelector: $, querySelectorAll: () => scopes, createElement: element }, console };
  vm.createContext(context); vm.runInContext(read("renderer/memory-view.js"), context);
  const view = context.window.fatfishMemoryView.create(api);
  view.enter("persona"); await settle();
  check("loaded public profile stays quiet without losing saved data", $("#public-profile-msg").textContent === "" && $("#public-profile-text").value === saved && $("#btn-public-save").disabled);
  $("#public-profile-text").value = "新的公开资料夹具"; $("#public-profile-text").emit("input");
  check("unsaved profile still gets a concise actionable status", $("#public-profile-msg").textContent === "尚未保存。" && view.getReloadState().dirty && !$("#btn-public-save").disabled);
  const before = reads; view.enter("persona"); await settle();
  check("copy changes do not remove draft protection", reads === before && $("#public-profile-text").value === "新的公开资料夹具");
  $("#public-profile-text").value = saved; $("#public-profile-text").emit("input");
  check("reverting edits removes the idle message and dirty state", $("#public-profile-msg").textContent === "" && !view.getReloadState().dirty && $("#btn-public-save").disabled);
  $("#public-profile-text").value = "已确认的公开资料夹具"; $("#public-profile-text").emit("input"); await $("#btn-public-save").emit("click");
  check("explicit save still provides completion feedback", writes === 1 && $("#public-profile-msg").textContent.includes("公开资料已保存") && !view.getReloadState().dirty);
  view.enter("memory"); await settle();
  check("private memory range and empty-state instructions are concise", $("#memory-scope-hint").textContent === "仅用于你与它的对话。" && $("#memory-list").children[0].textContent.includes("记住"));
  scopes[1].emit("click"); await settle();
  check("public range keeps its disclosure and editing entry", $("#memory-scope-hint").textContent.includes("可对外公开") && $("#memory-scope-hint").children[0].textContent === "编辑公开资料");
  scopes[2].emit("click"); await settle();
  check("unavailable diary does not imply the feature already exists", $("#memory-list").children[0].textContent === "日记将在后续版本开放。");
  console.log(`${count}/${count} UI copy checks passed (source and plain elements, no native UI/network)`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
