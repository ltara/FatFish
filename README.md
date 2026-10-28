# FatFish Win Client（内部）

Windows 免托管纯客户端。对外交付物名称：**FatFish-Setup.exe**（Windows 客户端安装包）。

## 产品对齐（v1）

- Win-only、免 Docker、用户自备 API Key
- 数据与 Key 不出本机；非多租户托管
- 买断价 ¥99（闲鱼/产品文案用，本仓库不写定价页）
- **用户说明书 / electron-ui 禁止出现**：QQNT、NapCat、OneBot、肥鱼桥、Docker
- 正式入口为原生「肥鱼」窗口（**Electron**），不在系统浏览器打开设置/登录

## 目录

| 路径 | 说明 |
|------|------|
| `docs/用户说明书.md` | 给用户看的中文说明（术语已脱敏） |
| `docs/DEV.md` | 开发内部说明 |
| `docs/ELECTRON.md` | **Electron 正式 UI** 开发与云机打包要点 |
| `app/electron-ui/` | **正式桌面壳**（Electron，状态/设置/登录） |
| `app/core/` | 伙伴核心、隔离引擎、消息路由和插件网关 |
| `scripts/` | fetch-vendor / start / stop / doctor |
| `vendor/` | 构建时下载（`MANIFEST.txt` 入库；二进制忽略） |

## 本机数据布局（安装后）

```
%AppData%\FatFish\
  config.json
  persona.txt
  secrets\deepseek_api_key
  secrets\local_token
  logs\
  runtime\
```

## 快速构建（Windows）

见 `docs/ELECTRON.md`。摘要：`fetch-vendor` → `npm install`（`app/core`）→ `npm run dist`（`app/electron-ui`，仅 Windows）。
