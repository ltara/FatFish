# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库中工作时提供指引。

## 回复语言

每次回答一律使用中文（简体）。代码、命令、文件路径、标识符保持原样。

## 项目简介

FatFish（肥鱼）：仅限 Windows、无需 Docker 的桌面客户端（Electron），是**住在用户电脑里的 AI 伙伴**。它有固定人格、记得聊过的事，能替主人在电脑上做事。智能引擎是 DeepSeek Harness（DSH），主人从 IM 平台和它聊天。第一个平台是 QQ：肥鱼登录一个小号，**主人用自己的主号私聊小号**。模型费用由用户自己的 Key 承担（默认 DeepSeek，可以切换其他模型）。文档与界面文案均为中文。最终交付物为 `FatFish-Setup-*.exe`。

商业模式：买断，一次性交付【安装包 + 文档】，**不做补丁更新**，交付即固定版本。安装包可以随意传播，首次使用**必须联网激活**，激活后永久有效。

**架构以 `docs/ARCHITECTURE.md` 为准**（目标态、DSH 集成方案、权限模型、激活方案、里程碑）。当前代码仍是旧结构（bridge 直连 DeepSeek），正在按该文档的 M2→M6 迁移。

代码树在 macOS/Linux 上开发，但只有在 Windows 上才能完整运行；非 Windows 平台会跳过 Win 后台启动器（状态为 `degraded` / `backend_win_only`）。

## 常用命令

项目没有测试套件，也没有 linter。验证方式为冒烟脚本加手动运行。

```bash
# Electron UI（官方外壳）— app/electron-ui
npm install
npm start                # electron .
npm run smoke            # 对 main/preload/service-manager/renderer 执行 node --check，若已安装 electron 则以 FATFISH_SMOKE=1 启动
npm run pack             # electron-builder --dir（会先运行 ensure-crlf）
npm run dist             # 仅 Windows → dist/FatFish-Setup-<ver>.exe（nsis）

# Bridge（回复引擎，M3 后迁为 app/core）独立运行 — app/bridge
npm install && FATFISH_APPDATA=/tmp/fatfish-dev node server.mjs

# 本地设置服务独立运行 — app/shell（M3 删除）
node local-server.mjs    # 127.0.0.1:8787

# 将第三方 Windows 资源下载到 vendor/（会写入带 SHA256 的 vendor/MANIFEST.txt）
./scripts/fetch-vendor.sh        # 或 scripts\fetch-vendor.ps1
```

打包只走 Electron 的 `npm run dist` 路径（见 `docs/ELECTRON.md`），必须在 Windows 上运行。

没有按用例运行的工具：语法检查用 `node --check <file>`，Electron 启动检查用 `npm run smoke`。

## 架构

### 目标态（详见 `docs/ARCHITECTURE.md`）

Electron 外壳 → fork **Core**（`app/core`，由 bridge 演进而来，两者之间走 IPC）→ Core 拉起 **DSH runtime**（`vendor/dsh/` 中的官方单文件 exe，`dsh --profile` 自有 `fatfish` profile，通过 stdio 走按行分隔的 JSON-RPC）。Core 通过 **Channel 适配层**接入 IM 平台，QQ 是第一个实现（NapCat WS `:3001`）。DSH 负责人格、会话持久化、记忆、工具、权限审批和定时提醒，肥鱼不自研 Agent 能力。`DSH_HOME` = `%AppData%\FatFish\dsh\`。

### 当前代码

三个协同工作的本地进程，全部绑定 `127.0.0.1` 并使用 token 鉴权（绝不绑定 `0.0.0.0`）。`app/electron-ui/service-manager.js` 中的 `ServiceManager.startAll()` 按顺序启动它们，退出时 `stopAll()` 将其结束（依靠 `runtime/` 中的 PID 文件和子进程引用，Windows 上使用 `taskkill /T /F`）：

1. **本地设置服务** — `app/shell/local-server.mjs`（`:8787`），通过 `ELECTRON_RUN_AS_NODE=1` + `process.execPath` 运行，失败时回退到 `vendor/node/node.exe`。属于冗余组件，M3 删除（保存 Key 已由主进程直接写文件）。
2. **后台登录/WS 服务** — `vendor/napcat` 中的第三方 Win 启动器（`launcher-user.bat`/`launcher.bat`），提供登录页（`:6099`）和本地 WS（`:3001`）。不能以 Electron-as-Node 方式运行；需要用户已安装官方 QQ。`.bat` 文件必须使用 CRLF 换行（由 `.gitattributes` + `scripts/ensure-crlf*` 保证，`dist`/`pack` 会自动运行），否则 cmd 会立即退出。
3. **回复引擎** — `app/bridge/server.mjs` 连接 WS，调用 DeepSeek，从 AppData 读取配置/密钥/人设。`agent-adapter.mjs` 每条消息启动一次 `dsh headless`（零工具，默认关闭），属于旧方案，M3 由 `engine-host.mjs`（常驻 sdk profile）取代。

Electron UI（`app/electron-ui`）：`main.js`（窗口、托盘、所有 `ipcMain.handle` 处理器）↔ `preload.js`（`contextBridge` → `window.fatfish`，每个 IPC 通道一行封装）↔ `renderer/`（单窗口：首页 / 人设 / 功能 / 设置页面，风险确认、登录、首次设置等覆盖层；纯 HTML/JS/CSS，无框架）。新增涉及主数据的功能需要三处同时修改：`main.js` 中的处理器、`preload.js` 中的封装、`renderer.js` 中的调用。登录是应用内对 `http://127.0.0.1:6099/webui/` 的 `<webview>`；禁止使用 `shell.openExternal` 或系统浏览器。`login-api.js` 封装登录服务的 API；`persona-lib.js` 管理人设库（`personas.json`），应用某个人设时会将其写入 `persona.txt`，并通过 `runtime/persona_rev` 通知 bridge 重新加载。`runtime/outbound_paused` 是 bridge 检查的“暂停外发”标志。这两个文件标志在 M3 改为 IPC。

