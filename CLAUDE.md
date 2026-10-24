# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库中工作时提供指引。

## 回复语言

每次回答一律使用中文（简体）。代码、命令、文件路径、标识符保持原样。

## 项目简介

FatFish（肥鱼）：仅限 Windows、无需 Docker 的桌面客户端（Electron），在本地运行 QQ 私聊自动回复引擎，使用用户自己的 DeepSeek API Key。所有数据和密钥都留在本机。文档与界面文案均为中文。最终交付物为 `FatFish-Setup-*.exe`。

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

# Bridge（回复引擎）独立运行 — app/bridge
npm install && FATFISH_APPDATA=/tmp/fatfish-dev node server.mjs

# 本地设置服务独立运行 — app/shell
node local-server.mjs    # 127.0.0.1:8787

# 将第三方 Windows 资源下载到 vendor/（会写入带 SHA256 的 vendor/MANIFEST.txt）
./scripts/fetch-vendor.sh        # 或 scripts\fetch-vendor.ps1
```

打包只走 Electron 的 `npm run dist` 路径（见 `docs/ELECTRON.md`），必须在 Windows 上运行。

没有按用例运行的工具：语法检查用 `node --check <file>`，Electron 启动检查用 `npm run smoke`。

## 架构

三个协同工作的本地进程，全部绑定 `127.0.0.1` 并使用 token 鉴权（绝不绑定 `0.0.0.0`）。`app/electron-ui/service-manager.js` 中的 `ServiceManager.startAll()` 按顺序启动它们，退出时 `stopAll()` 将其结束（依靠 `runtime/` 中的 PID 文件和子进程引用，Windows 上使用 `taskkill /T /F`）：

1. **本地设置服务** — `app/shell/local-server.mjs`（`:8787`），通过 `ELECTRON_RUN_AS_NODE=1` + `process.execPath` 运行，失败时回退到 `vendor/node/node.exe`。
2. **后台登录/WS 服务** — `vendor/napcat` 中的第三方 Win 启动器（`launcher-user.bat`/`launcher.bat`），提供登录页（`:6099`）和本地 WS（`:3001`）。不能以 Electron-as-Node 方式运行；需要用户已安装官方 QQ。`.bat` 文件必须使用 CRLF 换行（由 `.gitattributes` + `scripts/ensure-crlf*` 保证，`dist`/`pack` 会自动运行），否则 cmd 会立即退出。
3. **回复引擎** — `app/bridge/server.mjs` 连接 WS，调用 DeepSeek，从 AppData 读取配置/密钥/人设。`agent-adapter.mjs` 是可选的、默认关闭的本地助手引擎，任何失败或超时都会回退到 DeepSeek 路径。

Electron UI（`app/electron-ui`）：`main.js`（窗口、托盘、所有 `ipcMain.handle` 处理器）↔ `preload.js`（`contextBridge` → `window.fatfish`，每个 IPC 通道一行封装）↔ `renderer/`（单窗口：状态 / 设置 / 登录页面，风险确认浮层；纯 HTML/JS/CSS，无框架）。新增涉及主数据的功能需要三处同时修改：`main.js` 中的处理器、`preload.js` 中的封装、`renderer.js` 中的调用。登录是应用内对 `http://127.0.0.1:6099/webui/` 的 `<webview>`；禁止使用 `shell.openExternal` 或系统浏览器。`login-api.js` 封装登录服务的 API；`persona-lib.js` 管理人设库（`personas.json`），应用某个人设时会将其写入 `persona.txt`，并通过 `runtime/persona_rev` 通知 bridge 重新加载。`runtime/outbound_paused` 是 bridge 检查的“暂停外发”标志。

### 数据与路径

用户数据位于 `%AppData%\FatFish\`（`config.json`、`persona.txt`、`personas.json`、`secrets/deepseek_api_key`、`secrets/local_token`、`logs/`、`runtime/`）。可用 `FATFISH_APPDATA` 覆盖根目录（bridge 与 Electron 均支持；非 Windows 下 bridge 回退到 `~/.fatfish`）。开发环境与打包后的资源路径不同（仓库根目录 vs `process.resourcesPath`；见 `docs/ELECTRON.md` 中的表格以及 `app/electron-ui/package.json` 中的 `build.extraResources`）。

## 容易踩坑的约定

- **面向用户的禁用词**：`docs/用户说明书.md`、`app/electron-ui`（包括注释和 toast）中不得出现 QQNT、NapCat、OneBot、肥鱼桥、Docker。请使用 `docs/DEV.md` 中的对照表（如 后台服务、智能回复引擎、登录窗口）。曾有提交为避免误检而改写了一条注释。人设提示词与 UI 也不得出现模型厂商或上游框架的名称。
- API Key 绝不完整记录到日志或回显。
- 手写的 `.ps1` 文件必须是 UTF-8 **带 BOM**（或纯 ASCII），否则 Windows PowerShell 5.1 会错误解析中文。
- Electron 固定在 33.x，electron-builder 固定在 25.1.8。
- 提交信息格式为 `type(scope): 中文描述`（如 `feat(ui): …`、`fix(ui): …`）。
