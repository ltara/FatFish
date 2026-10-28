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

**现状**：M3 第 1、2 步及 **M3-A、M3-B 已完成**（当前工作区，尚未提交）。external/local 独立进程、DSH_HOME 与工作区，M3-A 当时对外实测 `tools[] = []`，M4 当前严格白名单为三项记忆（`memory_save`、`memory_search`、`memory_forget`）和三项提醒（`remind_create`、`remind_list`、`remind_delete`）；本机按需启动、空闲 10 分钟停止，审批走 gateway。身份只认 `owners` 绑定表，旧 `owner_qq` 已迁移并删除；设置页可用 6 位一次性配对码绑定、查看和解除。配对码不进模型；换码不重置尝试限制；解绑会拦住在途回复及排队消息。auto 留给 v2。**M3-C 也已完成**：旧设置服务、旧回复引擎、空功能开关已删除，暂停通过启动握手与 IPC 同步且跨重启保留；人格应用立即重载并保留会话。**M3-D 也已完成**：错误分类、首页真实统计、实时状态和原生托盘同步均通过无付费验收。**M4 本机独立入口、对话和审批已实现并通过本地验收**：新安装 QQ 默认关闭，基础流程不再强制扫码，启用渠道才单独确认账号风险；本机每次工具调用经运行时内置审批机制确认，含工作区写入。M4-1 记忆核心已验收（56 项连续 3 轮、两实例真实隐私复验），见 `docs/M4_MEMORY.md`；记忆页与公开资料编辑已接通，视觉修正后的最终复验尚未完成；用户按 Esc 停止界面走查后，未获新的明确允许前不得恢复界面操作，继续无窗口的代码/Core 工作。提醒 Core 与本机幂等收件链路已实现并完成无窗口验证（43 项调度、41 项收件、15 项 Main VM、16 项恢复/反压、23 项运行时真实 60 秒），Main/preload/renderer 已接线；实际窗口提醒/最小化提示与真实 QQ 验收仍待完成，当前没有 Windows 系统通知实现，见 `docs/M4_REMIND.md`；M4-7 工具裁剪与工作区已实现，29 项 Core 与 21 项 VM 检查各连续三轮、最新两实例实际工具/隐私复验通过；local 为严格 21 项工具，对外仍为 6 项，原生选择器/设置页仍待允许后验收，见 `docs/M4_WORKSPACE.md`。M4-8 已探测：锁定 SDK 无法加载界面操作服务/native/MCP 模块，13 项检查连续三轮，无桌面动作或付费；按路线图失败分支，v1 不启用，留 v1.x，见 `docs/M4_COMPUTER_USE.md`。M4-9 模型切换代码与后台已实现：Core 57、Main 17、表单 27、数据链路 13 各三轮；external/local 真实兼容接口各 1 次通过，原生模型表单待允许，见 `docs/M4_MODELS.md`。M4-10/11 仍待完成。M5-1 独立激活服务已完成真实本地 Wrangler/D1 39 项连续三轮，未部署；M5-2 独立验签/指纹与正常/独立模型测试门禁已接并完成无窗口三轮验证（Core 30、Main 10、客户端/Worker 14）；M5-3 表单已接，13 项元素检查三轮，原生复验待允许。正式信任锚未配置、失败关闭，测试只换隔离副本的公开锚，禁止加运行时跳过开关；M5-4/5 后续代码和隔离检查见下段；原生/正式安装包门禁仍待，见 `docs/M5_LICENSE.md`。M3-E 真实 QQ 验收单独保留。尚未连接真实 QQ 验收。

### Electron UI（`app/electron-ui`）

`main.js`（窗口、托盘、所有 `ipcMain.handle`）↔ `preload.js`（`contextBridge` → `window.fatfish`，每个 IPC 通道对应一行封装）↔ `renderer/`（本地构建的 React + shadcn/ui 呈现壳，既有控制器保留业务与安全逻辑）。界面源码为 `renderer-src/App.tsx` 与 `renderer-src/components/ui/`；`renderer/index.html` 是带激活锁的生成首帧，勿手改，修改后执行 `npm run build:ui`，`npm run check:ui` 做类型检查。**新增涉及主数据的功能，要同时修改 `main.js`、`preload.js`、`renderer.js` 三处。**`service-manager.js` 负责拉起后台和 Core：`getCore()` 读取 Core 上报的状态快照，`sendCore()` 下发命令。登录是应用内的 `<webview>` 打开 `http://127.0.0.1:6099/webui/`，**禁止**使用 `shell.openExternal` 或系统浏览器。后台启动器的 `.bat` 必须是 CRLF 换行（`.gitattributes` + `scripts/ensure-crlf*` 保证），否则 cmd 会立刻退出。

