# M2 DSH 技术验证报告（2026-10-25，Windows 实机）

> 内部文档。对应 `docs/ARCHITECTURE.md` §10 的 M2。原型代码在 `spikes/m2-dsh/`。

## 环境

- Windows 10/11 x64（Git Bash），系统 Node 22（仅用于运行测试脚本，DSH 不依赖它）
- DSH：PyPI `deepseek-harness-runtime-bin==0.2.1rc2` 的 `win_amd64` wheel，SHA256 `d38c18f5…1cb7`；exe 自报版本 `0.2.1-rc.2`
- 模型：`deepseek-official` / `deepseek-flash`，使用真实 Key
- `DSH_HOME` 为隔离的临时目录，profile 为自有的 `fatfish`（验证时在 `spikes/m2-dsh/profile/`，M3 已迁到 `app/core/profile/`）

## 结论速览

| # | 验收项 | 结果 | 说明 |
|---|---|---|---|
| ① | 多轮对话 + 重启后 `session/resume` | ✅ | 同一会话能记住随机口令；进程重启后 resume 用时 29～38ms，口令仍能答出 |
| ② | 替换人格 | ✅ | `system-prompt.personaPrefix` + `includeHarnessIdentity: false` 生效（「每句以咕噜结尾」测试通过） |
| ③ | 工具审批 | ✅（**需要自写插件**） | 见 §1。拒绝时不落盘，允许时写入成功 |
| ④ | 定时提醒 | ❌ → 方案 A | rc2 的 sdk profile 挂不上 `dsh-schedule`，见 §2；已决定自写提醒插件（M4） |
| ⑤ | 上传与遥测关闭 | ✅ | 用本地转发代理实测，见 §3 |
| ⑥ | 体积 / 冷启动 / 内存 | ✅ | 见 §4 |

## 1. 审批：rc2 的 SDK 不转发，改用 Cordis 插件应答

master 文档里写的 `initialize.approvalRequests: true` → 服务端发出 `approval/request` 请求，**在 rc2 里并不存在**（exe 中没有 `approvalRequests` 字符串，`user-question/ask` 同样不存在）。在 rc2 里，`approval/request` 只是**运行时内部的 Cordis waterfall 事件**；没有应答者时，默认结果是 `unavailable`，也就是按拒绝处理（fail-closed）。

做法：`profile/fatfish-approval.mjs` 是一个约 60 行的 Cordis 插件，通过 patch 的 `insert` 挂载。它监听 `approval/request`，经 `127.0.0.1` 回环 HTTP（带 Bearer token）询问 Core，再把 Core 返回的 `allowed-once` / `rejected` / `cancelled` 交回 DSH。任何异常、超时或拿不到 Core，一律返回 `rejected`。

- **权限判断仍然 100% 由 DSH 做出**：沙箱拦下越界写入后，模型申请提权，DSH 才发起审批。插件只负责回答。
- 请求里带有 `sessionId`、`toolName`、`callId`、`reason`，以及 **`displayReason.zh`**，例如「允许本次操作使用 danger-full-access 权限：该文件位于会话工作区之外……」。这段文字可以直接用作审批弹窗正文，§11-4 的疑问得到解答。
- `workspace-write` 默认允许写**工作区和 `%TEMP%`**，这两处写入不会触发审批。

## 2. 定时提醒：rc2 的 sdk profile 挂不上（已决定：方案 A）

exe 里确实打包了 `dsh-schedule` 和 `dsh-tool-schedule`，但 schedule 依赖一条服务链：

```
schedule → sessionController → fileUploads → connection（web 客户端连接，依赖 webStartup）
```

也就是说，要用 schedule，就得把 **Web Host 整个**拉进 sdk runtime，还会多开一个 HTTP 监听端口。因此判定不可行，相关行已从 profile 中撤回。`time-context` 可以单独挂载，时区为 Asia/Shanghai，工作正常。

**可选方案**：
- **A（推荐）**：肥鱼自己写一个提醒工具插件，和审批插件同一种机制。它向模型暴露 `remind_create/list/delete`，数据存在 FatFish 的数据目录里；到期后由 Core 向原会话发一条 `session/prompt`（例如「[提醒到期] 喝水」），伙伴照常生成一句话发到 QQ。预计工作量为 1～2 天，可以放进 M4。
- B：v1 不做主动提醒，以后再说。

**2026-10-25 决定采用 A**，设计见 `docs/ARCHITECTURE.md` §3.4。

## 3. 隐私：实测结果