已知断层（M3 修复）：功能页的「记住聊过的话」「使用本机工具」开关只写进了 config，bridge 不读；首页「今日互动」没有数据源。

### 数据与路径

用户数据位于 `%AppData%\FatFish\`（`config.json`、`persona.txt`、`personas.json`、`secrets/deepseek_api_key`、`secrets/local_token`、`logs/`、`runtime/`；目标态新增 `license.json`、`dsh/`）。可用 `FATFISH_APPDATA` 覆盖根目录（bridge 与 Electron 均支持；非 Windows 下 bridge 回退到 `~/.fatfish`）。开发环境与打包后的资源路径不同（仓库根目录 vs `process.resourcesPath`；见 `docs/ELECTRON.md` 中的表格以及 `app/electron-ui/package.json` 中的 `build.extraResources`）。

## 架构红线

- **权限完全使用 DSH 自带的机制**（权限预设、审批策略、沙箱），不自研权限系统。肥鱼只决定「谁的消息能进入哪个 runtime」以及「审批请求转给谁」。
- **只有主人的消息能进入带工具的 runtime**。主人身份只认 NapCat 上报的 `user_id`，不认消息正文里的声明；主人 QQ 号只能在电脑端修改。v1 对其他人一律不回复。以后如果开放陪聊，必须单独起一个 runtime（独立的 `DSH_HOME` 子目录，`read-only` + `never`，无工具）。DSH 的权限按进程生效，不能只靠提示词隔离。
- **DSH 隐私与隔离开关**：`fatfish` profile 必须关闭 `session-log-deepseek`（默认会把会话日志附带上传给官方 API）和 `plugin-package-inventory-deepseek`（默认附带本机插件清单），把 OTel 遥测设为 `DISABLED`，并让 `skill-filesystem` / `agent-instructions` 不读取宿主机上的技能和 AGENTS.md。改动 profile 补丁时不得重新打开；改完后用 `spikes/m2-dsh` 的 `privacy` 场景重新实测（见 `docs/M2_DSH.md`）。
- **rc2 的 SDK 没有 `approvalRequests` / `user-question/ask`**（那是 master 分支的功能）。审批走自有 Cordis 插件 `fatfish-approval.mjs`。
- **锁死版本，不升级**：DSH `0.2.1rc2`、NapCat、Node、Electron 33.x、electron-builder 25.1.8 都必须锁定确切版本。交付后不发补丁，外部变化（模型下线等）要能通过设置里的配置规避。
- **许可证**：主进程和 Core 各自独立验签（Ed25519，离线），Core 验签不通过就不拉起 DSH。私钥只存在于激活服务端，绝不入库。

## 容易踩坑的约定

- **面向用户的禁用词**：`docs/用户说明书.md`、`app/electron-ui`（包括注释和 toast）中不得出现 QQNT、NapCat、OneBot、肥鱼桥、Docker、DSH、DeepSeek Harness、Cordis。请使用 `docs/DEV.md` 中的对照表（如 后台服务、智能回复引擎、登录窗口）。曾有提交为避免误检而改写了一条注释。人设提示词与 UI 也不得出现模型厂商或上游框架的名称。内部文档（`docs/DEV.md`、`docs/ARCHITECTURE.md` 等）不受此限制。
- API Key 绝不完整记录到日志或回显。日志只记录元数据（时间、方向、长度、错误码），**不记录消息正文**。
- 手写的 `.ps1` 文件必须是 UTF-8 **带 BOM**（或纯 ASCII），否则 Windows PowerShell 5.1 会错误解析中文。
- 提交信息格式为 `type(scope): 中文描述`（如 `feat(ui): …`、`fix(ui): …`）。
