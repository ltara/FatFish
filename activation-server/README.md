# 肥鱼激活服务（M5-1）

服务端专用，**不进客户端安装包**。Workers + D1，只处理激活码哈希、设备指纹哈希和许可证签发；不接收模型 Key、聊天、记忆、MachineGuid 或磁盘原始序列号。当前只完成本地验收，未创建远程资源、未部署。

## 1. 版本与本地验收

- 开发机 Node >=22；仅服务端开发需要，不改变客户端 vendor Node。
- Wrangler 锁定 `4.152.0`，锁文件随源码保存，不使用浮动 `npx` 最新版。
- `compatibility_date = 2026-10-01`。Ed25519 使用标准 Web Crypto，不使用旧的 NODE-ED25519 私有接口。

```powershell
cd D:\workspace\FatFish\activation-server
npm.cmd ci
$env:WRANGLER_SEND_METRICS = 'false'
npm.cmd run check
npm.cmd run test:local -- --evidence <绝对证据目录>
```

`test:local` 会在全新临时目录生成**一次性测试私钥/令牌**，用真实 `wrangler d1 execute --local` 建库、`wrangler dev --local` 启动 Worker，测试后只停自己创建的进程树并清理该目录。无需 Cloudflare 账号，不开窗口，不部署，无模型调用。

最新验收 39 项：激活/重试/两台上限、八路并发只能两台、同机并发幂等、作废、精确解绑、重启持久化、管理鉴权、管理 CLI、限流、坏签名配置失败关闭、密钥和批量激活码脚本。证据见 `docs/M5_ACTIVATION.md`。

## 2. 手工启动本地服务

仅使用本地练习密钥，**不要把生产私钥复制到开发机**：

```powershell
New-Item -ItemType Directory .local
node scripts/generate-keys.mjs .local/local-test-keys
```

脚本拒绝已存在目录，不覆盖旧密钥；默认不打印任何私密内容。依次将以下文件内容配置到同目录的 `.dev.vars`，不要直接敲到共享命令行/日志里：

| `.dev.vars` 名称 | 本地文件 |
|---|---|
| `LICENSE_PRIVATE_KEY` | `private.pkcs8.base64` |
| `ADMIN_TOKEN` | `admin-token.txt` |
| `RATE_SALT` | `rate-salt.txt` |

`.dev.vars`、`.wrangler`、`.local` 已忽略。Windows 的 mode=0600 不等于已经正确设置 ACL；在受限用户目录保存，检查实际 ACL/备份权限，不要同步到公开网盘。不要 `git add -f` 这些文件。

```powershell
npm.cmd run schema:local
npm.cmd run dev
```

默认只监听 `127.0.0.1:8791`。所有示例数据库 ID 都是本地占位值，不是生产资源。

## 3. 发码、查询、解绑、作废

```powershell
node scripts/generate-codes.mjs 20 .local/batch-001
```

每码 128 位随机量，格式 `FF-xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxx`。`delivery-codes.txt` 是敏感发货明文；`import.json` 只有 SHA-256 哈希、v1、设备数 2，服务器永不存明文激活码。目录必须全新，单批 1～100 个。

通过本机安全方式把管理令牌加载到 `FATFISH_ACTIVATION_ADMIN_TOKEN`，不要把令牌作为命令参数。`FATFISH_ACTIVATION_URL` 默认本地地址；远程必须 HTTPS，CLI 不跟随重定向，避免凭据外送。

```powershell
node scripts/admin.mjs import .local/batch-001/import.json
node scripts/admin.mjs query <code_hash>
node scripts/admin.mjs unbind <code_hash> <fingerprint>
node scripts/admin.mjs revoke <code_hash>
```

查询只返回受控的哈希、状态和设备哈希。导入幂等，不复活已作废码、不重置设备上限。解绑只删选中的设备绑定；作废保留记录。不要把「没有收到确认」当成没执行，先查询再决定是否重试。

## 4. 接口

所有 JSON 响应 `Cache-Control: no-store`，无 CORS，带 Origin 的网页请求一律拒绝。管理接口必须 Bearer 管理令牌。

