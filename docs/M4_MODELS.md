# M4-9 模型切换：实现与验收边界

> 2026-10-26，当前共享工作区，未提交。代码、无窗口回归和少量真实兼容接口验收通过；原生设置表单仍待用户允许后验收。不是整个 M4 或 M5 完成。

## 1. 使用流程

设置页「模型」支持服务商、模型名称、密钥和显式「测试连接」。选「自定义接口」可填写地址与三种协议；容量和输出上限收在高级设置，默认值只是客户端声明值，不是探测到的服务商限额。服务商预设由 Core 返回，表单不重复维护端点。

- 默认仍为 `deepseek-official` / `deepseek-flash`，兼容旧 `secrets/deepseek_api_key`。
- 自定义支持 `openai-completions`、`openai-responses`、`anthropic-messages`。预设也通过明确声明的兼容路由运行，不依赖 SDK 不确定的模型目录。
- 不自动测试，不自动保存草稿。测试会产生费用；超时提示先查服务商调用记录，不鼓励重复提交。
- Key 留空只在相同服务商、协议和地址范围内复用。切换认证范围会清除尚未提交的输入，不能把旧 Key 偷带给新地址。
- 允许 HTTP 是为本机兼容服务保留入口，表单明确提示明文传输风险。URL 不允许账号、密码、查询参数、fragment 或控制字符。
- 模型设置变化后，两种 v1 实例下一句使用新模型上下文；旧展示记录保留，不发送前一个提供者的 SDK 聊天历史。新轮次仍会发送当前人格，以及实际检索得到的记忆，界面明确说明。

三实例是总体架构，v1 只有 external/local 两个真实实例。auto 留给 v2；不能为了勾选 M4-9 验收而提前引入自主实例。

## 2. 数据、安全与并发

`app/core/model-config.cjs` 是存储权威：

1. Key 写入随机版本文件 `secrets/model-<UUID>.key`，独占创建并 fsync；config 原子 rename 后才清理上一版 Key。
2. `config.model` 包含 route、generation 和不透明 keyRef，不包含完整 Key。提交失败保留原配置/原 Key，只清理本次未提交文件。
3. 公开 IPC 仅给 route、版本、是否已保存、部分尾号，不给 Key 或 keyRef。缺失/损坏的已选 Key 不回退到其他文件或环境 Key。
4. 草稿可带 `expectedGeneration`，旧表单保存和测试均在请求接口前拒绝。活跃本机/对外轮次、工作区切换或模型切换期间禁止改模型。
5. 主窗口顶层 frame 才可调用 model IPC；有效载荷有结构和长度上限。旧密钥入口也经 Core 保存当前路由，不再假成功写一个未使用的旧文件。

`model-service.mjs` 的连接测试使用独立临时 DSH_HOME、空工作区、固定测试人格和一句话。记忆/提醒插件关闭，实际请求 `tools=[]`；不读活跃聊天/人格/记忆，不持久化正常会话、不保存草稿。禁用自动重试，失败只停自己的测试进程。服务商返回文字不传给 UI，避免对方回显密钥。普通运行时动态补丁只有环境变量引用，不含 Key。

**M5 接入提醒：连接测试同样会拉起 DSH，许可证门禁必须覆盖它，不能只检查 InstanceManager。** 当前尚未实现激活，不宣称有许可证保护。

## 3. 无窗口验证

所有夹具只访问回环地址，Core 用 Electron-as-Node，不创建原生窗口。普通 Node 元素夹具不是浏览器/完整 DOM 验收。

| 检查 | 最终结果 | 主要覆盖 |
|---|---|---|
| `app/core` `model-check` | 57/57，连续三轮 | 原子存储失败关闭、旧 Key 兼容、旧版本拒绝、真实 Core 双实例切换、旧 SDK 历史不跨端点、三协议与默认连接测试、工具为零、401/500 无自动重试、超时、活跃轮次互斥、坏补丁恢复、日志不含内容/Key |
| `model-main-check` | 17/17，三轮；测试说明措辞修正后再复验 | 实际 Main/preload 的 Node VM、frame 鉴权、有效载荷、旧入口转发及乐观版本、Key 元数据、事件卸载 |
| `model-view-check` | 27/27，连续三轮 | 实际表单模块、脏草稿、认证范围、显式测试、busy、stale、失败保留、费用提示、脚本打包顺序 |
| `model-data-check` | 13/13，连续三轮 | 实际 Main/preload/表单/ServiceManager/Core/rc2，壳和元素为夹具；原子保存、独立测试、Core 通知、防重复、Key 回显防护、退出清理 |
| `model-protocol-check` | 三协议各一次成功 | 锁定 SDK 的真实流式解析、认证头、local 精确 21 项工具，不是手写 SDK 替身 |

