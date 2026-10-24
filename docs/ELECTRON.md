# Electron 桌面壳（正式入口）

目标平台：**Windows 10/11**（Win-only）。箱上 Linux 仅用于 `npm install` / 语法与 smoke；GUI 与后台启动器须在 Windows 跑。


## 目录

```
app/electron-ui/
  main.js                 # 主进程：窗口、IPC、本机 Key、调用 service-manager
  service-manager.js      # 本机服务 startAll / stopAll / getState
  preload.js              # contextBridge → window.fatfish
  renderer/               # 状态 / 设置 / 登录 + 风险遮罩
  package.json            # electron 钉 33.x；extraResources；scripts
```

窗口标题：**肥鱼**。侧栏三页：状态、设置、登录。登录使用 **`<webview>` 内嵌** `http://127.0.0.1:6099/webui/`，**禁止** `shell.openExternal` / 系统浏览器。

## 自动启停（进程树）

开 App（非 smoke）时 `ServiceManager.startAll()` 依次拉起：

1. **本机设置服务** — `shell/local-server.mjs`（默认 `127.0.0.1:8787`）  
   用 `ELECTRON_RUN_AS_NODE=1` + `process.execPath` 跑；失败再回退 `vendor/node/node.exe`。
2. **后台登录服务** — `vendor/napcat` 下 **Win 自带启动器**（`launcher-user.bat` / `launcher.bat`）  
   **禁止** Electron-as-Node；仅 Windows。提供登录页（约 `6099`）与本机 WS（约 `3001`）。
3. **伙伴核心 Core** — `core/server.mjs`，以 `child_process.fork` + `ELECTRON_RUN_AS_NODE` 启动，**带 IPC 通道**（协议见文件头注释）。Core 再拉起 `vendor/dsh` 里的智能引擎，并连接本机 WS。日志写到 `logs/core.log`，只记录元数据。

关窗口 / `before-quit` / 退出：`stopAll()` 先通过 IPC 让 Core 正常关闭引擎，最多等 8 秒，好让会话日志落盘；然后再按 PID 文件与子进程引用杀掉（Windows `taskkill /T /F`），并尽力结束后台 boot helper；**不**杀用户 QQ 主进程。

状态页：启动中显示「正在启动本机服务…」；失败给出可操作提示（缺 QQ、端口占用、后台目录缺失）。**不要**再要求用户另开 `start.ps1`。

用户文案禁止：QQNT、NapCat、OneBot、肥鱼桥、Docker。

## 路径（开发 vs 打包）

| | 开发 | 打包（`app.isPackaged`） |
|---|---|---|
| 根 | 仓库根 `fatfish-win-client/` | `process.resourcesPath` |
| 设置服务 | `app/shell/local-server.mjs` | `resources/shell/local-server.mjs` |
| Core | `app/core/server.mjs` | `resources/core/server.mjs` |
| 智能引擎 | `vendor/dsh/*.exe` | `resources/vendor/dsh/*.exe` |
| 后台 | `vendor/napcat/` | `resources/vendor/napcat/` |
| Node 便携 | `vendor/node/`（可选回退） | `resources/vendor/node/` |

`package.json` → `build.extraResources` 已包含：`core/`（不含 `dev/`）、`shell/`、`vendor/dsh`、`vendor/napcat`、`vendor/node`。体积大属预期（智能引擎约 279 MB + 后台组件 + 便携 Node）。打包前必须先在 `app/core` 里执行 `npm install`，否则打进去的包里没有 `ws`。

## Windows 开发

```powershell
cd app\electron-ui
npm install
npm start
```

无需先跑 `scripts\start.ps1`（客户端会自动启停）；脚本仍可用于排障。

## 箱上（Linux）验证

```bash
cd app/electron-ui
npm install
npm run smoke
```

Linux 上会跳过 Win 后台启动器（`backend_win_only` / degraded），语法与窗口 smoke 仍应通过。

## 本机数据

与 `docs/DEV.md` 一致：

- `%AppData%\FatFish\secrets\deepseek_api_key`
- `%AppData%\FatFish\secrets\local_token`
- `%AppData%\FatFish\runtime\*.pid`、`risk_ok`
- 开发可用 `FATFISH_APPDATA` 覆盖

保存 Key：优先 `POST http://127.0.0.1:8787/api/save-key`，并主进程 `fs` 直写。**从不** log / 回显完整 Key。

## 云 Win 打包

在云机仓库根已同步、`vendor/dsh` + `vendor/napcat` + `vendor/node` 已就位（`fetch-vendor`），并且 `app/core` 已执行 `npm install` 时：

```powershell
cd C:\fatfish\fatfish-win-client\app\electron-ui
npm install
# 国内镜像可选：
# $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
# $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist
```

> `npm run dist` / `pack` 会先跑 `ensure-crlf`，保证 `vendor/napcat` 内 `.bat` 为 CRLF（纯 LF 会导致 Win `cmd` 秒退、登录服务超时）。


产物：`app\electron-ui\dist\FatFish-Setup-0.1.0.exe`（nsis）。

预估体积量级（含后台组件 + 便携 Node + Electron 运行时）：**安装包约 200–350 MB**（视压缩与是否裁剪 node_modules 而定）；未压缩 `win-unpacked` 可到 **~350–450 MB**。

可选：将 `dist\FatFish-Setup-*.exe` 同步到 COS `/dafeiyu/fatfish/releases/`。

## 与托盘脚本关系

启停已由 Electron 主进程接管；系统托盘菜单仍为后置里程碑。
