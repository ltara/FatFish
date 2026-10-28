# M5-5：构建期代码保护与公开信任锚注入

> 2026-10-26，当前共享工作区，未提交。代码/隔离资源夹具 **41/41，连续三轮**；未调用 electron-builder 打包、未生成安装包、未操作原生窗口、未部署、未生成正式私钥。M5-5 的实际安装包门禁仍未通过，不能称整个 M5 完成。

## 1. 选择与范围

采用 `javascript-obfuscator` **4.1.1**，不用 V8 字节码，避免给已锁定 Electron/Node 引入额外字节码 ABI 约束。独立构建工具在 `scripts/release/`，另锁 `@electron/asar` **3.4.1**、`resedit` **1.7.2**，均只用于构建，不进入客户端依赖。

八个自有模块：

- Core：`license-trust.cjs`、`device-fingerprint.cjs`、`license-gate.cjs`、`server.mjs`、`engine-host.mjs`、`model-service.mjs`。
- Electron ASAR 内：`main.js`、`service-manager.js`。

使用标识符替换、字符串编码和部分控制流变换，不混淆第三方包，不开反调试、控制台拦截或自毁，不输出 source map。Main 保留顶层标识符以兼容现有 VM 契约，其逻辑/字符串仍经过变换；不把 base64 编码单独当成代码保护。

混淆只是提高阅读和修改成本，不是加密；公钥和地址本来就是公开信息。本机管理员仍可反编译/修改程序。资源清单是可信构建环境内的审计记录，**不是发行者的密码学签名，也不是防篡改的根信任**。

## 2. 构建钩子

`app/electron-ui/package.json` 已接 `beforePack`、`afterPack`、`afterSign`；`pack` 和 `dist` 均适用：

1. **beforePack**：读取 `FATFISH_RELEASE_CONFIG` 指向的绝对路径公开 JSON，严格只允许 version/publicKey/activationURL；只收 canonical Ed25519 SPKI，地址只收无凭据/参数的命名 HTTPS `/activate`，拒绝 IP、localhost/local/internal。这里只检查地址形式，不声称已验证 DNS、TLS 或真实服务部署。检查锁定 Electron/builder/构建工具版本，并记录源码快照。缺配置就失败，不修改源码。
2. **afterPack**：复制后的资源必须与快照一致；只在资源里注入公钥/URL并混淆，八个变换全部语法通过后才写入。扫描明文算法片段、source map、备份、私钥、误入的 dev/服务端/secret 文件；任何失败都抛错，阻止签名/安装包继续生成。未知 unpacked/native 资源或 ASAR 链接布局直接拒绝，不能静默漏处理。
3. **ASAR/PE 完整性**：锁定 builder 25.1.8 在 afterPack 前已经写入旧 ASAR 头哈希，所以重建 ASAR 后必须替换 PE 的唯一 `INTEGRITY/ELECTRONASAR` 项，再读回比对。没有追加重复项，也没有关闭完整性校验。
4. **afterSign**：再次验证模块、ASAR 和 PE 内嵌头哈希；允许签名/图标版本编辑引起的 PE 字节变化，再记录最终 SHA256，**不改签名**。未签名和真实签名的完整 builder 流程仍需以后实包验证。

生产源码 `license-trust.cjs` 继续保持 null，普通开发启动失败关闭；构建变量不在客户端运行时读取，也不接受父进程/环境的「已激活」布尔值。私钥只属于激活服务，不能传给上述 JSON。

## 3. 操作说明

### 无窗口开发检查（本轮实际执行的类别）

```powershell
# 在仓库根目录；只安装独立构建工具，不改客户端的锁定依赖
Set-Location scripts/release
npm.cmd ci --ignore-scripts
npm.cmd run check
$env:E2E_EXEC_PATH = '<仓库内 electron.exe 的绝对路径>'
npm.cmd test -- --evidence '<独占证据目录>'
```

测试只在独占临时目录创建代码资源 ASAR 和不可运行的最小 PE 资源夹具；不是应用安装包。一次性签名私钥只留内存。真实 Core/SDK 使用回环模型；Electron 只以 `ELECTRON_RUN_AS_NODE=1` 解析 ASAR 模块，没有创建窗口、托盘、浏览器或真实 QQ。

### 未来正式构建（本轮未执行，需单独授权）

在仓库外准备公开配置，格式如下，内容要替换为运营者已确认的公钥和实际服务地址：

