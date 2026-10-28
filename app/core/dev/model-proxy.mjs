/** Recording forward proxy adapted from the M2 privacy probe. Request bodies stay in RAM. */
import http from "node:http";
import https from "node:https";

export async function startModelProxy({ reply, failure, tool, upstreamPrefix = "/anthropic", maxForwardRequests = Infinity } = {}) {
  if (!["", "/anthropic"].includes(upstreamPrefix) || !(maxForwardRequests === Infinity || Number.isSafeInteger(maxForwardRequests) && maxForwardRequests >= 0)) throw new Error("invalid_proxy_policy");
  const requests = [];
  const responses = [];
  let forwarded = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let json;
      try { json = JSON.parse(body.toString("utf8")); } catch { res.writeHead(400).end(); return; }
      requests.push(json);
      const fault = failure?.();
      if (fault === "network") { req.socket.destroy(); return; }
      if (fault === "hold") return; // A runtime-kill fixture; close() destroys the socket.
      if (Number.isInteger(fault)) {
        res.writeHead(fault, { "content-type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "LOCAL_FAILURE_FIXTURE" } }));
        return;
      }
      if (reply) {
        // Local-only fixture: exercise the real runtime request shape without spending tokens.
        const answer = reply(json);
        const call = tool?.(json);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event("message_start", { message: { id: "local-fixture", type: "message", role: "assistant", model: json.model,
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
        event("content_block_start", { index: 0, content_block: call ? { type: "tool_use", id: "local-tool-call", name: call.name, input: {} } : { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text: answer } });
        event("content_block_stop", { index: 0 });
        event("message_delta", { delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
        event("message_stop", {});
        res.end();
        return;
      }
      if (forwarded >= maxForwardRequests) { responses.push({ blocked: "request_budget" }); res.writeHead(429); res.end(); return; }
      forwarded++;
      const headers = { ...req.headers, host: "api.deepseek.com", "content-length": String(body.length) };
      // rc2 embeds PUBLIC_BASE_URL=https://api.deepseek.com/anthropic.
      // A root-only redirect would forward /v1/messages to the wrong endpoint (404).
      const upstream = https.request({ host: "api.deepseek.com", path: upstreamPrefix + req.url, method: req.method, headers }, (r) => {
        const response = { path: req.url, status: r.statusCode, contentType: r.headers["content-type"], events: [] };
        responses.push(response);
        let eventBuffer = "";
        r.on("data", (chunk) => {
          eventBuffer = (eventBuffer + chunk.toString("utf8")).slice(-20000);
          const lines = eventBuffer.split("\n");
          eventBuffer = lines.pop();
          for (const line of lines) if (line.startsWith("event:")) {
            const name = line.slice(6).trim();
            if (!response.events.includes(name)) response.events.push(name);
          }
        });
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      upstream.on("error", (e) => { responses.push({ error: e.code || "upstream_error" }); if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on("close", () => upstream.destroy());
      upstream.end(body);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    requests, responses, get forwarded() { return forwarded; }, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
