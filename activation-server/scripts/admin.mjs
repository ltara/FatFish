/** Native admin CLI. URL/token come from environment; no credentials in argv, request logging or errors. */
import fs from "node:fs";
const [op, value, fingerprint] = process.argv.slice(2), token = process.env.FATFISH_ACTIVATION_ADMIN_TOKEN;
let url;
try {
  url = new URL(process.env.FATFISH_ACTIVATION_URL || "http://127.0.0.1:8791");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error();
} catch { throw new Error("激活服务地址无效；远程服务必须使用 HTTPS，地址不能包含凭据。"); }
if (typeof token !== "string" || token.length < 32 || token.length > 1024) throw new Error("请通过 FATFISH_ACTIVATION_ADMIN_TOKEN 设置管理令牌，不要写进命令参数。");
let route, body;
const isHash = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
if (op === "import") {
  try { if (!value || fs.statSync(value).size > 16384) throw new Error(); body = JSON.parse(fs.readFileSync(value, "utf8")); }
  catch { throw new Error("导入清单不可读或格式不正确；请提供小于 16KB 的 import.json。"); }
  route = "/admin/codes";
} else if (op === "query" && isHash(value)) route = "/admin/code?code_hash=" + value;
else if (op === "revoke" && isHash(value)) { route = "/admin/revoke"; body = { code_hash: value }; }
else if (op === "unbind" && isHash(value) && isHash(fingerprint)) { route = "/admin/unbind"; body = { code_hash: value, fingerprint }; }
else throw new Error("用法：admin.mjs import <import.json> | query <code_hash> | revoke <code_hash> | unbind <code_hash> <fingerprint>");
try {
  const result = await fetch(new URL(route, url), { method: body ? "POST" : "GET", redirect: "error", headers: { authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const reply = await result.json();
  if (!result.ok || reply.ok !== true) { console.error("管理操作未完成，状态码：" + result.status); process.exitCode = 1; }
  else {
    const shown = { ok: true };
    if (op === "query") {
      if (!isHash(reply.code?.code_hash) || !["active", "revoked"].includes(reply.code.status) || !Array.isArray(reply.devices) || reply.devices.some((d) => !isHash(d.fingerprint))) throw new Error();
      shown.code_hash = reply.code.code_hash; shown.status = reply.code.status; shown.devices = reply.devices.map((d) => d.fingerprint);
    } else if (op === "import") { if (!Number.isSafeInteger(reply.created) || reply.created < 0 || reply.created > 100) throw new Error(); shown.created = reply.created; }
    else if (op === "revoke") { if (typeof reply.found !== "boolean") throw new Error(); shown.found = reply.found; }
    else { if (typeof reply.removed !== "boolean") throw new Error(); shown.removed = reply.removed; }
    console.log(JSON.stringify(shown, null, 2));
  }
} catch { console.error("没有收到管理操作确认。请先查询服务端状态，不要盲目重复提交。"); process.exitCode = 1; }
