# AGENTS.md

本文件为在本仓库中工作的 AI 编程助手提供指引。

## 回复语言

每次回答一律使用中文（简体）。代码、命令、文件路径、标识符保持原样。

## 先读这些

1. `docs/HANDOFF.md`：现在做到哪、环境坑、下一步动作
2. `docs/ARCHITECTURE.md`：架构的唯一参照（第 2 版：三实例）
3. `docs/ROADMAP.md`：开发顺序与每一步的验收标准
4. `docs/M2_DSH.md`：DSH 实测结论（协议、事件结构、隐私开关）
5. `DESIGN.md`：界面设计

## 项目简介

FatFish（肥鱼）：仅限 Windows、无需 Docker 的桌面客户端（Electron），是**住在用户电脑里的 AI 伙伴**。智能引擎是 DeepSeek Harness（DSH，锁定 `0.2.1rc2`）。一共有三种使用场景，每种对应一个独立的 DSH 实例：
- **远程陪伴**（对外实例，v1）：主人在 IM 平台私聊肥鱼的小号，只能聊天、记事、设提醒，**不能接触电脑**。第一个平台是 QQ（NapCat）。
- **本机助手**（本机实例，v1）：主人在肥鱼窗口里对话，可以使用全部工具，每次操作都要审批。
- **自由活动**（自主实例，v2）：伙伴用自己的账号去社交平台和视频平台活动，与主人的数据完全隔离。

模型费用由用户自己的 Key 承担（默认 DeepSeek，可以切换）。商业模式是买断，一次性交付【安装包 + 文档】，**不做补丁更新**；安装包可以随意传播，首次使用**必须联网激活**，激活后永久有效。文档和界面文案都是中文。交付物是 `FatFish-Setup-*.exe`。

代码树也可以在 macOS/Linux 上开发，但只有 Windows 能完整运行（非 Windows 平台会跳过 Win 后台启动器，状态为 `degraded` / `backend_win_only`；DSH 只 vendor 了 Windows exe）。

## 常用命令

项目没有测试框架，也没有 linter。验证方式是 e2e 脚本、冒烟脚本和手动运行。

```bash
# Core（伙伴核心）— app/core；需要 vendor/dsh（fetch-vendor）
npm install
npm run check                    # 对全部模块执行 node --check
DEEPSEEK_API_KEY=… npm run e2e   # 假 OneBot 后台 + 真 DSH 的端到端验收（仅 Windows，临时 AppData）
E2E_EXEC_PATH=<electron.exe> npm run e2e   # 用 Electron-as-Node 运行 Core，和打包后一致
FATFISH_APPDATA=/tmp/fatfish-dev node server.mjs   # 独立运行

# Electron UI — app/electron-ui
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install   # 直连 GitHub 会 TLS 失败
npm start
npm run smoke            # 对 Electron 外壳和 Core 执行 node --check；已安装 electron 时以 FATFISH_SMOKE=1 启动
npm run pack | dist      # 仅 Windows；dist → dist/FatFish-Setup-<ver>.exe（先在 app/core 里执行 npm install）

# 第三方 Windows 资源 → vendor/（napcat、node、dsh；写入带 SHA256 的 MANIFEST.txt；DSH 的哈希写死，不一致就退出）
./scripts/fetch-vendor.sh        # 或 scripts\fetch-vendor.ps1（在 Git Bash 里调用时要加 env -u PSModulePath）

# 调试 DSH profile（见 docs/HANDOFF.md §5）
node spikes/m2-dsh/pending.mjs   # 列出没有激活的插件行
```

## 架构摘要（细节见 ARCHITECTURE）

Electron 外壳 → fork **Core**（`app/core`，走 IPC）→ Core 的 InstanceManager 管理 **1～3 个 DSH 进程**（`vendor/dsh/*.exe --profile fatfish-<实例>`，stdio JSON-RPC，每个实例的 `DSH_HOME` 是 `%AppData%\FatFish\dsh\<实例>`）→ Channel 层接入 IM 平台（`channels/qq.mjs` → NapCat WS `:3001`）。自有 Cordis 插件（审批、记忆、提醒……）通过回环 HTTP 把请求交给 Core 处理，**数据范围由 Core 决定**。

**现状**：M3 第 1、2 步完成，但目前是**单实例**（profile `app/core/profile/`，`workspace-write` + 审批），主人只认 `config.owner_qq`（没有界面能设置它），所以真实渠道不会回复任何人。`app/shell/`（`:8787`）仍然会被启动，`app/bridge/` 已经不再启动，两者都要在 M3-C 删除。下一步是 M3-A（三实例框架 + 对外实例无工具）。

