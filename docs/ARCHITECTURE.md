# 架构（内部，勿放入用户安装包 docs）

> 2026-10-25 定稿草案。本文是后续开发的唯一架构参照；与旧文档冲突时以本文为准。
> 内部文档，可以出现上游名称；面向用户的文案仍遵守 `CLAUDE.md` 禁用词。

## 1. 产品定义

**肥鱼是住在用户电脑里的 AI 伙伴**：有固定人格、记得聊过的事、能替主人在电脑上做事，主人从 IM 平台找它聊天。第一个平台是 QQ。

- **使用方式**：肥鱼登录一个 QQ 小号；**主人用自己的主号私聊小号**。
- **智能引擎**：DeepSeek Harness（下称 DSH，<https://github.com/deepseek-ai/deepseek-harness>，MIT）。人格、记忆、工具、权限、定时任务都交给 DSH，肥鱼不再自研 Agent 能力。
- **模型**：默认 DeepSeek，允许用户切换到其他模型（DSH 原生支持第三方 provider 和 OpenAI / Anthropic 兼容接口）。

### 商业模式

| 项 | 决定 |
|---|---|
| 交付 | 一次性交付【安装包 + 文档】，**不做补丁更新**，交付即固定版本 |
| 收费 | 买断（闲鱼），无订阅；模型费用由用户自己的 Key 承担 |
| 防盗 | 安装包可以随意传播；**首次使用必须联网激活**，激活后**永久有效** |
| 售后 | 换机解绑、激活问题、使用答疑 |

「不更新」决定了两件事：所有上游依赖必须**锁死确切版本**；不可控的外部变化（模型下线、QQ 升级）必须由用户自己通过**配置**规避，不能等发补丁。

## 2. 总体结构

```
┌──────────── Electron 外壳 app/electron-ui ───────────────────────────┐
│  窗口 / 托盘 / 激活 / 首次向导 / 审批弹窗 / 服务管理                  │
│        │ IPC（child_process fork 消息通道，取代 runtime/ 文件标志）    │
│  ┌─────▼──────────── 伙伴核心 Core（app/core，由 bridge 演进）─────┐  │
│  │ 许可证校验 → 身份路由（主人 / 其他人） → 会话映射 → 事件上报     │  │
│  │      │                                  ▲                       │  │
│  │      ▼                                  │ session.event          │  │
│  │ EngineHost ── stdio JSON-RPC ── DSH runtime（dsh --profile sdk）  │  │
│  │      │                                                          │  │
│  │      ▼                                                          │  │
│  │ Channel 适配层 ── QQ（NapCat WS :3001） │ 以后：其他 IM / 本地窗  │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
          │ 仅激活时联网（一次）
          ▼
   激活服务（Serverless，见 §6）
```

本机进程：

| 进程 | 来源 | 说明 |
|---|---|---|
| Electron 主进程 | `app/electron-ui` | 唯一 UI；管理以下子进程 |
| Core | `app/core`（原 `app/bridge`） | 以 `ELECTRON_RUN_AS_NODE=1` fork；与主进程走 IPC |
| DSH runtime | `vendor/dsh/*.exe` | 由 Core 拉起，stdio JSON-RPC；Core 独占 |
| 后台登录 / WS | `vendor/napcat` | 不变；`:6099` 登录页、`:3001` WS |

**删除**：`app/shell/local-server.mjs`（`:8787`），保存 Key 已由主进程直接写文件。`runtime/outbound_paused`、`runtime/persona_rev` 这类文件标志改为 IPC 消息。

## 3. DSH 集成方案（调研结论）

### 3.1 集成方式：SDK profile + stdio JSON-RPC

DSH 是一个 Cordis 插件框架，通过 **profile**（一组 bundle 叠加 `cordis.patch.yml`）组装成不同应用。shipped profile 有 `web`、`headless`、`sdk`、`sdk-minimal`、`acp`。

**选用 `dsh --profile sdk`**：它在 stdin/stdout 上提供**按行分隔的 JSON-RPC 2.0**（包 `@deepseek-ai/dsh-sdk-protocol`）。官方的 TS 客户端 `dsh-sdk-client` 和 Python SDK 都走这个协议。Core 直接实现协议的客户端（协议很小），或者 vendor `dsh-sdk-client`。

