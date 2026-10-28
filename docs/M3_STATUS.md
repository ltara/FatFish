# M3-D 状态与错误验收

2026-10-25，Windows；当前工作区，未提交。模型与消息服务均为回环夹具，付费调用 0，未触碰真实 QQ。

## 先观察，再分类

`node spikes/m3-status/run.mjs` 运行锁定的 rc2；只在探针临时 overlay 禁用 `llm-retry`，不修改生产 profile。实际输出：

| 故障 | `turn/end.data.reason.error` | 分类 |
|---|---|---|
| HTTP 401 | `{code: "AUTH", status: 401}` | `invalid_key` |
| HTTP 402 | `{code: "QUOTA", status: 402}` | `insufficient_balance` |
| HTTP 429 | `{code: "RATE_LIMIT", status: 429}` | `rate_limited` |
| HTTP 404 | `{code: "SERVER", status: 404}` | `model_unavailable` |
| 回环连接被断开 | `{code: "TRANSPORT"}` | `network` |

以上 reason 的 kind 均为 `error`。`assistant/attempt.data.stream[]` 中还有 `type: chunk` → `chunk.type: finish` → `chunk.reason.failure` 的同类结构，可作后备。404 不能单凭状态区分模型名错误与接口路径错误，因此用户提示检查模型和接口设置，不断言服务商根因。

在请求进行中终止本次测试自己创建的引擎，客户端收到 `engine_exited` / RPC `dsh_exit_*`，分类为 `engine_crashed`。原始服务商错误文本和 stderr 不传入状态快照、不落日志；stderr 仅识别明确的传输 errno。部分文本之后若以 error 结束，不当作成功回复。

## 实现

- Core：`turn-errors.mjs` 分类，Router 选择中文伙伴口吻的安全回复；只上报分类元数据。
- 崩溃：自动重启并退避；一分钟内累计次数，连续多次中断可见；成功对话或稳定运行一分钟后清除累计。
- 首页：从实际渠道/self 快照判断连接，不再拿登录页面的缓存当在线；`core_stats` 提供今日私聊和最后成功回复时间。
- 托盘：首页与托盘共用 `renderer/status-view.js` 的策略；文字、菜单和状态色一致。状态事件经 main/preload 通知 renderer，不要求手动刷新。
- “已保存”不等于有效：出现 `invalid_key` 后密钥栏显示“无效”，不显示健康绿点；成功请求后自动清除旧失败。
- QQ 版本不匹配入口已预留，但实际版本检测仍在 M6；已根据锁定后台的实际 heartbeat 类补充账号 online 状态；夹具覆盖连接仍在但账号离线及恢复，仍不替代真机验收。

## 可复跑验收

1. `app/core`：`npm run error-check` **27/27**。真实 rc2 的五类失败、Router 回复、杀引擎及自动恢复、计数、结构后备、错误文本不误分类、对外工具仍为空。
2. `app/electron-ui`：`npm run status-ui -- --evidence <绝对目录>` **15/15**。实际 main/preload/renderer/Core/runtime 与原生 Tray，只有模型/消息服务是夹具；使用生产重试配置。覆盖 401、网络连接被断开、请求中杀引擎、恢复、实时统计、渠道断开、账号心跳离线/恢复、日志隐私。没有切断本机真实网络。
3. `check`、`smoke`、`contracts` **38/38**、`cleanup-check` **12/12**、跨进程 `lifecycle-ui` **11/11** 回归通过。

截图与 JSON 报告在本机 `.codex/visualizations/2026/10/24/01a16f76-c9b5-70c2-a81d-9b843307a01e/fatfish-m3d-evidence/`；目录日期沿用该聊天创建时间，不是本次验收日期。

本轮只观察/实现 M3-D，不代表 M3-E 真实 QQ 验收已通过，也不代表 M4/M5 已完成。