证据根目录：`C:/Users/caidengfeng/.codex/visualizations/2026/10/24/01a16f76-c9b5-70c2-a81d-9b843307a01e/`。

- `fatfish-m4-model-final-core-1|2|3/model-report.json`
- `fatfish-m4-model-final-data-1|2|3/model-data-report.json`
- `fatfish-m4-model-final-protocol/model-probe-report.json`

执行：

```powershell
$env:E2E_EXEC_PATH = '<electron.exe 的绝对路径>'
npm.cmd --prefix app/core run model-check -- --evidence <绝对目录>
npm.cmd --prefix app/core run model-protocol-check -- --evidence <另一个绝对目录>
npm.cmd --prefix app/electron-ui run model-main-check
npm.cmd --prefix app/electron-ui run model-view-check
npm.cmd --prefix app/electron-ui run model-data-check -- --evidence <另一个绝对目录>
```

这些命令不打开窗口。`smoke` 和 `*-ui` 会打开窗口，用户未给新明确许可前禁止运行。

## 4. 本轮真实兼容接口：严格两次

此前用户已允许少量真实模型调用。本轮使用其独立测试配置的 Key，固定测试文字/人格、全新临时目录，无真实 QQ、无用户聊天/记忆/文件。`live-check.mjs` 需显式 opt-in `FATFISH_ALLOW_PAID_MODEL_CHECK=2`，代理硬限制最多两次转发，失败不自动重试。

- 真实上游 `https://api.deepseek.com/chat/completions`，模型 `deepseek-flash`，走 `llm-pi-ai` / `openai-completions` 自定义路由，而非原生官方 Messages 路由。
- external/local 各 1 次，HTTP 200、非空完整回复、没有工具调用，合计 **2 次**；不扩大到 50 轮。
- 实际请求严格 external 6/local 21 项工具；无 `dsh_session_log` / `dsh_plugin_packages`。
- 被测 exe SHA256：`f9ed01f241df37c50c702d81b6c226d576210b8f3947699735ca90285ea13365`。
- 证据 `fatfish-m4-model-compatible-live/live-report.json`。只存元数据和工具名，不存回复、提示词或 Key。

本轮没有重新做 OTLP sink/全连接采样，不能把这两次说成完整 M2 privacy 探针重跑。公共隐私补丁没有重新开启开关；新兼容请求字段和工具名单已直接录制验证。其他预设服务商没有各自 Key，未宣称逐家真实认证。

接口格式依据：[DeepSeek 官方兼容接入](https://api-docs.deepseek.com/quick_start/agent_integrations/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。Responses 夹具依据 [OpenAI 官方流式事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)。配置线索不替代锁定 rc2 的实际请求验收。

## 5. 保留门禁与下一步

- 原生设置表单、下拉、键盘焦点、缩放和布局未验收，不把 VM/元素夹具冒充 UI。
- M4-10 必须干净 Win10/只有 PowerShell 5.1；当前开发机不能代替。
- M4-11 的 50 轮真实抽样应另说明费用边界；现有少量调用许可不能无限扩张。
- M5 全范围保留：本地激活服务、主进程/Core 独立验签、激活 UI、可续基础向导/可选 QQ、代码保护与产物检查。
- 新 Key 版本文件已改变清理范围；M5/最终数据清理审计要处理当前旧清除逻辑的缺口，并遵守 Key/license 单独确认，不能误删实际用户数据。

### 同轮既有无窗口回归

Core check、contracts 38、身份 43、清理 12、错误 27、可选渠道 18、记忆 56、提醒调度 43、工作区 29、渠道启停、收件恢复 16、真实 60 秒提醒链路 23 均通过；Main 收件 15、工作区 VM 21、收件数据 41 通过。首次清理静态检查匹配到新测试说明里普通英文转发措辞，不是旧组件复活；修正新测试措辞后，清理 12 项与全回归继续通过，没有放宽静态门禁。最终又运行旧路径静态扫描、所有 renderer 的 node --check 与 git diff --check，通过；未运行 Electron smoke。