方法：设置 `DEEPSEEK_BASE_URL`，让模型请求经过本地转发代理（代理再转发到 `api.deepseek.com`），检查每个请求体中的字段；把 OTLP 地址指向一个本地接收端；同时每 1.5 秒采样一次 DSH 进程的 TCP 连接。

| 项 | 默认 sdk profile（对照组） | fatfish profile |
|---|---|---|
| `dsh_session_log`（会话日志上传） | **2/2 个请求都带** | 0 |
| `dsh_plugin_packages`（本机插件清单） | 带 | **0**（新发现，已关闭） |
| OTLP 遥测请求 | 0（默认模式只在用户反馈时上传） | 0（已设为 `DISABLED`） |
| 除模型请求外的出站连接 | 无 | 无 |

对照组证明探针能检测到上传，所以 fatfish profile 下的 0 是可信的。仍然会发送的非标准字段只有 `output_config`（请求参数，不含用户数据）。`.anonymous-user-id` 会写在 `DSH_HOME` 下。

**隔离方面的新发现**：默认的 `skill-filesystem` 会扫描宿主机的 `~/.agents`、`~/.dsh` 和项目目录。测试中，模型把**这台开发机上安装的飞书、企微技能**当成了自己的能力。默认的 `agent-instructions` 也会读取宿主机上的 AGENTS.md。这两项都已在 profile 中关闭：`includeDefaultRoots: false`、`maxBytes: 0`。关闭后只剩 DSH 自带的一个 Windows 沙箱诊断技能。

## 4. 体积与性能

| 项 | 实测 |
|---|---|
| wheel（压缩） | 83.9 MB |
| 解压后（exe + rg） | **278.6 MB**（273.2 + 5.4）；ARCHITECTURE 中「84～150 MB」的估计偏低 |
| 冷启动（spawn → `initialize` 返回） | 806～835 ms |
| 常驻内存（WorkingSet） | 204～218 MB |
| 一轮「你好」的输入 token | 默认约 3.9k 未命中缓存 + 5.8k 命中；关闭技能与外部指令后为 **579 未命中缓存 + 5.8k 命中** |

安装包预计增加约 80～90 MB（NSIS 压缩率需要打包实测），安装后增加约 280 MB。

## 5. 对实现的其他影响

- **事件结构**：回复文本在 `session.event` → `event.data.message.content[]` 的 `type: "text"` 块中，另有 `type: "reasoning"` 块需要跳过。一轮对话以 `session.status` 从 `running` 变为 `idle` 为结束标志。
- **工具集偏「编程」**：默认有 25 个工具（pwsh、web_search、subagent、workflow、goal、plan 等）。伙伴场景可以在 M4 裁剪，以降低 token 消耗和误操作风险。`web_search` 会使用 DeepSeek Key 调用 DeepSeek 的搜索 API。
- **Windows shell 使用 `pwsh`**（PowerShell 7）。本机装有 PowerShell 7，所以没有验证在**只有 5.1** 的干净系统上是什么表现，§11-2 仍然待定，需要到干净的 Win10 上实测。
- **人格要说明对话是连续的**：resume 之后，模型能答出口令，却自称「重启后不会记得」。人格提示词需要告诉它对话是连续的。
- **模型会自己建「记忆文件」**：有一次，模型主动在工作区写了 `memory.md`（工作区内写入不需要审批）。长期记忆方案（M4）要考虑把这种行为规范下来，或者禁止。
- **开发环境的小坑**：从 Git Bash 调用 Windows PowerShell 5.1 时，会继承 PowerShell 7 的 `PSModulePath`，导致 `Get-FileHash` 等 cmdlet 找不到。在 Git Bash 里运行 `fetch-vendor.ps1` 前需要先 `env -u PSModulePath`，直接在 PowerShell 里运行不受影响。

## 6. 复现

```bash
./scripts/fetch-vendor.sh                       # 现已包含 DSH（固定 SHA256，校验失败则退出）
export DSH_EXE="$(cygpath -w vendor/dsh/deepseek-harness-sdk-runtime-win-x64.exe)"
export SPIKE_HOME="$(cygpath -w /tmp/dsh-spike-home)" DEEPSEEK_API_KEY=…
mkdir -p /tmp/dsh-spike-home/profiles/fatfish && cp app/core/profile/* /tmp/dsh-spike-home/profiles/fatfish/
cd spikes/m2-dsh
node pending.mjs                                # 期望输出 all entries active
node run.mjs boot|persona|memory|resume|privacy
node run.mjs approval fatfish reject|allow      # 会在 %USERPROFILE%\fatfish-spike-outside 写入或清理探针文件
```
