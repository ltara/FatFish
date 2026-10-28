# M4-7 本机工具裁剪与工作区

2026-10-25，Windows，当前工作区未提交。**代码与无窗口验证已完成，原生文件夹选择器、实际设置页布局与缩放验收仍未运行，不能标记整体 M4/M5 完成。** 用户明确禁止窗口操作，本轮未运行 Computer Use、Electron smoke 或 UI 自动操作。

## 工具契约

`tool-contract.cjs` 同时定义两实例的精确白名单；`contracts` 与 privacy 录制代理都比较实际请求体，不只看配置。

- external 仍为 6 项：`memory_save`、`memory_search`、`memory_forget`、`remind_create`、`remind_list`、`remind_delete`。
- local 在 Windows 下由原先实测的 31 项裁剪为 21 项：上述 6 项，加上 `edit`、`glob`、`grep`、`interrupt_agent`、`list_agents`、`pwsh`、`read`、`read_image`、`send_message`、`skill`、`subagent`、`subagent_fork`、`web_fetch`、`working_directory`、`write`。
- 移除目标/计划/todo、workflow、模型可见 job 管理与插件管理入口；goal driver 一并关闭。保留架构要求的 shell、文件、网页读取、技能和子代理；此项不是对所有保留工具逐个做功能认证。
- v1 不开放 `web_search`，也关闭相应搜索提供者。初次探测证实只关闭提供者仍会把 `web_search` 放进请求体，不能当作工具已裁掉；在 `tool-web.config` 设 `search:false, fetch:true` 后，rc2 录制请求严格只保留 `web_fetch`。配置线索参考[上游 tool-web 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/tool-web/README.md)，但该页是 master，最终结论来自本机锁定 rc2 的实测，不照搬其其他新 API。
- local 仍经内置 pre-execute ask / ApprovalService 逐次确认。此次不改权限机制，不给 external 增加任何宿主工具；隐私公共 overlay 不重新打开宿主技能、指令、会话日志、插件清单或遥测。

## 工作区配置与生命周期

- `workspace-config.cjs` 为 Core 拥有的配置读写：`config.local_workspace`，默认 `workspace/local`；`local_workspace_generation` 记录本机工作区上下文代号。同步严格读取、原子 fsync 替换，保存时重读并保留其他配置、主人绑定和渠道开关。没有依赖升级。
- 设置页复用现有设置块、路径文字、按钮和 hint。Main/preload/renderer 全链路接通：`workspace-get`、`workspace-choose`、`workspace-reset`；主窗口顶层 frame 才可使用。选择器只接受一个现有目录，路径来自原生选择结果，renderer 没有任意路径 setter。取消不写配置；并发选择、对话/审批中更改失败关闭。
- **工作区是默认操作目录，不是新的权限系统或不可跨越的沙箱。** `working_directory` 等保留工具仍服从运行时逐次审批；不再使用“工作区里可以自由读写”的旧文案。更改目录不会移动、复制或删除文件，也不会授予免审批权限。
- 路径保存为物理规范路径，支持中文和空格；拒绝相对路径、非目录、不可读写/不存在目录以及控制字符。Windows 只接受本地盘符路径，不对未知 UNC 地址做自动探测。选择时 junction 会解析成真实目标；保存后的路径若被替换为指向别处的 junction，下一次启动失败关闭。选定目录丢失时不自动创建、不悄悄回退默认目录。
- 更改前先校验，没有活跃 local turn 才停止本机进程；保存后下一次按需启动，不唤醒 external。相同路径是无写盘/无停机的 no-op。任何等待期间若绑定或渠道配置变化，保存重新读取当前配置，不覆盖旧快照。
- 更改后本机物理 SDK 会话使用新的工作区代号和路径摘要；不能 resume 旧目录的模型会话。逻辑对话 ID 与旧展示记录保留，记忆代号不被偷偷更改，对外会话不受影响。恢复默认也开始新的模型会话，不自动恢复旧目录的历史上下文。这不是安全擦除历史文件。
- Core IPC `workspace_ui` 只来自父进程，不注册为模型工具。路径、对话正文和 Key 不进入元数据日志。

