# 交接说明（给接手开发的人或模型）

> 2026-10-25，最后提交 `6fa9366`（之后只有文档提交）。先读这份，再按顺序读：`CLAUDE.md` → `docs/ARCHITECTURE.md` → `docs/ROADMAP.md` → `docs/M2_DSH.md` → `DESIGN.md`。

## 1. 一句话现状

DSH 引擎已经接通，Electron → Core → DSH 这条链路在 Windows 上实测可用（e2e 15/15 通过，Core 用 Electron 的 Node 模式运行，和打包后一样）。但是**当前是单实例 + 带工具**，而且没有设置主人的界面，所以真实的 QQ 渠道**不会回复任何人**。**下一步是 ROADMAP 的 M3-A**（三实例框架、对外实例无工具），完成之前不要放行真实渠道。

## 2. 已完成的提交

| 提交 | 内容 |
|---|---|
| `cac73af` | 产品重新定位为 AI 伙伴；ARCHITECTURE 第 1 版、CLAUDE、DESIGN |
| `be412e3` | M2 DSH 技术验证：`spikes/m2-dsh/`；`fetch-vendor` 接入 DSH（固定 SHA256） |
| `d2f2b96` | M3-1：`app/core`（EngineHost、Router、QQ 渠道、e2e） |
| `6fa9366` | M3-2：Electron 以 fork + IPC 启动 Core；打包包含 `core/` 和 `vendor/dsh` |
| （本次） | 文档：ARCHITECTURE 第 2 版（三实例）、ROADMAP、HANDOFF、CLAUDE、DESIGN |

## 3. 代码地图（只列需要知道的）

| 文件 | 状态 | 说明 |
|---|---|---|
| `app/core/server.mjs` | ✅ | 入口；**IPC 协议写在文件头注释里**，新增消息时同步修改 |
| `app/core/engine-host.mjs` | ✅ 单实例 | DSH 进程管理：每次启动覆盖安装 profile；去掉继承来的 `DSH_*` 等变量；崩溃后退避重启；key、人格、模型变化时重启；首次使用会话时 resume；串行执行各轮对话；审批回环服务（M3-A 要抽到 gateway） |
| `app/core/router.mjs` | ✅ 单实例 | 只放行 `config.owner_qq`（**没有界面能设置它**）；暂停；当日统计存 `runtime/stats.json`；出错时用伙伴口吻回复 |
| `app/core/channels/qq.mjs` | ✅ | OneBot WS，只连 loopback；发送用消息段，不用 CQ 码；长回复分段 |
| `app/core/dsh-client.mjs` | ✅ | JSON-RPC 客户端；`prompt()` 返回 `{ texts, events, endReason }`。**目前只传 `--profile`，M3-A 需要支持 `--patch`** |
| `app/core/profile/` | ✅ 单实例 | `cordis.patch.yml`（隐私、隔离、人格、时区、审批插件）+ `fatfish-approval.mjs`。M3-A 要拆成 `profiles/` 下的多个目录 |
| `app/core/dev/e2e.mjs` | ✅ | 假 OneBot 后台 + 真 DSH + 真 Key 的 15 项验收；`E2E_EXEC_PATH=<electron.exe>` 模拟打包后的运行方式 |
| `app/electron-ui/service-manager.js` | ✅ | fork Core，`getCore()` / `sendCore()`；**仍然会启动 8787**（M3-C 删除）；没有审批监听者时一律拒绝 |
| `app/electron-ui/main.js` | 部分 | `get-status` 已加入 `engine_state`、`channel_state`、`core_stats`、`last_turn_error`，**但 renderer 还没使用**（M3-D）；暂停和保存 Key 会通知 Core |
| `app/bridge/`、`app/shell/` | ❌ 待删除 | 已不再启动（bridge）或属于冗余组件（shell），M3-C 删除 |
| `spikes/m2-dsh/` | 参考 | `run.mjs` 中有**录制代理**，M3-A 的工具白名单验收要复用它；`pending.mjs` 用来检查哪些插件行卡在 pending |

## 4. 这台开发机的环境坑（Windows + Git Bash）

