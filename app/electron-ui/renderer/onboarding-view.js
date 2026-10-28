/** Resumable owner setup. UI chooses navigation; Main alone decides which steps have proof. */
(function (root, factory) { if (typeof module === "object" && module.exports) module.exports = factory(); else root.fatfishOnboardingView = factory(); })(typeof globalThis === "object" ? globalThis : this, function () {
  const titles = { model: "模型与密钥", local: "本机试聊", "qq-risk": "QQ 账号告知", "qq-login": "登录小号", "qq-pair": "配对主人", "qq-trial": "远程试聊", done: "设置完成", risk: "基础告知" };
  const errors = { onboarding_invalid: "首次设置进度无法读取，原文件没有改动。请检查本机数据后重新读取。", onboarding_save_failed: "没有保存设置进度。请修复本机数据后重新读取，不要重复发送测试。", onboarding_unavailable: "本机服务还没准备好，请稍后重新读取。", onboarding_base_incomplete: "请先完成本机试聊，再接入 QQ。" };
  function create(api, { query = (s) => document.querySelector(s), model, show = () => {}, leave = () => {}, login = () => {}, pair = () => {}, risk = () => {}, updated = () => {} } = {}) {
    const $ = query; let data = null, active = false, busy = false, version = 0, selected = null, external = false, wired = false, lastPhase, off;
    const msg = (value, bad = false) => { $("#onboarding-msg").textContent = value; $("#onboarding-msg").className = "hint selectable" + (bad ? " err" : ""); };
    const phase = () => selected === "model" && !data?.baseComplete ? "model" : data?.phase;
    function controls() {
      const p = phase(); $("#btn-onboarding-next").disabled = busy || !data || p === "model" && (!data.modelReady || model?.isBusy() || model?.isDirty()) || p === "qq-risk" && !$("#onboarding-qq-risk-ok").checked;
      $("#btn-onboarding-later").disabled = busy; $("#btn-onboarding-back").disabled = busy;
      $("#btn-onboarding-read").disabled = busy; $("#btn-onboarding-qq").disabled = busy;
    }
    function render() {
      if (!active) return;
      const p = phase();
      $("#onboarding-title").textContent = titles[p] || "首次设置";
      $("#onboarding-step").textContent = data ? `${data.branch === "qq" ? "QQ 接入 · " : ""}第 ${p === "model" ? 3 : data.step} 步，共 ${data.total} 步 · ${titles[p] || "首次设置"}` : "正在读取本机设置…";
      for (const name of ["model", "local", "qq-risk", "qq-login", "qq-pair", "qq-trial", "done"]) $("#onboarding-" + name).classList.toggle("hidden", p !== name);
      $("#btn-onboarding-back").classList.toggle("hidden", p !== "local");
      $("#btn-onboarding-qq").classList.toggle("hidden", p !== "done" || data?.qqComplete);
      $("#onboarding-done-hint").textContent = data?.qqComplete ? "本机与 QQ 设置完成。" : "本机设置完成。QQ 可稍后接入。";
      $("#btn-onboarding-next").textContent = ({ model: "下一步", local: "去试聊", "qq-risk": "确认启用", "qq-login": "打开登录窗口", "qq-pair": "绑定主人", "qq-trial": "重新检查", done: "进入肥鱼" })[p] || "重新读取";
      $("#onboarding-qq-paused").classList.toggle("hidden", !(p === "qq-trial" && data?.qqPaused));
      if (p === "qq-trial" && data?.qqPaused) $("#btn-onboarding-next").textContent = "恢复回复";
      if (p === "model" && lastPhase !== p) model?.enter("settings"); else if (p !== "model") model?.enter("home");
      lastPhase = p; controls();
    }
    async function refresh(advance = false) {
      const read = ++version;
      try {
        const result = await api.getOnboarding(); if (read !== version) return;
        if (!result?.ok) throw new Error(result?.error || "onboarding_unavailable");
        if (!advance && active && phase() === "model" && result.data.phase === "local") selected = "model";
        data = result.data; if (advance) selected = null;
        updated(data); if (active && data.phase === "risk") { active = false; risk(); return; }
        render();
      } catch (e) { if (read === version) { msg(errors[e.message] || "没有读到设置进度，请重新读取。", true); controls(); } }
      return data;
    }
    async function open() { active = true; external = false; selected = null; lastPhase = null; show(); msg(""); await refresh(true); }
    async function later() {
      if (busy) return; busy = true; controls();
      try { const r = await api.deferOnboarding(true); if (!r?.ok) throw new Error(r?.error); data = r.data; active = false; external = false; leave("home"); }
      catch (e) { msg(errors[e.message] || "没有保存成功，请稍后重新读取。", true); }
      finally { busy = false; controls(); }
    }
    async function next() {
      if (busy) return; const p = phase();
      if (p === "model") { if (model?.isDirty() || model?.isBusy() || !data.modelReady) { msg("请先保存并显式测试当前设置。", true); return; } selected = null; await refresh(true); return; }
      if (p === "local" || p === "done") { active = false; leave(p === "local" ? "chat" : "home"); return; }
      if (p === "qq-login" || p === "qq-pair") { active = false; external = true; if (p === "qq-login") login(); else pair(); return; }
      if (p === "qq-risk") {
        if (!$("#onboarding-qq-risk-ok").checked) return;
        busy = true; controls();
        try { const r = await api.setQqEnabled(true, true); if (!r?.ok) throw new Error(r?.error); await refresh(true); }
        catch { msg("QQ 没有启用成功，请检查本机服务后重试。", true); }
        finally { busy = false; controls(); }
        return;
      }
      if (p === "qq-trial" && data?.qqPaused) {
        busy = true; controls(); try { if (await api.setOutboundPaused(false) !== true) throw new Error(); await refresh(true); }
        catch { msg("没有恢复成功，请到首页检查自动回复状态。", true); } finally { busy = false; controls(); } return;
      }
      await refresh(true);
    }
    async function startQQ() { if (busy) return; busy = true; controls(); try { const r = await api.startQqOnboarding(); if (!r?.ok) throw new Error(r?.error); data = r.data; active = true; selected = null; show(); msg(""); render(); } catch (e) { msg(errors[e.message] || "暂时无法进入 QQ 设置。", true); } finally { busy = false; controls(); } }
    function wire() {
      if (wired) return; wired = true;
      $("#btn-onboarding-next").addEventListener("click", next); $("#btn-onboarding-later").addEventListener("click", later);
      $("#btn-onboarding-back").addEventListener("click", () => { selected = "model"; render(); }); $("#btn-onboarding-qq").addEventListener("click", startQQ);
      $("#btn-onboarding-read").addEventListener("click", () => refresh()); $("#onboarding-qq-risk-ok").addEventListener("change", controls);
      off = api.onOnboardingChanged(() => { refresh().catch(() => {}); }); controls();
    }
    return { wire, open, refresh, controls, next, later, startQQ, resumeExternal: () => external, resume: async () => { external = false; await open(); }, getData: () => data, dispose: () => { off?.(); active = false; ++version; } };
  }
  return { create };
});