用到的方法：

| 方向 | 方法 | 用途 |
|---|---|---|
| C→S | `initialize` | 传 cwd、provider/model、`approvalRequests: true`、`capabilities.userQuestions: true` |
| C→S | `session/prompt` | 把一条 QQ 消息排进某个会话（返回入队回执，不是回复） |
| C→S | `session/resume` | 启动后恢复已持久化的会话 |
| C→S | `shutdown` | 退出 |
| S→C | `session.event` | 所有会话事件；从 `assistant/message` 取出回复文本发回 QQ |
| S→C | `session.status` | `running` / `idle`，用来驱动「对方正在输入」和超时处理 |
| — | 审批 | **rc2 的 SDK 不转发 `approval/request`**（M2 实测）。改由自有 Cordis 插件 `fatfish-approval.mjs` 应答运行时内部的 waterfall，经回环 HTTP 询问 Core（见 §4、`docs/M2_DSH.md` §1） |

`initialize.approvalRequests`、`user-question/ask` 是 master 分支的功能，锁定的 rc2 中没有，不要使用。

注意事项（来自协议文档）：没有 cancel 方法，要中止一轮只能结束进程；协议版本 `0.0.1`，没有兼容承诺，所以必须锁死版本；收到的通知覆盖所有会话，按 `sessionId` 过滤由客户端负责。

**不选的方案**：`headless`（每条消息冷启动一次，现在的 `agent-adapter.mjs` 就是这种，延迟高、拿不到审批回调）；`web`（是给浏览器用的 UI，HTTP API 不是公开契约）；`acp`（面向编辑器，语义不匹配）。

### 3.2 运行时分发：官方单文件 exe

PyPI 包 `deepseek-harness-runtime-bin` 的 Windows wheel（`0.2.1rc2`，`win_amd64`，83.9 MB）里有一个**单文件可执行程序** `deepseek-harness-sdk-runtime-win-x64.exe`，自带 Node 和全部依赖，附带 `-rg.exe` sidecar。运行时只要求设置 `DSH_HOME`，不需要系统 Node、npm 或 pnpm。

