/** Core-owned plugin boundary. Identity comes from a per-instance token, never the body. */
import http from "node:http";
import { randomBytes } from "node:crypto";

const OUTCOMES = new Set(["allowed-once", "rejected", "cancelled"]);
const MAX_BODY = 64 * 1024;

export class PluginGateway {
  constructor({ onApproval = async () => "rejected", onTool = null, timeoutMs = 120000 } = {}) {
    this.onApproval = onApproval;
    this.timeoutMs = timeoutMs;
    this.onTool = onTool;
    this.tokens = new Map();
    this.pending = new Set();
  }

  register(instance, isSessionActive) {
    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, { instance, isSessionActive });
    return token;
  }

  async start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.#handle(req, res));
    this.server.requestTimeout = this.timeoutMs + 5000;
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.url = `http://127.0.0.1:${this.server.address().port}/plugin`;
  }

  async #handle(req, res) {
    const reply = (status, outcome = "rejected") => {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ outcome }));
      }
    };
    const authorization = String(req.headers.authorization || "");
    const identity = /^Bearer [0-9a-f]{64}$/.test(authorization) ? this.tokens.get(authorization.slice(7)) : null;
    if (!identity) { req.resume(); return reply(401); }
    if (req.method !== "POST" || req.url !== "/plugin") { req.resume(); return reply(404); }
    const abort = new AbortController();
    const cancel = (reason = "cancelled") => abort.abort(reason);
    const closed = () => cancel("cancelled");
    res.once("close", closed);
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) { reply(413); req.destroy(); return; }
        chunks.push(chunk);
      }
      const p = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (["fatfish-memory", "fatfish-remind"].includes(p?.plugin) && this.onTool && typeof p.sessionId === "string" && identity.isSessionActive(p.sessionId) &&
          p.args && typeof p.args === "object" && !Array.isArray(p.args)) {
        const result = await this.onTool({ instance: identity.instance, sessionId: p.sessionId, plugin: p.plugin, op: p.op, args: p.args });
        if (!res.destroyed) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      if (identity.instance !== "local" || p?.plugin !== "fatfish-approval" || p.op !== "request" ||
          typeof p.sessionId !== "string" || !identity.isSessionActive(p.sessionId) ||
          !p.args || typeof p.args !== "object" || Array.isArray(p.args)) return reply(403);
      const { toolName, callId, reason, displayReason } = p.args;
      this.pending.add(abort);
      const deadlineAt = Date.now() + this.timeoutMs;
      let timer;
      const cancelled = new Promise((resolve) => {
        abort.signal.addEventListener("abort", () => resolve("rejected"), { once: true });
        timer = setTimeout(() => cancel("timeout"), this.timeoutMs);
        if (abort.signal.aborted) resolve("rejected");
      });
      try {
        const outcome = await Promise.race([
          Promise.resolve().then(() => this.onApproval({
            instance: identity.instance, sessionId: p.sessionId, toolName, callId, reason, displayReason, deadlineAt,
          }, abort.signal)), cancelled,
        ]);
        reply(200, OUTCOMES.has(outcome) ? outcome : "rejected");
      } finally {
        clearTimeout(timer);
        cancel();
        this.pending.delete(abort);
      }
    } catch {
      reply(400);
    } finally {
      res.off("close", closed);
    }
  }

  async stop() {
    for (const c of this.pending) c.abort();
    this.tokens.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
}
