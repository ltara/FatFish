/** Activation overlay. Only an explicit user click contacts the service; no raw server text is displayed. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(); else root.fatfishActivationView = factory();
})(typeof globalThis === "object" ? globalThis : this, function () {
  const text = (code) => ({
    invalid_code: "激活码无效，请核对后重试。", device_limit: "这个码已经在 2 台电脑上用过，请联系售后解绑旧电脑。",
    rate_limited: "尝试次数较多，请稍后再试。", activation_network: "暂时连不上网络。输入已保留，请检查网络后再试。",
    activation_unavailable: "激活服务暂时不可用，请稍后再试。", activation_response_invalid: "没有收到有效的激活结果，请联系售后。",
    license_unconfigured: "这个安装包还未配置激活服务，请联系售后。", device_unavailable: "暂时无法识别这台电脑，请联系售后。",
    license_invalid: "本机激活凭据无法验证，请重新激活或联系售后。", license_wrong_device: "这个激活凭据不属于当前电脑，请重新激活。",
    license_save_failed: "激活结果没有保存成功。输入已保留，请检查本机数据目录。", activation_busy: "正在激活，请等待结果。",
    activation_required: "请输入随购买提供的激活码。",
  }[code] || "没有完成激活，输入已保留。请稍后再试或联系售后。");
  const canonical = (s) => typeof s === "string" ? s.toUpperCase().replace(/[ \t\r\n-]/g, "") : "";
  function create(api, { query = (s) => document.querySelector(s), body = () => document.body } = {}) {
    const $ = query; let pending, resolvePending, busy = false, wired = false;
    const message = (value, bad = false) => { $("#activation-msg").textContent = value; $("#activation-msg").className = "hint selectable" + (bad ? " err" : ""); };
    const render = () => { const good = /^FF[0-9A-F]{32}$/.test(canonical($("#activation-code").value)); $("#activation-code").disabled = busy; $("#btn-activate").disabled = busy || !good; $("#btn-activation-recheck").disabled = busy; $("#activation-mask").setAttribute("aria-busy", String(busy)); };
    const accept = (state) => {
      if (!state?.valid) return false;
      body().classList.remove("activation-locked"); $("#activation-mask").classList.add("hidden"); $("#activation-code").value = "";
      resolvePending?.(); resolvePending = null; pending = null; return true;
    };
    async function recheck() {
      if (busy) return;
      busy = true; message("正在检查本机激活状态…"); render();
      try { const state = await api.getLicense(); if (!accept(state)) message(text(state?.error || "activation_required"), state?.error !== "activation_required"); }
      catch { message("暂时无法读取本机激活状态，请重新检查。", true); }
      finally { busy = false; render(); }
    }
    async function activate() {
      if (busy || !/^FF[0-9A-F]{32}$/.test(canonical($("#activation-code").value))) return;
      busy = true; message("正在激活，请等待确认…"); render();
      try { const result = await api.activateLicense(canonical($("#activation-code").value)); if (!result?.ok || !accept(result)) message(text(result?.error), true); }
      catch { message("没有收到激活确认，输入已保留。请先重新检查本机状态。", true); }
      finally { busy = false; render(); }
    }
    function wire() {
      if (wired) return; wired = true;
      $("#activation-code").addEventListener("input", () => {
        const el = $("#activation-code"), code = canonical(el.value), at = canonical(el.value.slice(0, el.selectionStart ?? el.value.length)).length;
        if (/^FF[0-9A-F]{0,32}$/.test(code)) {
          el.value = "FF" + (code.length > 2 ? " " + code.slice(2).match(/.{1,4}/g).join(" ") : "");
          let caret = 0, count = 0; while (caret < el.value.length && count < at) { if (/[0-9A-F]/.test(el.value[caret])) count++; caret++; }
          el.setSelectionRange?.(caret, caret);
        }
        message(""); render();
      });
      $("#btn-activate").addEventListener("click", activate); $("#btn-activation-recheck").addEventListener("click", recheck); render();
    }
    function ensure() {
      if (pending) return pending;
      body().classList.add("activation-locked"); $("#activation-mask").classList.remove("hidden");
      pending = new Promise((r) => { resolvePending = r; }); const current = pending; recheck(); return current;
    }
    return { wire, ensure, recheck, activate };
  }
  return { create };
});
