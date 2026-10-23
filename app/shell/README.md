# 壳层脚本

- `local-server.mjs`：仅绑定 `127.0.0.1:8787`，静态页 + `GET /api/status` + `POST /api/save-key`（Electron / 后台复用）
- `FatFishTray.ps1`：**DEPRECATED**。曾用系统浏览器打开设置/登录；正式入口为 **Electron**（`app/electron-ui`）。保留作回退，勿作开始菜单主入口。

对外文案只用「肥鱼」「设置」「登录窗口」「诊断」。
