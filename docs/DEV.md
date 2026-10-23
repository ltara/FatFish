# 开发说明（内部，勿放入用户安装包 docs）

## 组件映射（对外话术）

| 内部 | 用户说明书说法 |
|------|----------------|
| QQNT | QQ（官方客户端，安装向导会检测） |
| NapCat | 客户端后台服务 |
| 肥鱼桥 / bridge | 智能回复引擎 |
| OneBot | （不出现） |
| WebUI :6099 | 「登录窗口」 |
| Docker | （不出现；本交付免 Docker） |


## 桌面壳（Electron — 正式 UI）

> **Tauri 主路径已搁置。** 正式 UI：`app/electron-ui/`（单窗口：状态 / 设置 / 登录）。详见 `docs/ELECTRON.md`。  
> `app/tauri-ui/` / `docs/TAURI.md` 保留归档（SHELVED）。

- 对外窗口标题：「肥鱼」
- 登录：应用内 `<webview>` 内嵌；禁止系统浏览器 / `shell.openExternal`
- `FatFishTray.ps1`：DEPRECATED（曾用浏览器打开设置/登录）；正式入口为 Electron exe（打包后置）

## 端口约定（仅 127.0.0.1）

- 内部 WS：默认 `127.0.0.1:3001`（可配置，`config.json` → `onebot_url`）
- 本地设置页：`127.0.0.1:8787`（`local-server.mjs`）
- 登录窗口：`127.0.0.1:6099`
- 一律 Token；禁止 `0.0.0.0`

## 本机数据

```
%AppData%\FatFish\          # 开发可用环境变量 FATFISH_APPDATA 覆盖
  config.json
  persona.txt
  secrets\deepseek_api_key
  secrets\local_token
  logs\
  runtime\*.pid
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

产物：`vendor/napcat/`、`vendor/node/`、`vendor/MANIFEST.txt`（含 SHA256）。二进制 gitignore。

可选覆盖：`NAPCAT_VERSION`、`NODE_VERSION` 环境变量。

## 桥

```bash
cd app/bridge && npm install && npm start
# 或: FATFISH_APPDATA=/tmp/fatfish-dev node server.mjs
```

无 Key 时仍连 WS，私聊固定回复「请先在设置中填写 API Key」。

## 打包流水线

见 `docs/WIN_BUILD.md`：

1. `scripts/fetch-vendor.ps1`（或 `.sh`）
2. `cd app/bridge && npm install`
3. `packaging/assemble.ps1` → `dist/FatFish/`
4. `installer/build.ps1` → `installer/Output/FatFish-Setup.exe`（需 Inno Setup 6，**须在 Windows 上执行**）

## 与 MVP 关系

`/workspace/fatfish-mvp` 为 Docker 验证原型；本仓库为正式 Win 交付路径，桥逻辑自 `bridge/server.mjs` 迁入并改读 AppData。

## Windows PowerShell 编码
自研 `.ps1` 须 **UTF-8 with BOM**（或纯 ASCII 文案），避免 Win PS5.1 中文系统解析失败。
