/** Memory management uses only the main window's narrow preload operations. */
(function () {
  window.fatfishMemoryView = { create(api) {
    const $ = (s) => document.querySelector(s);
    const names = { owner: "关于你", owner_public: "公开资料", diary: "它的日记" };
    const state = { scope: "owner", offset: 0, items: [], total: 0, loaded: false, loading: false, busy: false, stale: false, epoch: 0, confirmation: null, changed: false };
    let publicDirty = false, publicBusy = false, publicLoaded = false, publicEpoch = 0, publicSaved = "", entered = false;
    const errorText = (code) => ({ memory_changed: "记忆数量有变化，请取消并刷新后重新确认。", memory_not_found: "这条记忆已不在了，请刷新列表。", memory_args_invalid: "操作信息有误，请刷新后重试。", memory_export_failed: "没有导出成功，请换一个保存位置重试。" })[code] || "暂时无法读取或保存记忆，请检查本机服务后重试。";
    const message = (text = "", error = false) => { $("#memory-msg").textContent = text; $("#memory-msg").className = "hint selectable" + (error ? " err" : ""); };
    const publicMessage = (text = "", error = false) => { $("#public-profile-msg").textContent = text; $("#public-profile-msg").className = "hint selectable" + (error ? " err" : ""); };
    const button = (text, action, classes = "btn-secondary btn-sm") => { const el = document.createElement("button"); el.type = "button"; el.textContent = text; el.className = classes; el.addEventListener("click", action); return el; };
    const updatePublicButton = () => { $("#btn-public-save").disabled = !publicLoaded || !publicDirty || publicBusy; $("#btn-public-save").textContent = publicBusy ? "保存中…" : "保存公开资料"; };
    const focusRefresh = () => $("#btn-memory-refresh").focus();
    const metadata = (item) => {
      const origin = item.sourceSession === "ui" ? "由你编辑" : item.sourceSession.startsWith("local-") ? "来自本机对话" : item.sourceSession.startsWith("owner-") ? "来自 QQ" : "来源未记录";
      return new Date(item.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " · " + origin + (item.tags.length ? " · " + item.tags.join("、") : "");
    };
    function cancelConfirmation() { state.confirmation = null; render(); focusRefresh(); if (state.changed) load(); }
    function confirmBox(action) {
      const box = document.createElement("div"); box.className = "memory-confirm";
      const text = document.createElement("p"); text.className = "memory-confirm-question";
      text.textContent = action.kind === "clear" ? `清空「${names[action.scope]}」的 ${action.total} 条记忆？此操作不能撤销。` : "删除这条记忆？此操作不能撤销。";
      box.append(text);
      const item = action.kind === "forget" && state.items.find((r) => r.id === action.id);
      if (item) {
        const target = document.createElement("details"), summary = document.createElement("summary"), preview = document.createElement("span");
        target.className = "memory-text memory-confirm-target"; preview.className = "memory-preview"; preview.textContent = item.text; summary.title = "展开核对将删除的完整内容"; summary.append(preview); target.append(summary);
        const source = document.createElement("p"); source.className = "memory-meta"; source.textContent = names[action.scope] + " · " + metadata(item); box.append(target, source);
      }
      const note = document.createElement("p"); note.className = "hint"; note.textContent = "将开启新会话，旧聊天记录保留。";
      const actions = document.createElement("div"); actions.className = "btn-row";
      const confirm = button(state.busy ? "正在处理…" : action.kind === "clear" ? "确认清空" : "确认删除", () => mutate(action), "btn-secondary btn-sm danger-text");
      confirm.dataset.memoryConfirm = "true"; confirm.disabled = state.busy || state.stale;
      const cancel = button("取消", cancelConfirmation, "btn-ghost btn-sm"); cancel.dataset.memoryCancel = "true"; cancel.disabled = state.busy;
      actions.append(confirm, cancel); box.append(note, actions); return box;
    }
    function render() {
      const disabled = state.loading || state.busy;
      document.querySelectorAll("[data-memory-scope]").forEach((b) => { b.setAttribute("aria-pressed", String(b.dataset.memoryScope === state.scope)); b.disabled = state.busy; });
      $("#btn-memory-refresh").disabled = disabled;
      $("#btn-memory-clear").disabled = disabled || !state.loaded || state.stale || state.total === 0;
      $("#btn-memory-export").disabled = disabled;
      $("#btn-memory-prev").disabled = disabled || state.offset === 0 || !state.loaded;
      $("#btn-memory-next").disabled = disabled || state.offset + state.items.length >= state.total || !state.loaded;
      $("#memory-page").textContent = state.total ? `${Math.floor(state.offset / 100) + 1} / ${Math.ceil(state.total / 100)} 页` : "";
      $("#memory-count").textContent = state.loaded ? `${names[state.scope]} · 共 ${state.total} 条` : "";
      const hint = $("#memory-scope-hint"); hint.replaceChildren();
      hint.textContent = state.scope === "owner" ? "仅用于你与它的对话。" : state.scope === "owner_public" ? "由你编辑，可对外公开。" : "它的经历，不含你的私密记忆。";
      if (state.scope === "owner_public") hint.append(button("编辑公开资料", async () => { $('[data-page="persona"]').click(); await loadPublic(); $("#public-profile-text").scrollIntoView({ block: "center" }); $("#public-profile-text").focus(); }));
      const list = $("#memory-list"), scroll = list.scrollTop;
      const expanded = new Set([...list.querySelectorAll("details[open]")].map((d) => d.closest("[data-memory-id]").dataset.memoryId));
      list.setAttribute("aria-busy", String(state.loading)); list.replaceChildren();
      for (const item of state.items) {
        const row = document.createElement("div"); row.className = "memory-row"; row.dataset.memoryId = item.id;
        const main = document.createElement("div"); main.className = "memory-row-main";
        if (item.text.length > 90 || item.text.split("\n").length > 2) {
          const details = document.createElement("details"), summary = document.createElement("summary"), preview = document.createElement("span");
          details.className = "memory-text"; details.open = expanded.has(item.id); preview.textContent = item.text; preview.className = "memory-preview"; summary.append(preview); summary.title = "展开或收起全文"; details.append(summary); main.append(details);
        } else { const text = document.createElement("p"); text.className = "memory-text"; text.textContent = item.text; main.append(text); }
        const meta = document.createElement("p"); meta.className = "memory-meta";
        meta.textContent = metadata(item); main.append(meta);
        const remove = button("删除", () => { state.confirmation = { kind: "forget", scope: state.scope, id: item.id }; render(); $("[data-memory-confirm]").focus(); }, "btn-secondary btn-sm danger-text");
        remove.dataset.memoryDelete = item.id; remove.disabled = disabled || state.stale;
        row.append(main, remove);
        if (state.confirmation?.id === item.id) row.append(confirmBox(state.confirmation));
        list.append(row);
      }
      if (!state.items.length) { const empty = document.createElement("p"); empty.className = "hint memory-empty"; empty.textContent = state.loading ? "正在读取记忆…" : !state.loaded ? "还没有读取到记忆。" : state.scope === "diary" ? "日记将在后续版本开放。" : state.scope === "owner_public" ? "还没有公开资料，可到人格页填写。" : "还没有记忆，试着对它说「记住……」。"; list.append(empty); }
      list.scrollTop = scroll;
      if (state.confirmation?.kind === "clear") { const clear = document.createElement("div"); clear.id = "memory-clear-confirm"; clear.append(confirmBox(state.confirmation)); list.prepend(clear); }
      list.scrollTop = scroll;
    }
    async function load(offset = state.offset) {
      if (state.busy) return;
      const epoch = ++state.epoch, scope = state.scope;
      state.loading = true; state.changed = false; render(); message("正在读取记忆…");
      try {
        const result = await api.memoryList(scope, offset);
        if (epoch !== state.epoch) return;
        if (!result?.ok) throw new Error(result?.error);
        if (offset > 0 && offset >= result.data.total) { state.loading = false; return load(Math.max(0, Math.floor((result.data.total - 1) / 100) * 100)); }
        Object.assign(state, { items: result.data.items, total: result.data.total, offset, loaded: true, stale: false }); message();
      } catch (e) { if (epoch === state.epoch) { state.stale = true; message(errorText(e.message), true); } }
      finally { if (epoch === state.epoch) { state.loading = false; render(); } }
    }
    async function mutate(action) {
      if (state.busy || state.stale) return;
      state.busy = true; render(); message("正在处理…");
      try {
        const result = action.kind === "clear" ? await api.clearMemory(action.scope, action.total, true) : await api.forgetMemory(action.scope, action.id, true);
        if (!result?.ok) throw new Error(result?.error);
        state.confirmation = null; state.busy = false; await load(); message(action.kind === "clear" ? "本组记忆已清空。旧聊天记录保留。" : "记忆已删除。旧聊天记录保留。"); focusRefresh();
      } catch (e) { state.busy = false; if (["memory_changed", "memory_not_found"].includes(e.message)) { state.stale = true; state.changed = true; } render(); message(errorText(e.message), true); }
    }
    async function loadPublic() {
      if (publicDirty || publicBusy) return;
      const epoch = ++publicEpoch; $("#public-profile-text").disabled = !publicLoaded;
      publicMessage("正在读取公开资料…");
      try {
        const result = await api.getPublicProfile();
        if (epoch !== publicEpoch || publicDirty) return;
        if (!result?.ok) throw new Error(result?.error);
        publicSaved = result.data.text; $("#public-profile-text").value = publicSaved; publicLoaded = true;
        $("#public-profile-text").disabled = false; $("#btn-public-retry").classList.add("hidden"); publicMessage();
      } catch (e) { if (epoch === publicEpoch) { publicMessage(errorText(e.message), true); $("#btn-public-retry").classList.remove("hidden"); } }
      finally { updatePublicButton(); }
    }
    document.querySelectorAll("[data-memory-scope]").forEach((b) => b.addEventListener("click", () => {
      if (state.busy || state.scope === b.dataset.memoryScope) return;
      Object.assign(state, { scope: b.dataset.memoryScope, offset: 0, items: [], total: 0, loaded: false, stale: false, confirmation: null }); load(0);
    }));
    $("#btn-memory-refresh").addEventListener("click", () => { state.confirmation = null; load(); });
    $("#btn-memory-prev").addEventListener("click", () => { state.confirmation = null; load(Math.max(0, state.offset - 100)); });
    $("#btn-memory-next").addEventListener("click", () => { state.confirmation = null; load(state.offset + 100); });
    $("#btn-memory-clear").addEventListener("click", () => { state.confirmation = { kind: "clear", scope: state.scope, total: state.total }; render(); $("[data-memory-confirm]").focus(); });
    $("#btn-memory-export").addEventListener("click", async () => {
      state.busy = true; render(); message("正在准备导出…");
      try { const result = await api.exportMemory(); if (result?.canceled) message(); else if (result?.ok) message("全部记忆已导出。文件包含私密内容，请妥善保管。"); else throw new Error(result?.error); }
      catch (e) { message(errorText(e.message), true); }
      finally { state.busy = false; render(); }
    });
    $("#public-profile-text").addEventListener("input", () => { publicDirty = $("#public-profile-text").value !== publicSaved; publicMessage(publicDirty ? "尚未保存。" : ""); updatePublicButton(); });
    $("#btn-public-retry").addEventListener("click", loadPublic);
    $("#btn-public-save").addEventListener("click", async () => {
      const text = $("#public-profile-text").value; publicBusy = true; updatePublicButton(); publicMessage("正在保存…");
      try {
        const result = await api.savePublicProfile(text); if (!result?.ok) throw new Error(result?.error);
        publicSaved = text; publicDirty = $("#public-profile-text").value !== text; publicMessage(publicDirty ? "上一版已保存，当前修改尚未保存。" : "公开资料已保存，下一次检索起可用。");
      } catch (e) { publicMessage(errorText(e.message) + " 输入已保留。", true); }
      finally { publicBusy = false; updatePublicButton(); }
    });
    api.onMemoryChanged(() => {
      state.changed = true;
      if ($("#page-memory").classList.contains("active") && !state.confirmation && !state.busy) load();
      if ($("#page-persona").classList.contains("active") && !publicDirty && !publicBusy) loadPublic();
    });
    render();
    return { getReloadState: () => ({ busy: publicBusy || state.busy || state.loading, dirty: publicDirty, confirming: !!state.confirmation }), enter(name) {
      if (name === "memory") { state.confirmation = null; load(); if (!entered) { const page = $("#page-memory"); page.classList.add("memory-enter"); page.addEventListener("animationend", () => page.classList.remove("memory-enter"), { once: true }); entered = true; } }
      if (name === "persona") loadPublic();
    } };
  } };
})();
