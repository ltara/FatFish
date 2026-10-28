# 开发说明（内部，勿放入用户安装包 docs）

## 组件映射（对外话术）

| 内部 | 用户说明书说法 |
|------|----------------|
| QQNT | QQ（官方客户端，安装向导会检测） |
| NapCat | 客户端后台服务 |
| Core / DSH / DeepSeek Harness / Cordis | 伙伴核心 / 智能引擎 |
| OneBot | （不出现） |
| WebUI :6099 | 「登录窗口」 |
| Docker | （不出现；本交付免 Docker） |


## 桌面壳（Electron — 正式 UI）

> 正式 UI：`app/electron-ui/`（单窗口：状态 / 设置 / 登录）。详见 `docs/ELECTRON.md`。

- 对外窗口标题：「肥鱼」
- 登录：应用内原生二维码界面；禁止系统浏览器 / `shell.openExternal`

## 端口约定（仅 127.0.0.1）

- 内部 WS：默认 `127.0.0.1:3001`（可配置，`config.json` → `onebot_url`）
- 登录窗口：`127.0.0.1:6099`
- 插件网关：Core 分配随机回环端口，每实例独立 token
- 一律 Token；禁止 `0.0.0.0`

## 本机数据

```
%AppData%\FatFish\          # 开发可用环境变量 FATFISH_APPDATA 覆盖
  config.json
  license.json             # Main/Core 各自独立验签
  onboarding.json          # Main 首次设置进度，无消息正文/Key/原始账号
  persona.txt
  personas.json
  dsh\external\
  dsh\local\
  memory\owner.jsonl
  memory\owner_public.jsonl
  memory\diary.jsonl
  memory\context-generation.json # 删除后不恢复旧模型上下文
  reminders.json            # 计划、可信来源/最近渠道与发送 outbox
  inbox\reminders.json      # Main 的展示消息与去重高水位；不送进本机模型
  secrets\model-<UUID>.key # config.model.keyRef 指向当前版本；完整 Key 不进 config
  secrets\deepseek_api_key # 仅旧默认配置兼容
  secrets\local_token
  logs\
  runtime\*.pid
  runtime\outbound_paused   # 仅持久化；Core 初始握手后由 IPC 更新
```

## fetch-vendor

```bash
# Linux 箱（下载 Win 资产）
./scripts/fetch-vendor.sh

# Windows
powershell -ExecutionPolicy Bypass -File scripts\fetch-vendor.ps1
```

默认拉取：

- NapCat `v4.18.41` → `NapCat.Shell.zip`（需用户自装官方 QQ）
- Node `v20.20.2` win-x64 便携包
- DSH `0.2.1rc2` Windows SDK runtime（哈希锁定，禁止升级）

产物：`vendor/napcat/`、`vendor/node/`、`vendor/dsh/`、`vendor/MANIFEST.txt`（含 SHA256）。二进制 gitignore。

可选覆盖：`NAPCAT_VERSION`、`NODE_VERSION` 环境变量。

## 伙伴核心

```bash
cd app/core && npm install && npm start
# 或: FATFISH_APPDATA=/tmp/fatfish-dev node server.mjs
```

独立启动无审批 UI，审批一律拒绝；日常使用请启动 Electron。身份仅认 `config.owners`，默认空表不回复任何人。

## 打包流水线

见 `docs/ELECTRON.md`：

1. `scripts/fetch-vendor.ps1`（或 `.sh`）
2. `cd app/core && npm install`
3. 先按 `M5_PROTECTION.md` 安装独立 `scripts/release` 锁定工具并准备仓库外的公开配置；缺配置会在 beforePack 失败，不能产出默认未保护安装包。
4. 获得打包授权后，设置仅供构建读取的 `FATFISH_RELEASE_CONFIG=<公开配置绝对路径>`，`cd app/electron-ui && npm run dist` → `dist/FatFish-Setup-<ver>.exe`（**须在 Windows 上执行**）

## 与 MVP 关系

`/workspace/fatfish-mvp` 为历史验证原型；本仓库为正式 Win 交付路径，运行链为 Electron → Core → 分实例引擎。

## Windows PowerShell 编码
自研 `.ps1` 须 **UTF-8 with BOM**（或纯 ASCII 文案），避免 Win PS5.1 中文系统解析失败。

## 状态验收

`app/core` 执行 `npm run error-check`；`app/electron-ui` 执行 `npm run status-ui -- --evidence <绝对目录>`。后者会短暂创建真实窗口和原生托盘，但消息与模型只访问回环夹具，不接真实账号、不付费。实测结构见 `M3_STATUS.md`。

## 本机与可选渠道验收

`app/core` 的 `npm run optional-channel-check` 验证不依赖 QQ；`app/electron-ui` 的 `npm run local-ui -- --native-tray --evidence <绝对目录>` 验证真实本机工具审批、聊天与可选渠道。只用唯一临时目录和回环模型，不付费。正常软件首次启动不要求扫码，QQ 在设置中按需启用。详见 M4_LOCAL.md。

## 提醒无窗口验收

在 `app/electron-ui` 执行 `npm run inbox-check`（生产数据/控制器与 preload VM）和 `npm run inbox-main-check`（实际 Main IPC + 夹具壳）；两者仅普通 Node，不启动 Electron。在 `app/core` 执行 `E2E_EXEC_PATH=<electron.exe> npm run inbox-runtime-check -- --evidence <绝对目录>` 验证真实 Core 下的握手、ACK 丢失、磁盘损坏恢复与满箱反压，模型只用回环夹具。

