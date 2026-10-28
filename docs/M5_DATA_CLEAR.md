# M5 收口：数据清理契约修复

> 2026-10-26，共享工作区未提交。仅临时目录、普通元素/VM、隐藏 Node/PowerShell 与真实 Core/SDK 的回环测试；没有操作窗口、真实 QQ 或实际用户数据，没有付费、正式安装包、部署或提交。原生确认控件/键盘/缩放仍未验收。

## 1. 缺陷证据和既定契约

ARCHITECTURE §14 要求清理会话、记忆、提醒、活动和伙伴房间，Key/许可证单独确认；DESIGN §9.13 禁止系统 confirm。旧实际 Main 的 VM 复现：`clearLocalData(true)` 返回成功、未单独授权就删除旧 Key、聊天记录仍在、未先停后台。

修复前证据 `fatfish-clear-before/repro.json` 与 `main-source.json` 保留了实际 Main 结果和源码哈希；不是仅静态猜测。三次独立 buglog 查询（入口符号、症状、机制）均无命中，不是老坑复发，不额外增加复发挡板。

## 2. 当前行为

- 点击「清空」只打开同块的范围确认；读取 Main 的当前应用数据项数量，不自动删除。两项 checkbox 默认未勾选，分别决定模型 Key 和本机激活信息。取消重置勾选；最终按钮明确「清空并退出」，不再用系统弹窗。
- Main 只接受完整、严格布尔的 `{confirmed:true, includeKeys, includeLicense}`；旧 boolean、truthy、未知字段和路径参数都拒绝。预览仅返回 count，没有路径、Key、账号或正文。身份仍要求主窗口顶层 frame、许可证和基础告知；清理失败后的同进程显式重试可继续清理，不开放模型或其他数据入口。
- 有正在进行的保护 IPC（包括本机对话、保存、连接测试）就拒绝清理，避免迟到结果重新写盘。开始清理后锁住其他操作，注销提醒控制器、忽略旧 Core 的进度回执；等待已在启动的服务结束再停机，禁止这个 ServiceManager 再启动。确认直接托管进程退出后才开始删除。后台未能安全停止时，明确报告“未开始清理”，不假称已停止。
- 清理已知应用数据：人格、主人绑定/设置、首次设置进度、展示聊天、全部实例会话/状态、记忆、提醒/收件、活动、伙伴房间、日志、运行标记和自有访问 token。
- 默认保留当前/旧模型 Key、许可证。为了不把自定义 Key 发到错误服务，保留关联的标准化模型路由、版本和 Key 指针；config 其他内容删除。先原子写入这个保留配置，失败时还没删其他数据。配置坏了、无法安全保留时拒绝；用户可以修复配置，或另行选择清除模型 Key 后重试。
- 明确选择 Key 清理才删除所有自有 `model-<UUID>.key` 与旧 Key；明确选择激活信息清理才删除 `activation-display.json` 和 `license.json`，且许可证最后删除；默认随许可证保留尾号显示元数据。无关 secret/未知文件不扩大删除范围。
- **不删除任何工作区文件**（包括默认目录里的文件），不追踪目录链接，不清理 QQ 客户端本身的登录状态；只清空肥鱼的绑定/渠道配置。根目录或 secrets 父目录是链接时拒绝；应用数据内部的 junction/链接仅移除链接，外部目标不动。
- 修复后台启动器父进程日志 FD 未释放，以及 Core fork 失败路径的 FD 释放，避免后台已退出但 Windows 日志文件仍被父进程占用。
- 成功清空内存进度/登录缓存后退出，不自动重开窗口；下次手动启动从真实磁盘状态重新进入激活/基础告知/首次设置。没有继续沿用旧对象重启 Core。

**失败边界**：多文件删除不是整批可回滚事务。逐项失败就停止并报告可能部分清理，不吞错或返回成功；后台/其他写入口在当前进程内保持锁定。重试仍需再次显式确认，不自动重试。退出或机器断电后不承诺自动恢复清理，用户需按实际剩余数据核对；不会把失败当成已全部删除。

## 3. 验证范围

证据根目录：`C:/Users/caidengfeng/.codex/visualizations/2026/10/24/01a16f76-c9b5-70c2-a81d-9b843307a01e/`。

`fatfish-data-clear-final/` 以下各连续三轮：

| 检查 | 结果 | 实际范围 |
|---|---|---|
| data-clear-check | 22/22 | 临时真实文件系统；默认/独立 scope、路由保留、Windows junction 不追踪、根/文件类型拒绝、写失败、部分删除失败和显式重试 |
| data-clear-main-check | 15/15 | 实际 Main/preload、VM 壳；顶层 frame、严格请求、在途命令、停机失败不删除、写入口锁定、独立 Key/激活选项、退出而非重开 |
| data-clear-view-check | 17/17 | 实际控制器与普通元素；无自动动作、取消、旧预览丢弃、范围独立、busy、固定错误、实际 HTML/renderer 接线 |
| data-clear-runtime-check | 14/14 | 实际 ServiceManager/Core/rc2 和回环模型；在途启动顺序、仍活着的托管 PID 拒绝、两类启动 FD 释放、实际聊天后停止，Windows 进程清单确认本测试 SDK 从 1 到 0，真实会话/日志移除后保留 Key/许可证/用户文件 |

另对当前 Main/ServiceManager 重跑：首次向导数据链路 37、八模块保护资源夹具 41，各连续三轮；对应 `onboarding-1|2|3/`、`protection-1|2|3/` 报告，不再拿改动前的源码哈希冒充当前证据。原生窗口与 DOM 仍未运行。

同轮回归：向导 store 27、view 24、实际挂载 9、模型表单 31、激活/告知 15、许可证 Main 12 各三轮；模型 Main 17、工作区 Main 21、收件 Main 15；Core contracts 38、身份 43、旧路径清理 12、可选渠道 18、模型 57。98 个自有模块语法和静态 HTML ID 唯一检查通过；未执行会开窗口的 smoke。

```powershell
# 在 app/electron-ui 中；均不打开窗口，数据仅在独占临时目录
npm.cmd run data-clear-check
npm.cmd run data-clear-main-check
npm.cmd run data-clear-view-check
$env:E2E_EXEC_PATH = '<electron.exe 绝对路径>'
npm.cmd run data-clear-runtime-check -- --evidence '<独占绝对目录>'
```

## 4. 未替代的门禁

实际清理控件/退出路径的原生交互、激活/首次向导和其他已改 UI、真实 QQ、干净 Win10/PowerShell 5.1、50 轮人格抽样、正式激活配置和安装包均仍待。后续人格编辑/导入的四处系统 confirm/alert 也已整改，renderer 调用清零，并修复示例删除复活，见 M5_PERSONA.md；仍未进行原生窗口验收，不能用普通元素断言实际显示/焦点通过。