| 方法/路径 | 请求 | 主要结果 |
|---|---|---|
| `POST /activate` | `{code, fingerprint}` | `{ok:true, license:{payload,signature}}`；`invalid_code` / `device_limit` / `rate_limited` / `unavailable` |
| `POST /admin/codes` | `{code_hashes,edition:"v1",max_devices:2}` | 创建数量；可设 1 台，不超过 2 台 |
| `GET /admin/code?code_hash=...` | — | 码状态、设备哈希及登记时间 |
| `POST /admin/unbind` | `{code_hash,fingerprint}` | 是否移除了确切设备 |
| `POST /admin/revoke` | `{code_hash}` | 是否找到并作废 |
| `GET /health` | — | HTTP 存活，不代表数据库/签名配置就绪 |

激活入口同来源 IP 每自然分钟最多 10 次。D1 只存带服务端盐的 IP 哈希；后续请求顺便删除 10 分钟前的限流行，没有请求期间不自动清理。Cloudflare 覆盖 `CF-Connecting-IP`；不能把可绕过 Cloudflare 的裸源站暴露到公网。此限制不抵御分布式 IP 攻击，上线前仍需费用限额/WAF/告警方案，不宣称不存在滥用风险。

绑定容量与 active 条件在同一条 SQL 写语句里判断；不是先查数量再无条件插入。密钥导入/签名先于设备分配，坏密钥不会吃掉名额。请求上限 16KB，字段白名单、指纹/码哈希严格格式，SQL 全部绑定参数。错误只返回固定分类，Worker 不记录请求体/码/指纹/密钥。

## 5. 许可证契约与永久离线边界

`payload` 是以下有序紧凑 JSON 的 UTF-8 字节，以无 padding 的 base64url 编码；`signature` 是对**原始 payload 字节**的 Ed25519 签名，同样 base64url：

```json
{"version":1,"product":"fatfish","code_hash":"<64 hex>","fingerprint":"<64 hex>","issued_at":"<UTC ISO8601>","edition":"v1"}
```

没有到期时间。M5-2 主进程和 Core 必须各自用内置公钥验签，并独立计算/比对机器指纹、校验字段与 edition，不能相信 Renderer 或对方的「已激活」布尔值。客户端门禁与独立连接测试路径现已接入并完成无窗口验证，详见 `docs/M5_LICENSE.md`；正式公钥/地址仍未配置，原生表单与完整向导尚未验收。

**永久离线意味着：服务端解绑/作废不能撤销已经发出的离线许可证。** 它们只影响之后的签发和设备名额；退款作废也不能让已激活的离线用户立即停用。旧设备在解绑后仍可能持有有效许可证，这是架构已选的商业取舍，不伪称实时防盗版。

## 6. 生产密钥生成与备份（只说明，不自动执行）

1. 在受控服务端/离线管理环境生成**正式** Ed25519 密钥；客户端只拿 `public.spki.base64`。测试密钥不得混用。
2. 私钥、管理令牌、限流盐分别放 Worker secret；不要放 Wrangler `vars`、源码、客户端、CI 输出或安装包。正式配置/创建云资源/部署需另获授权。
3. 私钥做两份独立加密离线备份，保存访问人/日期/公钥指纹；恢复演练只用隔离本地数据库，验证签名可被原公钥验过，别连接生产激活接口。
4. D1 独立备份码哈希、状态、设备绑定。只有私钥备份不足以恢复原发货与绑定状态。
5. **不更新客户端的前提下不能随意更换签名公钥。** 私钥遗失会导致新签发无法被既有安装包验证；泄漏则可能无限签发。恢复必须保持原密钥，轮换需要产品与新安装包方案。
6. 上线前单独配置真实 D1 ID、域名/TLS、secrets、WAF/费用与故障告警，验证从公网客户端激活和离线使用；本地 39 项不代表生产已生效。

官方依据：[本地开发](https://developers.cloudflare.com/workers/local-development/)、[本地 secrets](https://developers.cloudflare.com/workers/local-development/environment-variables/)、[D1 batch 事务](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Web Crypto / Ed25519](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)。实际可用性以本仓库锁定 Wrangler 的真实本地 Worker/D1 验收为准。

## 客户端联合检查

`npm.cmd run test:client -- --evidence <绝对目录>` 在原 39 项外加 14 项实际客户端/本地 Worker/独立 Core 契约检查，连续三轮通过。只在隔离副本放本轮公开锚与回环 URL，私钥仍只在 Worker 本地 secret；不提供生产运行时跳过验签开关。部分异常由传输夹具触发，不等同于断开用户网络。
