// Injected only by the source-development host. Never included in the installed renderer.
(function () {
  "use strict";
  if (window.__fatfishDevelopmentUpdates || !window.fatfishDevelopment) return;
  const bridge = window.fatfishDevelopment;
  let revision = 0, pendingReload = false, reloading = false, cssPending = 0, disposed = false, queuedStyleRevision = 0, styleFailed = false;
  const hint = document.createElement("div"); hint.id = "fatfish-development-update"; hint.setAttribute("role", "status");
  Object.assign(hint.style, { position: "fixed", right: "16px", bottom: "8px", zIndex: "500", padding: "6px 10px", borderRadius: "6px", background: "#202728", color: "#fff", fontSize: "12px", pointerEvents: "none", display: "none" });
  document.body.appendChild(hint);
  const messages = { draft: "界面更新待应用：请先保存或清空输入。", editor: "界面更新待应用：请先保存并返回人格列表。", busy: "界面更新待应用：等待当前操作或审批结束。", starting: "界面更新待应用：等待界面就绪。", style: "样式更新未能加载，保留原样式；请再次保存重试。", reload: "界面刷新未完成，请手动刷新开发版。" };
  const show = reason => { hint.textContent = messages[reason] || ""; hint.style.display = reason ? "block" : "none"; };
  function reason() {
    try {
      if (bridge.getPending() > 0) return "busy";
      if (typeof window.__fatfishDevelopmentReloadState !== "function") return "starting";
      return window.__fatfishDevelopmentReloadState();
    } catch { return "starting"; }
  }
  function tick() {
    if (disposed || reloading || !pendingReload) return;
    const blocked = reason(); if (blocked) { show(blocked); return; }
    if (cssPending || queuedStyleRevision || styleFailed) return;
    reloading = true; show(null);
    try {
      const page = document.querySelector(".nav-btn.active")?.getAttribute("data-page");
      if (["home", "chat", "persona", "memory", "channels", "settings"].includes(page)) sessionStorage.setItem("fatfish-development-page", page);
    } catch { /* Page name only; never store input, credentials or messages. */ }
    const root = document.querySelector("#ui-root"); if (root) root.inert = true;
    try { bridge.requestReload(revision); }
    catch { reloading = false; if (root) root.inert = false; show("reload"); }
  }
  function updateStyles(value) {
    queuedStyleRevision = value;
    if (cssPending) return;
    startStyles();
  }
  function startStyles() {
    const value = queuedStyleRevision; queuedStyleRevision = 0; styleFailed = false;
    function finished() {
      --cssPending;
      if (disposed || cssPending) return;
      if (queuedStyleRevision) startStyles();
      else if (styleFailed) show("style"); else { show(null); tick(); }
    }
    for (const link of document.querySelectorAll('link[rel="stylesheet"][href]')) {
      const url = new URL(link.href, location.href);
      if (!/(?:\/styles\.css|\/assets\/ui\.min\.css)$/.test(url.pathname)) continue;
      const replacement = link.cloneNode(false); url.searchParams.set("fatfish-hot", String(value)); replacement.href = url.href;
      ++cssPending;
      replacement.onload = () => { link.remove(); finished(); };
      replacement.onerror = () => { styleFailed = true; replacement.remove(); finished(); };
      link.after(replacement);
    }
  }
  const restoreTimer = setInterval(() => {
    if (document.body.classList.contains("activation-locked") || document.querySelector("#main-app")?.style.visibility !== "visible") return;
    clearInterval(restoreTimer);
    try {
      const page = sessionStorage.getItem("fatfish-development-page"); sessionStorage.removeItem("fatfish-development-page");
      if (["home", "chat", "persona", "memory", "channels", "settings"].includes(page)) document.querySelector(`.nav-btn[data-page="${page}"]`)?.click();
    } catch { /* A blocked storage area must not break the app. */ }
  }, 200);
  const timer = setInterval(tick, 250);
  window.__fatfishDevelopmentUpdates = {
    apply(value) {
      if (!value || !Number.isSafeInteger(value.revision) || value.revision <= revision || typeof value.cssOnly !== "boolean" || disposed) return false;
      revision = value.revision; pendingReload = pendingReload || !value.cssOnly;
      updateStyles(revision); tick(); return true;
    },
    dispose() { disposed = true; clearInterval(timer); clearInterval(restoreTimer); hint.remove(); },
  };
})();
