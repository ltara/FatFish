# M5 收口：人格就地交互与示例一次性迁移

> 2026-10-26，未提交。未操作窗口、真实账号或实际用户数据，未调用付费模型。用户随后允许仅在临时目录生成本地未安装测试包，不运行界面、不安装/发布、不使用正式密钥；这不撤销窗口禁令。实际包验收另记，不将这里的普通元素/VM 当作原生验收。

## 1. 交互规范整改

旧 renderer 四处调用系统 confirm/alert。用实际函数和普通 VM window 替身复现，证据 `fatfish-persona-dialog-before/repro.json`；没有真的打开弹窗。

- 新 `renderer/persona-actions.js`：删除在原按钮位置确认，捕获人格 ID；五秒到期、切换 ID/页面/面板即失效。Esc/取消返回焦点，超时只在焦点还在确认行时返回，不抢其他输入框。
- 确认后才调用实际 Main，等待时禁止重复删除和编辑保存/应用；迟到结果不关闭新编辑对象或覆盖新草稿。确认删除成功和后续刷新失败分开提示；未知结果引导返回列表核对，不自动重发。删除使用中的人格会提示已切换，删最后一个会提示恢复内置人格。
- 导入空输入/等待/失败全部就地 aria-live hint，失败保留素材；成功只进入草稿、不保存或应用。新输入、页面离开和销毁会使旧结果失效。
- 复用 owner-actions/owner-confirm、btn-row、ghost 按钮和 hint，无新 token/动效。boolean hidden 增加强制隐藏规则，避免组件的 flex/inline display 暴露 inactive 控件；不改变 until-found 语义。
- 当前实际 renderer 的系统 alert/confirm/prompt 调用数为 0。只做了静态 CSS/HTML 和普通对象验证，仍需原生焦点/键盘/缩放验收。

单纯的界面机制整改未强行归入 buglog 的五类入口。下方另一个真实数据缺陷有独立失败测试和根因，单独记录。

## 2. 删除示例人格复活：实际数据缺陷

实际 Main 联调发现删除示例后，列表数不降；初期无界循环测试已停止并改成有上限、必须单调递减的断言，未通过缩小用例绕开问题。仅终止已核实身份的测试 Node 进程，临时目录按绝对路径前缀校验后清理，没有操作普通肥鱼窗口/进程。

`fatfish-persona-seed-before/repro.json` 证明：实际 `persona-lib` 删除返回成功，磁盘上该 ID 已消失，但下一次 `readStore` 又出现。`fatfish-persona-data-before-seed-fix` 保存实际 Main 的失败断言。

根因：补齐示例的迁移代码每次读取都执行，无法区分“从未初始化”和“用户主动删除”。三组历史检索（符号/症状/机制）均无命中，四项老坑条件无历史匹配/复发证据，不算老坑，不额外增加复发挡板。

修复：人格库新增 `samplesVersion:1`。新库初始化记录版本；旧库只补齐一次缺失示例，不覆盖相同 ID 的用户修改、正文、时间或当前选中项。已标记的库读取不再补齐，已存在的更高标记不降级。普通保存保留标记；删到最后一项时仍按既有契约恢复内置库。未修改人格后缀、工具、模型设置或权限。

## 3. 无窗口证据

证据根目录 `C:/Users/caidengfeng/.codex/visualizations/2026/10/24/01a16f76-c9b5-70c2-a81d-9b843307a01e/`，`fatfish-persona-final/` 以下各连续三轮：

| 检查 | 结果 | 范围 |
|---|---|---|
| persona-actions-check | 33/33 | 实际控制器、普通元素/假时钟；确认/期限/Esc/焦点、busy、迟到、失败/未知结果、只导入草稿、实际 HTML/renderer 接线与共享隐藏规则 |
| persona-store-check | 16/16 | 真实临时人格文件；新库/旧库迁移、样例删除持久化、全新 Node 进程重读、最后一项恢复、用户内容保留、稳定读取不改字节、更高标记保留 |
| persona-data-check | 13/13 | 实际 Main/解析器/人格存储 + 实际 renderer 初始化/面板/动作包装函数；壳和元素是替身，非完整 DOM/窗口 |

数据报告附 Main/preload/persona-lib/控制器/renderer/HTML/CSS SHA256。三轮另回归数据清理 22/15/17、向导挂载 9、八模块保护资源 41；当前向导真实 Core 数据链路 37 和 Core contracts 38 通过，均费用 0。后续为实际构建允许默认 dist 路径的保护检查新增一项（42），不与本节原 41 项报告混用。

命令（`app/electron-ui`，均无窗口）：`npm run persona-actions-check`、`persona-store-check`、`persona-data-check -- --evidence <独占绝对目录>`。未运行 smoke 或任何原生 UI 脚本。

规范依据：[HTML hidden 的样式覆盖规则](https://html.spec.whatwg.org/multipage/interaction.html#the-hidden-attribute)。原生交互与截图门禁仍待；本节不替代 M4-11 的 50 轮真实模型人格抽样。
