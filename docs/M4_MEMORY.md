# M4 长期记忆核心验收

2026-10-25，Windows，当前工作区，未提交。**M4-1 核心已实现并验收；M4-2 记忆页、M4-4 公开资料编辑区已接通，视觉修正后最终复验仍待允许，不代表 M4/M5 已完成。**

## 实现与边界

- `memory-store.mjs`：Core 拥有的 JSONL 快照，三个固定范围 `owner`、`owner_public`、`diary`；ID、范围、文本、标签、创建时间、来源会话完整保存。关键词与标签匹配后按时间排序，最多返回 8 条；列表分页、导出由 Core 提供。
- `fatfish-memory.mjs`：两个独立实例都注册 `memory_save(text,tags?)`、`memory_search(query)`、`memory_forget(id)`。插件只把真实执行会话和参数转给网关，不持有数据、不写 stdout。
- `memory-service.mjs`：网关 token 决定实例，活跃执行上下文决定逻辑会话和可信渠道账号。外部调用再次检查 owners；在途解绑后不能继续读写。所有模型参数严格校验，不接受 `scope`、`instance`、`sessionId` 等越权字段。
- 主人私有事实可由 local 或已绑定主人的 external 会话保存到 `owner`、读取、删除。两者都可检索公开资料和日记；模型不能写入或删除公开资料。公开资料的写入仅有父进程 `memory_ui` IPC 入口，Main/preload/renderer 已完成接线且仅主窗口顶层 frame 可操作。auto 未实现，不会因为携带一个名字就获得访问权。
- 本记忆阶段新增三项工具后的白名单为 `memory_save`、`memory_search`、`memory_forget`。后续 M4-3 又加入三项提醒，当前精确六项见 `M4_REMIND.md`；仍不包含任何宿主文件、shell、网页、技能或子代理工具。`tool-contract.cjs` 是当前白名单，相关验收都检查精确相等；M3-A 当时的空白名单是历史结果，不是现在的工具清单。
- ROADMAP 原先“对外实例调用时模型无法指定 owner_public 以外的范围”的验收措辞与唯一架构 §7.2 的主人私有记忆共享规则矛盾；已按架构对齐为“模型不可指定范围，公开资料仅 UI 写入”，没有扩展为陌生人/自主实例可读私有事实。

## 删除与模型上下文

只删除 JSONL 条目不够：事实可能仍在旧模型会话里。因此删除、清空、修改公开资料时：

1. **先**原子推进 `memory/context-generation.json`，再改记忆文件；重启后仍读取此代号。
2. 立即使旧代号的插件上下文失效，然后停止旧 reader 进程。所有新的 turn 等待停止完成；启动/空闲停止期间排队的旧 turn 不能重新恢复旧代号。
3. 后续同一逻辑会话使用新的物理模型会话（如 `local-main-g2`）。审批、对话事件和结果对 UI 保持原逻辑 ID。
4. 在途旧结果被 Core 固定确认替代，不把可能带有已删事实的模型输出发回主人。模型自己调用 `memory_forget` 也能完成删除，不等自己所在的工具传输结束而死锁。

**这不是历史文件安全擦除。**旧 `chat/` 展示记录与 `dsh/*/sessions` 文件仍保留，但不再自动作为后续模型上下文恢复。记忆页删除确认必须明确提示会开始新的模型会话、旧显示记录保留；不能称其为删除全部聊天或擦除磁盘。用户主动重新说出事实或审批读取旧文件也不属于自动恢复保证。

损坏 JSONL/代号不静默覆盖，异常失败关闭；目录 junction 被拒绝。写入使用独占临时文件、fsync 和替换，仅清理本次写入的临时文件。条目上限 5000、文本上限 4000 字符、标签和检索结果有界。

## 验收

命令：`E2E_EXEC_PATH=<app/electron-ui/node_modules/electron/dist/electron.exe> npm run memory-check`（在 `app/core`）。

- **56/56，连续 3 轮**。真实 rc2、插件注册、回环网关与实际 Core IPC；模型输出是本地 SSE 夹具，**付费调用 0**，不是自然语言模型质量或真实 QQ 验收。
- 覆盖跨会话、跨独立进程、重启、模型伪造参数、绕过 schema 直接请求、公开资料只读、逐次本机审批与拒绝不保存、在途解绑、删除后同逻辑会话不含随机事实、重启不恢复、工具自删除、在途结果抑制、空闲停止竞态、损坏数据、junction、清空/导出、逻辑会话关联、日志不含正文和 Key。
- 回归 `contracts` **38/38**、`optional-channel-check` **18/18**、`cleanup-check` **12/12**、`identity-check` **43/43**、`error-check` **27/27**、`check`、Electron `smoke: window_ready`、`git diff --check` 均通过。
- 真实 Electron 本机 UI 回归 **34/34**，包括原生托盘、文件审批的允许/拒绝/超时、200% 可达性和渠道单独启停。证据目录：`C:\Users\caidengfeng\.codex\visualizations\2026\10\24\01a16f76-c9b5-70c2-a81d-9b843307a01e\fatfish-m4-memory-core-regression`。这不是尚未实现的记忆页验收。

