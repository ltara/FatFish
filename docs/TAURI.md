> **SHELVED（已搁置）** — 主人改口：正式 UI 改为 **Electron**（`app/electron-ui/`，见 `docs/ELECTRON.md`）。
> 本目录与 `app/tauri-ui/` **保留不删**，仅作归档参考；勿再作为主路径开发。

# Tauri 桌面壳（已搁置 / SHELVED）

目标平台：**Windows 10/11 + WebView2**（Win-only）。箱上 Linux 仅用于 `cargo check` / 前端静态检查；GUI 需在 Windows 跑。

## 目录

```
app/tauri-ui/
  src/                 # 前端：状态 / 设置 / 登录 + 风险遮罩
  src-tauri/           # Rust：读写本机 Key、探测 127.0.0.1 服务
  package.json
```

窗口标题：**肥鱼**。侧栏三页：状态、设置、登录。登录使用 **应用内 `WebviewWindow`**（或 iframe 嵌入），**禁止** `shell.open` / 系统浏览器。

## Windows 开发

前置：

- [Node 20+](https://nodejs.org/)
- [Rust](https://rustup.rs/)（stable）
- WebView2 Runtime（Win10/11 通常已有；缺失时安装包会引导）
- Microsoft C++ Build Tools（MSVC）

```powershell
cd app\tauri-ui
npm install
npm run tauri -- dev
# 等同：npx tauri dev   或   npm run tauri:dev
```

产物调试可另开终端启动后台：

```powershell
# 仓库根
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

打包（下一里程碑再并入 Setup.exe）：

```powershell
cd app\tauri-ui
npm run tauri -- build
# 输出约在 src-tauri\target\release\bundle\nsis\
```

## 依赖版本

- Rust 侧钉在 **tauri 2.11.6** / **tauri-build 2.6.3**（crate MSRV 1.77.2）；本包 `rust-version = "1.85"` + `.cargo/config.toml` `incompatible-rust-versions = fallback`，箱上 rustc 1.85 可 `cargo check`。
- Tauri **2.12+** 要求 rustc ≥ 1.90；Win 真机若已升级 Rust，可再抬版本。

## 箱上（Linux）验证

```bash
cd app/tauri-ui
npm install
npm run build          # vite → dist/
npm run check          # = cd src-tauri && cargo check
```

已在箱上验证：`npm install`、`vite build`、`cargo check`（钉 tauri 2.11.6）通过。  
`tauri dev` / 真 GUI 需 WebView2，请在 **Windows** 跑。箱上若缺 GTK/WebKit 开发包，先装：

`libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev pkg-config`

## 本机数据

与 `docs/DEV.md` 一致：

- `%AppData%\FatFish\secrets\deepseek_api_key`
- 开发可用 `FATFISH_APPDATA` 覆盖（Linux 默认可落 `~/.local/share/FatFish`）

Rust 命令 `save_api_key` **从不** log / 回显完整 Key；状态仅返回「已保存 / 未保存」。

## 权限与 CSP

- 能力文件：`src-tauri/capabilities/default.json`（含 `create-webview-window`，**无** opener）
- CSP：仅 `'self'`、`http://127.0.0.1:*`、`https://api.deepseek.com`（及 Tauri IPC）

## 与托盘脚本关系

`app/shell/FatFishTray.ps1` 已标注 **DEPRECATED**。正式入口改为 Tauri exe；托盘 + 启停后置里程碑再做。