- `fetch-vendor` 已实现：下载 wheel 后校验写死的 SHA256（不一致则退出），把 exe、sidecar 和许可证解压到 `vendor/dsh/`，并写入 `MANIFEST.txt`。
- 安装包随附 DSH，**不再需要侧载**。`docs/M0_VOLUME.md` 里「npm 安装后约 710 MB」的结论作废。M2 实测：解压后 **278.6 MB**，冷启动约 0.8 s，常驻内存约 210 MB。
- `DSH_HOME` = `%AppData%\FatFish\dsh\`，与用户自己可能装的 DSH（`~/.dsh`）完全隔离。
- 锁定版本：`0.2.1rc2`。DSH 处于 developer preview，明确声明会有破坏性变更，这与「交付即固定」一致，**发版后不再升级**。
- 在 `THIRD_PARTY_NOTICES` 里附上 DSH 的 MIT 许可。

### 3.3 Profile 定制：`fatfish` profile

不直接用 shipped `sdk`，而是在 `DSH_HOME/profiles/` 下初始化**自有 profile**（以 `sdk` 为模板，用 `--from-default-profile sdk`），由安装或首次启动写入固定的 `cordis.patch.yml`。补丁要完成下列事项：

| 目的 | 处理 | 原因 |
|---|---|---|
| 人格 | `system-prompt`：`includeHarnessIdentity: false` + `personaPrefix` 设为当前人格（M2 已验证） | 默认是「coding agent」人设 |
| **关闭会话日志上传** | `session-log-deepseek.enabled: false` | 默认开启：调用官方 API 时会把会话日志（每次最多 8 MiB）附带上传，违背「聊天内容不出本机」（M2 抓包证实默认会上传） |
| **关闭插件清单上报** | `plugin-package-inventory-deepseek.enabled: false` | 默认会在每个请求里附带 `dsh_plugin_packages`（M2 新发现） |
| **关闭遥测** | `session-telemetry-otel.mode: DISABLED` | 默认是 `FEEDBACK_ONLY` |
| **隔离宿主机内容** | `skill-filesystem.includeDefaultRoots: false`；`agent-instructions.maxBytes: 0` | 默认会扫描用户电脑上的 `~/.agents`、`~/.dsh` 技能和 AGENTS.md；M2 中模型把开发机上的第三方技能当成了自己的能力 |
| 时区 | 插入 `dsh-time-context`，设置 `timeZone: Asia/Shanghai`，同时给子进程设置 `TZ` | sdk profile 默认不挂载；SDK 协议也不传时区 |
| 审批应答 | 插入 `./fatfish-approval.mjs` | rc2 的 SDK 不转发审批（见 §3.1） |
| 权限 | 采用 DSH 自带的权限预设与审批策略，**不自研**（见 §4） | 用户要求完全使用 DSH 的权限控制 |
| 长期记忆 | 按需挂一个 MCP 记忆服务（`dsh-mcp-client`，已打包在 exe 中） | DSH 自带的是会话持久化和自动压缩，跨会话的记忆需要 MCP |

profile 位于 `app/core/profile/`。`engine-host.mjs` 每次启动 runtime 时，都会把这个目录整份覆盖到 `$DSH_HOME/profiles/fatfish/`，因此用户层的补丁不会生效，这是有意为之。

匿名安装 ID（`identity/anonymous-user-id`）会附加在发往 DeepSeek 的请求上。它不包含身份信息，但要写进隐私说明。

### 3.4 会话映射

- **主人 = 一个长期会话** `owner-<QQ号>`。会话持久化在 `DSH_HOME/sessions`（JSONL），重启后用 `session/resume` 恢复。DSH 会自动压缩旧上下文，所以长期聊下去不会爆上下文。
- 「换人设」= 更新 profile 的系统提示词并重启 runtime（sdk profile 关闭了 HMR，配置只在启动时生效）。人格切换后会话是延续还是新开，在 M2 实测后决定。
- 主动消息：~~使用 DSH 自带的 schedule~~。**M2 实测在 rc2 的 sdk profile 中挂载不了**（依赖链会延伸到 Web Host，见 `docs/M2_DSH.md` §2）。**已决定（2026-10-25）：方案 A，肥鱼自写提醒插件**，和 `fatfish-approval.mjs` 用同一种机制：
  - 插件向模型暴露 `remind_create` / `remind_list` / `remind_delete` 三个工具，通过回环 HTTP 交给 Core 落盘（`%AppData%\FatFish\reminders.json`）。插件本身不保存状态。
  - Core 负责计时。到期后向原会话发送 `session/prompt`（例如「[提醒到期] 喝水」），伙伴按人格生成一句话，照常发到 QQ。
  - 「暂停」期间，到期的提醒照常触发，但不发出去（与 §4 一致）。Core 重启后会补发已过期的一次性提醒，周期提醒只补发最近一次。
  - 安排在 M4。

### 3.5 模型切换

DSH 的 provider 层原生支持：内置的第三方 provider（`openai`、`anthropic`、`moonshotai`、`zai` 等）和**自定义接口**（`openai-completions` / `openai-responses` / `anthropic-messages` + base URL + Key）。设置页提供「服务商 / 接口地址 / Key / 模型名」表单，写入 profile 补丁，`initialize` 时传入选定的 route。这也是「不更新」前提下应对模型下线的手段。

## 4. 身份与权限

**权限完全使用 DSH 自带的机制**：权限预设（`read-only` / `workspace-write` / `danger-full-access`）、审批策略（`ask` / `never`）、文件写入沙箱（Windows 下用 ACL restricted-token runner）。肥鱼只负责两件事：**谁的消息能进入哪个 runtime**，以及**审批请求转给谁**。

| 身份 | 处理 |
|---|---|
| **主人**（首次向导中绑定的 QQ 号） | 进入主 runtime：`workspace-write` + `ask`。审批请求由 `fatfish-approval` 插件转给 Core，再交给主人确认：电脑端弹窗（正文使用 `displayReason.zh`），或回到主人 QQ 由主人回复「同意 / 拒绝」；超时视为拒绝。注意：写入工作区和 `%TEMP%` 不会触发审批 |
| **其他任何人** | v1 **默认不回复**，不进入 DSH。如果以后开放陪聊，必须使用**独立的 runtime 实例**（单独的 `DSH_HOME` 子目录，`read-only` + `never`，移除工具），并且不和主人共享会话与记忆 |

原因：SDK 协议的权限是**按 runtime 进程**生效的，不能按会话设置。所以隔离必须通过进程和 `DSH_HOME` 来实现，不能只靠提示词。QQ 是任何人都能发消息的入口，陌生人消息一旦进了带工具的 runtime，就等于远程控制主人的电脑。

额外的约束：

- Core 只认 NapCat 上报的 `user_id`，不认消息正文里的「我是主人」。
- 主人 QQ 号的修改只能在电脑端界面进行。
- 「暂停」= Core 不再向 DSH 投递消息，并丢弃 DSH 的外发输出（定时提醒照样触发，但不发出去）。
- DSH 的 `SAFETY.md` 明确说明它**未经安全审计**。风险告知中要写明：「伙伴可以在你的电脑上执行操作，请只在你信任的电脑上使用」。

## 5. Channel 适配层

```ts
interface Channel {
  id: "qq" | string;
  start(): Promise<void>;
  onMessage(cb: (m: { from: string; text: string; images?: Img[]; raw: unknown }) => void): void;
  send(to: string, content: string | Block[]): Promise<void>;
  status(): "offline" | "connecting" | "online";
}
```

- **QQ**（`channels/qq.mjs`）：沿用现在 bridge 中的 OneBot WS 逻辑，只连 loopback 并带 token。v1 只处理私聊，群消息一律忽略。
- 长回复要分段发送；QQ 的图片 / 文件以后转成 DSH 的 `SdkEncodedImageBlock`。
- 以后加平台就是加一个 Channel 实现，Core 和 EngineHost 不用改。

## 6. 激活与许可证

### 流程

```
首次启动 → 输入激活码 → POST /activate { code, fingerprint }
         ← { license }  （服务端 Ed25519 签名）
         → 写 %AppData%\FatFish\license.json
