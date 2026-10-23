# Windows 构建说明（内部）

目标产物：`installer/Output/FatFish-Setup.exe`（对外称「Windows 客户端安装包」）。

## 前置

1. Windows 10/11 x64
2. [Inno Setup 6](https://jrsoftware.org/isinfo.php)（含 ChineseSimplified 语言包）
3. 本仓库副本；可联网以下载 vendor

> Linux 开发箱可跑 `scripts/fetch-vendor.sh` 与组装逻辑校验，但 **ISCC / Setup.exe 须在 Windows 上打出**。不要伪造 exe。

## 步骤

```powershell
cd <repo>\fatfish-win-client

# 1) 拉第三方 Win 发行版 + SHA256 → vendor\MANIFEST.txt
powershell -ExecutionPolicy Bypass -File .\scripts\fetch-vendor.ps1

# 2) 桥依赖
cd app\bridge
npm install
cd ..\..

# 3) 组装安装树
powershell -ExecutionPolicy Bypass -File .\packaging\assemble.ps1

# 4) 编译安装包
powershell -ExecutionPolicy Bypass -File .\installer\build.ps1
```

成功后检查：

- `dist\FatFish\FatFish.bat`（入口，调托盘）
- `dist\FatFish\bin\napcat\`、`bin\node\`、`app\bridge\`、`app\shell\`、`app\web\`、`scripts\`
- `installer\Output\FatFish-Setup.exe`

## 冒烟（干净机）

1. 安装官方 QQ
2. 运行 `FatFish-Setup.exe`
3. 托盘 → 启动 → 打开设置 → 填 Key → 登录窗口扫码
4. 另一 QQ 私聊小号「你好」，应有回复
5. 对照 `docs/用户说明书.md` 验收项

## 入口说明

当前 v1 用 `FatFish.bat` 启动 `app\shell\FatFishTray.ps1`（Inno `MyAppExeName=FatFish.bat`）。后续可换成真实 `FatFish.exe` 壳并改 iss。

## 启动脚本行尾（必守）

Windows `cmd` 对 **纯 LF** 的 `.bat`/`.cmd` 会直接秒退，表现为「后台登录服务启动超时」。

仓库已固化：

- `.gitattributes`：`*.bat` / `*.cmd` → `text eol=crlf`
- `scripts/ensure-crlf.sh` / `ensure-crlf.ps1` / `ensure-crlf-node.js`：强制改写为 CRLF
- `fetch-vendor`（sh/ps1）解压后立刻跑 ensure
- `packaging/assemble.ps1` 写 `FatFish.bat` 用显式 CRLF，拷贝 vendor 后再 ensure
- Electron：`npm run dist` / `pack` 前自动 `ensure-crlf`

下次打 Setup **勿再带 LF**。非定版勿上传 COS。
