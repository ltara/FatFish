# M5-2 / M5-3：独立验签、激活数据链路与界面门禁

> 2026-10-26，当前共享工作区，未提交。双进程门禁代码和无窗口检查通过；激活表单已接，原生交互/布局未验收。正式公钥/服务地址尚未配置，未生成正式私钥、未部署、未打包，不宣称整个 M5 完成。

后续：M5-4 可续向导和 M5-5 构建保护现已接通代码/无窗口验证，分别见 `M5_ONBOARDING.md`、`M5_PROTECTION.md`。本节 Core/Worker 历史基线继续有效；Main 当前 12 项、激活/告知 15 项，不能将以下旧 10/13 项报告当作当前版本原生验收。

## 1. 实现

- `app/core/license-trust.cjs`：构建时固定的公开 SPKI 与激活地址，不接受 IPC/环境覆盖。当前有意保留 null，生产路径失败关闭；测试不能用来冒充正式激活。
- `device-fingerprint.cjs`：分别在 Main/Core 进程内读取 64 位注册表 MachineGuid 和系统盘卷序列号，固定域分隔盐后 SHA-256。只返回哈希，原值不写日志/文件或发送出去。使用隐藏的 `reg.exe` / `cmd.exe vol`，不依赖 PowerShell 7；当前开发机实测成功，不替代干净 Win10 验收。每进程缓存一次计算，不把它称作硬件证明或不可伪造标识。
- `license-gate.cjs`：各进程独立读文件、验 Ed25519 原始字节签名、比对本机哈希、校验产品/version/edition/UTC 时间格式。严格 canonical envelope/payload/base64url，拒绝额外字段、字节改动、额外空白、目录/junction、超大文件。没有到期判断、时间回拨限制或启动网络复核。
- 保存先校验签名/设备，临时文件独占创建 + fsync + rename；失败保留旧文件。激活响应还必须匹配本次填写的码哈希，正确签名但串码的响应也不接受。
- 激活只请求构建时固定 URL；远程 HTTPS、本机回环可 HTTP，拒绝重定向。无自动重试，限制响应体；错误固定分类，不反射原文。相同进程并发激活在发出第二次请求前拒绝。

## 2. Main 与 Core 不相互代验

Main 启动时未通过就不 `startAll`；所有受保护 IPC 共用顶层 frame + 本机验签门禁。公开入口仅限激活状态/提交、静态关于、最小状态和窗口控制，未激活状态不返回人格、数据路径或 Key 状态。托盘暂停也重新验签；未激活状态不探测 QQ 端口。

Core 在任何数据初始化、渠道/模型启动前独立验证，失败仅返回固定 license 元数据并退出 78。正常命令再检查，且每秒检测许可证丢失/失效后停止自身实例。EngineHost 启动/新轮次和独立 `ModelService.test` 还有本地门禁；不存在仅锁聊天、却让「测试连接」拉起 SDK 的旁路。环境变量、父进程「已验证」字段、Renderer 状态都不能替代它。

Main/Core 共用算法源码，但验签和机器身份计算分别执行，不传递可信布尔值。保护的目标是常规授权与提高破解成本，不是假称本机管理员无法改程序/复制机器身份。代码保护仍属 M5-5。

## 3. 激活界面代码

`renderer/activation-view.js`、Main/preload、实际 HTML 已接通。第一帧 body 就是锁定状态，隐藏主页面/其他向导；只有 Main 返回 verified 状态才放行。表单使用既有 onboard 控件，4 位分组、保留中间光标、单一主按钮在右、固定中文错误、aria-live，Esc 不解锁。

不自动激活，显式按钮才发请求；「重新检查」只读本机。码无效、两台已满、网络不通各有明确提示；失败留输入，busy 禁重复提交。没有原始服务端文字。风险持久化也必须返回严格 true 才能继续，不能把拒绝对象当成已同意。

**只做了普通元素/Node VM 检查。没有运行浏览器、完整 DOM、真实 Electron 窗口、布局/缩放/键盘走查。** 没把旧本机 UI 34 项证据套到这版激活流程。

## 4. 无窗口证据

