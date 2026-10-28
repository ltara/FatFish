/** Verify rc2's hand-declared routes with real SDK and loopback-only protocol fixtures. No native UI/paid calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DshClient } from "../../app/core/dsh-client.mjs";
import { installProfile, engineEnv, resolveDshExe } from "../../app/core/engine-host.mjs";
import { CORE_DIR } from "../../app/core/paths.mjs";
import { startCompatProxy } from "../../app/core/dev/compat-proxy.mjs";
import tools from "../../app/core/tool-contract.cjs";
const home = fs.mkdtempSync(join(tmpdir(), "fatfish-model-probe-")), results = [];
const evidenceArg = process.argv.indexOf("--evidence"), evidence = evidenceArg < 0 ? null : resolve(process.argv[evidenceArg + 1]);
let proxy, client;
try {
  for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
    const root = join(home, api); fs.mkdirSync(root); installProfile("fatfish-local", root);
    proxy = await startCompatProxy({ api });
    const patch = join(root, "model.patch.json");
    fs.writeFileSync(patch, JSON.stringify([{ id: "llm-pi-ai", config: { providers: { "fatfish-model": {
      apiKeyEnv: "FATFISH_MODEL_API_KEY", api, baseURL: proxy.url, models: [{ id: "fatfish-test-model", contextWindow: 65536, maxTokens: 4096 }],
    } } } }]));
    client = new DshClient({ exe: resolveDshExe(), profile: "fatfish-local", args: ["--patch", join(CORE_DIR, "profiles/common.patch.yml"), "--patch", patch],
      env: engineEnv({ DSH_HOME: root, FATFISH_MODEL_API_KEY: "sk-compatible-fixture-not-a-key" }), cwd: root });
    client.start(); let reason, reply = null, error = null;
    try { await client.request("initialize", { cwd: root, provider: "fatfish-model", model: "fatfish-test-model" }); const result = await client.prompt("model-probe", "只回复一句话，不调用工具。"); reason = result.endReason; reply = result.texts.at(-1); }
    catch (e) { error = e.message; }
    const bodies = proxy.requests.map((r) => r.body || r);
    const contract = (p) => api === "openai-completions" ? tools.localToolsMatch({ tools: p.tools?.map((t) => ({ name: t.function?.name })) }) : tools.localToolsMatch(p);
    results.push({ api, completed: reason?.kind === "completed" && reply === "兼容接口测试回复。", error, requests: proxy.requests.length, exactTools: bodies.length > 0 && bodies.every(contract), path: proxy.requests[0]?.path,
      authorized: api === "anthropic-messages" ? proxy.requests[0]?.apiKey === "sk-compatible-fixture-not-a-key" : proxy.requests[0]?.authorization === "Bearer sk-compatible-fixture-not-a-key",
      stderr: client.stderrTail.replaceAll(home, "<probe-home>") });
    console.log(JSON.stringify(results.at(-1), null, 2));
    await client.shutdown(); client = null; await proxy.close(); proxy = null;
  }
  assert.ok(results.every((r) => r.completed && r.exactTools && r.authorized), "rc2 compatible routes must really complete");
} finally {
  await client?.shutdown(); await proxy?.close();
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(join(evidence, "model-probe-report.json"), JSON.stringify({ paidCalls: 0, nativeUI: false, results }, null, 2)); }
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-model-probe-")) fs.rmSync(home, { recursive: true, force: true });
}