### 数据与路径

开发热更新（2026-10-27）：既有开发快捷方式与 `npm run dev` 启动时编译并监听界面源码，CSS 热替换，组件/控制器在无请求、审批与草稿时整页刷新；主进程/preload/Core/依赖改动须手动重开。只同步隔离代码副本，不监听用户数据、不自动重启后台。开发脚本不进正式包；74 项隔离检查已通过，原生生命周期仍由用户手动验证，见 `docs/DEVELOPMENT_HOT_RELOAD.md`。不得为验证热更新擅自启动现有窗口或调用模型。

用户数据在 `%AppData%\FatFish\`（完整布局见 ARCHITECTURE §14），可以用 `FATFISH_APPDATA` 覆盖。开发和打包后的资源路径不同（仓库根目录 vs `process.resourcesPath`，见 `docs/ELECTRON.md` 和 `app/electron-ui/package.json` 的 `build.extraResources`）。

M5-4 本机优先的可续首次设置代码/无窗口三轮通过：进度 27、控制器 24、实际挂载 9、模型表单 31、激活/告知 15、Main 门禁 12、实际 Core 数据链路 37。QQ 分支单独选择；真实成功凭据才完成，进度恢复不自动重测/重发，未同意基础告知不启动服务。M5-5 构建期公开锚注入、八模块混淆和 ASAR/PE 检查已接，隔离资源夹具 41 项三轮；没有正式密钥/部署/打包。原生 UI、真实 QQ、实际安装包和干净系统门禁仍待，见 `docs/M5_ONBOARDING.md`、`docs/M5_PROTECTION.md`。不是整个 M5 完成；继续保持用户的窗口禁令。

数据清理契约现已修复，默认保留 Key/许可证，独立确认、在途写互斥、安全停机、链接不追踪，成功退出、不自动重开；22/15/17/14 项无窗口各三轮，当前向导 37/保护 41 也重新三轮，见 `docs/M5_DATA_CLEAR.md`。原生清理控件仍未验收；不要操作普通试用窗口或实际用户数据。

人格就地交互和示例删除持久化现已 33/16/13 项无窗口三轮，见 `docs/M5_PERSONA.md`。**最新许可**：可以在独占临时目录生成本地未安装测试包，只检查资源/代码保护/后台，不运行界面、不安装发布、不使用正式密钥；普通试用窗口和实际用户数据仍不操作。正式安装程序/签名/部署/提交推送未获授权。

真实本地未安装包现已 22 项通过（仅 Node 模式后台，界面/安装/发布均未运行），见 `docs/M5_PACKAGE.md`。保护夹具已扩为 43 项，修正默认 dist 路径与 Windows 多级 ASAR 名称到本机 API 的转换。**最新模型许可**：最多 50 次真实出站模型请求，工具后续也计数；只在新临时上下文、不读历史/不连 QQ，限制输出、遇错停止、不自动付费重试。截至包验收付费为 0；随后人格抽样已实发 1/50 次，首请求未完整回复，按约定停止且未重试。测试代理压缩响应缺陷已离线修复，29 项和真实引擎 gzip 回环各三轮；不能断定首请求根因，M4-11 仍未通过。剩余 49 次须再次明确允许后才恢复，不重置账本。见 `docs/M4_PERSONA.md`。

关于页已补激活码末四位（非鉴权本机显示元数据，不存完整码）；32 项实际 Main/preload/about 无窗口检查三轮，最新真实未安装包 23 项通过。默认保留尾号与许可证，独立清激活才删除；原生界面仍待。见 `docs/M5_ACTIVATION_DISPLAY.md`、`docs/M5_COMPLETION_AUDIT.md`。

## 架构红线

开发激活补充（2026-10-26）：用户要求固定开发码，`npm run dev` 使用开发专用本机签发器与隔离代码副本，私钥只留开发服务端，正式信任模块和双重验签不改。脚本不进构建资源，不能加入打包后可用的开发绕过开关。新入口仅写代码、尚未运行验收；步骤见 `docs/DEVELOPMENT_ACTIVATION.md`。用户已要求界面验证由他手动操作，后续不得自动操作窗口；程序启停也仅限用户明确要求的范围。

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