- **DSH 运行时**：`./scripts/fetch-vendor.sh` 会下载并校验。PyPI 的 CDN 走 HTTP/2 时会断，脚本里已经加了 `--http1.1 --retry`。`vendor/dsh/` 不进 git。
- **Electron 安装**：npm 源是 npmmirror，但 Electron 的 postinstall 会去 GitHub 下载二进制，导致 TLS 失败。要这样装：`ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install`。打包时还要加 `ELECTRON_BUILDER_BINARIES_MIRROR`（见 `docs/ELECTRON.md`）。
- **在 Git Bash 里调用 Windows PowerShell 5.1**：它会继承 PowerShell 7 的 `PSModulePath`，导致 `Get-FileHash` 找不到。要用 `env -u PSModulePath powershell ...`。
- **路径**：Git Bash 里 `/tmp` 实际指向 `%LOCALAPPDATA%\Temp`；把路径传给 Windows 程序时要用 `cygpath -w`（反斜杠）或 `cygpath -m`（正斜杠）。在 heredoc 或 `printf` 里写反斜杠路径会被当作转义字符（例如 `\v`）。
- **测试 Key**：环境变量 `DEEPSEEK_API_KEY` 已经设置。**绝不能打印或写入文件**。e2e 会检查日志里没有 Key。

## 5. 常用验证命令

```bash
cd app/core && npm install && npm run check
DEEPSEEK_API_KEY=… npm run e2e                                  # 约 1～2 分钟，15 项
E2E_EXEC_PATH="$(cygpath -w ../electron-ui/node_modules/electron/dist/electron.exe)" npm run e2e
cd app/electron-ui && npm run smoke                               # 语法检查，覆盖 Electron 外壳和 Core
# 调试 profile：
export DSH_EXE="$(cygpath -w vendor/dsh/deepseek-harness-sdk-runtime-win-x64.exe)" SPIKE_HOME="$(cygpath -w /tmp/dsh-spike-home)"
cp app/core/profile/* /tmp/dsh-spike-home/profiles/fatfish/ && node spikes/m2-dsh/pending.mjs
"$DSH_EXE" --profile fatfish --dump-config      # 需要设置 DSH_HOME；查看组装后的全部插件行
```

## 6. 必须遵守的规则（违反任意一条都是事故）

1. **外部渠道 → 只进对外实例，对外实例没有任何能接触本机的工具**（ARCHITECTURE §4.2）。改动 profile 后，必须用录制代理实测请求体里的 `tools[]`。
2. **主人身份只看绑定表**（平台上报的账号），不看消息正文，也不看提示词。
3. **profile 的隐私开关不能重新打开**：`session-log-deepseek`、`plugin-package-inventory-deepseek`、OTel、宿主机技能和指令。
4. **rc2 没有** `approvalRequests` / `user-question/ask`。不要参考 DSH master 分支的文档来写协议代码，以 exe 的实际行为为准（可以用 `grep -a` 在 exe 里搜字符串来确认）。
5. 日志只记录元数据；Key 不回显；自有插件不写 stdout。
6. 面向用户的文案遵守禁用词（CLAUDE.md）。
7. 版本全部锁定；不引入需要联网更新的依赖。
8. 提交信息格式：`type(scope): 中文描述`，结尾加上 Co-Authored-By。

## 7. 待用户决定的事项

见 ARCHITECTURE §16 的 D-1～D-10。**拿不到用户答复时按推荐方案执行，并在文档中注明「按推荐方案执行，待确认」。**其中 D-4（自由活动先接哪个平台）和 D-9（v2 怎么收费）只能由用户决定，不能替用户选。

## 8. 下一步的具体动作（M3-A 第 1 步）

1. 在 `dsh-client.mjs` 的 `start()` 中支持 `this.args`（附加参数），并在 EngineHost 中传入 `--patch <common.patch.yml 的绝对路径>`。先用 `--dump-config` 确认 `--patch` 写在 `--profile` 后面时能生效（CLI 帮助说明它属于启动器参数）。
2. 拆分 profile 目录，写 `fatfish-external` 的禁用清单，用 `pending.mjs` 逐行排查连带影响。
3. 把录制代理搬进 e2e，增加「对外实例 `tools[]` 为空」等 3 条用例（ROADMAP M3-A 验收）。
