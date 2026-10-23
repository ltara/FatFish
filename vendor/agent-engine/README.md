# 本机助手引擎（试验）— 可选侧载

**不进入主 Setup 必选包。** 默认 `agent_engine.enabled=false`，伴侣 completions 路径不变。

## 钉版本

建议侧载 `@deepseek-ai/dsh@0.2.1-rc.2`（见仓库 `docs/M0_VOLUME.md` 体积闸门）。

## 放置位置（任选其一）

1. `%AppData%\FatFish\agent-engine\`（推荐，与安装包分离）
2. 环境变量 `FATFISH_AGENT_ENGINE` 指向目录
3. 开发态仓库 `vendor/agent-engine\`（本目录；**勿打进 Setup**）

## 最小入口

目录内提供其一即可被 bridge 识别：

- `run-headless.mjs`（薄封装 / 联调 mock）
- 或 `node_modules/@deepseek-ai/dsh` 本地安装
- 或 `dsh` / `dsh.cmd` 可执行文件

M1 第一刀：**零工具**；`spawn` / 超时 / 崩溃 → 自动回退现有 completions。
