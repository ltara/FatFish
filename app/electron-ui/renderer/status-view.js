/** One metadata-only status policy shared by the home page and desktop tray. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.fatfishStatusView = factory();
})(typeof globalThis === "object" ? globalThis : this, function () {
  const errors = {
    invalid_key: ["密钥无效", "模型密钥未通过验证", "请到设置检查密钥，保存后发一句话验证。", "settings"],
    insufficient_balance: ["余额不足", "模型账户余额不足", "请检查你使用的模型账户。", "settings"],
    rate_limited: ["稍后重试", "模型暂时繁忙", "等一会儿后再发一句话。", "settings"],
    network: ["连接中断", "暂时连不上模型", "检查网络后再发一句话，成功后提示会自动消失。", "settings"],
    model_unavailable: ["模型不可用", "当前模型不可用", "请检查模型名称和接口设置。", "settings"],
    engine_crashed: ["正在恢复", "伙伴意外中断，正在恢复", "请稍候；恢复后再发一句话。", "settings"],
    turn_failed: ["回复中断", "上次回复未能完成", "稍后再发一句话；反复出现时检查设置。", "settings"],
    workspace_unavailable: ["需选择工作区", "本机工作区暂时不可用", "请到设置重新选择一个可用的本机文件夹。", "settings"],
    model_config_invalid: ["需检查模型", "模型设置暂时不可用", "请到设置里检查本机模型配置。", "settings"],
  };
  function build(s = {}) {
    if (s.license && !s.license.valid) return { label: "待激活", kind: "warn", issues: [], objectText: "伙伴 · 待激活", trayText: "肥鱼 · 待激活" };
    if (s.phase === "risk_confirmation_required") return { label: "待确认", kind: "warn", issues: [], objectText: "伙伴 · 待确认", trayText: "肥鱼 · 待确认" };
    const remote = s.qq_enabled !== false;
    const issues = [];
    const add = (id, text, hint, action = "settings") => issues.push({ id, text, hint, action, label: "去处理" });
    if (!s.core_running && s.phase !== "starting") add("core", "伙伴核心未启动", "请展开诊断，重新启动本机服务。");
    if (!s.key_saved) add("no_key", "还没填模型密钥", "自动回复需要本机密钥。");
    const error = s.last_turn_error?.error;
    if (errors[error] && s.key_saved) add(error, ...errors[error].slice(1));
    if (s.engine_state === "missing_runtime") add("runtime", "智能引擎没有装好", "请重新安装完整客户端。");
    if (s.engine_state === "workspace_unavailable" && error !== "workspace_unavailable") add("workspace", "本机工作区暂时不可用", "请到设置重新选择一个可用的本机文件夹。");
    if (s.engine_state === "model_config_invalid" && error !== "model_config_invalid") add("model_config", "模型设置暂时不可用", "请到设置里检查本机模型配置。");
    if ((s.engine_crash_count || 0) >= 3) add("repeated_crash", "伙伴连续多次意外中断", "请重新启动本机服务；仍反复中断时保留日志排查。");
    else if (s.engine_state === "crashed" && s.engine_error === "init_failed") add("init_failed", "伙伴启动失败", "请重新启动本机服务；仍失败时保留日志排查。");
    else if (s.engine_state === "crashed" && error !== "engine_crashed") add("crashed", "伙伴意外中断，正在恢复", "请稍候；恢复后会自动更新状态。");
    if (remote && !s.qq_online && s.phase !== "starting") add("qq_offline", "QQ 未连接", "扫码登录；已登录时检查网络或重新登录。", "login");
    if (remote && s.qq_version_mismatch) add("qq_version", "QQ 版本尚未验证", "当前版本与已验证版本不同，请查看登录提示。", "login");
    if (s.approval_pending) add("approval", "有一项操作等你确认", "核对操作内容后，选择是否允许。", "chat");
    let label = "在线", kind = "ok";
    if (s.phase === "starting") { label = "启动中"; kind = "info"; }
    else if (!s.core_running) { label = "未启动"; kind = "bad"; }
    else if (!s.key_saved || s.engine_state === "no_key") { label = "待设置密钥"; kind = "warn"; }
    else if (s.approval_pending) { label = "等你确认"; kind = "warn"; }
    else if ((s.engine_crash_count || 0) >= 3) { label = "反复中断"; kind = "bad"; }
    else if (s.engine_state === "crashed") { label = s.engine_error === "init_failed" ? "启动失败" : "正在恢复"; kind = "bad"; }
    else if (s.engine_state === "missing_runtime") { label = "需重新安装"; kind = "bad"; }
    else if (s.engine_state === "workspace_unavailable") { label = "需选择工作区"; kind = "warn"; }
    else if (s.engine_state === "model_config_invalid") { label = "需检查模型"; kind = "warn"; }
    else if (errors[error]) { label = errors[error][0]; kind = "warn"; }
    else if (s.engine_state && s.engine_state !== "ready" && !(!remote && ["idle", "stopped"].includes(s.engine_state))) { label = "准备中"; kind = "info"; }
    else if (remote && !s.qq_online) { label = "QQ 未连接"; kind = "warn"; }
    else if (remote && s.outbound_paused) { label = "已暂停"; kind = "warn"; }
    else if (!remote) label = "本机就绪";
    return { label, kind, issues, objectText: "伙伴 · " + label, trayText: "肥鱼 · " + label };
  }
  return { build };
});
