/** Loopback OpenAI-compatible SSE fixture. Bodies/credentials stay in memory; never forwards requests. */
import http from "node:http";
export async function startCompatProxy({ api = "openai-completions", reply = () => "兼容接口测试回复。", tool = () => null, failure = () => null } = {}) {
  const requests = [], held = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.writeHead(400).end(); return; }
      requests.push({ path: req.url, authorization: req.headers.authorization, apiKey: req.headers["x-api-key"], body });
      const respond = () => {
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const call = tool(body), text = reply(body), id = "compat-fixture";
      if (api === "anthropic-messages") {
        const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
        event("content_block_start", { index: 0, content_block: call ? { type: "tool_use", id: "compat-tool-call", name: call.name, input: {} } : { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text } });
        event("content_block_stop", { index: 0 }); event("message_delta", { delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
        event("message_stop", {}); res.end(); return;
      }
      if (api === "openai-responses") {
        let sequence = 0;
        const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
        const response = { id: "resp_fixture", object: "response", created_at: 1, model: body.model, status: "in_progress", output: [], error: null, incomplete_details: null };
        const item = call ? { id: "fc_fixture", type: "function_call", call_id: "compat-tool-call", name: call.name, arguments: "", status: "in_progress" }
          : { id: "msg_fixture", type: "message", role: "assistant", status: "in_progress", content: [] };
        const at = { item_id: item.id, output_index: 0 }, part = { type: "output_text", text: "", annotations: [], logprobs: [] };
        event("response.created", { response }); event("response.output_item.added", { output_index: 0, item });
        if (call) { const args = JSON.stringify(call.input); event("response.function_call_arguments.delta", { ...at, delta: args }); event("response.function_call_arguments.done", { ...at, arguments: args }); item.arguments = args; }
        else {
          event("response.content_part.added", { ...at, content_index: 0, part }); event("response.output_text.delta", { ...at, content_index: 0, delta: text, logprobs: [] });
          event("response.output_text.done", { ...at, content_index: 0, text, logprobs: [] }); part.text = text;
          event("response.content_part.done", { ...at, content_index: 0, part }); item.content = [part];
        }
        item.status = "completed"; event("response.output_item.done", { output_index: 0, item });
        event("response.completed", { response: { ...response, status: "completed", output: [item], usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } });
        res.end(); return;
      }
      const chunk = (delta, finish_reason = null, usage) => res.write("data: " + JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + "\n\n");
      chunk({ role: "assistant", ...(call ? { tool_calls: [{ index: 0, id: "compat-tool-call", type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { content: text }) });
      chunk({}, call ? "tool_calls" : "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
      res.end("data: [DONE]\n\n");
      };
      const fault = failure();
      if (fault === "hold") { held.add(respond); res.once("close", () => held.delete(respond)); return; }
      if (fault === "network") { req.socket.destroy(); return; }
      if (Number.isInteger(fault)) { res.writeHead(fault, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "fixture_error", message: "LOCAL_COMPAT_FIXTURE" } })); return; }
      respond();
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { requests, url: `http://127.0.0.1:${server.address().port}` + (api === "anthropic-messages" ? "" : "/v1"),
    releaseHeld: () => { for (const fn of held) fn(); held.clear(); }, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
