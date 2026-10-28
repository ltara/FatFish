/** Owner model settings. No auto-tests, raw provider replies, or saved key values in the page. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.fatfishModelView = factory();
})(typeof globalThis === "object" ? globalThis : this, function () {
  const providers = new Set(["deepseek-official", "openai", "anthropic", "moonshotai", "zai", "custom"]);
  const apis = ["openai-completions", "openai-responses", "anthropic-messages"];
  const fields = ["#model-provider", "#model-api", "#model-base-url", "#model-name", "#api-key", "#model-context", "#model-max-tokens"];
  const errorText = (code) => ({
    no_key: "请填写当前接口的密钥，不会自动使用其他接口的密钥。", model_key_invalid: "密钥格式不正确，请核对后重新填写。",
    invalid_key: "密钥未通过验证，请检查密钥和接口地址。", insufficient_balance: "模型账户余额不足，请检查账户后再试。",
    rate_limited: "接口暂时繁忙，请稍后再试。", network: "暂时连不上接口，请检查网络和地址后再试。",
    model_name_invalid: "模型名称不正确，请按服务商提供的名称填写。", model_unavailable: "当前模型不可用，请核对模型名称和接口设置。",
    model_endpoint_invalid: "接口地址不正确，请填写不含账号、密码或查询参数的网络地址。", model_api_invalid: "接口格式不正确，请按接口提供方说明选择。",
    model_capacity_invalid: "容量或输出上限不正确，请核对接口限制，输出上限不能超过容量。",
    model_save_failed: "没有保存成功，请检查本机数据是否可写。输入已保留。",
    model_busy: "它正在处理对话或操作，请等完成后再保存。", model_test_busy: "已有连接测试正在运行，请等待结果。",
    model_stale: "模型设置已经变化，当前输入已保留。请重新读取并核对后再操作。",
    model_test_timeout: "测试等待太久，已停止本机等待。可能已产生费用，请先检查服务商记录再重试。",
    model_test_invalid_response: "接口返回了异常内容，没有通过测试。请核对接口是否可信。", model_test_failed: "没有完成连接测试，请核对接口设置。输入已保留。",
    core_unavailable: "本机服务暂时不可用，请稍后重新读取。", core_timeout: "暂时没有收到确认，请先重新读取当前设置，不要重复提交。",
    config_invalid: "设置文件无法读取，请检查本机数据后重新读取。", model_config_invalid: "模型设置暂时不可读，请检查本机数据后重新读取。",
    missing_runtime: "本机运行组件不完整，请重新安装完整客户端。",
  }[code] || "操作未完成，请检查本机服务和模型设置。输入已保留。");
  const cleanURL = (value) => {
    if (typeof value !== "string" || /[\x00-\x20\x7f]/.test(value)) throw new Error("model_endpoint_invalid");
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error("model_endpoint_invalid");
    return u.href.replace(/\/+$/, "");
  };
  function create(api, { query = (s) => document.querySelector(s), changed = () => {}, tested = () => {}, stateChanged = () => {}, requireSavedForTest = false } = {}) {
    const $ = query, state = { saved: null, catalog: new Map(), loaded: false, loading: false, busy: null, active: false, stale: false, readVersion: 0, keyScope: null };
    const message = (text, kind = "") => { const el = $("#settings-msg"); el.textContent = text; el.className = "hint selectable" + (kind ? " " + kind : ""); };
    const route = () => {
      const provider = $("#model-provider").value, preset = state.catalog.get(provider), custom = provider === "custom";
      if (!providers.has(provider) || !custom && !preset) throw new Error("model_provider_invalid");
      const out = { provider, model: $("#model-name").value.trim(), api: custom ? $("#model-api").value : preset.api,
        baseURL: cleanURL(custom ? $("#model-base-url").value.trim() : preset.baseURL) };
      if (provider !== "deepseek-official") Object.assign(out, { contextWindow: Number($("#model-context").value), maxTokens: Number($("#model-max-tokens").value) });
      return out;
    };
    const scopeOf = (r) => JSON.stringify([r.provider, r.api, cleanURL(r.baseURL)]);
    const scope = () => { try { return scopeOf(route()); } catch { return null; } };
    const sameScope = () => !!state.saved && scope() !== null && scope() === scopeOf(state.saved);
    const dirty = () => {
      if (!state.saved) return false;
      if ($("#api-key").value.length) return true;
      try { const r = route(); return Object.keys(r).some((k) => r[k] !== state.saved[k]); } catch { return true; }
    };
    function validation() {
      if (!state.loaded) return "请先读取模型设置。";
      if (state.stale) return "设置已有变化，请重新读取后核对。";
      let r; try { r = route(); } catch { return "请填写有效的接口地址和接口格式。"; }
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(r.model)) return "请填写服务商提供的模型名称。";
      if (r.provider === "custom" && !apis.includes(r.api)) return "请选择接口格式。";
      if (r.provider !== "deepseek-official" && (!Number.isSafeInteger(r.contextWindow) || r.contextWindow < 1024 || r.contextWindow > 2147483647 || !Number.isSafeInteger(r.maxTokens) || r.maxTokens < 1 || r.maxTokens > r.contextWindow)) return "请核对容量和输出上限，输出上限不能超过容量。";
      const key = $("#api-key").value.trim();
      if (key && (key.length > 4096 || !/^[\x21-\x7e]+$/.test(key))) return "请核对密钥格式。";
      if (!key && (!sameScope() || !state.saved.key_saved)) return "请填写当前接口的密钥。";
      return "";
    }
    function render() {
      const blocked = !state.loaded || state.loading || !!state.busy, custom = $("#model-provider").value === "custom";
      $("#settings-model").setAttribute("aria-busy", String(state.loading || !!state.busy));
      fields.forEach((s) => { $(s).disabled = blocked; });
      $("#model-custom-fields").classList.toggle("hidden", !custom);
      $("#model-advanced").classList.toggle("hidden", $("#model-provider").value === "deepseek-official");
      const invalid = validation(), hasChanges = dirty();
      $("#btn-save-key").disabled = blocked || !!invalid || !hasChanges;
      $("#btn-model-test").disabled = blocked || !!invalid || requireSavedForTest && hasChanges;
      $("#btn-model-reload").disabled = state.loading || !!state.busy;
      $("#model-action-hint").textContent = state.busy ? state.busy === "test" ? "正在测试…" : "正在保存…" : state.loading ? "正在读取模型设置…" : invalid || (requireSavedForTest && hasChanges ? "请先保存，再测试连接。" : "");
      $("#model-reload-note").classList.toggle("hidden", !hasChanges);
      const keyHint = $("#key-mask-hint");
      keyHint.textContent = !$("#api-key").value && state.saved && sameScope() && state.saved.key_saved ?
        "已保存" + (state.saved.key_tail ? "（尾号 " + state.saved.key_tail + "）" : "") + "，留空沿用。" : "";
      let plain = false; try { plain = custom && new URL($("#model-base-url").value.trim()).protocol === "http:"; } catch { /* invalid input has its own hint */ }
      $("#model-http-warning").classList.toggle("hidden", !plain);
      try { stateChanged(); } catch { /* only optional control synchronization */ }
    }
    function apply(data) {
      if (!data || !providers.has(data.provider) || typeof data.model !== "string" || !Number.isSafeInteger(data.generation) || typeof data.key_saved !== "boolean" || typeof data.baseURL !== "string") throw new Error("model_config_invalid");
      cleanURL(data.baseURL);
      state.saved = { ...data }; state.loaded = true; state.stale = false;
      $("#model-provider").value = data.provider; $("#model-api").value = data.provider === "custom" ? data.api : "openai-completions";
      $("#model-base-url").value = data.provider === "custom" ? data.baseURL : ""; $("#model-name").value = data.model;
      $("#model-context").value = String(data.contextWindow ?? 65536); $("#model-max-tokens").value = String(data.maxTokens ?? 4096);
      $("#api-key").value = ""; state.keyScope = scope();
    }
    async function load(force = false) {
      if (state.loading || state.busy || !force && dirty()) return;
      const version = ++state.readVersion; state.loading = true; message("正在读取模型设置…"); render();
      try {
        const response = await api.getModel(); if (version !== state.readVersion) return;
        if (!response?.ok) throw new Error(response?.error || "core_unavailable");
        const data = response.data;
        if (!Array.isArray(data.presets) || !Array.isArray(data.apis) || !apis.every((v) => data.apis.includes(v))) throw new Error("model_config_invalid");
        const catalog = new Map(data.presets.map((p) => [p.provider, p]));
        if ([...providers].filter((p) => p !== "custom").some((p) => !catalog.has(p))) throw new Error("model_config_invalid");
        state.catalog = catalog; apply(data); message("");
      } catch (e) { if (version === state.readVersion) message(errorText(e.message), "err"); }
      finally { if (version === state.readVersion) { state.loading = false; render(); } }
    }
    async function operate(op) {
      if (state.loading || state.busy) return;
      if (op === "test" && requireSavedForTest && dirty()) { message("请先保存，再测试已保存的设置。", "err"); return; }
      const invalid = validation(); if (invalid) { message(invalid, "err"); return; }
      if (op === "save" && !dirty()) return;
      const args = { ...route(), key: $("#api-key").value.trim(), expectedGeneration: state.saved.generation };
      state.busy = op; ++state.readVersion; message(op === "test" ? "正在测试连接…" : "正在保存…"); render();
      try {
        const response = await (op === "test" ? api.testModel(args) : api.saveModel(args));
        if (!response?.ok) throw new Error(response?.error || "core_unavailable");
        if (op === "save") { apply(response.data); message(response.data.changed ? "已保存。下一句使用新设置，旧聊天记录保留。" : "设置没有更改。", "ok"); try { changed(); } catch { /* state is already committed */ } }
        else {
          if (!response.data?.connected) throw new Error("model_test_invalid_response");
          if (response.data.onboarding_saved === false) message("连接正常，但设置进度未保存。请修复本机数据后重新读取，不要重复测试。", "err");
          else if (response.data.onboarding_model_ready === false) { state.stale = true; message("测试已完成，但当前设置已变化。请重新读取并核对，不会自动重测。", "err"); }
          else message(dirty() ? "连接正常。当前修改尚未保存。" : "连接正常。", "ok");
          try { tested(response.data); } catch { /* test already completed */ }
        }
      } catch (e) { if (e.message === "model_stale") state.stale = true; message(errorText(e.message), "err"); }
      finally { state.busy = null; render(); }
    }
    function edit(providerChanged = false, keyEdited = false) {
      if (state.loading || state.busy) return;
      if (providerChanged) {
        const preset = state.catalog.get($("#model-provider").value);
        $("#model-api").value = "openai-completions"; $("#model-base-url").value = ""; $("#model-name").value = preset?.model || "";
        $("#model-context").value = "65536"; $("#model-max-tokens").value = "4096";
      }
      const nextScope = scope(), clear = $("#api-key").value && !keyEdited && (providerChanged || state.keyScope !== nextScope);
      if (clear) $("#api-key").value = "";
      if (keyEdited || providerChanged || clear) state.keyScope = nextScope;
      message(clear ? "接口已更改，请重新填写对应密钥。" : state.stale ? errorText("model_stale") : ""); render();
    }
    let unlisten = null;
    function wire() {
      $("#model-provider").addEventListener("change", () => edit(true));
      fields.filter((s) => s !== "#model-provider").forEach((s) => $(s).addEventListener(s === "#model-api" ? "change" : "input", () => edit(false, s === "#api-key")));
      $("#btn-save-key").addEventListener("click", () => operate("save")); $("#btn-model-test").addEventListener("click", () => operate("test")); $("#btn-model-reload").addEventListener("click", () => load(true));
      unlisten = api.onModelChanged(() => {
        if (state.busy || state.loading) return;
        if (dirty()) { state.stale = true; message(errorText("model_stale")); render(); }
        else if (state.active) load();
      }); render();
    }
    return { wire, isDirty: dirty, isBusy: () => state.loading || !!state.busy, enter: (page) => { state.active = page === "settings"; if (state.active) load(); }, reload: () => load(true), save: () => operate("save"), test: () => operate("test"), dispose: () => { unlisten?.(); ++state.readVersion; } };
  }
  return { create };
});
