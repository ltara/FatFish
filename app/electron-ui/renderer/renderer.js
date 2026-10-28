/**
 * 肥鱼 renderer — 桌面壳
 * 流程：闪屏 → 基础告知 → 模型密钥 → 本机使用；QQ 接入是可选设置。
 * 无 webview / 无手输 token / 无上游品牌
 */
(function () {
  const api = window.fatfish;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const activationView = window.fatfishActivationView.create(api);
  const memoryView = window.fatfishMemoryView.create(api);
  const modelView = window.fatfishModelView.create(api, { changed: () => refreshStatus() });
  let onboardingView = null, wizardModelView = null;
  let onboardingWasComplete = null, onboardingCompletionNotice = false;
  function mountOnboarding() {
    const source = $("#settings-model"), clone = source.cloneNode(true);
    for (const el of [clone, ...clone.querySelectorAll("[id]")]) el.id = "onboarding-" + el.id;
    for (const el of clone.querySelectorAll("[aria-describedby]")) el.setAttribute("aria-describedby", el.getAttribute("aria-describedby").split(/\s+/).map((id) => "onboarding-" + id).join(" "));
    clone.classList.remove("settings-block", "settings-card"); clone.querySelector("h3")?.remove();
    clone.querySelector("#onboarding-api-key").value = "";
    clone.querySelector("#onboarding-btn-save-key").className = "btn-secondary";
    $("#onboarding-model-slot").replaceChildren(clone);
    const wizardModel = window.fatfishModelView.create(api, { query: (s) => $("#onboarding-" + s.slice(1)), requireSavedForTest: true,
      stateChanged: () => onboardingView?.controls(), changed: () => onboardingView?.refresh(), tested: () => onboardingView?.refresh() });
    wizardModelView = wizardModel;
    onboardingView = window.fatfishOnboardingView.create(api, { model: wizardModel,
      show: () => { bootPhase = "first_setup"; showOnboard("first-setup"); },
      leave: (page) => { if (page !== "chat") { onboardingCompletionNotice = false; if (onboardingWasComplete) $("#chat-onboarding-hint").classList.add("hidden"); } enterMain(); if (page === "chat") showPage("chat"); },
      login: () => prepareLogin(), pair: () => { showOnboard(null); showPage("channels"); openPlatform("qq"); $("#btn-pairing-start").click(); },
      risk: async () => { if (await setupRisk() === true) await onboardingView.open(); },
      updated: (data) => {
        if (onboardingWasComplete === false && data.baseComplete) onboardingCompletionNotice = true;
        onboardingWasComplete = data.baseComplete;
        $("#chat-onboarding-hint").classList.toggle("hidden", data.baseComplete && !onboardingCompletionNotice);
        $("#chat-onboarding-text").textContent = data.baseComplete ? "本机设置完成。" : data.modelReady ? "第 4 步，共 4 步 · 发一句话完成试聊。" : "请先配置并测试模型。";
      },
    });
    onboardingView.wire(); wizardModel.wire();
    $("#btn-onboarding-resume").addEventListener("click", () => resumeOnboarding());
    $("#btn-chat-onboarding").addEventListener("click", () => resumeOnboarding());
  }
  async function resumeOnboarding() { const r = await api.deferOnboarding(false); if (r?.ok) await onboardingView.open(); }

  let pollTimer = null;
  let loginPollTimer = null;
  let outboundWired = false;
  let bootPhase = "splash"; // splash | risk | login | first_setup | main
  let loginSucceededThisSession = false;

  function setBadge(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = "badge" + (kind ? " " + kind : "");
  }

  function hideAllLoginStates() {
    ["#login-waiting-svc", "#login-qr-wrap", "#login-verify", "#login-success", "#login-error"].forEach(
      (sel) => {
        const el = $(sel);
        if (el) el.classList.add("hidden");
      }
    );
    const overlay = $("#login-qr-overlay");
    if (overlay) {
      overlay.classList.add("hidden");
      overlay.classList.remove("ok", "warn");
    }
  }

  function stopLoginPoll() {
    if (loginPollTimer) {
      clearInterval(loginPollTimer);
      loginPollTimer = null;
    }
  }

  function showOnboard(which) {
    ["#risk-mask", "#login-flow", "#first-setup"].forEach((sel) => {
      const el = $(sel);
      if (el) el.classList.add("hidden");
    });
    if (which) {
      const el = $("#" + which);
      if (el) el.classList.remove("hidden");
    }
    const main = $("#main-app");
    if (main) main.style.visibility = which ? "hidden" : "visible";
  }

  function enterMain() {
    bootPhase = "main";
    showOnboard(null);
    stopLoginPoll();
    showPage("home");
    refreshStatus();
    loadChat();
  }

  let lastStatus = null;
  let personaCache = { items: [], activePersonaId: "", activeTitle: "" };
  let qqSettingBusy = false;
  let qqRiskOpen = false;

  function setStatusChip(id, kind, text) {
    const el = $("#" + id);
    const textEl = $("#" + id + "-text");
    if (el) {
      const base = id === "chip-qq" ? "home-object" : "status-meter";
      el.className = base + (kind ? " " + kind : "");
    }
    if (textEl) textEl.textContent = text;
  }

  function updateTrayLikeCapsule(s) {
    const cap = $("#status-capsule");
    if (!cap) return;
    if (!s) {
      cap.textContent = "状态未知";
      return;
    }
    const view = s.presentation || window.fatfishStatusView.build(s);
    cap.textContent = view.trayText;
  }

  function updateHomeFill(s) {
    updateHomeTodo(s);
    updateHomeToday(s);
    updateHomePersonaCard(s);
    const homeChat = $("#btn-home-chat");
    if (homeChat) {
      const needsSetup = (s?.presentation || window.fatfishStatusView.build(s)).issues.some(item => item.action === "settings");
      homeChat.textContent = s?.approval_pending ? "查看待确认操作" : needsSetup ? "打开本机对话" : "和它聊聊";
      homeChat.classList.toggle("btn-primary", !needsSetup);
      homeChat.classList.toggle("btn-secondary", needsSetup);
    }
    const pauseBtn = $("#btn-pause-toggle");
    if (pauseBtn) {
      // 大钮始终可见；缺登录/密钥时仍可点，状态行会提示
      pauseBtn.classList.toggle("hidden", s?.qq_enabled === false);
    }
  }

  function updateHomeTodo(s) {
    const wrap = $("#home-todo");
    const list = $("#home-todo-list");
    if (!wrap || !list) return;
    if (!s || bootPhase !== "main") {
      wrap.classList.add("hidden");
      list.innerHTML = "";
      return;
    }
    const items = [...(s.presentation || window.fatfishStatusView.build(s)).issues];
    if (s.reminder_unshown > 0) items.push({ text: `有 ${s.reminder_unshown} 条本机提醒`, hint: "打开对话查看", action: "chat", label: "查看" });
    if (s.reminder_error) items.push({ text: "本机提醒记录暂时不可用", hint: "普通对话不受影响", action: "chat", label: "查看" });
    if (!s.active_persona_title) {
      items.push({
        text: "还没有人格",
        hint: "先选一条或新建",
        action: "persona",
        label: "去处理",
      });
    }
    if (!items.length) {
      wrap.classList.add("hidden");
      list.innerHTML = "";
      return;
    }
    wrap.classList.remove("hidden");
    list.innerHTML = "";
    let emphasized = false;
    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "todo-card";
      row.innerHTML =
        '<span class="todo-mark"></span>' +
        '<div class="todo-text"></div>' +
        '<button type="button" class="btn-soft"></button>';
      const text = row.querySelector(".todo-text");
      text.appendChild(document.createTextNode(it.text));
      if (it.hint) {
        const h = document.createElement("span");
        h.className = "hint";
        h.textContent = it.hint;
        text.appendChild(h);
      }
      const btn = row.querySelector("button");
      if (!emphasized && it.action === "settings") {
        btn.className = "btn-primary btn-sm";
        emphasized = true;
      }
      btn.textContent = it.label;
      btn.addEventListener("click", () => {
        if (it.action === "login") prepareLogin();
        else if (it.action === "settings") showPage("settings");
        else if (it.action === "persona") showPage("persona");
        else if (it.action === "chat") showPage("chat");
      });
      list.appendChild(row);
    });
  }

  function updateHomeToday(s) {
    const empty = $("#home-today-empty");
    const grid = $("#home-today-grid");
    if (!empty || !grid) return;
    const act = (s && s.activity) || {};
    const remote = s?.qq_enabled !== false;
    $("#today-count-label").textContent = remote ? "今天私聊" : "本机对话";
    $("#today-reply-label").textContent = remote ? "上次自动回" : "上次回复";
    $("#today-channel-label").textContent = remote ? "远程回复" : "QQ 接入";
    const pausedFor = act.paused_for || "";
    const hasData = !!(act.has_data || act.dm_today || act.last_reply || pausedFor);
    if (!hasData) {
      empty.classList.remove("hidden");
      grid.classList.add("hidden");
      return;
    }
    empty.classList.add("hidden");
    grid.classList.remove("hidden");
    const dm = $("#today-dm");
    const last = $("#today-last-reply");
    const paused = $("#today-paused");
    if (dm) dm.textContent = act.dm_today || "—";
    if (last) last.textContent = act.last_reply || "—";
    if (paused) {
      if (!remote) paused.textContent = "未接入";
      else if (s && s.outbound_paused) paused.textContent = pausedFor ? "已暂停 " + pausedFor : "已暂停";
      else paused.textContent = "未暂停";
    }
  }

  function updateHomePersonaCard(s) {
    const nameEl = $("#home-persona-card-name");
    const oneEl = $("#home-persona-card-one");
    if (nameEl) nameEl.textContent = (s && s.active_persona_title) || "还没有人格";
    if (oneEl) {
      oneEl.textContent =
        (s && s.active_persona_summary) ||
        ((s && s.active_persona_title) ? "" : "还没有人格，去新建一条吧");
    }
  }

  function updateOnboardingBanner(s) {
    // 已由「需要你处理」模块承接
    void s;
  }

  function updateHomeCta(s) {
    updateHomeFill(s);
  }

  function syncPauseButton(paused) {
    const btn = $("#btn-pause-toggle");
    const box = $("#outbound-paused");
    if (box && document.activeElement !== box) box.checked = !!paused;
    if (btn) {
      btn.textContent = paused ? "恢复自动回复" : "暂停自动回复";
      btn.classList.toggle("is-paused", !!paused);
    }
  }

  function updatePlatformBindingHint(s) {
    const hint = $("#platform-qq-binding-note");
    if (hint) hint.textContent = !s ? "" : s.qq_enabled === false
      ? "先开启 QQ 接入并登录小号，再绑定你的主人账号。"
      : s.qq_online ? "" : "先登录 QQ 小号，再绑定你的主人账号。";
  }

  function applyStatus(s) {
    lastStatus = s;
    updatePlatformBindingHint(s);
    const channelStatus = $("#owners-channel-status");
    if (channelStatus) channelStatus.textContent = s?.qq_enabled === false ? "未接入" : s?.channel_state === "online" ? "在线" : s?.channel_state === "connecting" ? "正在连接…" : "未连接，请先登录小号";
    const stKey = $("#st-key");
    const stSvc = $("#st-svc");
    const stLogin = $("#st-login");
    const stReply = $("#st-reply");
    const stQq = $("#st-qq");
    const stOut = $("#st-outbound");
    const stPersona = $("#st-persona");
    const hint = $("#st-hint");

    if (!s) {
      setBadge(stKey, "未知", "warn");
      setBadge(stSvc, "未知", "warn");
      setBadge(stLogin, "未知", "warn");
      setBadge(stReply, "未知", "warn");
      setBadge(stQq, "未知", "warn");
      setBadge(stOut, "未知", "warn");
      setBadge(stPersona, "未知", "warn");
      setStatusChip("chip-qq", "warn", "未知");
      setStatusChip("chip-reply", "warn", "未知");
      setStatusChip("chip-key", "warn", "未知");
      updateTrayLikeCapsule(null);
      updateOnboardingBanner(null);
      updateHomeCta(null);
      if (hint) {
        hint.textContent = "无法读取状态。";
        hint.className = "hint err selectable";
      }
      return;
    }

    const remote = s.qq_enabled !== false;
    if (!qqSettingBusy) $("#qq-enabled").checked = remote;
    $("#btn-pairing-start").disabled = !remote;
    $("#btn-owner-relogin").classList.toggle("hidden", !remote);
    $("#btn-relogin").classList.toggle("hidden", !remote);

    if (s.qq_online && s.qq_uin_mask) {
      const who = s.qq_nick_mask
        ? s.qq_nick_mask + " · " + s.qq_uin_mask
        : s.qq_uin_mask;
      setBadge(stQq, "已登录 " + who, "ok");
      setStatusChip("chip-qq", "ok", who);
    } else {
      setBadge(stQq, remote ? "未登录" : "未接入", remote ? "warn" : "info");
      setStatusChip("chip-qq", "warn", "未登录");
    }

    const invalidKey = s.last_turn_error?.error === "invalid_key";
    setBadge(stKey, invalidKey ? "未通过验证" : s.key_saved ? "已保存（本机）" : "未保存", invalidKey ? "warn" : s.key_saved ? "ok" : "warn");
    setStatusChip("chip-key", invalidKey ? "warn" : s.key_saved ? "ok" : "warn", invalidKey ? "无效" : s.key_saved ? "已配" : "未配");

    setBadge(stOut, s.outbound_paused ? "已暂停" : "正常", s.outbound_paused ? "warn" : "ok");
    setBadge(
      stPersona,
      s.active_persona_title ? s.active_persona_title : "未设置",
      s.active_persona_title ? "info" : "warn"
    );

    syncPauseButton(!!s.outbound_paused);

    const phase = s.phase || "";
    if (phase === "starting") {
      setBadge(stSvc, "启动中…", "info");
      setBadge(stLogin, "启动中…", "info");
      setBadge(stReply, "启动中…", "info");
      setStatusChip("chip-reply", "info", "启动中…");
      updateTrayLikeCapsule(s);
      updateOnboardingBanner(s);
      updateHomeCta(s);
      if (hint) {
        hint.textContent = "正在启动本机服务…";
        hint.className = "hint selectable";
      }
      return;
    }

    setBadge(stSvc, s.core_running ? "运行中" : "未启动", s.core_running ? "ok" : "bad");
    setBadge(stLogin, !remote ? "未接入" : s.login_reachable ? "运行中" : "未启动", !remote ? "info" : s.login_reachable ? "ok" : "bad");
    setBadge(
      stReply,
      s.core_running ? "运行中" : "未启动",
      s.core_running ? "ok" : phase === "degraded" ? "warn" : "bad"
    );

    const view = s.presentation || window.fatfishStatusView.build(s);
    setStatusChip("chip-reply", view.kind, view.label);
    setStatusChip("chip-qq", view.kind, view.objectText);
    setBadge(stReply, view.label, view.kind);

    updateTrayLikeCapsule(s);
    updateOnboardingBanner(s);
    updateHomeCta(s);

    if (!hint) return;
    const issue = (s.presentation || window.fatfishStatusView.build(s)).issues[0];
    if (issue) {
      // The actionable issue is already shown in the dedicated section below.
      hint.textContent = "";
      hint.className = "hint selectable home-hint";
    } else if (s.service_error) {
      hint.textContent = s.service_error;
      hint.className = "hint err selectable";
    } else if (!s.core_running) {
      hint.textContent = "本机服务未能启动。可展开下方诊断并点「重新启动本机服务」。";
      hint.className = "hint err selectable";
    } else if (remote && !s.login_reachable) {
      hint.textContent = "伙伴核心已就绪，登录服务尚未就绪。请确认已安装官方 QQ。";
      hint.className = "hint selectable";
    } else if (!s.key_saved) {
      hint.textContent = "请到「设置」填写并保存模型密钥。";
      hint.className = "hint selectable";
    } else if (remote && !s.qq_online) {
      hint.textContent = "可点上方账号行或「重新登录 QQ」扫码。";
      hint.className = "hint selectable";
    } else if (remote && s.outbound_paused) {
      hint.textContent = "自动回复已暂停，私聊不会自动回复。";
      hint.className = "hint selectable";
    } else {
      // 就绪并入仪器行绿点，不再另起绿字
      hint.textContent = "";
      hint.className = "hint selectable home-hint";
    }
  }

  async function refreshStatus() {
    try {
      const s = await api.getStatus();
      if (s?.license && !s.license.valid) {
        if (bootPhase !== "activation") { bootPhase = "activation"; stopLoginPoll(); showOnboard("activation-mask"); activationView.ensure().then(() => bootFlow()); }
        return s;
      }
      applyStatus(s);
      return s;
    } catch (_) {
      applyStatus(null);
      return null;
    }
  }

  function startPollingWhileStarting() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      const s = await refreshStatus();
      if (!s || s.phase !== "starting") {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 1200);
  }

  function showPage(name) {
    personaActions.reset();
    $$(".page").forEach((p) => p.classList.remove("active"));
    $$(".nav-btn").forEach((b) => {
      const current = b.dataset.page === name;
      b.classList.toggle("active", current);
      if (current) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    const page = $("#page-" + name);
    if (page) page.classList.add("active");
    memoryView.enter(name);
    modelView.enter(name);
    if (name === "home") refreshStatus();
    if (name === "persona") loadPersona();
    if (name === "chat") loadChat();
    if (name === "channels") {
      loadOwners();
      refreshStatus();
    }
    if (name === "settings") {
      loadAbout();
      loadAutostart();
      loadWorkspace();
      refreshStatus();
    }
  }

  function openPlatform(id) {
    const panel = $("#channel-" + id);
    if (panel) panel.open = true;
  }

  // 平台、§9.13 就地确认、§9.15 配对覆盖层。
  let ownersVersion = 0;
  let ownerConfirmTimer;
  let ownerConfirmReset = null;
  const pairingView = { open: false, epoch: 0, challenge: null, timer: null, closeTimer: null, returnFocus: null };
  const identityError = (error) => ({
    channel_disabled: "QQ 尚未接入。请先在平台中启用。",
    core_unavailable: "本机服务还没就绪，请稍后点刷新。",
    core_timeout: "暂时没有收到回复，请稍后重试。",
    identity_config_invalid: "绑定信息无法读取，请检查本机数据后重试。",
    identity_save_failed: "没有保存成功，请检查数据文件夹是否可写后重试。",
    invalid_code: "收到的数字不匹配，请核对后重新发送。",
    too_many_attempts: "有账号尝试次数过多，需稍后再试。换码不会解除限制。",
  }[error] || "暂时无法完成，请稍后重试。");

  function ownerMessage(text, error = false) {
    const element = $("#owners-msg");
    element.textContent = text;
    element.className = "hint selectable" + (error ? " err" : "");
  }

  function renderOwners(owners) {
    ownerConfirmReset?.();
    clearTimeout(ownerConfirmTimer);
    const list = $("#owners-list");
    list.replaceChildren();
    const empty = $("#owners-empty");
    empty.classList.toggle("hidden", owners.length > 0);
    empty.textContent = "绑定后仅回复你的账号。";
    for (const owner of owners) {
      const row = document.createElement("div"); row.className = "feat-row owner-row";
      const main = document.createElement("div"); main.className = "feat-main";
      const title = document.createElement("div"); title.className = "feat-title selectable";
      title.textContent = (owner.channel === "qq" ? "QQ" : owner.channel) + " " + owner.accountMask;
      const detail = document.createElement("p"); detail.className = "feat-desc selectable";
      const date = new Date(owner.boundAt);
      detail.textContent = Number.isNaN(date.getTime()) ? "已绑定" : "绑定于 " + date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
      main.append(title, detail);
      const actions = document.createElement("div"); actions.className = "owner-actions";
      const reset = () => {
        if (ownerConfirmReset === reset) { clearTimeout(ownerConfirmTimer); ownerConfirmReset = null; }
        actions.replaceChildren();
        const remove = document.createElement("button");
        remove.type = "button"; remove.className = "btn-secondary btn-sm danger-text"; remove.textContent = "解除";
        remove.setAttribute("aria-label", "解除 " + title.textContent + " 的绑定");
        remove.addEventListener("click", () => {
          ownerConfirmReset?.();
          clearTimeout(ownerConfirmTimer);
          ownerConfirmReset = reset;
          actions.replaceChildren();
          const label = document.createElement("span"); label.className = "owner-confirm"; label.textContent = "确定解除？";
          const yes = document.createElement("button"); yes.type = "button"; yes.className = "btn-secondary btn-sm danger-text"; yes.textContent = "解除绑定";
          const no = document.createElement("button"); no.type = "button"; no.className = "btn-ghost btn-sm"; no.textContent = "取消";
          no.addEventListener("click", () => { clearTimeout(ownerConfirmTimer); reset(); });
          yes.addEventListener("click", async () => {
            clearTimeout(ownerConfirmTimer); yes.disabled = true; no.disabled = true;
            ownerMessage("正在解除绑定…");
            try {
              const result = await api.removeOwner(owner.channel, owner.account, true);
              if (!result?.ok) throw new Error(result?.error || "failed");
              ownersVersion++; renderOwners(result.owners || []);
              ownerMessage("已解除绑定，该账号将不再收到回复。");
              $("#btn-pairing-start").focus();
            } catch (e) { reset(); ownerMessage(identityError(e.message), true); }
          });
          actions.append(label, yes, no); yes.focus();
          ownerConfirmTimer = setTimeout(reset, 5000);
        });
        actions.appendChild(remove);
      };
      reset(); row.append(main, actions); list.appendChild(row);
    }
  }

  async function loadOwners() {
    const version = ++ownersVersion;
    ownerMessage("正在读取绑定信息…");
    try {
      const result = await api.getOwners();
      if (version !== ownersVersion) return;
      if (!result?.ok) throw new Error(result?.error || "failed");
      renderOwners(result.owners || []); ownerMessage("");
    } catch (e) { if (version === ownersVersion) ownerMessage(identityError(e.message), true); }
  }

  function pairingMessage(text, error = false) {
    const element = $("#pairing-msg");
    element.textContent = text; element.className = "hint selectable" + (error ? " err" : "");
  }

  function clearPairingTimers() {
    clearInterval(pairingView.timer); clearTimeout(pairingView.closeTimer);
  }

  function updatePairingCountdown() {
    const challenge = pairingView.challenge;
    if (!challenge || challenge.status !== "waiting") return;
    const seconds = Math.max(0, Math.ceil((challenge.expiresAt - Date.now()) / 1000));
    $("#pairing-countdown").textContent = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0") + " 后失效";
    if (!seconds) expirePairing();
  }

  function expirePairing() {
    if (!pairingView.challenge) return;
    pairingView.challenge = { pairingId: pairingView.challenge.pairingId, status: "expired" };
    clearInterval(pairingView.timer);
    $("#pairing-code").replaceChildren(); $("#pairing-countdown").textContent = "配对码已失效";
    pairingMessage("没有绑定账号。点「换一个」生成新的配对码。");
    $("#btn-pairing-refresh").disabled = false;
  }

  async function closePairing(cancel = true) {
    const id = pairingView.challenge?.pairingId;
    pairingView.open = false; pairingView.epoch++; clearPairingTimers(); pairingView.challenge = null;
    $("#pairing-mask").classList.add("hidden"); $("#pairing-code").replaceChildren();
    $("#main-app").inert = false;
    pairingView.returnFocus?.focus();
    if (cancel) {
      try {
        const result = await api.cancelPairing(id);
        if (!result?.ok && result?.error !== "core_unavailable") ownerMessage(identityError(result?.error), true);
      } catch { ownerMessage("暂时无法取消，请等配对码失效后再试。", true); }
    }
    if (onboardingView?.resumeExternal()) await onboardingView.resume();
  }

  async function createPairing() {
    const epoch = ++pairingView.epoch;
    clearPairingTimers(); pairingView.challenge = null;
    $("#pairing-code").replaceChildren(); $("#pairing-countdown").textContent = "";
    $("#pairing-receiver").textContent = ""; $("#btn-pairing-cancel").textContent = "取消";
    $("#btn-pairing-refresh").disabled = true;
    pairingMessage("正在生成配对码…");
    try {
      const result = await api.startPairing();
      if (!pairingView.open || epoch !== pairingView.epoch) {
        if (result?.pairing?.pairingId) api.cancelPairing(result.pairing.pairingId).catch(() => {});
        return;
      }
      if (!result?.ok || !/^\d{6}$/.test(result.pairing?.code || "")) throw new Error(result?.error || "failed");
      pairingView.challenge = result.pairing;
      $("#pairing-receiver").textContent = result.receiver?.account ? "发送给 QQ 小号：" + result.receiver.account : "小号尚未连接，请先取消并重新登录。";
      const code = $("#pairing-code");
      for (const group of [result.pairing.code.slice(0, 3), result.pairing.code.slice(3)]) {
        const span = document.createElement("span"); span.textContent = group; code.appendChild(span);
      }
      pairingMessage(""); updatePairingCountdown();
      pairingView.timer = setInterval(updatePairingCountdown, 250);
    } catch (e) {
      if (pairingView.open && epoch === pairingView.epoch) pairingMessage(identityError(e.message), true);
    } finally {
      if (pairingView.open && epoch === pairingView.epoch) $("#btn-pairing-refresh").disabled = false;
    }
  }

  function wireIdentity() {
    $("#btn-owners-refresh").addEventListener("click", loadOwners);
    $("#btn-owner-relogin").addEventListener("click", () => prepareLogin());
    $("#btn-pairing-start").addEventListener("click", () => {
      pairingView.open = true; pairingView.returnFocus = document.activeElement;
      $("#main-app").inert = true; $("#pairing-mask").classList.remove("hidden");
      createPairing(); $("#btn-pairing-cancel").focus();
    });
    $("#btn-pairing-refresh").addEventListener("click", createPairing);
    $("#btn-pairing-cancel").addEventListener("click", () => closePairing(pairingView.challenge?.status !== "success"));
    $("#pairing-mask").addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); closePairing(); }
      if (event.key === "Tab") {
        const buttons = [...$("#pairing-mask").querySelectorAll("button:not(:disabled)")];
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    api.onIdentityEvent((event) => {
      if (event.type === "owners") { ownersVersion++; renderOwners(event.owners || []); }
      if (event.type === "unavailable") {
        ownerMessage("本机服务已断开，请稍后点刷新。", true);
        if (pairingView.open) {
          pairingView.epoch++; clearPairingTimers(); pairingView.challenge = null; $("#pairing-code").replaceChildren();
          $("#btn-pairing-refresh").disabled = false;
          $("#pairing-countdown").textContent = ""; pairingMessage("本机服务已断开，原配对码已失效。请稍后重试。", true);
        }
        return;
      }
      if (event.type !== "pairing" || !pairingView.open || event.pairingId !== pairingView.challenge?.pairingId) return;
      if (event.status === "failed") pairingMessage(identityError(event.reason), true);
      else if (event.status === "expired") expirePairing();
      else if (event.status === "cancelled") closePairing(false);
      else if (event.status === "success") {
        clearPairingTimers(); pairingView.challenge = { pairingId: event.pairingId, status: "success" };
        $("#pairing-code").replaceChildren(); $("#pairing-countdown").textContent = "";
        pairingMessage("已绑定 " + (event.owner.channel === "qq" ? "QQ" : event.owner.channel) + " " + event.owner.accountMask);
        $("#pairing-msg").classList.add("ok"); $("#btn-pairing-refresh").disabled = true;
        $("#btn-pairing-cancel").textContent = "完成";
        pairingView.closeTimer = setTimeout(() => closePairing(false), 1500);
      }
    });
  }

  function applyLoginView(session) {
    hideAllLoginStates();
    if (!session) {
      $("#login-error").classList.remove("hidden");
      $("#login-error-msg").textContent = "无法连接本机服务。";
      return;
    }

    const phase = session.phase || "";

    if (phase === "waiting_service") {
      $("#login-waiting-svc").classList.remove("hidden");
      $("#login-waiting-msg").textContent = session.message || "正在启动本机服务，请稍候…";
      startPollingWhileStarting();
      return;
    }

    if (phase === "success" || session.isLogin) {
      stopLoginPoll();
      loginSucceededThisSession = true;
      $("#login-success").classList.remove("hidden");
      const who = [];
      if (session.nick_mask) who.push(session.nick_mask);
      if (session.uin_mask) who.push("（" + session.uin_mask + "）");
      $("#login-success-who").textContent = who.length ? "当前账号：" + who.join("") : "QQ 已登录";
      const needKey = session.key_saved === false;
      $("#login-success-next").textContent = needKey
        ? "请继续设置模型密钥。"
        : "";
      return;
    }

    if (phase === "verify") {
      $("#login-verify").classList.remove("hidden");
      startLoginPoll();
      return;
    }

    if (phase === "error" && !session.qrDataUrl) {
      $("#login-error").classList.remove("hidden");
      $("#login-error-msg").textContent = session.message || "登录遇到问题，请重试。";
      return;
    }

    $("#login-qr-wrap").classList.remove("hidden");
    const img = $("#login-qr-img");
    if (session.qrDataUrl && img.getAttribute("src") !== session.qrDataUrl) {
      img.setAttribute("src", session.qrDataUrl);
    }
    const overlay = $("#login-qr-overlay");
    const overlayText = $("#login-qr-overlay-text");
    if (phase === "scanned") {
      overlay.classList.remove("hidden");
      overlay.classList.add("ok");
      overlayText.textContent = "已扫码，请在手机上确认";
    } else if (phase === "error") {
      overlay.classList.remove("hidden");
      overlay.classList.add("warn");
      overlayText.textContent = "二维码已失效，请刷新";
    } else {
      overlay.classList.add("hidden");
    }
    $("#login-phase-msg").textContent =
      session.message ||
      (phase === "scanned" ? "已扫码，请在手机上确认登录" : "请使用手机 QQ 扫描二维码");
    startLoginPoll();
  }

  function startLoginPoll() {
    if (loginPollTimer) return;
    loginPollTimer = setInterval(async () => {
      try {
        const s = await api.pollLoginStatus();
        applyLoginView(s);
        if (s && (s.phase === "success" || s.isLogin)) stopLoginPoll();
      } catch (_) {
        /* keep polling */
      }
    }, 1500);
  }

  async function prepareLogin() {
    const latest = await api.getStatus().catch(() => null);
    if (latest?.license && !latest.license.valid) { bootPhase = "activation"; await activationView.ensure(); return bootFlow(); }
    if (latest?.qq_enabled === false) {
      showPage("channels"); openPlatform("qq"); $("#qq-enabled").focus(); return;
    }
    bootPhase = "login";
    showOnboard("login-flow");
    stopLoginPoll();
    hideAllLoginStates();
    $("#login-waiting-svc").classList.remove("hidden");
    $("#login-waiting-msg").textContent = "正在准备登录…";
    try {
      const s = latest || await api.getStatus();
      if (s && s.phase === "starting") {
        applyLoginView({
          phase: "waiting_service",
          message: "正在启动本机服务，请稍候…",
        });
        // retry when ready
        const wait = setInterval(async () => {
          const st = await refreshStatus();
          if (st && st.phase !== "starting" && st.login_reachable) {
            clearInterval(wait);
            const session = await api.getLoginSession();
            applyLoginView(session);
          } else if (st && st.phase !== "starting" && !st.login_reachable) {
            clearInterval(wait);
            applyLoginView({
              phase: "waiting_service",
              message:
                st.service_error ||
                "登录服务未就绪。请确认已安装官方 QQ，稍后重试。",
            });
          }
        }, 1500);
        return;
      }
      if (s && !s.login_reachable) {
        applyLoginView({
          phase: "waiting_service",
          message:
            s.service_error ||
            "登录服务未就绪。请确认已安装官方 QQ，返回后点「重新启动本机服务」再试。",
        });
        return;
      }
      const session = await api.getLoginSession();
      applyLoginView(session);
    } catch (_) {
      applyLoginView(null);
    }
  }

  async function refreshQr() {
    $("#login-phase-msg").textContent = "正在刷新二维码…";
    try {
      const r = await api.refreshLoginQr();
      applyLoginView(r);
    } catch (_) {
      applyLoginView({ phase: "error", message: "刷新失败，请重试。" });
    }
  }

  async function afterLoginContinue() {
    if (onboardingView?.resumeExternal()) { await onboardingView.resume(); return; }
    enterMain();
  }

  async function loadAutostart() {
    const box = $("#autostart-enabled");
    if (!box || !api.getAutostart) return;
    try {
      const s = await api.getAutostart();
      if (document.activeElement !== box) box.checked = !!(s && s.enabled);
    } catch (_) {
      /* ignore */
    }
  }

  let personaView = "list"; // list | editor | import
  const personaActions = window.fatfishPersonaActions.create(api, {
    view: () => personaView,
    deleted: async ({ current }) => { if (current) { await loadPersona({ preserveMsg: true }); if (personaView === "list" && $("#page-persona").classList.contains("active")) $("#btn-persona-new").focus(); } refreshStatus(); },
    draft: async (value) => { await openPersonaEditor(null, value); setPersonaMsg($("#persona-editor-msg"), "已进入编辑草稿，保存后不会自动应用。", "ok"); },
  });

  function showPersonaPanel(which) {
    personaActions.reset();
    personaView = which;
    const list = $("#persona-list-view");
    const editor = $("#persona-editor");
    const imp = $("#persona-import-panel");
    if (list) list.classList.toggle("hidden", which !== "list");
    if (editor) editor.classList.toggle("hidden", which !== "editor");
    if (imp) imp.classList.toggle("hidden", which !== "import");
    if (which === "import") setPersonaMsg($("#persona-import-msg"), "", "");
  }

  function setPersonaMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "hint" + (kind ? " " + kind : "");
  }

  function filterPersonaItems(items, q) {
    const needle = (q || "").trim().toLowerCase();
    if (!needle) return items || [];
    return (items || []).filter((it) => {
      const hay = ((it.title || "") + " " + (it.summary || "") + " " + (it.body || "")).toLowerCase();
      return hay.indexOf(needle) >= 0;
    });
  }

  function locateActivePersonaInList() {
    const activeId = personaCache.activePersonaId;
    if (!activeId) return;
    const box = $("#persona-list");
    if (!box) return;
    const row = box.querySelector('[data-persona-id="' + activeId + '"]');
    if (!row) return;
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    row.classList.add("flash-locate");
    setTimeout(() => row.classList.remove("flash-locate"), 1200);
  }

  function toastPersonaApplied(ok, message) {
    const msg = $("#persona-msg");
    if (!ok) {
      setPersonaMsg(msg, message || "应用失败。", "err");
      return;
    }
    // 应用结果已经包含下一句生效的说明，不重复拼接。
    setPersonaMsg(
      msg,
      message || "已应用，下一句起生效。",
      "ok"
    );
  }

  async function loadPersona(opts) {
    const preserveMsg = !!(opts && opts.preserveMsg);
    showPersonaPanel("list");
    const msg = $("#persona-msg");
    try {
      const r = await api.personaList();
      personaCache = {
        items: (r && r.items) || [],
        activePersonaId: (r && r.activePersonaId) || "",
        activeTitle: (r && r.activeTitle) || "",
      };
      const nameEl = $("#persona-current-name");
      if (nameEl) nameEl.textContent = personaCache.activeTitle || "—";

      const empty = $("#persona-empty");
      const listBox = $("#persona-list");
      const toolbar = document.querySelector(".persona-toolbar");
      const items = personaCache.items;
      if (toolbar) toolbar.classList.remove("hidden");
      if (!items.length) {
        if (empty) empty.classList.remove("hidden");
        if (listBox) listBox.innerHTML = "";
        if (!preserveMsg) setPersonaMsg(msg, "", "");
        return;
      }
      if (empty) empty.classList.add("hidden");
      renderPersonaList(items);
      if (!preserveMsg) setPersonaMsg(msg, "", "");
    } catch (_) {
      setPersonaMsg(msg, "无法读取人格库。", "err");
    }
  }

  function renderPersonaList(allItems) {
    const box = $("#persona-list");
    if (!box) return;
    const q = ($("#persona-list-search") && $("#persona-list-search").value) || "";
    const items = filterPersonaItems(allItems, q);
    box.innerHTML = "";
    if (!items.length) {
      box.innerHTML = '<p class="hint">无匹配人格。</p>';
      return;
    }
    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "persona-item";
      row.classList.toggle("is-current", !!it.active);
      row.setAttribute("data-persona-id", it.id || "");
      const actionLabel = it.active ? "编辑" : "应用";
      row.innerHTML =
        '<button type="button" class="persona-item-main persona-item-open">' +
        '<p class="persona-item-title"></p>' +
        '<p class="persona-item-summary"></p>' +
        "</button>" +
        '<div class="persona-item-actions">' +
        '<button type="button" class="btn-secondary btn-sm persona-apply-btn"></button>' +
        "</div>";
      row.querySelector(".persona-item-title").textContent = it.title || "未命名";
      if (it.active) {
        const current = document.createElement("span"); current.className = "persona-current-badge"; current.textContent = "使用中";
        row.querySelector(".persona-item-title").appendChild(current);
      }
      row.querySelector(".persona-item-summary").textContent = it.summary || "";
      row.querySelector(".persona-item-summary").title = it.summary || "";
      row.querySelector(".persona-item-open").addEventListener("click", () => openPersonaEditor(it.id));
      const applyBtn = row.querySelector(".persona-apply-btn");
      applyBtn.textContent = actionLabel;
      applyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (it.active) {
          openPersonaEditor(it.id);
          return;
        }
        const res = await api.personaApply(it.id);
        await loadPersona({ preserveMsg: true });
        toastPersonaApplied(
          !!(res && res.ok),
          (res && res.message) || (res && res.ok ? "已应用，下一句起生效。" : "应用失败。")
        );
        refreshStatus();
      });
      box.appendChild(row);
    });
  }

  async function openPersonaEditor(id, draft) {
    showPersonaPanel("editor");
    const msg = $("#persona-editor-msg");
    setPersonaMsg(msg, "", "");
    $("#persona-edit-id").value = id || "";
    $("#persona-editor-title").textContent = id ? "编辑人格" : "新建人格";
    if (draft) {
      $("#persona-edit-title").value = draft.title || "";
      $("#persona-edit-summary").value = draft.summary || "";
      $("#persona-edit-body").value = draft.body || "";
      $("#btn-persona-delete").classList.add("hidden");
      return;
    }
    $("#btn-persona-delete").classList.toggle("hidden", !id);
    if (!id) {
      $("#persona-edit-title").value = "";
      $("#persona-edit-summary").value = "";
      $("#persona-edit-body").value = "";
      return;
    }
    try {
      const r = await api.personaGet(id);
      if (!r || !r.ok || !r.item) {
        setPersonaMsg(msg, "读取失败。", "err");
        return;
      }
      $("#persona-edit-title").value = r.item.title || "";
      $("#persona-edit-summary").value = r.item.summary || "";
      $("#persona-edit-body").value = r.item.body || "";
    } catch (_) {
      setPersonaMsg(msg, "读取失败。", "err");
    }
  }

  async function savePersonaEditor() {
    const msg = $("#persona-editor-msg");
    const id = ($("#persona-edit-id").value || "").trim();
    const payload = {
      title: ($("#persona-edit-title").value || "").trim(),
      summary: ($("#persona-edit-summary").value || "").trim(),
      body: $("#persona-edit-body").value || "",
    };
    if (!payload.title) {
      setPersonaMsg(msg, "请填写名称。", "err");
      return;
    }
    setPersonaMsg(msg, "保存中…", "");
    try {
      let r;
      if (id) r = await api.personaUpdate(id, payload);
      else r = await api.personaCreate(payload);
      if (r && r.ok) {
        if (!id && r.item) $("#persona-edit-id").value = r.item.id;
        $("#btn-persona-delete").classList.remove("hidden");
        setPersonaMsg(msg, "已保存到本机。", "ok");
        const list = await api.personaList();
        const nameEl = $("#persona-current-name");
        if (nameEl) nameEl.textContent = (list && list.activeTitle) || "—";
      } else {
        setPersonaMsg(msg, "保存失败。", "err");
      }
    } catch (_) {
      setPersonaMsg(msg, "保存失败。", "err");
    }
  }

  async function applyPersonaEditor() {
    const msg = $("#persona-editor-msg");
    let id = ($("#persona-edit-id").value || "").trim();
    const payload = {
      title: ($("#persona-edit-title").value || "").trim(),
      summary: ($("#persona-edit-summary").value || "").trim(),
      body: $("#persona-edit-body").value || "",
    };
    if (!payload.title) {
      setPersonaMsg(msg, "请填写名称。", "err");
      return;
    }
    try {
      if (id) {
        await api.personaUpdate(id, payload);
      } else {
        const c = await api.personaCreate(payload);
        if (!(c && c.ok && c.item)) {
          setPersonaMsg(msg, "保存失败，无法应用。", "err");
          return;
        }
        id = c.item.id;
        $("#persona-edit-id").value = id;
      }
      const r = await api.personaApply(id);
      if (r && r.ok) {
        setPersonaMsg(
          msg,
          (r && r.message) || "已应用，下一句起生效。",
          "ok"
        );
      } else {
        setPersonaMsg(msg, (r && r.message) || "应用失败。", "err");
      }
      refreshStatus();
    } catch (_) {
      setPersonaMsg(msg, "应用失败。", "err");
    }
  }

  function deletePersonaEditor() { personaActions.askDelete(); }

  async function runImportDraft() { await personaActions.importDraft(); }

  function wirePersona() {
    const n = $("#btn-persona-new");
    const i = $("#btn-persona-import");
    const back = $("#btn-persona-back");
    const save = $("#btn-persona-save");
    const apply = $("#btn-persona-apply");
    const del = $("#btn-persona-delete");
    const cancelImp = $("#btn-import-cancel");
    const goImp = $("#btn-import-go");
    const openNew = () => openPersonaEditor(null);
    const openImp = () => showPersonaPanel("import");
    if (n) n.addEventListener("click", openNew);
    if (i) i.addEventListener("click", openImp);
    if (back) back.addEventListener("click", () => loadPersona());
    if (save) save.addEventListener("click", () => savePersonaEditor());
    if (apply) apply.addEventListener("click", () => applyPersonaEditor());
    if (del) del.addEventListener("click", () => deletePersonaEditor());
    if (cancelImp) cancelImp.addEventListener("click", () => loadPersona());
    if (goImp) goImp.addEventListener("click", () => runImportDraft());

    const locateBtn = $("#persona-locate-btn");
    if (locateBtn) {
      locateBtn.addEventListener("click", () => {
        showPersonaPanel("list");
        locateActivePersonaInList();
      });
    }
    const listSearch = $("#persona-list-search");
    if (listSearch) {
      listSearch.addEventListener("input", () => renderPersonaList(personaCache.items));
    }
  }


  function licenseSummary(state) {
    if (state?.valid !== true) return "尚未激活";
    return "已激活 · 本机" + (typeof state.codeTail === "string" && /^[0-9A-F]{4}$/.test(state.codeTail) ? " · 激活码尾号 " + state.codeTail : "");
  }

  async function loadAbout() {
    try {
      const a = await api.getAbout();
      $("#about-version").textContent = "版本 " + (a && a.version ? a.version : "");
      const license = await api.getLicense(); $("#about-license").textContent = licenseSummary(license);
    } catch (_) {
      $("#about-version").textContent = "版本 —";
    }
  }

  async function restartServices() {
    const hint = $("#st-hint");
    hint.textContent = "正在启动本机服务…";
    hint.className = "hint";
    setBadge($("#st-svc"), "启动中…", "info");
    setBadge($("#st-login"), "启动中…", "info");
    setBadge($("#st-reply"), "启动中…", "info");
    try {
      await api.restartServices();
    } catch (_) {}
    startPollingWhileStarting();
    await refreshStatus();
  }

  function setupSplash() {
    const splash = $("#splash");
    return new Promise((resolve) => {
      setTimeout(() => {
        splash.classList.add("splash-hide");
        setTimeout(() => {
          splash.classList.add("hidden");
          splash.setAttribute("aria-hidden", "true");
          resolve();
        }, 350);
      }, 1100);
    });
  }

  let riskEpoch = 0, cancelRisk = null;
  function setupRisk() {
    cancelRisk?.(); const epoch = ++riskEpoch;
    return new Promise((resolve) => {
      const mask = $("#risk-mask"), box = $("#risk-ok"), go = $("#risk-go"); let change, click, ended = false;
      const finish = (value) => { if (ended) return; ended = true; if (change) box.removeEventListener("change", change); if (click) go.removeEventListener("click", click); if (epoch === riskEpoch) cancelRisk = null; resolve(value); };
      cancelRisk = () => finish(false);
      (async () => {
        let accepted = false; try { accepted = await api.isRiskAccepted(); } catch {}
        if (epoch !== riskEpoch) { finish(false); return; }
        if (accepted === true) { mask.classList.add("hidden"); finish(true); return; }
        bootPhase = "risk"; showOnboard("risk-mask");
        change = () => { go.disabled = !box.checked; };
        click = async () => {
          if (!box.checked || go.disabled) return; go.disabled = true;
          try {
            if (await api.acceptRisk() !== true) throw new Error("risk_not_saved");
            if (epoch !== riskEpoch) return;
            $("#risk-save-msg").textContent = ""; mask.classList.add("hidden"); finish(true);
          } catch { if (epoch === riskEpoch) $("#risk-save-msg").textContent = "没有保存成功，请检查本机服务后再试。"; }
          finally { if (epoch === riskEpoch) go.disabled = !box.checked; }
        };
        box.addEventListener("change", change); go.addEventListener("click", click); change();
      })();
    });
  }
  function wireOutbound() {
    if (outboundWired) return;
    outboundWired = true;
    const box = $("#outbound-paused");
    const toggle = async (paused) => {
      try {
        await api.setOutboundPaused(!!paused);
        syncPauseButton(!!paused);
        refreshStatus();
      } catch (_) {}
    };
    if (box) {
      box.addEventListener("change", async () => {
        await toggle(!!box.checked);
      });
    }
    const btn = $("#btn-pause-toggle");
    if (btn) {
      btn.addEventListener("click", async () => {
        const next = !(lastStatus && lastStatus.outbound_paused);
        await toggle(next);
      });
    }
  }

  function wireWindowControls() {
    const min = $("#btn-win-min");
    const max = $("#btn-win-max");
    const close = $("#btn-win-close");
    if (min) min.addEventListener("click", () => api.windowMinimize && api.windowMinimize());
    if (max) max.addEventListener("click", () => api.windowMaximizeToggle && api.windowMaximizeToggle());
    if (close) close.addEventListener("click", () => api.windowClose && api.windowClose());
  }

  let chatState = null, chatLoadingVersion = 0, chatSending = false, approvalTimer;
  async function loadChat() {
    const version = ++chatLoadingVersion;
    try {
      const state = await api.getChat();
      if (version !== chatLoadingVersion) return;
      if (!state?.ok) throw new Error("load_failed");
      chatState = state;
      const chatNav = $('[data-page="chat"]');
      const chatLabel = chatNav.querySelector("span") || chatNav;
      chatLabel.textContent = state.reminderUnshown > 0 ? "对话 · " + (state.reminderUnshown > 99 ? "99+" : state.reminderUnshown) : "对话";
      chatNav.setAttribute("aria-label", state.reminderUnshown > 0 ? `对话，有 ${state.reminderUnshown} 条未展示提醒` : "对话");
      $("#chat-reminder-error").textContent = state.reminderError ? "提醒记录暂时无法读取，普通对话不受影响。请检查本机数据后重试。" : "";
      const list = $("#chat-messages"), nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      list.replaceChildren(); clearInterval(approvalTimer);
      let lastTime = 0;
      if (!state.messages.length && !state.busy) {
        const empty = document.createElement("div"); empty.className = "chat-empty";
        const title = document.createElement("h3"); title.textContent = "今天，想聊些什么？";
        const note = document.createElement("p"); note.textContent = "聊近况、记事，或处理电脑上的事。";
        empty.append(title, note); list.appendChild(empty);
      }
      for (const m of state.messages) {
        if (m.at - lastTime > 10 * 60000) {
          const time = document.createElement("p"); time.className = "chat-time";
          time.textContent = new Date(m.at).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }); list.appendChild(time); lastTime = m.at;
        }
        const item = document.createElement("div");
        item.className = ["status", "approval"].includes(m.role) ? "chat-status chat-message" : "chat-message " + m.role;
        if (m.role === "assistant") window.fatfishChatRenderer.render(item, m.text);
        else item.textContent = m.text;
        list.appendChild(item);
      }
      for (const approval of state.approvals) {
        const card = document.createElement("section"); card.className = "chat-approval"; card.dataset.approvalId = approval.id;
        const head = document.createElement("div"); head.className = "mod-head";
        const title = document.createElement("strong"); title.textContent = "需要你确认";
        const timer = document.createElement("span"); timer.className = "hint"; timer.dataset.deadline = approval.deadlineAt;
        head.append(title, timer); card.appendChild(head);
        const summary = document.createElement("p"); summary.textContent = approval.summary; card.appendChild(summary);
        const details = document.createElement("details"), label = document.createElement("summary"), detail = document.createElement("pre");
        label.textContent = "详细信息"; detail.textContent = approval.detail; details.append(label, detail); card.appendChild(details);
        const actions = document.createElement("div"); actions.className = "btn-row";
        for (const [outcome, text, className] of [["allowed-once", "允许这一次", "btn-primary"], ["rejected", "不允许", "btn-secondary"]]) {
          const button = document.createElement("button"); button.type = "button"; button.className = className; button.textContent = text;
          button.dataset.outcome = outcome;
          button.addEventListener("click", async () => {
            card.querySelectorAll("button").forEach((b) => { b.disabled = true; });
            try {
              const r = await api.answerApproval(approval.id, outcome);
              if (!r?.ok) $("#chat-error").textContent = "这次确认已失效，请查看对话中的结果。";
            } catch { $("#chat-error").textContent = "没有收到本机服务的确认，请稍后查看结果。"; }
            await loadChat();
          });
          actions.appendChild(button);
        }
        card.appendChild(actions); list.appendChild(card);
      }
      const tick = () => {
        list.querySelectorAll("[data-deadline]").forEach((element) => {
          const seconds = Math.max(0, Math.ceil((Number(element.dataset.deadline) - Date.now()) / 1000));
          element.textContent = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
          element.classList.toggle("is-urgent", seconds > 0 && seconds <= 15);
          if (!seconds) element.closest(".chat-approval").querySelectorAll("button").forEach((b) => { b.disabled = true; });
        });
      };
      tick(); if (state.approvals.length) approvalTimer = setInterval(tick, 250);
      if (state.busy) { const thinking = document.createElement("p"); thinking.className = "chat-thinking"; thinking.textContent = state.approvals.length ? "等你确认后继续" : "正在想…"; list.appendChild(thinking); }
      $("#chat-input").readOnly = state.busy;
      const send = $("#btn-chat-send"); send.textContent = state.busy ? "停止" : "发送"; send.className = state.busy ? "btn-secondary" : "btn-primary";
      $("#btn-chat-new").disabled = state.busy;
      if (nearBottom || state.approvals.length) list.scrollTop = list.scrollHeight;
      if (state.approvals.length && !$("#page-chat").classList.contains("active")) showPage("chat");
      if ($("#page-chat").classList.contains("active") && document.visibilityState === "visible" && document.hasFocus()) {
        const ids = state.messages.filter((m) => m.reminderDeliveryId && !m.reminderShown).map((m) => m.reminderDeliveryId);
        if (ids.length) api.markRemindersShown(ids).catch(() => {});
      }
    } catch {
      $("#chat-error").textContent = "对话记录无法读取，请检查本机数据后重试。";
    }
  }
  function wireChat() {
    const input = $("#chat-input"), error = $("#chat-error");
    const resizeInput = () => {
      const style = getComputedStyle(input);
      input.style.height = "auto";
      input.style.height = Math.min(parseFloat(style.getPropertyValue("--chat-input-max")), Math.max(parseFloat(style.getPropertyValue("--chat-input-min")), input.scrollHeight)) + "px";
    };
    input.addEventListener("input", resizeInput);
    window.addEventListener("resize", () => {
      if (chatState?.approvals.length) { const list = $("#chat-messages"); list.scrollTop = list.scrollHeight; }
    });
    const send = async () => {
      if (chatState?.busy) { await api.cancelChat(); return; }
      if (chatSending || !input.value.trim()) return;
      chatSending = true; const draft = input.value; input.value = ""; error.textContent = "";
      resizeInput();
      try {
        const r = await api.sendChat(draft);
        if (!r?.accepted) { input.value = draft; error.textContent = "没有发送成功，输入已保留。请检查本机服务后重试。"; }
        else if (r.error === "chat_save_failed") error.textContent = "回复已处理，但记录未能保存。请先检查数据文件夹，不要重复提交操作。";
      } catch { input.value = draft; error.textContent = "暂时没有收到回复，输入已保留。请先检查对话记录，避免重复提交。"; }
      finally { chatSending = false; resizeInput(); await loadChat(); }
    };
    $("#btn-chat-send").addEventListener("click", send);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); } });
    $("#btn-chat-new").addEventListener("click", async () => {
      const r = await api.newChat();
      if (!r?.ok) { error.textContent = "没有新建成功，请先停止当前回复或检查数据文件夹。"; return; }
      input.value = ""; error.textContent = ""; await loadChat(); input.focus();
    });
    api.onChatChanged(() => loadChat());
    api.onRemindersChanged(() => { loadChat(); refreshStatus(); });
    window.addEventListener("focus", () => { if ($("#page-chat").classList.contains("active")) loadChat(); });
  }

  function wireQqSetting() {
    const box = $("#qq-enabled"), panel = $("#qq-risk-panel"), ok = $("#qq-risk-ok");
    const confirm = $("#btn-qq-enable-confirm"), cancel = $("#btn-qq-enable-cancel"), message = $("#qq-setting-msg");
    const closeRisk = () => { qqRiskOpen = false; panel.classList.add("hidden"); ok.checked = false; confirm.disabled = true; };
    const apply = async (enabled) => {
      qqSettingBusy = true; box.disabled = true; confirm.disabled = true; cancel.disabled = true;
      message.textContent = enabled ? "正在准备 QQ 接入…" : "正在关闭 QQ 接入…";
      message.className = "hint selectable";
      try {
        const result = await api.setQqEnabled(enabled, enabled && ok.checked);
        if (!result?.ok) throw new Error(result?.error || "channel_unavailable");
        closeRisk(); box.checked = enabled;
        message.textContent = enabled ? "已启用，请登录并绑定账号。" : "QQ 已关闭。";
        await refreshStatus();
        if (enabled) await prepareLogin();
      } catch {
        box.checked = lastStatus?.qq_enabled !== false;
        message.textContent = "没有保存成功，请检查本机服务后重试。";
        message.className = "hint err selectable";
      } finally {
        qqSettingBusy = false; box.disabled = false; cancel.disabled = false; confirm.disabled = !ok.checked;
      }
    };
    box.addEventListener("change", () => {
      if (box.checked) {
        box.checked = false; qqRiskOpen = true; panel.classList.remove("hidden");
        message.textContent = ""; ok.focus();
      } else apply(false);
    });
    ok.addEventListener("change", () => { confirm.disabled = !ok.checked || qqSettingBusy; });
    confirm.addEventListener("click", () => { if (ok.checked && !qqSettingBusy) apply(true); });
    cancel.addEventListener("click", () => { closeRisk(); box.focus(); });
  }

  // §8.6 工作区沿用设置块；选择器只由主窗口发起，模型没有配置入口。
  let workspaceBusy = false, workspaceData = null, workspaceReadVersion = 0;
  const workspaceError = (code) => ({
    local_busy: "它正在处理本机对话或操作，请等完成后再更改。",
    core_unavailable: "本机服务暂时不可用，请稍后重新读取。", core_timeout: "暂时没有收到回复，请先重新读取当前工作区。",
    config_invalid: "设置文件无法读取，请检查本机数据后重试。", config_save_failed: "没有保存成功，请检查数据文件夹是否可写后重试。",
    workspace_invalid: "工作区设置无法读取，请检查本机设置后重试。", workspace_unavailable: "文件夹不可用，请选择一个可读写的本机文件夹。",
  }[code] || "工作区暂时不可用，请重新读取或选择文件夹。");
  function renderWorkspace() {
    $("#settings-workspace").setAttribute("aria-busy", String(workspaceBusy));
    $("#btn-workspace-choose").disabled = workspaceBusy;
    $("#btn-workspace-reset").disabled = workspaceBusy || workspaceData?.isDefault === true;
    $("#btn-workspace-reset").title = workspaceData?.isDefault ? "正在使用默认工作区" : "恢复默认工作区，不移动文件";
    $("#btn-workspace-retry").disabled = workspaceBusy;
    if (workspaceData) $("#workspace-path").textContent = workspaceData.path;
  }
  async function loadWorkspace() {
    if (workspaceBusy) return;
    const version = ++workspaceReadVersion, msg = $("#workspace-msg");
    $("#settings-workspace").setAttribute("aria-busy", "true");
    msg.className = "hint selectable"; msg.textContent = "正在读取工作区…";
    try {
      const result = await api.getWorkspace(); if (version !== workspaceReadVersion || workspaceBusy) return;
      if (!result?.ok) throw new Error(result?.error || "core_unavailable");
      workspaceData = result.data; renderWorkspace(); msg.textContent = "";
      $("#btn-workspace-retry").classList.add("hidden");
    } catch (e) {
      if (version !== workspaceReadVersion || workspaceBusy) return;
      msg.className = "hint err selectable"; msg.textContent = workspaceError(e.message);
      $("#btn-workspace-retry").classList.remove("hidden");
      if (!workspaceData) $("#workspace-path").textContent = "尚未读到当前工作区";
    } finally { if (version === workspaceReadVersion && !workspaceBusy) renderWorkspace(); }
  }
  async function changeWorkspace(reset) {
    if (workspaceBusy) return;
    workspaceBusy = true; ++workspaceReadVersion; renderWorkspace();
    const msg = $("#workspace-msg"); msg.className = "hint selectable";
    msg.textContent = reset ? "正在恢复默认工作区…" : "请在文件夹选择器中选择工作区。";
    try {
      const result = await (reset ? api.resetWorkspace() : api.chooseWorkspace());
      if (!result?.ok) throw new Error(result?.error || "core_unavailable");
      if (result.cancelled) { msg.textContent = "已取消，工作区没有更改。"; return; }
      workspaceData = result.data;
      msg.textContent = result.data.changed ? "已更改，下句开启新会话；旧聊天记录和文件保留。" : "工作区没有更改。";
      $("#btn-workspace-retry").classList.add("hidden");
    } catch (e) { msg.className = "hint err selectable"; msg.textContent = workspaceError(e.message); $("#btn-workspace-retry").classList.remove("hidden"); }
    finally { workspaceBusy = false; renderWorkspace(); refreshStatus(); }
  }
  function wireWorkspace() {
    $("#btn-workspace-choose").addEventListener("click", () => changeWorkspace(false));
    $("#btn-workspace-reset").addEventListener("click", () => changeWorkspace(true));
    $("#btn-workspace-retry").addEventListener("click", () => loadWorkspace());
    api.onWorkspaceChanged(() => { if ($("#page-settings").classList.contains("active")) loadWorkspace(); });
  }

  function wireUi() {
    modelView.wire();
    wireIdentity();
    wireQqSetting();
    wireChat();
    wireWorkspace();
    $("#btn-home-chat")?.addEventListener("click", () => showPage("chat"));
    $$(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => showPage(btn.dataset.page));
    });
    const br = $("#btn-refresh");
    const bs = $("#btn-restart");
    const bl = $("#btn-relogin");
    if (br) br.addEventListener("click", () => refreshStatus());
    if (bs) bs.addEventListener("click", () => restartServices());
    if (bl) bl.addEventListener("click", () => prepareLogin());
    const chipQq = $("#chip-qq");
    const chipReply = $("#chip-reply");
    const chipKey = $("#chip-key");
    if (chipQq) chipQq.addEventListener("click", () => {
      if (lastStatus?.qq_enabled === false) { showPage("chat"); return; }
      if (lastStatus && lastStatus.qq_online) return;
      prepareLogin();
    });
    if (chipReply) chipReply.addEventListener("click", async () => {
      if (lastStatus?.qq_enabled === false) { showPage("chat"); return; }
      if (!(lastStatus && lastStatus.qq_online)) {
        prepareLogin();
        return;
      }
      const next = !(lastStatus && lastStatus.outbound_paused);
      try {
        await api.setOutboundPaused(!!next);
        refreshStatus();
      } catch (_) {}
    });
    if (chipKey) chipKey.addEventListener("click", () => showPage("settings"));
    const changePersona = $("#btn-home-change-persona");
    if (changePersona) {
      changePersona.addEventListener("click", () => {
        showPage("persona");
        setTimeout(() => locateActivePersonaInList(), 50);
      });
    }
    const auto = $("#autostart-enabled");
    if (auto) {
      auto.addEventListener("change", async () => {
        const msg = $("#settings-startup-msg");
        try {
          const r = await api.setAutostart(!!auto.checked);
          if (msg) {
            msg.textContent = r && r.ok ? (auto.checked ? "已开启开机启动。" : "已关闭开机启动。") : "切换失败";
            msg.className = "hint " + (r && r.ok ? "ok" : "err");
          }
        } catch (_) {
          if (msg) {
            msg.textContent = "切换失败";
            msg.className = "hint err";
          }
        }
      });
    }
    const openData = $("#btn-open-data");
    if (openData) {
      openData.addEventListener("click", async () => {
        const msg = $("#settings-data-msg");
        try {
          const r = await api.openDataFolder();
          if (msg) {
            msg.textContent = r && r.ok ? "已打开数据文件夹。" : (r && r.error) || "打开失败";
            msg.className = "hint " + (r && r.ok ? "ok" : "err");
          }
        } catch (_) {
          if (msg) {
            msg.textContent = "打开失败";
            msg.className = "hint err";
          }
        }
      });
    }
    const exportBtn = $("#btn-export-settings");
    if (exportBtn) {
      exportBtn.addEventListener("click", async () => {
        const msg = $("#settings-data-msg");
        try {
          const r = await api.exportSettings();
          if (msg) {
            if (r && r.canceled) {
              msg.textContent = "";
              return;
            }
            msg.textContent = r && r.ok ? "已导出设置（不含密钥明文）。" : (r && r.error) || "导出失败";
            msg.className = "hint " + (r && r.ok ? "ok" : "err");
          }
        } catch (_) {
          if (msg) {
            msg.textContent = "导出失败";
            msg.className = "hint err";
          }
        }
      });
    }
    window.fatfishDataClearView.create(api);
    wirePersona();
    const bqr = $("#btn-refresh-qr");
    const brl = $("#btn-retry-login");
    const blc = $("#btn-login-continue");
    if (bqr) bqr.addEventListener("click", () => refreshQr());
    if (brl) brl.addEventListener("click", () => prepareLogin());
    if (blc) blc.addEventListener("click", () => afterLoginContinue());
    $("#btn-login-back").addEventListener("click", () => onboardingView?.resumeExternal() ? onboardingView.resume() : enterMain());
    wireOutbound();
    wireWindowControls();
  }

  async function bootFlow() {
    await setupSplash();
    bootPhase = "activation";
    await activationView.ensure();
    if (await setupRisk() !== true) return;

    let s = null;
    try {
      s = await api.getStatus();
    } catch (_) {}

    const license = await api.getLicense().catch(() => null);
    if (!license?.valid) { bootPhase = "activation"; showOnboard("activation-mask"); await activationView.ensure(); return bootFlow(); }

    if (s && s.phase === "starting") startPollingWhileStarting();

    const setup = await api.getOnboarding();
    if (!setup?.ok || setup.data.needsWizard) { await onboardingView.open(); return; }
    enterMain();
  }

  async function main() {
    activationView.wire();
    mountOnboarding();
    wireUi();
    if (api.onStatusChanged) api.onStatusChanged(() => refreshStatus());
    await loadAbout();
    await bootFlow();
  }

  // Read-only development refresh guard. No bridge or permission changes in the shipped app.
  function developmentReloadState() {
    if (bootPhase === "splash" || bootPhase === "login") return "starting";
    const memory = memoryView.getReloadState();
    if (chatSending || chatState?.busy || chatState?.approvals?.length || qqSettingBusy || workspaceBusy ||
        modelView.isBusy() || wizardModelView?.isBusy() || memory.busy || memory.confirming ||
        pairingView.open || qqRiskOpen || ($("#data-clear-confirm") && !$("#data-clear-confirm").hidden) || $("#owners-list .owner-confirm")) return "busy";
    if (modelView.isDirty() || wizardModelView?.isDirty() || memory.dirty || $("#chat-input")?.value ||
        ($("#activation-code")?.value && bootPhase === "activation") ||
        $$('input[type="password"]').some(el => el.value) || (bootPhase === "risk" && $("#risk-ok")?.checked)) return "draft";
    if (["#persona-editor", "#persona-import-panel"].some(sel => $(sel) && !$(sel).classList.contains("hidden"))) return "editor";
    return null;
  }
  if (window.fatfishDevelopment) window.__fatfishDevelopmentReloadState = developmentReloadState;
  main();
})();
