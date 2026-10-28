# M4-8：锁定 SDK 的界面操作能力探测

2026-10-25，Windows，当前工作区未提交。**探测完成：当前交付的 `0.2.1rc2` SDK 无法直接加载所探测的官方 computer-use 服务/提供者，v1 不启用，按 ROADMAP 的失败分支留到 v1.x。** 不是断言 Windows 永远不支持，也不是宣称做过真实截图、点击或应用操作。

用户当前明确禁止窗口操作。本轮只做二进制版本/哈希、临时 profile 组合加载、实际模型请求工具目录与错误验证，没有运行 Computer Use 工具、Electron 窗口、真实驱动或系统权限提示；截图和桌面输入均为 0。模型只使用回环文本夹具，真实模型调用与费用为 0。

## 被测对象

- `vendor/dsh/deepseek-harness-sdk-runtime-win-x64.exe`，自报 `0.2.1-rc.2`。
- 被测 exe SHA256：`f9ed01f241df37c50c702d81b6c226d576210b8f3947699735ca90285ea13365`。这是本轮复现身份，不混同 `fetch-vendor` 固定的整个 wheel SHA256。
- 每种组合各有独立 `DSH_HOME` 与空工作目录，从生产 `fatfish-local` 复制到唯一临时目录，再加临时 overlay；生产 external/local profile 没有修改，仍为 6/21 项工具。
- 不安装缺失模块，不升级运行时，不复用 Codex 的私有驱动/权限，不引入新的桌面操控或自研权限系统。

## 组合与实际结果

| 组合 | 初始化 / 纯文本夹具 | 实际请求 tools | 组件结果 |
|---|---|---|---|
| 生产 local 基线 | 成功 | 精确 21 项 | 无插件错误 |
| 加 `@deepseek-ai/dsh-computer-use` | 成功 | 仍精确 21 项 | 服务 import 失败，`ERR_MODULE_NOT_FOUND` |
| 服务 + `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` | 成功 | 仍精确 21 项 | 服务与 native 提供者均 import 失败 |
| 服务 + `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp` | 成功 | 仍精确 21 项 | 服务与 MCP 提供者均 import 失败，尚未到驱动启动阶段 |

MCP 组合的 command 明确指向测试目录内**不存在**的 exe，并关闭重连；没有发现/启动用户电脑上的任何 `cua-driver`。因为插件先 import 失败，此结果不验证真实 MCP 驱动能否在 Windows 操作应用。

**关键区别：SDK 的 `initialize` 成功、能正常回复文本，不代表可选插件已激活。** 本次 stderr 明确为 `entry did not activate` 和 `Cannot find package ...`；实际模型请求没有新增任何 computer-use 工具。不能把这类初始化成功当作能力支持。

## 上游资料的边界

[官方 computer-use 服务说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/computer-use/computer-use/README.md)区分共享服务与提供者：服务本身不提供模型工具。[官方 native 提供者说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/computer-use-cua-driver-native/README.md)要求额外的原生运行时与主机权限，[MCP 提供者源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/computer-use-cua-driver-mcp/src/index.ts)则组合已安装驱动。

这些页面都是 master，不是锁定 rc2 的可用性证明。本次只拿它们确定候选模块名与服务/提供者的区别，最终结论来自上表的当前 SDK 实测。二进制内也能搜索到模块名/嵌入的包清单文档；**字符串或文档条目存在同样不代表模块已随 SDK 打包并可加载**，不能替代真实 import 与请求体检查。未把讨论区其他版本的成功/失败经验套用到本项目。

## 复现与证据

```bash
# 仓库根目录；普通 Node，无原生窗口/桌面动作，无付费调用
node spikes/m4-computer-use/probe.mjs --evidence <绝对目录>
```

- **13/13，连续三轮**：固定被测二进制/版本、基线精确工具、三种模块缺失、初始化假阳性区别、无工具调用/图像事件、生产 profile 字节不变等。
- 每轮 4 次模型请求全部是本地 SSE 夹具，不转发真实 API。报告只记录用例、实际工具名、版本、哈希与脱敏 stderr，不保存模型请求体、Key 或桌面内容。
- 证据：`C:/Users/caidengfeng/.codex/visualizations/2026/10/24/01a16f76-c9b5-70c2-a81d-9b843307a01e/fatfish-m4-computer-capability-final-1|2|3/computer-capability-report.json`。

生产 profile 未改动，因此不重复运行付费 privacy；最近有效的两实例真实隐私/工具目录复验仍见 `M4_WORKSPACE.md`。本轮没有提交、推送、打包或部署。

## v1.x 再接入时的门禁

1. 先确定可交付且版本/许可证锁定的 Windows 提供者与依赖；不能因为当前 master 有包就升级锁定引擎。
2. 必须通过既有运行时审批，每次操作确认；不能借用 Codex 私有工具或绕过用户停止窗口操作的指示。
3. 在独立测试窗口与临时数据下验证目录、截图、坐标/DPI、点击、取消、恢复与“重新观察后确认结果”闭环；需要用户重新明确允许。
4. 请求体精确工具白名单、两实例隐私与来源隔离复验；不得把界面操控能力加进 external。
5. 真实驱动、截图图像路由与模型兼容性均未被本次文本夹具验证，不能省略。

下一步继续 M4-9 模型切换；M4 其余验收、干净 Win10/PowerShell 5.1、人格抽样、真实 QQ 与 M5 的原范围继续保留。