之后每次启动 → 本地验签 + 比对指纹，不联网
```

- **激活码**：闲鱼发货时发放；每个码允许 N 台设备（建议 2 台）。
- **机器指纹**：`MachineGuid`（注册表）+ 系统盘卷序列号，经 SHA-256 加盐。只上传哈希，不上传明文。
- **许可证**：`{ code_hash, fingerprint, issued_at, edition }` + Ed25519 签名。公钥内置在客户端。**永久有效，没有过期时间，也不做定期复核**。
- **校验位置**：主进程启动时校验一次，**Core 启动时再独立校验一次**（不通过就不拉起 DSH）。两处的关键代码用 bytenode 编译或做混淆。目标是让破解成本高于售价，Electron 应用不可能做到绝对防破解。
- **售后解绑**：管理接口支持按激活码查看已绑定的设备和解绑；换机时由售后操作。

### 服务端

Cloudflare Workers + D1（或 KV），只有 `POST /activate` 和带鉴权的 `/admin/*` 两个接口，几乎零运维。私钥只存在服务端的 secret 中。

**风险**：激活服务就是这个产品的「寿命」。服务端一旦失效，新用户和换机用户都无法激活。已激活的用户不受影响，因为许可证是离线验签的。必须保证服务端长期可用（Serverless 免费额度足够），私钥要离线备份。

### 文案

「聊天内容与 Key 不出本机」改为：「聊天内容与 Key 只在你的电脑和你选择的模型服务商之间传输；激活时只上传激活码和设备标识的哈希」。

## 7. 本机数据

```
%AppData%\FatFish\
  config.json              Core 与 UI 共享配置（主人 QQ、渠道、模型 route、暂停状态）
  license.json             许可证
  personas.json            人设库
  secrets\                 model key、local_token
  dsh\                     DSH_HOME（profiles、sessions、settings、MCP 记忆数据）
  logs\                    只记录元数据（时间、方向、长度、错误码），不记录消息正文
  runtime\                 PID 文件
```

「清除本地数据」需要同时清掉 `dsh\sessions` 和记忆数据；「导出」需要包含人设和配置，不包含 Key 与许可证。

## 8. 「交付即固定」下的外部风险

| 风险 | 影响 | 应对 |
|---|---|---|
| **QQ 客户端自动升级后后台服务失效** | QQ 渠道断开，产品不可用；而且不能靠发补丁修复 | 说明书写明经过验证的 QQ 版本，并引导用户关闭 QQ 自动更新；启动时检测 QQ 版本，不匹配就在「需要你处理」中提示。**这是最大的风险** |
| 模型被下线或改名 | 回复失败 | §3.5 的模型切换；错误分级后提示用户在设置里换模型 |
| DSH 依赖的外部服务变化（如 web search） | 个别工具失效 | 不影响主流程；DSH 本身锁定版本，只在本地运行 |
| 激活服务失效 | 新用户无法激活 | §6 服务端长期托管，私钥备份 |
| QQ 封号 | 小号不可用 | 风险告知中写明只用小号 |

## 9. 目录调整（目标态）

```
app/
  electron-ui/     外壳（新增：activation.js、approval 弹窗、模型设置）
  core/            原 bridge
    server.mjs       入口：许可证校验 → 启动 EngineHost + Channels
    engine-host.mjs  DSH 进程、JSON-RPC、会话映射、审批转发
    router.mjs       身份判断、暂停、事件上报
    channels/qq.mjs
    profile/         fatfish profile 的 cordis.patch.yml 模板
  （删除 shell/）
activation-server/ Workers 源码（不进安装包）
vendor/
  napcat/ node/ dsh/
```

`agent-adapter.mjs`（每条消息启动一个 headless 进程，零工具）由 `engine-host.mjs` 取代。「直连 DeepSeek API」的降级路径保留到 M3 结束，然后删除，以 DSH 为唯一引擎。

## 10. 里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| **M2 DSH 技术验证**（Windows 实机） | 从 wheel 解出 exe；`fatfish` profile；Core 原型通过 JSON-RPC 收发 | ①多轮对话和重启后 `session/resume` 恢复上下文 ②替换人格提示词生效 ③一次需要审批的工具调用被 `approval/request` 截获 ④定时提醒到期后自动发起一轮 ⑤日志上传和遥测确认关闭（抓包验证）⑥实测安装体积、冷启动时间、常驻内存 |
| **M3 核心重构** | `app/core` 分层；QQ Channel；主人身份路由；删除 8787 和文件标志；IPC 上报 | 主人私聊有回复，非主人不回复，暂停有效，UI 的状态和统计都是真实数据 |
| **M4 伙伴能力** | 人设对接 profile；审批弹窗和 QQ 内审批；长期记忆（MCP）；提醒插件（§3.4）；工具裁剪；模型切换设置；记忆查看和清除 | 跨会话能记起事实；「1 分钟后提醒我喝水」能准时在 QQ 收到；切换到第三方模型后对话正常 |
| **M5 激活** | Workers 服务；客户端许可证；首次向导（激活 → Key / 模型 → 绑定主人 → 登录 QQ） | 未激活无法使用；换机走解绑流程；断网时已激活用户正常使用 |
| **M6 交付** | 打包、体积、用户说明书（隐私说明和风险告知更新）、售后手册、锁定的 QQ 版本说明 | 在干净的 Win10 / Win11 上从安装到第一次对话全流程通过 |

## 11. 待确认问题

M2 结果见 `docs/M2_DSH.md`。

1. ~~人格补丁的写法~~：已解决（§3.3）。
2. Windows 工具栈使用 `pwsh`（PowerShell 7）。开发机装有 PowerShell 7，所以**仍需要在只有 5.1 的干净 Win10 上实测**：如果需要 7，要考虑随附还是改用其他工具。
3. `computer-use` 包（操控应用）在 Windows 下的可用性，以及它的权限和审批行为（M4）。
4. ~~审批文案~~：已解决，`displayReason.zh` 可以直接用作弹窗正文。
5. MCP 记忆服务用哪一个；它需要的 Node 能不能复用 `vendor/node`（M4）。
6. ~~常驻内存~~：约 210 MB。Windows Defender 对单文件 exe 的误报情况仍需在干净系统上验证。
7. ~~主动提醒的实现方式~~：已决定采用方案 A，自写提醒插件（§3.4）。
8. **新增**：伙伴场景下默认的 25 个编程类工具要裁剪到什么程度（M4）。