`reminder-runtime-check` 不加 `--fast` 时实际等待 60 秒，现使用生产收件数据/控制器；`--fast` 仅 5 秒诊断，不能代替一分钟验收。以上均不证明真实窗口/QQ 可见。用户当前禁止窗口操作，不执行 `smoke`、`*-ui` 或 Computer Use；后续须获新的明确允许。详见 `M4_REMIND.md`。

## 工作区无窗口验收

`app/core`：`E2E_EXEC_PATH=<electron.exe> npm run workspace-check -- --evidence <绝对目录>`；`app/electron-ui`：`npm run workspace-main-check`。前者使用真实 Core/运行时和临时目录，后者是实际 Main/preload 与 renderer 函数的 Node VM，不启动 Electron 或原生选择器。模型仅回环夹具，不付费。配置字段是 `local_workspace` / `local_workspace_generation`，只能 Core 写；更改不移动文件，会换新的本机模型上下文，正在对话/审批时拒绝。详见 `M4_WORKSPACE.md`。

## 模型设置无窗口验证（M4-9）

Core 的 `npm run model-check` / `model-protocol-check` 使用真实锁定运行时和回环模型；Electron 目录的 `model-main-check` / `model-view-check` / `model-data-check` 使用 Node VM/元素夹具，不打开原生窗口。不等于界面布局验收。版本化 Key、认证范围、原子保存与实际两次兼容接口证据见 `M4_MODELS.md`。

`spikes/m4-models/live-check.mjs` 是单独付费探测，必须显式授权、通过环境注入 Key 和 `FATFISH_ALLOW_PAID_MODEL_CHECK=2`，代理最多转发两次到固定上游；不会由 check/smoke 自动运行。不要把旧测试目录里的 Key 输出到命令记录。

## 许可证开发验证（M5-2/3）

源码 `license-trust.cjs` 默认未配置，普通 Main/Core 启动失败关闭是预期行为。不得为方便测试添加生产环境的验签跳过开关。`license-check` / `license-main-check` / `activation-view-check` / 激活服务 `test:client` 都无窗口；通过隔离源码副本的公开测试锚和一次性内存私钥验证，详见 `M5_LICENSE.md`。既有 Core/VM/待运行 UI 测试已接相同签名夹具；不能把历史 UI 通过套到当前激活版。原生 UI 与 smoke 当前仍禁止运行。


## 首次向导与构建保护（M5-4/5）

向导的 store/view/wiring/model-data 检查不打开窗口；`onboarding-data-check` 是实际 Core/rc2 加回环 QQ/模型，详见 `M5_ONBOARDING.md`。独立构建工具 `scripts/release` 的 `npm test` 创建临时 ASAR/最小 PE 资源夹具，以 Electron-as-Node 检查，不调用 builder、不开窗口、不做安装包。公开信任锚注入、41 项三轮与未来正式构建说明见 `M5_PROTECTION.md`。当前未获窗口/正式打包许可，不运行 smoke、*-ui、pack 或 dist。


## 数据清理无窗口验证

Electron 目录的 `data-clear-check` / `data-clear-main-check` / `data-clear-view-check` / `data-clear-runtime-check` 使用唯一临时目录。最后一项跑真实 Core/SDK，并用隐藏 Win PowerShell 读取本测试进程状态，不运行桌面界面或真实渠道。默认保留 Key 与许可证、不碰工作区文件；多文件删除不是整批回滚事务，失败不得声称已全部清空。完整范围/证据见 M5_DATA_CLEAR.md。


## 人格就地交互与一次性示例迁移

`persona-actions-check` / `persona-store-check` / `persona-data-check` 分别用普通元素、真实临时文件/新 Node 进程和实际 Main VM 验证，均无窗口。新版人格库以 `samplesVersion` 标记示例迁移，读取不能补回用户删除。证据和边界见 M5_PERSONA.md。用户最新仅允许在临时隔离源码中构建本地未安装包并跑后台检查，不授权普通窗口/原生 UI/安装发布或正式私钥。


## 实际本地未安装测试包（已获单独许可）

独立 `scripts/release/package-fixture.cjs` / `package-check.cjs` 必须显式 `--allow-local-package --evidence <绝对目录>`；仅隔离临时源码、清洁 ZIP、测试公钥，禁签名自动发现和发布。后台执行前只读验证 RunAsNode fuse，并强制 ELECTRON_RUN_AS_NODE=1。不是 GUI/安装/发布授权，正式私钥不能传入。当前实际产物 22 项及 Windows ASAR 修复见 M5_PACKAGE.md；不在普通工作区或实际用户数据上运行。

## 关于页激活码末四位

开发启动更新（2026-10-26）：`npm run dev` 现指向固定开发码入口，不再直接等同 `npm start`。只向复制客户端注入开发公钥，正式源码验签不变；默认独立数据，也可显式沿用现有开发目录。本机日常使用可直接双击仓库根目录 `肥鱼（开发版）.lnk`，不需要手动命令；换机器用 `scripts/create-development-shortcut.ps1` 生成本机快捷方式。详见 `DEVELOPMENT_ACTIVATION.md`。本轮只创建代码与快捷方式文件，未启动或验证新入口，按用户要求交由他手动执行；不得自行重开窗口、试聊或恢复付费测试。

`npm.cmd --prefix app/electron-ui run activation-display-check -- --evidence <绝对目录>` 为无窗口检查：本地签名响应、实际 Main/preload 和 renderer 的 about 函数，32 项三轮。`activation-display.json` 仅含原码末四位/许可证字节哈希，是非鉴权显示元数据，不能把哈希尾部当原码尾号。默认保留，独立清激活才删除。详见 M5_ACTIVATION_DISPLAY.md；最新真实未安装包见 M5_PACKAGE.md（23 项），不要运行 smoke 或图形界面。