```json
{
  "version": 1,
  "publicKey": "<Ed25519 公钥 SPKI DER 的 base64，不是私钥>",
  "activationURL": "https://<已部署域名>/activate"
}
```

在 `app/electron-ui` 运行原 `pack`/`dist` 前，为该构建进程设置 `FATFISH_RELEASE_CONFIG=<公开 JSON 绝对路径>`。不要把正式私钥、管理 token、模型 Key 写入配置或构建命令。正式服务、公钥和备份流程尚未由用户配置，本轮没有代选域名/密钥。

构建后可从仓库根目录只读复核：

```powershell
node scripts/release/verify-artifact.cjs --app-dir '<win-unpacked 绝对路径>' --config '<公开 JSON 绝对路径>'
```

输出 `resources/protection-manifest.json` 只含工具版本、公钥摘要、源码/混淆模块/ASAR/PE 哈希，没有源码、许可证、账号、消息、Key 或私钥。验收仍应独立核对发行版本和代码签名，不用可编辑清单代替来源认证。

## 4. 无窗口证据

证据根目录：`C:/Users/caidengfeng/.codex/visualizations/2026/10/24/01a16f76-c9b5-70c2-a81d-9b843307a01e/`。

- `fatfish-m5-protection-final/round-1|2|3/protection-report.json`：**41/41，各三轮**，附八模块与 ASAR/PE 哈希；`nativeUI:false`、`realQQ:false`、`paidCalls:0`、`installerBuilt:false`、`resourceFixture:true`。
- 覆盖真实锁定 builder 的三钩子解析（没有启动构建）、缺配置/错钥/版本覆盖拒绝、复制源码不一致、公开锚快照不受随后改文件影响、八模块变换、原始工作区字节不变、明文/备份与资源篡改拒绝、ASAR/PE 哈希替换、签名 overlay 模拟和只读验证 CLI。
- Electron-as-Node 确实通过实际 ASAR 与相邻 Core 路径加载模块。实际混淆后 Main 在 VM 中逐通道拒绝未激活请求，许可证和基础告知均确认才启动服务；不把 VM 当原生窗口验收。
- 实际混淆后 Core 独立拒绝假父进程/env 断言；同机验签、每字节翻转、错设备、固定激活端点/签名存储、真实 SDK 本机回复、实际 21 项工具、请求无两项私密上传字段、删证停机、独立连接测试拒绝/成功（tools 为空）、直接引擎拒绝均通过。激活 HTTP 响应仅传输夹具，没有访问真实激活服务；没有重跑全量 OTLP 隐私探针。
- `fatfish-m5-protection-audit-official.json`：官方 npm registry 本次审计 103 项依赖，报告已知漏洞 0；默认镜像的 audit 接口不支持，未将其失败当通过。审计不保证没有未知漏洞，构建依赖也不应进入客户端。

早期 initial/data/runtime/38 项报告是诊断版本，不能冒充最终 41 项三轮。

后续用户明确允许仅在临时目录生成未安装包并做后台验证：真实 builder 产物已完成 22 项，保护夹具因默认输出路径/Windows 多级 ASAR 兼容修正扩为 43 项，详见 `M5_PACKAGE.md`。原 41 项三轮是历史证据；不与当前真实包或 43 项混用。未运行图形界面、安装、发布或使用正式私钥。

## 5. 剩余交付门禁

正式激活服务/公钥/域名确认、实际 builder 输出与安装包扫描、真实签名流程、干净 Win10/11 和 PowerShell 5.1、原生激活/向导/已有 UI、真实 QQ、50 轮人格抽样均未被本节替代。关于页当前只显示本机激活状态；签名 payload 只有码哈希，不能把哈希尾部冒充激活码后四位。

后续数据清理缺口已修复并完成无窗口三轮，见 `M5_DATA_CLEAR.md`：默认保留 Key/许可证、严格独立 scope、安全停机、不碰工作区文件。当前 Main/ServiceManager 的首次向导 37 和保护资源 41 项也已重新验证，最新证据在 `fatfish-data-clear-final/`；原生清理控件仍未验收，没有删除任何实际用户数据。

依据：[混淆器固定 4.1.1 文档](https://github.com/javascript-obfuscator/javascript-obfuscator/blob/4.1.1/README.md)、[ASAR 固定 3.4.1 文档](https://github.com/electron/asar/blob/v3.4.1/README.md)。builder 时序和 PE 字段以本地锁定 25.1.8 的 `platformPackager.js`、`electron/electronWin.js` 实际代码为准，不套用 master 的时序。
