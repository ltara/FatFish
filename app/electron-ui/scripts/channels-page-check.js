/** 平台目录：真实导航/接入函数和普通元素，不启动应用、渠道或模型。 */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const html = read("renderer/index.html"), app = read("renderer-src/App.tsx"), source = read("renderer/renderer.js");
let count = 0;
const check = (name, value) => { assert.ok(value, name); count++; console.log("PASS " + name); };
const actual = name => { const match = source.match(new RegExp("(?:async )?function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}")); assert.ok(match, name); return match[0]; };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function element() {
  const classes = new Set(), attrs = new Map(), handlers = new Map();
  return { checked: false, disabled: false, textContent: "", dataset: {}, attrs,
    classList: { add: k => classes.add(k), remove: k => classes.delete(k), contains: k => classes.has(k), toggle: (k, on) => on ? classes.add(k) : classes.delete(k) },
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k),
    addEventListener: (type, fn) => handlers.set(type, fn), emit: type => handlers.get(type)?.(), focus() { this.focused = true; },
  };
}
(async () => {
  const channels = html.match(/<section id="page-channels"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  const settings = html.match(/<section id="page-settings"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  check("platform page is a separate sibling before settings", channels && settings && html.indexOf('id="page-channels"') < html.indexOf('id="page-settings"') && channels.includes("<h2>平台</h2>"));
  check("only the supported QQ platform is presented", (channels.match(/data-channel=/g) || []).length === 1 && channels.includes('data-channel="qq"') && !/Telegram|飞书|微信|即将/.test(channels));
  for (const id of ["qq-enabled", "qq-risk-panel", "qq-risk-ok", "btn-qq-enable-confirm", "btn-qq-enable-cancel", "qq-setting-msg", "owners-list", "owners-empty", "owners-channel-status", "btn-owner-relogin", "btn-pairing-start", "btn-owners-refresh", "owners-msg"]) {
    check(id + " moves once to the channel page, without a duplicate settings entry", channels.includes('id="' + id + '"') && !settings.includes('id="' + id + '"') && (html.match(new RegExp('id="' + id + '"', "g")) || []).length === 1);
  }
  check("QQ switch has a real accessible name and local consequence notice", channels.includes('aria-labelledby="qq-enabled-title"') && channels.includes('aria-describedby="qq-enabled-note"') && channels.includes("关闭不影响本机对话"));
  check("account risk and opt-in confirmation remain local to QQ", channels.includes("风控与封号风险") && channels.includes("关闭即停止远程回复和渠道后台") && /id="qq-risk-panel" class="hidden"/.test(channels));
  check("source and first frame expose the same channel navigation", app.includes('data-page="channels"') && html.includes('data-page="channels"') && !app.includes("远程陪伴可在设置中接入"));
  check("navigation and user-facing text use the requested platform name", [app, html].every(text => !text.includes("聊天渠道") && /data-page="channels"[\s\S]*?<span>平台<\/span>/.test(text)));
  check("QQ is one closed native disclosure in a platform list", /<div class="platform-list"[^>]*>[\s\S]*?<details class="platform-item" id="channel-qq" data-channel="qq">/.test(channels) && !/<details[^>]*id="channel-qq"[^>]*\bopen/.test(channels));
  check("platform summary exposes its real status and an explicit setup action", /<summary[^>]*id="platform-qq-summary"[\s\S]*?id="owners-channel-status"[^>]*aria-live="polite"[\s\S]*?展开设置[\s\S]*?收起设置[\s\S]*?<\/summary>/.test(channels));
  const upcoming = channels.match(/<div class="platform-item platform-upcoming">([\s\S]*?)<\/div>\s*<\/div>/)?.[1];
  check("future platforms are explicit but neither clickable nor falsely available", upcoming && upcoming.includes("更多平台") && upcoming.includes("暂未开放") && !/<(?:button|a|input|summary)\b/.test(upcoming) && !/data-channel=/.test(upcoming));
  check("QQ setup is scoped under its platform with a separate owner group", channels.includes('class="platform-options"') && channels.includes('class="platform-owners"') && channels.includes(">主人账号</h3>") && (channels.match(/id="owners-channel-status"/g) || []).length === 1);
  check("narrow platform rows keep the identity readable above status and action", read("renderer/styles.css").includes(".platform-summary .platform-identity { flex-basis: 100%; }") && read("renderer/styles.css").includes(".platform-summary .platform-disclosure { margin-left: auto; }"));
  check("channel page reuses the existing form width", read("renderer/styles.css").includes("#page-home, #page-persona, #page-channels, #page-settings { max-width: var(--form-w); }"));
  const names = ["home", "chat", "persona", "memory", "channels", "settings"], pages = names.map(name => Object.assign(element(), { id: "page-" + name })), nav = names.map(page => Object.assign(element(), { dataset: { page } }));
  const calls = [], ctx = { $$: selector => selector === ".page" ? pages : nav, $: selector => pages.find(p => selector === "#" + p.id), personaActions: { reset() {} }, memoryView: { enter() {} }, modelView: { enter() {} } };
  for (const fn of ["loadOwners", "refreshStatus", "loadAbout", "loadAutostart", "loadWorkspace", "loadPersona", "loadChat"]) ctx[fn] = () => calls.push(fn);
  vm.createContext(ctx); vm.runInContext(actual("showPage"), ctx);
  ctx.showPage("channels");
  check("channel entry only reads bindings and status, without starting login", calls.join("|") === "loadOwners|refreshStatus");
  check("channel navigation selects only its own page and accessible current item", pages.filter(p => p.classList.contains("active")).map(p => p.id).join() === "page-channels" && nav.filter(p => p.attrs.has("aria-current")).map(p => p.dataset.page).join() === "channels");
  calls.length = 0; ctx.showPage("settings");
  check("settings retains model-independent reads but no longer loads remote bindings", calls.join("|") === "loadAbout|loadAutostart|loadWorkspace|refreshStatus");
  check("first-setup pairing reveals its platform before the existing action", source.includes('pair: () => { showOnboard(null); showPage("channels"); openPlatform("qq"); $("#btn-pairing-start").click(); }'));
  check("disabled-channel login opens platform setup before focusing its switch", actual("prepareLogin").includes('showPage("channels"); openPlatform("qq"); $("#qq-enabled").focus(); return;'));
  const detail = { open: false }, detailCtx = { $: selector => selector === "#channel-qq" ? detail : null };
  vm.createContext(detailCtx); vm.runInContext(actual("openPlatform"), detailCtx); detailCtx.openPlatform("qq");
  check("programmatic platform opening reveals the existing native disclosure", detail.open === true);
  detailCtx.openPlatform("not-supported");
  check("unknown platforms cannot create fake setup controls", detail.open === true);
  const bindingHint = { textContent: "" }, hintCtx = { $: () => bindingHint };
  vm.createContext(hintCtx); vm.runInContext(actual("updatePlatformBindingHint"), hintCtx);
  hintCtx.updatePlatformBindingHint({ qq_enabled: false, qq_online: false });
  check("disabled binding has a nearby explanation of both prerequisites", bindingHint.textContent.includes("先开启 QQ 接入并登录小号") && channels.includes('aria-describedby="platform-qq-binding-note"'));
  hintCtx.updatePlatformBindingHint({ qq_enabled: false, qq_online: true });
  check("disabled channel still explains prerequisites if its online snapshot is stale", bindingHint.textContent.includes("先开启 QQ 接入并登录小号"));
  hintCtx.updatePlatformBindingHint({ qq_enabled: true, qq_online: false });
  check("enabled but offline platform only asks for the remaining login step", bindingHint.textContent.includes("先登录 QQ 小号") && !bindingHint.textContent.includes("先开启"));
  hintCtx.updatePlatformBindingHint({ qq_enabled: true, qq_online: true });
  check("online platform drops the now-redundant prerequisite notice", bindingHint.textContent === "");
  hintCtx.updatePlatformBindingHint(null);
  check("unknown status does not invent channel prerequisites", bindingHint.textContent === "");

  const nodes = new Map(), $ = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const changes = []; let logins = 0, fail = false;
  const channelCtx = { $, qqSettingBusy: false, qqRiskOpen: false, lastStatus: { qq_enabled: false },
    api: { setQqEnabled: async (enabled, consent) => { changes.push([enabled, consent]); if (fail) throw Error("fixture"); channelCtx.lastStatus.qq_enabled = enabled; return { ok: true }; } },
    refreshStatus: async () => {}, prepareLogin: async () => { logins++; },
  };
  vm.createContext(channelCtx); vm.runInContext(actual("wireQqSetting") + "\nwireQqSetting();", channelCtx);
  const box = $("#qq-enabled"), panel = $("#qq-risk-panel"), ok = $("#qq-risk-ok"), confirm = $("#btn-qq-enable-confirm"), cancel = $("#btn-qq-enable-cancel");
  panel.classList.add("hidden"); confirm.disabled = true;
  check("mounting the moved controls performs no writes or login", changes.length === 0 && logins === 0);
  box.checked = true; box.emit("change"); confirm.emit("click"); await settle();
  check("switch only reveals consent, never enables QQ before acknowledgement", !box.checked && !panel.classList.contains("hidden") && confirm.disabled && changes.length === 0 && logins === 0);
  cancel.emit("click");
  check("cancel closes consent and returns focus without changing channel data", panel.classList.contains("hidden") && box.focused && changes.length === 0);
  box.checked = true; box.emit("change"); ok.checked = true; ok.emit("change"); confirm.emit("click"); confirm.emit("click"); await settle();
  check("explicit consent enables once, then invokes existing login", changes.length === 1 && changes[0][0] === true && changes[0][1] === true && logins === 1 && box.checked && panel.classList.contains("hidden"));
  box.checked = false; box.emit("change"); await settle();
  check("disable invokes the existing stop path, not login or owner deletion", changes.length === 2 && changes[1][0] === false && changes[1][1] === false && logins === 1 && !box.checked);
  fail = true; box.checked = true; box.emit("change"); ok.checked = true; ok.emit("change"); confirm.emit("click"); await settle();
  check("save failure preserves consent and shows inline recovery without login", !box.checked && !panel.classList.contains("hidden") && ok.checked && !confirm.disabled && $("#qq-setting-msg").className.includes("err") && logins === 1);
  console.log(`${count}/${count} channel page checks passed (plain elements, no application/channel/model)`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
