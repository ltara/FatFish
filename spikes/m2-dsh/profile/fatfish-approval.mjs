/**
 * fatfish approval answerer (Cordis plugin, mounted by the fatfish profile patch).
 * DSH 0.2.1-rc.2's SDK server does not forward `approval/request` to the client,
 * so this plugin answers the in-runtime waterfall by asking Core over loopback.
 * DSH still owns every permission decision; this only supplies the user's answer.
 * Fail closed: no Core / timeout / bad reply → "rejected". Never writes stdout (JSON-RPC channel).
 */
import http from "node:http";

export const name = "fatfish-approval";

const TIMEOUT_MS = Number(process.env.FATFISH_APPROVAL_TIMEOUT_MS) || 120000;
const OUTCOMES = new Set(["allowed-once", "rejected", "cancelled"]);

function sessionIdOf(agent) {
  return agent?.sessionId ?? agent?.session?.id ?? agent?.id ?? "";
}

function ask(payload, signal) {
  const url = process.env.FATFISH_APPROVAL_URL;
  const token = process.env.FATFISH_APPROVAL_TOKEN;
  if (!url || !token) return Promise.resolve("rejected");
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (s += c));
      res.on("end", () => {
        try {
          const o = JSON.parse(s).outcome;
          resolve(res.statusCode === 200 && OUTCOMES.has(o) ? o : "rejected");
        } catch {
          resolve("rejected");
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve("rejected"));
    signal?.addEventListener("abort", () => (req.destroy(), resolve("cancelled")), { once: true });
    req.end(body);
  });
}

export function apply(ctx) {
  ctx.on("approval/request", (req) =>
    ask({
      sessionId: sessionIdOf(req.agent),
      toolName: req.toolName,
      callId: req.callId,
      reason: req.reason,
      displayReason: req.displayReason,
    }, req.signal)
  );
}