## 无窗口验收

```bash
# app/core
E2E_EXEC_PATH=<electron.exe> npm run workspace-check -- --evidence <绝对目录>
npm run contracts
npm run check
# app/electron-ui：普通 Node，不运行 Electron
npm run workspace-main-check
```

- `workspace-check` **29/29，连续三轮**：配置校验/原子失败保留、坏 JSON 不覆盖、目录链接、更改不影响其他配置、真实 Core IPC、实际 rc2 相对文件写入、逐次审批、中文空格路径、切换后新进程与无旧 SDK 上下文、审批中拒绝切换、重启保留、路径丢失不调用模型、不回退、不重建、恢复默认不移动文件、精确 local 工具白名单与日志脱敏。文件只在唯一测试目录创建。
- `workspace-main-check` **21/21，连续三轮**：实际 Main IPC 在 Node VM 运行，只有原生壳/目录选择结果/Core 回复用夹具；验证窗口/子 frame 鉴权、取消不写、只用选择结果、不接受 renderer 路径、并发选择/活跃对话拒绝、保存失败，以及真实 preload 封装与 renderer 工作区函数的成功/取消/失败/过期读取抑制。**没有运行 Electron 或真实文件夹选择器，renderer 是函数级 VM 检查，不是完整 DOM/UI 联调。**
- 回归 `contracts` 38/38、`memory-check` 56/56、`identity-check` 43/43、`cleanup-check` 12/12、`optional-channel-check` 18/18、`error-check` 27/27、`reminder-check` 43/43、`inbox-runtime-check` 16/16，以及收件数据 41/41、Main 收件 VM 15/15，通过。语法与 `git diff --check` 通过；不执行 `smoke`。
- 裁剪后的 `reminder-runtime-check` 完整回归 **23/23**，`fast:false`，实际 60000ms 到期，迟到 822ms；仍使用生产收件数据适配器与回环模型/消息后台，不是实际窗口或 QQ 验收。

证据基目录：`C:/Users/caidengfeng/.codex/visualizations/2026/10/24/01a16f76-c9b5-70c2-a81d-9b843307a01e/`。

- 三轮工作区：`fatfish-m4-workspace-final-1|2|3/workspace-report.json`。
- Main/preload/renderer VM 与回归日志：`fatfish-m4-workspace-regression/`。
- 提醒完整一分钟回归：`fatfish-m4-workspace-reminder-regression/reminder-runtime-report.json`，须以实际报告结果为准；不把 `--fast` 结果混用。

## profile 变化后的真实隐私复验

沿用用户允许的少量真实调用，external/local 各 **2 次，共 4 次付费模型请求**。两实例均通过：`toolsMatch:true`，实际 tools 分别为 6/21 项，会话日志字段 0、插件清单字段 0、OTLP 0、采样未见额外引擎出站连接。`output_config` 仍是模型扩展参数，不是私有上传字段。代理请求体只在内存。

结果在 `fatfish-m4-workspace-privacy/external|local/results.jsonl`。只使用已配置的独立测试 Key、临时引擎目录和简单测试文字，不接真实 QQ、不操作实际用户文件。无窗口的其他检查模型请求全走回环，费用 0。以后再改 profile 仍须复验，不无限沿用本次结果。

## 未完成的门禁与下一步

1. 获新的明确允许后，验证真实文件夹选择器取消/成功、设置页可达性、960×640/800×560 与 200% 缩放。当前没有原生图，不能用 VM 代替截图。
2. M4-8 已完成锁定 SDK 的模块加载/工具目录探测，缺少服务与提供者，按路线图失败分支留 v1.x；没有操作真实应用，见 `M4_COMPUTER_USE.md`。
3. M4-9 模型切换、M4-10 干净 Win10/PowerShell 5.1、M4-11 50 轮人格抽样，以及 M5 仍保留原范围。M3-E、提醒、记忆修正后的真实界面/QQ 验收没有被本轮覆盖。
