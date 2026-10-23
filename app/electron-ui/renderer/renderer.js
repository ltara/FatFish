/**
 * 肥鱼 renderer — 深色桌面壳
 * 流程：闪屏 → 风险 → 扫码 → 首次 Key+人设 → 主壳（首页/人设/设置）
 * 无 webview / 无手输 token / 无上游品牌
 */
(function () {
  const api = window.fatfish;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

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

  function setCapsule(id, kind, text) {
    const el = $("#" + id);
    const textEl = $("#" + id + "-text");
    if (el) el.className = "capsule" + (kind ? " " + kind : "");
    if (textEl) textEl.textContent = text;
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
  }

  function applyStatus(s) {
    const stKey = $("#st-key");
    const stSvc = $("#st-svc");
    const stLogin = $("#st-login");
    const stBridge = $("#st-reply");
    const stQq = $("#st-qq");
    const stOut = $("#st-outbound");
    const stPersona = $("#st-persona");
    const hint = $("#st-hint");

    if (!s) {
      setBadge(stKey, "未知", "warn");
      setBadge(stSvc, "未知", "warn");
      setBadge(stLogin, "未知", "warn");
      setBadge(stBridge, "未知", "warn");
      setBadge(stQq, "未知", "warn");
      setBadge(stOut, "未知", "warn");
      setBadge(stPersona, "未知", "warn");
      setCapsule("cap-qq", "warn", "未知");
      setCapsule("cap-svc", "warn", "未知");
      setCapsule("cap-reply", "warn", "未知");
      if (hint) {
        hint.textContent = "无法读取状态。";
        hint.className = "hint err";
      }
      return;
    }

    if (s.qq_online && s.qq_uin_mask) {
      const who = s.qq_nick_mask
        ? s.qq_nick_mask + "（" + s.qq_uin_mask + "）"
        : s.qq_uin_mask;
      setBadge(stQq, "已登录 " + who, "ok");
      setCapsule("cap-qq", "ok", who);
    } else {
      setBadge(stQq, "未登录", "warn");
      setCapsule("cap-qq", "warn", "未登录");
    }

    setBadge(stKey, s.key_saved ? "已保存（本机）" : "未保存", s.key_saved ? "ok" : "warn");
    const keyHint = $("#key-mask-hint");
    if (keyHint) {
      keyHint.textContent = s.key_saved ? "当前：已保存到本机（内容已掩码，不会回显）。" : "尚未保存 Key。";
      keyHint.className = "hint";
    }

    setBadge(stOut, s.outbound_paused ? "已暂停" : "正常", s.outbound_paused ? "warn" : "ok");
    setBadge(
      stPersona,
      s.active_persona_title ? s.active_persona_title : "未设置",
      s.active_persona_title ? "info" : "warn"
    );

    const box = $("#outbound-paused");
    if (box && document.activeElement !== box) {
      box.checked = !!s.outbound_paused;
    }

    const phase = s.phase || "";
    if (phase === "starting") {
      setBadge(stSvc, "启动中…", "info");
      setBadge(stLogin, "启动中…", "info");
      setBadge(stBridge, "启动中…", "info");
      setCapsule("cap-svc", "info", "启动中…");
      setCapsule("cap-reply", "info", "启动中…");
      if (hint) {
        hint.textContent = "正在启动本机服务…";
        hint.className = "hint";
      }
      return;
    }

    setBadge(stSvc, s.settings_reachable ? "运行中" : "未启动", s.settings_reachable ? "ok" : "bad");
    setBadge(stLogin, s.login_reachable ? "运行中" : "未启动", s.login_reachable ? "ok" : "bad");
    setBadge(
      stBridge,
      s.bridge_running ? "运行中" : "未启动",
      s.bridge_running ? "ok" : phase === "degraded" ? "warn" : "bad"
    );

    setCapsule("cap-svc", s.settings_reachable && s.login_reachable ? "ok" : "bad",
      s.settings_reachable && s.login_reachable ? "运行中" : "异常");
    setCapsule(
      "cap-reply",
      s.bridge_running ? (s.outbound_paused ? "warn" : "ok") : "bad",
      s.bridge_running ? (s.outbound_paused ? "已暂停" : "运行中") : "未启动"
    );

    if (!hint) return;
    if (s.service_error) {
      hint.textContent = s.service_error;
      hint.className = "hint err";
    } else if (!s.settings_reachable) {
      hint.textContent =
        "本机服务未能启动。请确认安装完整、端口未被占用，然后点「重新启动本机服务」。";
      hint.className = "hint err";
    } else if (!s.login_reachable) {
      hint.textContent =
        "本机设置服务已就绪，登录服务尚未就绪。请确认已安装官方 QQ，稍后点「刷新状态」。";
      hint.className = "hint";
    } else if (!s.key_saved) {
      hint.textContent = "请到「设置」填写并保存 API Key。";
      hint.className = "hint";
    } else if (!s.qq_online) {
      hint.textContent = "就绪。可点「重新登录 QQ」扫码登录。";
      hint.className = "hint";
    } else {
      hint.textContent = "就绪。";
      hint.className = "hint ok";
    }
  }

  async function refreshStatus() {
    try {
      const s = await api.getStatus();
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
    $$(".page").forEach((p) => p.classList.remove("active"));
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
    const page = $("#page-" + name);
    if (page) page.classList.add("active");
    if (name === "home") refreshStatus();
    if (name === "persona") loadPersona();
    if (name === "settings") {
      loadAbout();
      refreshStatus();
    }
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
        ? "接下来完成首次设置（API Key），即可开始使用。"
        : "点击继续进入肥鱼。";
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
    bootPhase = "login";
    showOnboard("login-flow");
    stopLoginPoll();
    hideAllLoginStates();
    $("#login-waiting-svc").classList.remove("hidden");
    $("#login-waiting-msg").textContent = "正在准备登录…";
    try {
      const s = await api.getStatus();
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
    try {
      const s = await api.getStatus();
      if (s && !s.key_saved) {
        bootPhase = "first_setup";
        showOnboard("first-setup");
        return;
      }
    } catch (_) {}
    enterMain();
  }

  async function saveFirstSetup(skip) {
    const msg = $("#first-setup-msg");
    if (skip) {
      enterMain();
      return;
    }
    const key = ($("#first-api-key").value || "").trim();
    if (!key) {
      msg.textContent = "请先粘贴 API Key，或点「稍后设置」。";
      msg.className = "hint err";
      return;
    }
    msg.textContent = "保存中…";
    msg.className = "hint";
    try {
      const res = await api.saveApiKey(key);
      $("#first-api-key").value = "";
      const persona = $("#first-persona").value || "";
      if (persona.trim()) await api.savePersona(persona);
      if (res && res.ok) {
        enterMain();
      } else {
        msg.textContent = "保存失败，请重试。";
        msg.className = "hint err";
      }
    } catch (_) {
      msg.textContent = "保存失败，请重试。";
      msg.className = "hint err";
    }
  }


  async function loadAgentEngine() {
    const box = $("#agent-engine-enabled");
    const msg = $("#agent-engine-msg");
    const about = $("#about-agent-engine");
    if (!box || !api.getAgentEngine) return;
    try {
      const s = await api.getAgentEngine();
      box.checked = !!(s && s.enabled);
      if (msg) {
        if (s && s.enabled && !s.sidecar) {
          msg.textContent = "已开启，但未检测到侧载引擎，将继续走现有回复。";
          msg.className = "hint warn";
        } else if (s && s.enabled) {
          msg.textContent = "已开启（侧载可用）。暂停出站时不会调用。";
          msg.className = "hint ok";
        } else {
          msg.textContent = "";
          msg.className = "hint";
        }
      }
      if (about) {
        // Show about line whenever the experimental switch exists
        about.textContent = "本机助手引擎（试验）：" + (s && s.enabled ? "开" : "关") + (s && s.sidecar ? " · 侧载已就绪" : " · 未侧载");
        about.classList.remove("hidden");
      }
    } catch (_) {
      /* ignore */
    }
  }

  async function setAgentEngine(enabled) {
    const msg = $("#agent-engine-msg");
    try {
      const r = await api.setAgentEngineEnabled(!!enabled);
      if (msg) {
        if (r && r.ok) {
          msg.textContent = r.enabled
            ? r.sidecar
              ? "已开启本机助手引擎（试验）。"
              : "已开启，但未检测到侧载，仍走现有回复。"
            : "已关闭，私聊走现有回复。";
          msg.className = "hint ok";
        } else {
          msg.textContent = "切换失败";
          msg.className = "hint err";
        }
      }
      loadAgentEngine();
    } catch (_) {
      if (msg) {
        msg.textContent = "切换失败";
        msg.className = "hint err";
      }
    }
  }

  async function saveKey() {
    const input = $("#api-key");
    const msg = $("#settings-msg");
    const v = (input.value || "").trim();
    if (!v) {
      msg.textContent = "请先粘贴 Key";
      msg.className = "hint err";
      return;
    }
    msg.textContent = "保存中…";
    msg.className = "hint";
    try {
      const res = await api.saveApiKey(v);
      input.value = "";
      if (res && res.ok) {
        msg.textContent = "已保存到本机（内容不会回显）。";
        msg.className = "hint ok";
        refreshStatus();
      } else {
        msg.textContent = "保存失败。";
        msg.className = "hint err";
      }
    } catch (_) {
      msg.textContent = "保存失败。";
      msg.className = "hint err";
    }
  }

  let personaView = "list"; // list | editor | import

  function showPersonaPanel(which) {
    personaView = which;
    const list = $("#persona-list-view");
    const editor = $("#persona-editor");
    const imp = $("#persona-import-panel");
    if (list) list.classList.toggle("hidden", which !== "list");
    if (editor) editor.classList.toggle("hidden", which !== "editor");
    if (imp) imp.classList.toggle("hidden", which !== "import");
  }

  function setPersonaMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "hint" + (kind ? " " + kind : "");
  }

  async function loadPersona() {
    showPersonaPanel("list");
    const msg = $("#persona-msg");
    try {
      const r = await api.personaList();
      const nameEl = $("#persona-current-name");
      if (nameEl) nameEl.textContent = (r && r.activeTitle) || "—";
      const box = $("#persona-list");
      if (!box) return;
      box.innerHTML = "";
      const items = (r && r.items) || [];
      if (!items.length) {
        box.innerHTML = '<p class="hint">暂无人设，请新建或从素材导入。</p>';
        return;
      }
      items.forEach((it) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "persona-item";
        row.innerHTML =
          '<div class="persona-item-main">' +
          '<p class="persona-item-title"></p>' +
          '<p class="persona-item-summary"></p>' +
          "</div>" +
          '<div class="persona-item-actions">' +
          (it.active ? '<span class="badge ok">使用中</span>' : '<span class="badge">未使用</span>') +
          '<button type="button" class="btn-secondary btn-sm persona-apply-btn">应用</button>' +
          "</div>";
        row.querySelector(".persona-item-title").textContent = it.title || "未命名";
        row.querySelector(".persona-item-summary").textContent = it.summary || "";
        row.addEventListener("click", (e) => {
          if (e.target && e.target.classList.contains("persona-apply-btn")) return;
          openPersonaEditor(it.id);
        });
        const applyBtn = row.querySelector(".persona-apply-btn");
        applyBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const res = await api.personaApply(it.id);
          setPersonaMsg(msg, (res && res.message) || (res && res.ok ? "已应用。" : "应用失败。"), res && res.ok ? "ok" : "err");
          await loadPersona();
          refreshStatus();
        });
        if (it.active) applyBtn.disabled = true;
        box.appendChild(row);
      });
      setPersonaMsg(msg, "", "");
    } catch (_) {
      setPersonaMsg(msg, "无法读取人设库。", "err");
    }
  }

  async function openPersonaEditor(id, draft) {
    showPersonaPanel("editor");
    const msg = $("#persona-editor-msg");
    setPersonaMsg(msg, "", "");
    $("#persona-edit-id").value = id || "";
    $("#persona-editor-title").textContent = id ? "编辑人设" : "新建人设";
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
      setPersonaMsg(
        msg,
        (r && r.message) || (r && r.ok ? "已应用。" : "应用失败。"),
        r && r.ok ? "ok" : "err"
      );
      refreshStatus();
    } catch (_) {
      setPersonaMsg(msg, "应用失败。", "err");
    }
  }

  async function deletePersonaEditor() {
    const msg = $("#persona-editor-msg");
    const id = ($("#persona-edit-id").value || "").trim();
    if (!id) return;
    const ok = window.confirm("确定删除此人设？删除后不可恢复。");
    if (!ok) return;
    try {
      const r = await api.personaDelete(id, true);
      if (r && r.ok) {
        setPersonaMsg($("#persona-msg"), r.message || "已删除。", "ok");
        await loadPersona();
        refreshStatus();
      } else {
        setPersonaMsg(msg, "删除失败。", "err");
      }
    } catch (_) {
      setPersonaMsg(msg, "删除失败。", "err");
    }
  }

  async function runImportDraft() {
    const raw = $("#persona-import-text").value || "";
    if (!raw.trim()) {
      window.alert("请先粘贴素材文本。");
      return;
    }
    try {
      const r = await api.personaImportText(raw);
      if (r && r.ok && r.draft) {
        $("#persona-import-text").value = "";
        await openPersonaEditor(null, r.draft);
        setPersonaMsg($("#persona-editor-msg"), "已进入编辑草稿，保存后不会自动应用。", "ok");
      } else {
        window.alert("导入失败。");
      }
    } catch (_) {
      window.alert("导入失败。");
    }
  }

  function wirePersona() {
    const n = $("#btn-persona-new");
    const i = $("#btn-persona-import");
    const back = $("#btn-persona-back");
    const save = $("#btn-persona-save");
    const apply = $("#btn-persona-apply");
    const del = $("#btn-persona-delete");
    const cancelImp = $("#btn-import-cancel");
    const goImp = $("#btn-import-go");
    if (n) n.addEventListener("click", () => openPersonaEditor(null));
    if (i) i.addEventListener("click", () => showPersonaPanel("import"));
    if (back) back.addEventListener("click", () => loadPersona());
    if (save) save.addEventListener("click", () => savePersonaEditor());
    if (apply) apply.addEventListener("click", () => applyPersonaEditor());
    if (del) del.addEventListener("click", () => deletePersonaEditor());
    if (cancelImp) cancelImp.addEventListener("click", () => loadPersona());
    if (goImp) goImp.addEventListener("click", () => runImportDraft());
  }


  async function loadAbout() {
    try {
      const a = await api.getAbout();
      $("#about-version").textContent = "版本 " + (a && a.version ? a.version : "");
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

  function setupRisk() {
    return new Promise(async (resolve) => {
      const mask = $("#risk-mask");
      try {
        const ok = await api.isRiskAccepted();
        if (ok) {
          mask.classList.add("hidden");
          resolve(true);
          return;
        }
      } catch (_) {}
      bootPhase = "risk";
      showOnboard("risk-mask");
      const box = $("#risk-ok");
      const go = $("#risk-go");
      const onChange = () => {
        go.disabled = !box.checked;
      };
      box.addEventListener("change", onChange);
      go.addEventListener("click", async () => {
        try {
          await api.acceptRisk();
        } catch (_) {}
        mask.classList.add("hidden");
        resolve(true);
      });
    });
  }

  function wireOutbound() {
    if (outboundWired) return;
    outboundWired = true;
    const box = $("#outbound-paused");
    box.addEventListener("change", async () => {
      try {
        await api.setOutboundPaused(!!box.checked);
        refreshStatus();
      } catch (_) {}
    });
  }

  function wireWindowControls() {
    const min = $("#btn-win-min");
    const max = $("#btn-win-max");
    const close = $("#btn-win-close");
    if (min) min.addEventListener("click", () => api.windowMinimize && api.windowMinimize());
    if (max) max.addEventListener("click", () => api.windowMaximizeToggle && api.windowMaximizeToggle());
    if (close) close.addEventListener("click", () => api.windowClose && api.windowClose());
  }

  function wireUi() {
    $$(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => showPage(btn.dataset.page));
    });
    $("#btn-refresh").addEventListener("click", () => refreshStatus());
    $("#btn-restart").addEventListener("click", () => restartServices());
    $("#btn-relogin").addEventListener("click", () => prepareLogin());
    $("#btn-save-key").addEventListener("click", () => saveKey());
    wirePersona();
    $("#btn-refresh-qr").addEventListener("click", () => refreshQr());
    $("#btn-retry-login").addEventListener("click", () => prepareLogin());
    $("#btn-login-continue").addEventListener("click", () => afterLoginContinue());
    $("#btn-first-save").addEventListener("click", () => saveFirstSetup(false));
    $("#btn-first-skip").addEventListener("click", () => saveFirstSetup(true));
    wireOutbound();
    wireWindowControls();
  }

  async function bootFlow() {
    await setupSplash();
    await setupRisk();

    let s = null;
    try {
      s = await api.getStatus();
    } catch (_) {}

    if (s && s.phase === "starting") startPollingWhileStarting();

    // 已登录则跳过扫码；否则进入扫码流
    if (s && s.qq_online) {
      if (!s.key_saved) {
        bootPhase = "first_setup";
        showOnboard("first-setup");
        return;
      }
      enterMain();
      return;
    }

    await prepareLogin();
  }

  async function main() {
    wireUi();
    await loadAbout();
    await bootFlow();
  }

  main();
})();
