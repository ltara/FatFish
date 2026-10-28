# M5-5 本地真实未安装包验收

> 2026-10-26。用户明确允许「仅临时目录生成本地未安装测试包，不运行界面」。本节真实调用锁定 electron-builder 的 `--dir`，不是此前最小 PE/ASAR 资源夹具；**没有生成安装程序、运行界面、安装、发布、使用正式密钥或操作实际用户数据**。


**当前复验补充（2026-10-26）**：关于页尾号功能接入后已重新制作真实未安装包 **23/23**；最新测试根 `C:/Users/CAIDEN~1/AppData/Local/Temp/fatfish-package-Gzq0p0/`，2777 文件、760532353 字节，63 项应用源码 SHA 与当前一致。证据在 `fatfish-activation-display-package/`；新增包内尾号模块加载/保存检查。下面 CV0yy1 的 22 项是此前基线，保留历史，不冒充最新源码。没有运行界面、安装、发布、正式签名或真实模型。

## 1. 产物和隔离

- 测试根：`C:/Users/CAIDEN~1/AppData/Local/Temp/fatfish-package-CV0yy1/`。
- 未安装包：`source/app/electron-ui/dist/win-unpacked/`，入口 `肥鱼.exe`。共 2777 个文件、760530641 字节；详细哈希见证据的 `artifact-metadata.json`。
- 应用源码在临时 source 中逐项 SHA256 对比当前工作区；Core dev 和私有配置不复制。构建依赖只在隔离目录按原锁文件 offline ci，禁安装脚本，锁文件未改。
- 登录后台从已验证 SHA256 的原始 ZIP 重新解包，不复制开发目录的 config/cache/log/登录状态；便携 Node 同样从锁定 ZIP 解包。智能引擎/检索 sidecar 保持当前锁定源文件字节，不升级。
- 使用已安装的 Electron 33.4.11 发行目录、electron-builder 25.1.8。禁发布，移除模型/云/发布/签名凭据环境，禁签名证书自动发现；实际日志为没有签名信息、跳过签名。没有使用正式私钥/证书。
- 构建只注入一次性测试公钥和 `.test` 激活地址；测试签名私钥只在检查进程内存中。公钥配置在客户端包外，生产源码 `license-trust.cjs` 继续为 null，无客户端运行时跳过开关。

产物带 `LOCAL-TEST-ONLY.txt`，不可发货；不要未经新许可双击运行图形界面。激活测试数据/假模型 Key 都在包外的新临时 AppData，不是实际用户数据。

## 2. 实际发现的问题

1. 保护钩子的输出保护最初把默认 `app/electron-ui/dist/win-unpacked` 也当作源目录拒绝。现在仅允许配置的 dist 子目录，仍保护真正的应用源码目录；对应资源夹具从 41 扩到 42 项。
2. 真正的依赖树暴露 Windows ASAR 多级路径问题：校验用 `/` 规范名直接传给锁定 asar 的本机 API，二级以上目录误报 `was not found in this archive`。改为仅 API 边界 `path.normalize`，没有跳过目录或弱化扫描；增加多级依赖和 Node 模式导入检查，现为 43 项。
3. 首次包后端探针因测试准备遗漏 Core `channels/` 失败。修正的是隔离副本准备器，不是生产 extraResources（生产过滤本来包含它）；保留失败诊断，补全副本后重新构建并验收，不把夹具问题归为产品缺陷。

## 3. 实际产物 22 项通过

证据根 `C:/Users/caidengfeng/.codex/visualizations/2026/10/24/01a16f76-c9b5-70c2-a81d-9b843307a01e/fatfish-local-package/`：

- `package-preparation.json`：隔离目录、源码摘要、vendor ZIP/引擎字节哈希；`prepare.log` 记录原锁文件 offline 安装。
- `build.log`：实际 builder、默认 dist 输出、八模块保护、ASAR/PE 内嵌头哈希重写及后续钩子。`no signing info` 是明确的**未签名**，`finalizedAfterSign` 只表示该钩子完成字节复核，不是 Authenticode 签名证明。
- `package-report.json`：**22/22**，`realBuilder:true`、`nativeUI:false`、`installed:false`、`published:false`、`realQQ:false`、`paidCalls:0`、`formalKeys:false`。
- `artifact-metadata.json`、包内 `resources/protection-manifest.json`：资源/主程序/ASAR 哈希；清单是本地构建审计，不是发行者签名。
- `process-check.json`：构建和后台验收后，与本测试根匹配的主程序/智能引擎进程为 0。

后台启动前先只读检查 RunAsNode fuse 确实启用，再强制 `ELECTRON_RUN_AS_NODE=1`。只运行包内可执行文件的 Node 模式和 Core，未进入 Main 的原生窗口初始化。包内 ASAR 确实加载密码验证、服务管理器、二维码依赖、人格动作和数据清理模块；不从开发工作区提供 NODE_PATH 或智能引擎路径覆盖。

- 缺失/篡改两种许可证：包内父进程验签和另一个 Core 进程独立拒绝，Core 退出 78，无引擎事件、引擎目录或模型请求。伪造父环境 valid 标志不放行。
- 合法测试证：独立验证通过，实际资源路径启动包内 Core 和锁定引擎；一条本机回环回复完成。实测严格 21 项工具、无两项私密上传字段，未运行全量 OTLP 探针。
- QQ 在新配置中关闭；探针的安全围栏会在误启动后台/探测渠道前失败，实际尝试数为 0，不连接真实账号。
- 日志不含完整 Key、测试正文、原始许可证或指纹。未使用真实模型上游，费用 0；先前 50 次真实抽样许可尚未由本包检查消耗。

失败诊断 `build-failed-asar-path.log`、`package-failed-asar-path.json`、`package-failed-missing-channel-fixture.json` 是旧失败证据，不当作最终通过，也没有因观测超时就重启仍活着的测试。

## 4. 剩余门禁

M5-5 的本地真实产物保护验收已通过；NSIS 安装程序、真实代码签名、安装/卸载和干净系统属于后续交付门禁，未做。M5-3/4 原生激活/向导、真实 QQ、既有人格/记忆/提醒/工作区/模型界面仍受用户禁止界面操作的限制。

用户另已允许最多 **50 次真实模型请求**用于 M4-11，仅新临时上下文、不读历史、不连 QQ、限制输出、遇错停止、不自动付费重试。必须按实际出站请求计数（工具后续请求也占额度），不能把 50 个 HTTP 请求自动算作 50 个完整对话轮次；不足或不通过就如实保留未完成，不擅自增加额度。

只读 fuse 判断依据：[Electron RunAsNode](https://www.electronjs.org/docs/latest/tutorial/fuses#runasnode)、[公开 fuse wire 常量](https://github.com/electron/fuses/blob/main/src/constants.ts)。未修改 fuse，也未以图形界面运行主程序。
