(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.fatfishDataClearView = factory();
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";
  const errors = {
    clear_busy: "还有操作正在进行，请等它结束后再清理。",
    clear_args_invalid: "确认信息已失效，请取消后重新核对。",
    clear_model_invalid: "当前模型设置无法安全保留。请先修复设置，或单独选择清除模型密钥后重试。",
    clear_path_invalid: "数据位置不符合安全要求，未开始清理。请退出后检查数据目录。",
    clear_stop_failed: "后台未能安全停止，未开始清理。请退出后重新打开，再试一次。",
    clear_failed: "清理未完成，部分数据可能已删除。后台保持停止，请重试或退出后重新打开。",
    data_reset_locked: "后台已停止，请完成清理或退出后重新打开。",
  };
  function create(api, { query = (s) => document.querySelector(s) } = {}) {
    const el = {};
    for (const [key, id] of Object.entries({ open: "btn-clear-data", box: "data-clear-confirm", count: "data-clear-count", keys: "data-clear-keys", license: "data-clear-license", confirm: "btn-clear-data-confirm", cancel: "btn-clear-data-cancel", msg: "data-clear-msg" })) el[key] = query("#" + id);
    let sequence = 0, busy = false, opened = false, ready = false, disposed = false;
    const listeners = [];
    function message(text, bad = false) { el.msg.textContent = text; el.msg.className = "hint selectable" + (bad ? " err" : ""); }
    const scope = () => ({ includeKeys: el.keys.checked === true, includeLicense: el.license.checked === true });
    function controls() { el.open.disabled = busy; el.keys.disabled = busy; el.license.disabled = busy; el.cancel.disabled = busy; el.confirm.disabled = busy || !ready; }
    async function refresh() {
      if (!opened || busy || disposed) return;
      const seq = ++sequence; ready = false; controls(); el.count.textContent = "正在核对应用数据…";
      try {
        const r = await api.getDataClearPlan(scope()); if (seq !== sequence || !opened || disposed) return;
        if (r?.ok !== true || !Number.isSafeInteger(r.data?.count) || r.data.count < 0) throw new Error(r?.error);
        el.count.textContent = "将清理 " + r.data.count + " 项应用数据，不可恢复。"; ready = true;
      } catch (e) { if (seq !== sequence || !opened || disposed) return; el.count.textContent = "暂时无法核对数据。"; message(errors[e.message] || "无法读取清理范围，请稍后重新核对。", true); }
      controls();
    }
    async function open() {
      if (busy || disposed) return;
      opened = true; el.keys.checked = false; el.license.checked = false; el.box.hidden = false; el.open.hidden = true; message("");
      await refresh(); el.cancel.focus?.();
    }
    function cancel() {
      if (busy || disposed) return;
      sequence++; opened = false; ready = false; el.keys.checked = false; el.license.checked = false; el.box.hidden = true; el.open.hidden = false; controls(); message(""); el.open.focus?.();
    }
    async function clear() {
      if (busy || !ready || !opened || disposed) return;
      busy = true; ready = false; sequence++; const args = { confirmed: true, ...scope() }; controls(); message("正在停止后台并清理…");
      try {
        const r = await api.clearLocalData(args); if (disposed) return;
        if (r?.ok === true && r.exiting === true) { message("已清理，正在退出。"); return; }
        throw new Error(r?.error);
      } catch (e) { if (disposed) return; message(errors[e.message] || "清理结果暂时无法确认，请退出后检查。不会自动重试。", true); }
      busy = false; controls(); await refresh();
    }
    function on(node, type, fn) { const handler = () => { void fn(); }; node.addEventListener(type, handler); listeners.push(() => node.removeEventListener(type, handler)); }
    on(el.open, "click", open); on(el.cancel, "click", cancel); on(el.confirm, "click", clear); on(el.keys, "change", refresh); on(el.license, "change", refresh);
    el.box.hidden = true; el.keys.checked = false; el.license.checked = false; controls();
    return { open, cancel, clear, refresh, dispose() { disposed = true; sequence++; for (const off of listeners) off(); } };
  }
  return { create };
});