### profile 隐私复验

按用户之前允许的少量模型调用，本轮执行 `spikes/m2-dsh/run.mjs privacy fatfish-external|fatfish-local`：每实例 **2 次真实模型请求，共 4 次**。两实例均通过：会话日志字段 0、插件清单字段 0、OTLP 0、采样未见引擎额外外连。`output_config` 是所观察到的额外模型参数，不是会话日志或插件上传字段。

元数据结果保存在 `C:\Users\caidengfeng\AppData\Local\Temp\fatfish-memory-privacy-91af975d89204a838f8ddc9e6ce673e0\external|local\results.jsonl`。代理请求体只在内存，不落盘。没有连接真实 QQ、没有操作实际用户文件，也没有重启正在使用的试用窗口。未来再次改 profile 后仍须重新实测，不能把这轮结果无限沿用。

两份元数据结果另外复制到本轮证据目录 `C:\Users\caidengfeng\.codex\visualizations\2026\10\24\01a16f76-c9b5-70c2-a81d-9b843307a01e\fatfish-m4-memory-core-evidence\external-privacy.jsonl|local-privacy.jsonl`，避免只依赖临时目录。

## 下一步

1. M4-2/4：等待用户允许恢复独立测试窗口操作后，复验静态评审后的删除目标核对、单层滚动/页尾可见、人格行减法；随后完整回归并完成独立 UX 路径。
2. 不操作窗口期间，M4-3 已完成 Core 与本机幂等收件数据/IPC 的无窗口验证，详见 `M4_REMIND.md`；实际提醒界面仍未验收。接着推进 M4-7～11 与 M5。M3-E 真实 QQ 验收仍未通过，不以夹具替代。

## M4-2/4 界面进度（2026-10-25）

- 已实现记忆页三个范围、100 条分页、长正文展开、单条就地确认删除、明确数量的本组清空、全范围 JSON 导出。数量在确认期间变化时，Core 拒绝清空并要求刷新，避免悄悄删掉新记忆。
- 人格页增加公开资料编辑，明确公开风险和模型会话重置；保存失败不清输入，后台通知不覆盖脏草稿，刷新与 Core 重启可读回。页面统一「人格」，应用后下一句生效；新安装的默认人格不再把 QQ 当作唯一使用场景，已有自定义人格不覆盖。
- Main/preload/renderer 全链路；读取、保存、删除、清空、导出全部限定主窗口顶层 frame。模型不获得公开资料写入口。导出文件由系统保存对话框选择位置，测试中使用临时目标/取消/失败夹具，尚不声称独立走查过原生保存对话框。
- 修正前功能联调 `npm --prefix app/electron-ui run memory-ui -- --evidence <目录>` **34/34，多轮通过**（`fatfish-m4-memory-ui-final-1|2|3` 等）；本轮最终修正前的实际 Core/运行时调用也为 34/34，覆盖本机记忆工具审批、写入后记忆页可读、人格应用后的实际模型请求，费用 0。证据目录基于本文件上方的 visualization 路径。
- 两次初期失败是验收脚本假设：renderer 重载后默认范围已回到 owner，不能未经切换就断言 public 被保留；存储已提交不等于界面异步读回已完成，已改为等待 loading 与 busy 均结束。没有把这两条归为产品缺陷，也没有削弱数据断言。

### 独立评审与停止边界

1. `/root/memory_visual_review` 静态评审指出：删除确认应保留目标和来源、普通尺寸页尾/双滚动、人格页重复状态与预览挤压公开编辑。代码已修正：确认重列目标/来源/范围；普通尺寸按剩余高度仅记录区滚动，200% 用整页滚动；人格行仅标题、单行摘要与操作，删重复预览/徽标/分隔，新建恢复次按钮。禁用保存有就地原因、危险确认问题句有明确语义。**修正后仅语法/diff 核对，截图与功能复验未运行，不能沿用旧图证明新布局通过。**
2. `/root/memory_ux_review` 仅完成记忆 → 公开资料；点击编辑后的结果未核实时，用户以 physical Escape 停止了 Computer Use。所有原生操作随即停止。该入口反馈列为待复核，没有判定为已复现缺陷，也没有称保存闭环已通过。
3. 独立报告与 2 张原生图位于 `fatfish-m4-memory-ui-ux-final/ux/`；静态报告在同级 `visual/visual-review.md`。这是存量扩展评审，未打分；UX 只部分完成。最初不可见的 QA 进程属于测试启动器 `windowsHide`，后已通过精确 PID/标题核对修正；未操作普通「肥鱼」用户窗口。两份旧保持窗口会话均正常退出 0。
4. 用户已明确选择「暂不操作窗口，继续代码和后台验证」；未获新的明确允许前，不再运行界面操作、Electron smoke 或 UI 验收，也不通过其他工具绕过 Escape。Core/语法等无需窗口的工作仍可推进。本界面轮次未连接真实 QQ、未做付费调用、未提交/打包/部署。后续提醒轮次另有少量已允许的隐私实测，见 `M4_REMIND.md`。
