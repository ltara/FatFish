# M4-3 提醒后台实现与验收

2026-10-25，Windows，当前工作区，未提交。**Core 提醒后台与本机幂等收件数据链路已实现并通过无窗口验证；实际窗口中的提醒与真实 QQ 收信尚未验收，不代表 M4-3/M4/M5 全部完成。** 用户已选择「暂不操作窗口，继续代码和后台验证」；本轮只运行 Node/Core/运行时及回环夹具，没有打开或操作测试窗口。

## 代码与数据

- `reminder-time.mjs`：绝对时间、相对时长、五字段 cron；无时区的完整日期时间按上海 `+08:00` 解释，显式时区按输入解释，内部 UTC 毫秒。支持列表、范围、步长、月份/星期英文简称；月日和星期同时受限时按 OR，遵循 [Cronie 上游手册](https://raw.githubusercontent.com/cronie-crond/cronie/master/man/crontab.5)。不解析命令、环境变量、随机扩展或第六字段；没有 OS 计划任务、eval 或 shell。不存在的日期/无匹配日历拒绝。单次最短 1 秒，重复最短 1 分钟，不任意把绝对日期限制为十年。
- `reminder-store.mjs`：`%AppData%/FatFish/reminders.json`，原子快照 + fsync，含来源、时间表、最近活跃收件渠道和发送 outbox。最多 500 条，文本最多 1000 字符；坏 JSON/非法记录失败关闭，不覆盖；无依赖升级。日志不写正文或 Key。
- `reminder-service.mjs`：模型工具身份检查、到期收集、串行派发、暂停和恢复；`reminder-dispatch.mjs`：可信模型/渠道/父进程适配。
- `fatfish-remind.mjs`：只注册 `remind_create(when,text,repeat?)`、`remind_list()`、`remind_delete(id)`。source、实例、收件人不能由模型参数决定；模型只能从所属活跃会话经 token 网关调用，定时触发的上下文不能再创建提醒或写记忆。
- 当前 external 的实测 `tools[].name` 严格为：`memory_save`、`memory_search`、`memory_forget`、`remind_create`、`remind_list`、`remind_delete`。`tool-contract.cjs` 统一白名单；没有宿主文件、shell、网页、技能或子代理工具。

## 信任与派发

1. 记录创建时，由 Core 取真实逻辑会话及平台身份；发送前再次确认来源账号仍绑定，解除绑定阻止待发送提醒。模型不能用参数把 external 提升为 local，或指定另一个收件人。
2. **来源实例不随收件渠道改变。** 外部创建的提醒始终给 external 原会话发 `[提醒到期]`；主人随后回到电脑，只会把生成结果交给本机收件箱，不把远程文本送进 local 模型。原 external 已因关闭 QQ 而停止时使用 Core 固定提醒回退，不为此重启 external。
3. 最近活跃渠道只由真实主人入站消息/本机 `chat_send` 更新，不认消息正文。最新远程渠道被关闭或解绑时回退本机；启用但离线则保留到期消息等待恢复。
4. QQ 启用时沿用暂停语义：到期照常落队列，不生成或发出；恢复后一次性提醒补发，周期只补最近一次。QQ 关闭时，旧远程暂停标记不阻塞纯本机提醒。渠道恢复、恢复自动回复、完成本机交谈会唤醒待发队列，不必空等离线退避。
5. 到期生成只负责提醒文本，不允许执行操作。网关拒绝 scheduled 上下文的审批/插件调用；记忆/提醒服务也单独拒绝。local 运行时即使曾明确获准写同一路径，定时轮次也无法借用旧授权、不会把审批请求转给父进程。

## 恢复与不确定结果

- 到期先持久化 occurrence ID（提醒 ID + 到期 UTC 毫秒），生成前写 `generating`，生成成功的文字先写 `generated`，再发送。暂停或明确未发出时复用缓存文字，不重新付模型费用。
- 生成中重启无法确认原调用结果时，恢复为明确的 Core 文本回退，不重复调用模型；无 Key/生成失败/记忆重置中断同样可回退为「提醒：原内容」。这是错误恢复，不冒充模型正常生成。
- 渠道回复包含成功状态、`retcode=0` 和消息 ID 才记为已确认接收，不等于主人已读。已发帧但没有确定回执时标为 `uncertain`，重启后不自动重发或重生成；`remind_list` 会暴露状态供主人核对。没有宣称非幂等渠道可以做到绝对 exactly-once。
- 本机使用 `reminder_delivery` → `reminder_ack` IPC，固定 delivery ID。**Main 使用生产 `reminder-inbox.js` / `reminder-controller.js` 先幂等持久化，再 ack**；Main/preload/renderer 接线已实现。最新 Core 验证使用生产数据适配器，不再用直接 ACK 的父进程夹具；但 Node 验证不证明窗口中已经可见。
- 删除提醒会在生成后再次检查，丢弃在途结果；已经交给渠道的消息不能撤回。删除记忆不会悄悄取消独立设置的提醒，应分别取消。

## 验收（无窗口）

### 当前命令

```bash
# app/core
npm run reminder-check
E2E_EXEC_PATH=<electron.exe> npm run reminder-runtime-check -- --evidence <绝对目录>
E2E_EXEC_PATH=<electron.exe> npm run inbox-runtime-check -- --evidence <绝对目录>
npm run channel-lifecycle-check
npm run check
# app/electron-ui：都是普通 Node，不启动窗口
npm run inbox-check
npm run inbox-main-check
```

- `reminder-check` **43/43**：时间与 cron、暂停、重启、周期追赶、在途删除、缓存复用、未知回执、生成中断回退、解绑、伪造来源、定时调用拒绝、不可用后唤醒、坏数据不覆盖。使用可注入时钟，不冒充逐个等待真实周期。
- `reminder-runtime-check`：上一轮父进程夹具 **20/20，三轮实际 60 秒通过**；本轮改用生产收件数据/控制器，增加持久化、重放去重和 Core 重启不丢收件记录三项，**23/23，连续三轮**。真实 Core + rc2 + 插件/网关/计时器；每轮创建到期差精确为 60000ms，迟到分别为 794/762/682ms，没有提前投递。保留真实 10 秒渠道丢回执、暂停重启/补发、latest route、关闭 QQ、先获允许写临时文件再验证定时轮次无法写、未知回执不重试。模型与消息后台仍是回环夹具，**付费调用 0，不是真实 QQ 或原生界面验收**。
- `inbox-check` **41/41**：原子落盘后 ACK、持久化去重/高水位、坏数据不覆盖、保存失败与磁盘恢复、容量反压、跨新开对话的未展示记录、preload 无 Core ACK 入口、打包包含实现文件。
- `inbox-main-check` **15/15**：实际 `main.js` 在 Node VM 中运行，只有 Electron 壳对象为夹具；验证实际 IPC handler 的顶层窗口鉴权、隐藏/最小化/无焦点不能标展示、新开对话/重放、普通聊天不被坏收件数据阻断、接收不抢焦点和退出清理。**没有启动 Electron，也不是窗口功能验收。**
- `inbox-runtime-check` **16/16，连续三轮**：真实 Core + 生产收件数据/控制器；未握手不生成、不投递；丢掉一次落盘后的正 ACK，Core 重启重放不重复展示/生成；损坏期间不新生成、修复后恢复；满箱不生成，展示释放容量后补发；不拉起 external、不转发审批、不产生 `chat_send`。测试容量缩到 2 条以快速覆盖反压，生产容量仍为 2000。每轮 3 次模型请求全在回环夹具，费用 0。
- 添加恢复唤醒后的最后一轮快速诊断也有独立目录；`--fast` 会改为 5 秒，因此明确不作为真实一分钟验收的替代。
- 回归 `contracts` **38/38**、`memory-check` **56/56**、`identity-check` **43/43**、`cleanup-check` **12/12**、`optional-channel-check` **18/18**、`error-check` **27/27** 与语法/diff 检查通过。遵守停止界面操作的决定，没有执行 Electron smoke 或 UI 验收。

证据基目录：`C:/Users/caidengfeng/.codex/visualizations/2026/10/24/01a16f76-c9b5-70c2-a81d-9b843307a01e/`。

- 三轮完整结果：`fatfish-m4-reminder-final-1|2|3/reminder-runtime-report.json`，只保存用例名、时间差、状态协议元数据，不保存模型请求体/Key。
- 生产收件数据整合后的结果：`fatfish-m4-inbox-final-1|2|3/reminder-runtime-report.json`，`inbox` 明确标记 `production-data-controller-in-Node-not-Electron-UI`，不把 Node 适配器说成已操作真实窗口。
- 恢复/反压：`fatfish-m4-inbox-recovery-1|2|3/inbox-runtime-report.json`；记录用例布尔结果、模型请求数量（全是回环）、容量和 ACK 故障类型，不记录正文或 Key。
- 补唤醒后的快速诊断：`fatfish-m4-reminder-final-wake/reminder-runtime-report.json`，须看 `fast: true`，不能冒充一分钟结果。
- 上轮 profile 变化后的 privacy：`fatfish-m4-reminder-privacy/external.jsonl|local.jsonl`。各 **2 次真实模型请求，总计 4 次**；两实例会话日志字段 0、插件清单字段 0、OTLP 0，采样未见额外出站连接。请求体只留内存，不涉及真实 QQ 或实际用户文件。**本次本机收件链路轮次没有修改 profile，不重复付费，实际付费调用 0。**

### 调试边界

最初的耐久确认断言错误地把后台已收到帧当成 Core 已落盘确认，现已等待实际 `last.state`；未将该夹具时序问题写成产品缺陷。曾有一轮重新接入渠道时超时，原现场不足以直接归因；另行最小复现确认了下述重连缺陷。没有把所有超时都未经证据归到同一根因。

## 已修复的渠道启停缺陷

- **判定依据**：`channel-lifecycle-check` 修复前稳定得到 3 条连接，预期启动一次、关闭后再启动一次只能有 2 条。影响主动关闭后快速重新启用的生命周期，测试仅连回环假后台。
- **历史检索**：分别查文件/符号、`3 !== 2`/重复连接症状、`reconnectTimer`/stop-start 机制，均无历史文件或命中。不属于高置信老坑；根因、边界、触发映射、复发链路四项均没有旧记录可证明一致。
- **根因**：主动 stop 导致 close 后仍无条件排一个未跟踪的重连 timer；重新 start 恢复 `closed=false` 后，旧 timer 再创建第三条连接。
- **最小修复**：QQChannel 跟踪 timer，start/stop 清理，只有非主动 close 才安排重连。没有加通用新锁或扩展到其他模块；不保证任意重复调用 start 或非幂等渠道发送的绝对去重。
- **验证**：修复前 `3 !== 2`，修复后最小回归连续 3 次均 2 条连接；上述三轮完整提醒回归通过。没有操作真实 QQ。
- **记录**：`.buglog/bugfixes.jsonl`，`2026-10-25-001` / `lifecycle_order`；`where` 为 `app/core/channels/qq.mjs` 的 start/stop 与 close 回调，关键词 QQChannel、reconnectTimer、stop/start、重复连接，refs 指向该回归脚本。
- **挡板**：无高置信老坑，不额外添加挡板；timer 生命周期修复本身即为本次最小必要修改。

## 本机生产收件链路

- `app/electron-ui/reminder-inbox.js` 把消息与去重高水位放在同一个 `inbox/reminders.json` 事务内，独占临时文件、fsync、原子替换。避免分别写聊天记录与 ACK 表时跨文件半提交。坏 JSON/非法 hash/目录链接失败关闭，不覆盖原数据。
- Core 启动时本机可用性默认 `false`；无正文的最多 500 个提醒 ID 目录同步成功后，Main 才上报 `reminder_inbox_status`。新增/删除提醒、Core 重启均重新同步；失联撤销目录。只有 Main/controller 能确认接收，renderer 只能请求标记已展示。
- 每个提醒保留最新 occurrence 的高水位，同 occurrence 重放不重复写盘/展示、内容冲突拒绝，更早周期重放忽略；清理展示历史后仍能去重。目录删除只回收该提醒的 receipt，不删除已到达的消息。
- 生产最多 2000 条总消息；保留最近 400 条已展示历史，未展示消息不因裁剪而静默消失。满箱会报告不可用，让 Core 保留 outbox、避免新生成；展示释放容量再唤醒。磁盘写失败负 ACK，5 秒重试探针仅在读校验通过后原子写回原数据，确认恢复后才重开收信；坏文件不能用探针清空。
- 到达窗口的数据是**仅展示**记录，通过 `chat-get` 合并，不写 SDK 会话历史、不写普通聊天 JSON、不触发本机模型。远程来源的文字不能因此获得本机工具权限。
- 未展示消息跟随下一次新开对话；在实际展示的对话标记后，不再出现在之后的新对话。标记要求主窗口顶层 frame、窗口可见、未最小化且有焦点，renderer 也要求对话页活动/文档可见。这里的「已展示」不是「主人已读」，没有已读保证。
- 接收不会主动显示或聚焦窗口；首页与侧栏未展示计数复用现有组件。尚未实现 Windows 系统通知，本轮也未验证真实窗口可见性、布局、托盘提示或系统通知权限；这些不能算已通过。

## 仍待完成

1. 本机 Main 的幂等收信落盘/ack 与 preload/renderer 接线已完成无窗口验证；在用户允许前，不执行 Electron smoke 或原生 UI 验收。
2. 获明确允许后的本机实际可见提醒、重启/新开会话、保存失败/重放等界面验收，以及最小化后的提示方式检查；当前没有 Windows 系统通知实现。
3. M3-E/提醒的真实 QQ 小号验收，不能用本地后台代替；M4-7～11 与 M5 全部仍保留原要求。