### Electron UI（`app/electron-ui`）

`main.js`（窗口、托盘、所有 `ipcMain.handle`）↔ `preload.js`（`contextBridge` → `window.fatfish`，每个 IPC 通道对应一行封装）↔ `renderer/`（纯 HTML/JS/CSS，没有框架）。**新增涉及主数据的功能，要同时修改 `main.js`、`preload.js`、`renderer.js` 三处。**`service-manager.js` 负责拉起后台和 Core：`getCore()` 读取 Core 上报的状态快照，`sendCore()` 下发命令。登录是应用内的 `<webview>` 打开 `http://127.0.0.1:6099/webui/`，**禁止**使用 `shell.openExternal` 或系统浏览器。后台启动器的 `.bat` 必须是 CRLF 换行（`.gitattributes` + `scripts/ensure-crlf*` 保证），否则 cmd 会立刻退出。

### 数据与路径

用户数据在 `%AppData%\FatFish\`（完整布局见 ARCHITECTURE §14），可以用 `FATFISH_APPDATA` 覆盖。开发和打包后的资源路径不同（仓库根目录 vs `process.resourcesPath`，见 `docs/ELECTRON.md` 和 `app/electron-ui/package.json` 的 `build.extraResources`）。

## 架构红线

- **按输入来源划分信任**：所有外部渠道的消息**只进对外实例**；对外实例**没有任何能接触本机的工具**（读写文件、执行命令、`web_fetch`、子代理、技能等，清单见 ARCHITECTURE §4.2），沙箱是 `read-only`，工作目录是空目录。**改动 profile 后，必须用录制代理实测请求体的 `tools[]` 与白名单一致**，不能只看配置。本机实例只接 Electron 的对话页。
- **能力不靠提示词约束**：「不许做什么」要通过「这个实例里没有对应工具」来保证。DSH 的权限按进程生效，隔离就必须用不同进程和不同的 `DSH_HOME`。
- **主人身份只认绑定表**（`owners`，通过配对码绑定，只认平台上报的账号），不认消息正文或提示词。主人信息可以写进提示词，但只用于对话内容。解除绑定只能在电脑上操作。
- **权限完全使用 DSH 自带的机制**，不自研。肥鱼只负责路由、审批转发和插件数据范围。
- **DSH 隐私与隔离开关**（所有实例共用）：关闭 `session-log-deepseek`、`plugin-package-inventory-deepseek`；OTel 设为 `DISABLED`；`skill-filesystem` 和 `agent-instructions` 不读取宿主机内容。不得重新打开，改完后要实测（`spikes/m2-dsh/run.mjs privacy`）。
- **rc2 的 SDK 没有 `approvalRequests` / `user-question/ask`**（那是 master 分支的功能），审批走自有插件。协议代码以 exe 的实际行为为准，不以 master 的文档为准。
- **自由活动（v2）里不能有任何属于主人的东西**：主人的文件、私密记忆、账号、本机网络都不能有（ARCHITECTURE §9）。
- **锁死版本，不升级**：DSH `0.2.1rc2`、NapCat、Node、`ws` 8.22.0、Electron 33.4.11、electron-builder 25.1.8。
- **许可证**：主进程和 Core 各自独立验签（Ed25519，离线），Core 验签不通过就不拉起 DSH。私钥只放在激活服务端，绝不入库。

## 容易踩坑的约定

- **面向用户的禁用词**：`docs/用户说明书.md`、`app/electron-ui`（包括注释和 toast）里不能出现 QQNT、NapCat、OneBot、肥鱼桥、Docker、DSH、DeepSeek Harness、Cordis，用 `docs/DEV.md` 的对照表替换。人设提示词和 UI 也不能出现模型厂商或上游框架的名称。内部文档不受这条限制。
- API Key 绝不完整记录到日志或回显。日志只记录元数据（时间、方向、长度、错误码），**不记录消息正文**（e2e 会检查）。
- 自有 Cordis 插件**绝不写 stdout**（stdout 是 JSON-RPC 通道）；任何异常都按「拒绝」或「空结果」处理。
- 手写的 `.ps1` 必须是 UTF-8 **带 BOM**（或纯 ASCII），否则 Windows PowerShell 5.1 会把中文解析错。
- 提交信息格式：`type(scope): 中文描述`（例如 `feat(core): …`、`fix(ui): …`）。
