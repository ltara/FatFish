# M5 关于页：激活码末四位

2026-10-26，按 DESIGN §8 设置「关于」的既定要求补齐；不改变许可证协议、Core/主进程验签、指纹、设备上限或离线策略。

## 数据与界面

- 只有主进程实际激活成功后，`activation-display.js` 才尝试保存 `activation-display.json`：版本、整份许可证字节的 SHA256 和规范化原码末四位。再次核对已安装许可证中的码哈希与刚输入的码一致；完整码不落盘、不进入日志。
- 主进程先独立验签，再读取匹配当前许可证字节的显示信息。`get-license` 仅额外返回可选 `codeTail`，不返回签名、指纹、码哈希或文件路径。preload 保持同一 IPC，renderer 使用 textContent 显示「已激活 · 本机 · 激活码尾号 XXXX」。
- 老许可证没有显示文件时仍然离线有效，只显示「已激活 · 本机」，不从哈希伪造尾号，不自动联网补录。显示文件坏了/写失败也不能把已成功的激活当成失败、自动再激活。
- **这是可编辑的本机显示元数据，不是服务端签名字段或鉴权凭据。** 末四位只能辅助辨认，不能单独证明购买/售后资格。删掉、伪造该文件均不能放行缺失或篡改的许可证。
- 默认清理数据时随许可证保留；只有独立勾选清除本机激活信息才移除，显示文件先删、许可证最后删。不扩展到工作区/未知文件，junction 不跟随。

## 当前验证

`npm.cmd --prefix app/electron-ui run activation-display-check -- --evidence <绝对目录>`

**32/32，连续三轮**。真实本地签名响应 → 实际 LicenseGate 网络/验签/安装 → 实际 Main IPC → preload → renderer 的 loadAbout 函数；所有界面元素、窗口、Electron 对象是普通测试对象，不是原生 UI。另有新 Node 进程重读、旧证兼容、错码、换证、篡改、损坏/过大文件、写失败、链接和数据清理。

同期回归：数据清理文件系统 22、Main 验签 12 各三轮；Core 验签 30、清理 Main 15/元素 17/实际运行时 14、激活元素 15、向导挂载 9/实际数据 37、保护资源 43，以及真实本地 Worker/D1 39 + 客户端 14 通过。112 个 JS 模块语法检查通过，没有执行会开窗口的 smoke。

**最新真实未安装包 23/23**，新增包内显示模块加载/落盘检查，实际包源快照 63 项与当前应用源码一致，详见 M5_PACKAGE.md。未运行图形界面、安装、发布或使用正式密钥；本轮额外真实模型请求 0。

证据根：`C:/Users/caidengfeng/.codex/visualizations/2026/10/24/01a16f76-c9b5-70c2-a81d-9b843307a01e/`

- `fatfish-activation-display/round-1|2|3/activation-display-report.json`
- 同目录的数据清理/主进程报告与 `regression/` 的各项报告、日志
- `fatfish-activation-display-package/package-report.json`、`artifact-metadata.json`

原生关于页换行、缩放与键盘验收仍待用户允许。没有拿普通对象验证冒充窗口通过。
