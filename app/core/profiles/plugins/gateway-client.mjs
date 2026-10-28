/** Plugin transport. Never writes stdout or returns raw transport errors. */
import http from "node:http";
export function callCore(plugin, op, args, exec) {
  const url = process.env.FATFISH_GATEWAY_URL, token = process.env.FATFISH_GATEWAY_TOKEN;
  const sessionId = exec?.agent?.session?.id || exec?.agent?.sessionId || "";
  if (!url || !token || !sessionId || exec?.signal?.aborted) return Promise.resolve({ ok: false, error: "operation_unavailable" });
  return new Promise((resolve) => {
    const body = JSON.stringify({ plugin, op, sessionId, args });
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; exec?.signal?.removeEventListener("abort", abort); resolve(value); } };
    const req = http.request(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": Buffer.byteLength(body) }, timeout: 5000 }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; if (data.length > 256000) req.destroy(); });
      res.on("end", () => {
        try { const value = JSON.parse(data); finish(res.statusCode === 200 && typeof value.ok === "boolean" ? value : { ok: false, error: "operation_unavailable" }); }
        catch { finish({ ok: false, error: "operation_unavailable" }); }
      });
      res.on("error", () => finish({ ok: false, error: "operation_unavailable" }));
    });
    const abort = () => { req.destroy(); finish({ ok: false, error: "operation_cancelled" }); };
    req.on("timeout", () => req.destroy()); req.on("error", () => finish({ ok: false, error: "operation_unavailable" }));
    exec?.signal?.addEventListener("abort", abort, { once: true });
    if (exec?.signal?.aborted) abort(); else req.end(body);
  });
}
export const operationOutput = { schema: { type: "object", properties: { ok: { type: "boolean" }, data: { type: "object", additionalProperties: true }, error: { type: "string" } }, required: ["ok"], additionalProperties: false },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] };
