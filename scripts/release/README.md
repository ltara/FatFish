# 独立构建工具

本目录只在可信开发/构建机执行，不进入安装包。代码保护、公开配置、无窗口检查和实际构建门禁见 [M5_PROTECTION](../../docs/M5_PROTECTION.md)。

依赖由本目录的 package-lock.json 独立锁定。使用 `npm ci --ignore-scripts`；不升级客户端 Electron、SDK 或运行时依赖。不要在此保存正式私钥、管理 token 或模型 Key。
