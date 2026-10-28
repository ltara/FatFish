/** Explicit opt-in only: at most two real requests to the existing provider's compatible endpoint.
 * Fixed synthetic text/persona, isolated profiles, no owner data, no QQ, no native UI. Never prints text or keys.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { DshClient } from "../../app/core/dsh-client.mjs";
import { installProfile, engineEnv, resolveDshExe } from "../../app/core/engine-host.mjs";
import { CORE_DIR } from "../../app/core/paths.mjs";
import modelConfig from "../../app/core/model-config.cjs";
import tools from "../../app/core/tool-contract.cjs";
import { startModelProxy } from "../../app/core/dev/model-proxy.mjs";
if (process.env.FATFISH_ALLOW_PAID_MODEL_CHECK !== "2" || !process.env.DEEPSEEK_API_KEY) throw new Error("explicit_two_request_budget_and_key_required");
const evidenceIndex = process.argv.indexOf("--evidence");
if (evidenceIndex < 0) throw new Error("evidence_directory_required");
const evidence = resolve(process.argv[evidenceIndex + 1]), home = fs.mkdtempSync(join(tmpdir(), "fatfish-compatible-live-"));
const key = process.env.DEEPSEEK_API_KEY, exe = resolveDshExe(), results = [];
let client, proxy;
try {
  proxy = await startModelProxy({ upstreamPrefix: "", maxForwardRequests: 2 });
  for (const instance of ["external", "local"]) {
    const root = join(home, instance); fs.mkdirSync(root); installProfile("fatfish-" + instance, root);
    const runtime = modelConfig.runtime({ route: modelConfig.normalize({ provider: "custom", api: "openai-completions", baseURL: proxy.url, model: "deepseek-flash", contextWindow: 65536, maxTokens: 512 }), key }, { noRetries: true });
    const patch = join(root, "model.patch.json");
    fs.writeFileSync(patch, JSON.stringify([...runtime.patch, { id: "llm-retry", disabled: true }]));
    client = new DshClient({ exe, profile: "fatfish-" + instance, args: ["--patch", join(CORE_DIR, "profiles/common.patch.yml"), "--patch", patch], cwd: root,
      env: engineEnv({ DSH_HOME: root, ...runtime.env, FATFISH_PERSONA: "这是连接验收。请只用简体中文回复一句话，不要调用工具。", FATFISH_PERSONA_SUFFIX: "" }) });
    client.start(); const before = proxy.requests.length; let result, code = null;
    try { await client.request("initialize", { cwd: root, provider: runtime.provider, model: runtime.model }); result = await client.prompt("compatible-live-" + instance, "你好，请只回复连接正常，不调用工具。", 30000); }
    catch (e) { code = /timeout/.test(e.message) ? "timeout" : "runtime_error"; }
    const bodies = proxy.requests.slice(before), body = bodies[0], expected = instance === "local" ? tools.localToolsMatch : tools.externalToolsMatch;
    const row = { instance, completed: result?.endReason?.kind === "completed" && result.texts.some((s) => s.trim()), endReason: result?.endReason?.kind || code,
      calls: bodies.length, exactTools: bodies.length === 1 && expected({ tools: body.tools?.map((t) => ({ name: t.function?.name })) }),
      toolNames: body?.tools?.map((t) => t.function?.name), privateUploadFields: bodies.some((b) => Object.hasOwn(b, "dsh_session_log") || Object.hasOwn(b, "dsh_plugin_packages")),
      model: body?.model, responseStatus: proxy.responses.at(-1)?.status, toolCalls: result?.events.filter((e) => e.type === "tool/call").length ?? null };
    results.push(row); console.log(JSON.stringify(row));
    if (client.child) { client.child.kill(); await client.exited; } client = null;
    assert.ok(row.completed && row.calls === 1 && row.exactTools && !row.privateUploadFields && row.toolCalls === 0, "live_compatible_check_failed_no_auto_retry");
  }
} finally {
  if (client?.child) { client.child.kill(); await client.exited; }
  await proxy?.close(); fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(join(evidence, "live-report.json"), JSON.stringify({ at: new Date().toISOString(), endpoint: "https://api.deepseek.com/chat/completions", nativeUI: false, realQQ: false,
    exeSHA256: exe && createHash("sha256").update(fs.readFileSync(exe)).digest("hex"), maxRequests: 2, actualForwarded: proxy?.forwarded || 0, results }, null, 2));
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-compatible-live-")) fs.rmSync(home, { recursive: true, force: true });
}
