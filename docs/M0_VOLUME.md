# M0 体积闸门（2026-10-24 Asia/Taipei）

## 基线（主包，不含可选引擎）

| 路径 | 体积 | 备注 |
|------|------|------|
| 箱上 `dist/FatFish/` | **199 MB** | bin(node+napcat)≈199MB；app/docs/scripts 可忽略 |
| 箱上 `vendor/node` | 87 MB | 便携 Node |
| 箱上 `vendor/napcat` | 112 MB | 后台组件 |
| 云 Win `C:\FatFish` 工作树 | **≈3642 MB** | 含构建缓存/多份产物，**非**用户 Setup 口径 |
| 云 Win 安装 asar | `...\Programs\fatfish-electron-ui\resources\app.asar` | UI 壳；bridge 在 extraResources |

**M1 Setup 相对基线增量目标：0**（引擎不进必选包）。

## `@deepseek-ai/dsh@0.2.1-rc.2` 粗估（Linux 箱实测；Win 同数量级）

| 项 | 体积 |
|----|------|
| npm tarball | **25 KB** |
| `npm install --omit=dev` node_modules | **≈710 MB** 解压 |
| 同目录 tar.gz 压缩 | **≈113 MB** |

建议阈：未压 Setup **+≤80 MB** / 装后 **+≤150 MB**。

### 结论（标红）

**超阈。** 完整引擎侧载解压约 710MB ≫ 150MB，压缩包约 113MB ≫ 80MB。  
**先报不擅进 Setup。** M1 仅允许 AppData / `FATFISH_AGENT_ENGINE` 可选侧载；主包零增量。

## 历史方案（已作废）

M0/M1 的可选侧载开关已被 M2 固定运行时方案替代，M3-C 删除对应配置和 UI。当前以 ARCHITECTURE、ROADMAP 和 ELECTRON 为准，不再使用旧开关。
