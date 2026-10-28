# 肥鱼品牌图标接入

## 1. 批准稿与导出

2026-10-28，用户确认采用标志化概念板中间的深色底图标，并明确允许程序原样裁切、透明化、缩放、导出与接入项目；不重新生成、不启动窗口、不打包、不提交。

- 原图：`docs/brand/logo-approved-20261028.png`。
- 原图 SHA-256：`465633a4d2952b772added6fa48e64fbca715fb13f61ccaac6344ba6107e7636`。
- 固定裁切框：`[555, 244, 990, 685]`，保留原有纵横比并补为 441px 方画布。
- 仅清理外部白底及边缘白色预乘，未修改鱼的造型或重新绘制。母版 PNG 为 512px；上采样不代表获得新的绘制细节。
- 导出器：`scripts/export-brand-assets.py`，本轮使用 Pillow 12.3.0；资源哈希、裁切及状态色记录在 `app/electron-ui/assets/brand-assets.json`。

离线重现：

```powershell
python scripts/export-brand-assets.py
npm.cmd --prefix app/electron-ui run build:ui
npm.cmd --prefix app/electron-ui run brand-assets-check
```

导出器校验批准原图哈希，原图变化即停止，不能悄悄换稿。

## 2. 五处接线

| 位置 | 接入方式 | 当前证据与边界 |
|---|---|---|
| 左上角 | `renderer-src/App.tsx` 使用 `../assets/icon.png`；32px，紧凑侧栏 24px；保留原文字和副标题 | 类型检查、本地首帧构建、隔离静态布局通过；不操作现有窗口 |
| 窗口与任务栏 | Windows 使用 `BrowserWindow.icon = assets/icon.ico`；窗口建立前设置与安装配置一致的 `com.fatfish.client` 身份；非 Windows 保留 PNG | 实际函数的 Node VM 断言通过；当前运行中的窗口不会被自动重启 |
| 托盘 | `tray.png` / `tray@2x.png`；ok、warn、bad、info 各有 16px / 32px 图；品牌不被状态圆点替换 | 原状态语义色只用于右下小角标；提示和菜单仍来自同一快照；真实系统显示由用户复验 |
| 应用程序 | `build.win.icon` 指向同一个 `assets/icon.ico`，内含 16/24/32/48/64/128/256 七种尺寸；安装与卸载图标同源 | 路径、ICO 目录、PNG 帧和打包白名单检查通过；没有运行打包，旧 EXE 资源没有被改写 |
| 快捷方式 | NSIS 延续桌面/开始菜单快捷方式；开发快捷方式创建脚本改为同一 ICO | 已有 `肥鱼（开发版）.lnk` 只更新 IconLocation，读回确认 TargetPath、Arguments、WorkingDirectory、WindowStyle、Description、Hotkey 不变；未点击运行 |

Windows 图标与身份 API 以已安装 Electron 33.4.11 类型声明核对，同时参考 [窗口图标 API](https://www.electronjs.org/docs/latest/api/browser-window#winseticonicon-windows-linux)、[应用身份 API](https://www.electronjs.org/docs/latest/api/app#appsetappusermodelidid-windows)。不修改开发运行组件本身的 EXE 资源，也不清理系统图标缓存或重启资源管理器。

## 3. 无窗口验证

- `check:ui` 与 `build:ui` 通过；只构建本地 UI 资源，不生成安装包。
- `brand-assets-check`：61 项，连续三轮；包含资源哈希、ICO 帧、源稿/生成首帧、实际 Main 窗口/托盘函数的 Node VM、Windows 身份和非 Windows PNG 兼容分支。
- 现有 UI framework 41、UI polish 36、model Main/preload 17、development UI 80 项，各连续三轮；没有启动 Electron、Core、渠道或模型。
- 隔离静态布局 21 项，各连续三轮：960×640、800×560、640×560 有效紧凑视口；均加载新图且品牌文字无横向溢出。页面去除全部控制器脚本，只使用 HTML/CSS/图片，不读用户数据，远程请求为 0。
- 导出器重新执行三轮，全部输出哈希一致；Pillow 解码七种 ICO 帧通过。24px 帧的一个角落因 LANCZOS 重采样留下 alpha 3/255，按近透明边缘（alpha ≤ 4）观察，不把正常抗锯齿误作不透明白底。

本轮预览/日志位于本次对话的 `fatfish-logo-approved-01` 产物目录；源文件的直接运行资源全部在仓库内，不依赖该产物目录。

## 4. 用户手动验收与剩余项

1. 保存正在编辑的内容，从托盘菜单选择退出，完全关闭开发版，再双击已有开发快捷方式。
2. 看左上角、任务栏、托盘是否为同一个批准图案；托盘状态仍应有提示文字与对应角标。
3. 若资源管理器仍显示旧的快捷方式缓存，可手动刷新；本轮不代为操作系统缓存或窗口。
4. 应用程序 EXE、安装/卸载与安装后快捷方式的原生验收，须在以后获得正式打包许可后进行。本轮没有安装、签名、发布、提交或推送，也没有声称这些门禁已完成。
