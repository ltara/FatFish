/**
 * FatFish Tauri shell — status / settings / login.
 * Never log or echo full API keys. Never open the system browser.
 */
const invoke = (...args) => window.__TAURI__.core.invoke(...args);

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function setBadge(el, text, kind) {
  el.textContent = text;
  el.className = "badge" + (kind ? ` ${kind}` : "");
}

async function refreshStatus() {
  const stKey = $("#st-key");
  const stSvc = $("#st-svc");
  const stLogin = $("#st-login");
  const hint = $("#st-hint");
  try {
    const s = await invoke("get_status");
    setBadge(stKey, s.key_saved ? "已保存（本机）" : "未保存", s.key_saved ? "ok" : "warn");
    setBadge(stSvc, s.settings_reachable ? "可达" : "未启动", s.settings_reachable ? "ok" : "bad");
    setBadge(stLogin, s.login_reachable ? "可达" : "未启动", s.login_reachable ? "ok" : "bad");
    if (!s.settings_reachable) {
      hint.textContent = "本机服务未启动。请用安装目录中的启动方式打开后台服务后，再点「刷新状态」。";
      hint.className = "hint";
    } else if (!s.key_saved) {
      hint.textContent = "请到「设置」填写并保存 API Key。";
      hint.className = "hint";
    } else {
      hint.textContent = "就绪。可在「登录」页完成 QQ 登录。";
      hint.className = "hint ok";
    }
    return s;
  } catch (e) {
    setBadge(stKey, "未知", "warn");
    setBadge(stSvc, "未知", "warn");
    setBadge(stLogin, "未知", "warn");
    hint.textContent = "无法读取状态（开发环境请确认已 cargo 构建）。";
    hint.className = "hint err";
    return null;
  }
}

function showPage(name) {
  $$(".page").forEach((p) => p.classList.remove("active"));
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  const page = $(`#page-${name}`);
  if (page) page.classList.add("active");
  if (name === "status") refreshStatus();
  if (name === "login") prepareLogin();
}

async function prepareLogin() {
  const placeholder = $("#login-placeholder");
  const panel = $("#login-panel");
  const msg = $("#login-msg");
  msg.textContent = "";
  msg.className = "hint";
  try {
    const s = await invoke("get_status");
    if (!s.login_reachable) {
      placeholder.classList.remove("hidden");
      panel.classList.add("hidden");
      return;
    }
    placeholder.classList.add("hidden");
    panel.classList.remove("hidden");
  } catch {
    placeholder.classList.remove("hidden");
    panel.classList.add("hidden");
  }
}

async function openLoginInApp() {
  const msg = $("#login-msg");
  msg.textContent = "";
  try {
    const ports = await invoke("get_ports");
    const url = ports.login_url || "http://127.0.0.1:6099/webui/";
    // Prefer WebviewWindow (in-app). Never shell.open / system browser.
    const { WebviewWindow } = window.__TAURI__.webviewWindow;
    const existing = await WebviewWindow.getByLabel("login");
    if (existing) {
      await existing.setFocus();
      msg.textContent = "已切换到登录窗口。";
      msg.className = "hint ok";
      return;
    }
    const win = new WebviewWindow("login", {
      url,
      title: "肥鱼 — 登录",
      width: 480,
      height: 720,
      center: true,
      focus: true,
    });
    win.once("tauri://created", () => {
      msg.textContent = "已在应用内打开登录窗口。";
      msg.className = "hint ok";
    });
    win.once("tauri://error", (e) => {
      msg.textContent = "无法打开登录窗口。请确认后台服务已启动。";
      msg.className = "hint err";
      console.error("login window error", e);
    });
  } catch (e) {
    msg.textContent = "打开登录失败。";
    msg.className = "hint err";
    console.error(e);
  }
}

async function embedLogin() {
  const msg = $("#login-msg");
  const frame = $("#login-frame");
  try {
    const ports = await invoke("get_ports");
    const url = ports.login_url || "http://127.0.0.1:6099/webui/";
    frame.classList.remove("hidden");
    frame.src = url;
    msg.textContent = "若下方空白，可能是登录页禁止嵌入，请改用「在应用内打开登录」。";
    msg.className = "hint";
  } catch (e) {
    msg.textContent = "无法加载登录页。";
    msg.className = "hint err";
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
    const res = await invoke("save_api_key", { key: v });
    input.value = "";
    if (res && res.ok) {
      msg.textContent = "已保存到本机（内容不会回显）。";
      msg.className = "hint ok";
      refreshStatus();
    } else {
      msg.textContent = "保存失败。";
      msg.className = "hint err";
    }
  } catch (e) {
    msg.textContent = "保存失败。";
    msg.className = "hint err";
    console.error(e);
  }
}

async function setupRisk() {
  const mask = $("#risk-mask");
  try {
    const ok = await invoke("is_risk_accepted");
    if (ok) {
      mask.classList.add("hidden");
      return;
    }
  } catch {
    // Fall through — show risk if command missing
  }
  mask.classList.remove("hidden");
  const box = $("#risk-ok");
  const go = $("#risk-go");
  box.addEventListener("change", () => {
    go.disabled = !box.checked;
  });
  go.addEventListener("click", async () => {
    try {
      await invoke("accept_risk");
    } catch (e) {
      console.error(e);
    }
    // Also mirror to localStorage for web-only preview
    try { localStorage.setItem("fatfish_risk_ok", "1"); } catch {}
    mask.classList.add("hidden");
  });
}

function wireUi() {
  $$(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.dataset.page));
  });
  $("#btn-refresh").addEventListener("click", () => refreshStatus());
  $("#btn-save-key").addEventListener("click", () => saveKey());
  $("#btn-open-login").addEventListener("click", () => openLoginInApp());
  $("#btn-embed-login").addEventListener("click", () => embedLogin());
}

async function main() {
  wireUi();
  await setupRisk();
  await refreshStatus();
}

main();