| 检查 | 结果 | 范围 |
|---|---|---|
| Core `license-check` | 30/30，连续三轮 | 每个文件字节翻转一位、canonical 格式、换机/错钥/签过但字段无效、永久离线、原子保存失败、junction/大文件、原始生产路径忽略假环境标志、真实 Core 拒绝/允许/失效停机、实际 SDK 本机回复、独立连接测试拒绝、恢复 |
| Main `license-main-check` | 10/10，连续三轮 | 实际 Main 的 Node VM；所有受保护通道未激活拒绝、frame 鉴权、最小元数据、Main 不相信 Core 的 valid、非 smoke 启动门禁、篡改后阻止新请求 |
| 服务端 `test:client` | 原 39/39 + 客户端 14/14，连续三轮 | 真实 Wrangler/D1 → 实际客户端激活/原子存储 → 实际 Core 独立接受；同机重试、设备满、未知码、错签名/串码、固定错误、并发互斥、离线；部分异常由传输夹具触发，未假称全部为真实断网 |
| UI `activation-view-check` | 13/13，连续三轮 | 实际控制器 + 普通元素，码格式/光标、三类错误、busy、防伪成功、重读解锁、初始锁/语义、风险确认严格布尔与失败保留 |

证据根目录 `C:/Users/caidengfeng/.codex/visualizations/2026/10/24/01a16f76-c9b5-70c2-a81d-9b843307a01e/`：

- `fatfish-m5-license-core-verified-1|2|3/license-report.json`
- `fatfish-m5-license-main-verified-1|2|3/license-main-report.json`
- `fatfish-m5-license-worker-verified-1|2|3/activation-report.json`（`results` 39，`clientResults` 14）

Core 报告附源码 SHA256，已复核三轮的 `license-gate.cjs` 与当前源文件相同。早期 final/diagnostic 是旧 13 项客户端或早期表单版本，不混用。

### 测试不是运行时后门

`dev/license-fixture.cjs` 在独占临时目录复制受测 Core，逐文件比较字节/哈希，**只替换公开信任锚**并使用内存里的一次性测试私钥签发。没有把测试私钥写进客户端，没有添加 `FATFISH_LICENSE_VALID` 一类放行开关。生产默认 null 的拒绝分支单独用原始源码运行过。

既有 Core/VM 测试改用合法测试签名，不能靠关掉验签来维持绿色。UI 测试也已改为相同隔离源码方式，只准备并检查了复制/依赖解析，**未重新运行原生 UI**。`dev/` 不进入现有打包资源，实际用户 AppData/license 没有改动。

同轮回归通过：contracts 38、身份 43、清理 12、错误 27、可选渠道 18、记忆 56、提醒 43、工作区 29、收件恢复 16、真实 60 秒提醒链路 23；模型 Core 57、实际 Main/表单/Core 模型数据链路 13、Main 模型 17、工作区 VM 21、收件 VM 15。模型/渠道都是回环夹具，费用 0。本轮未改 profile、未重复真实付费隐私探针。

## 5. 命令与剩余工作

```powershell
$env:E2E_EXEC_PATH = '<electron.exe 绝对路径>'
npm.cmd --prefix app/core run license-check -- --evidence <绝对目录>
npm.cmd --prefix app/electron-ui run license-main-check -- --evidence <另一个绝对目录>
npm.cmd --prefix app/electron-ui run activation-view-check
npm.cmd --prefix activation-server run test:client -- --evidence <另一个绝对目录>
```

以上均无窗口。源码默认信任锚未配置，直接启动普通客户端/Core 会失败关闭，**不是可绕过的开发激活方式**。正式公钥/服务地址应在受控构建中注入并做安装包预检，正式私钥仅在服务端；该构建配置/代码保护流程现已接入并完成隔离资源夹具验证，见 `M5_PROTECTION.md`；未配置正式服务或实际打包。

M5-4 可续首次向导（基础本机与可选 QQ）已完成代码/无窗口三轮，Main 门禁扩为 12 项、激活/告知扩为 15 项，见 `M5_ONBOARDING.md`。M5-5 构建保护/资源检查现已完成代码和 41 项隔离夹具三轮，正式安装包门禁仍待。关于页现已补齐原码末四位的非鉴权本机显示元数据，32 项无窗口三轮；旧证缺失时只显示状态，不从哈希伪造尾号，不改变许可协议，见 M5_ACTIVATION_DISPLAY.md。原生激活/向导/既有 UI 验收等用户新明确允许，真实 QQ、干净 Win10/5.1 和 50 轮人格抽样仍保留，不用本节机制检查冒充完整交付。
