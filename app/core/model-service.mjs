/** Owner-only model settings and an isolated, tool-free connection test. */
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import modelConfig from "./model-config.cjs";
import { installProfile, engineEnv, resolveDshExe } from "./engine-host.mjs";
import { DshClient } from "./dsh-client.mjs";
import { CORE_DIR } from "./paths.mjs";
import { classifyTurnFailure } from "./turn-errors.mjs";
import licenseModule from "./license-gate.cjs";
export class ModelService {
  constructor({ root, instances, timeoutMs = 20000 }) { Object.assign(this, { root, instances, timeoutMs }); }
  get() { return { ...modelConfig.describe(modelConfig.read(this.root)), presets: Object.entries(modelConfig.presets).map(([provider, values]) => ({ provider, ...values })), apis: [...modelConfig.apis] }; }
  save(args) { if (this.stopped) throw new Error("model_unavailable"); return this.instances.setModel(args); }
  test(args) {
    if (this.stopped) throw new Error("model_unavailable");
    new licenseModule.LicenseGate(this.root).requireValid();
    if (this.running) throw new Error("model_test_busy");
    const selected = modelConfig.draft(this.root, args);
    const running = this.#test(selected).finally(() => { if (this.running === running) this.running = null; });
    this.running = running; return running;
  }
  async #test(selected) {
    const exe = resolveDshExe(); if (!exe) throw new Error("missing_runtime");
    const home = fs.mkdtempSync(join(tmpdir(), "fatfish-model-connection-")), start = Date.now();
    let client, failed = true;
    try {
      installProfile("fatfish-external", home);
      const route = { ...selected.route, ...(selected.route.provider === "deepseek-official" ? {} : { maxTokens: Math.min(64, selected.route.maxTokens) }) };
      const runtime = modelConfig.runtime({ route, key: selected.key }, { noRetries: true });
      const patch = join(home, "connection.patch.json");
      fs.writeFileSync(patch, JSON.stringify([...runtime.patch, { id: "llm-retry", disabled: true },
        ...(route.provider === "deepseek-official" ? [{ id: "llm-deepseek", config: { thinking: "disabled", reasoningEffort: "off", maxTokens: 64 } }] : []),
        { id: "fatfish-memory", disabled: true }, { id: "fatfish-remind", disabled: true }]));
      client = this.client = new DshClient({ exe, profile: "fatfish-external", args: ["--patch", join(CORE_DIR, "profiles/common.patch.yml"), "--patch", patch], cwd: home,
        env: engineEnv({ DSH_HOME: home, ...runtime.env, FATFISH_PERSONA: "你正在进行连接测试。请只回复连接正常，不要调用工具。", FATFISH_PERSONA_SUFFIX: "" }) });
      client.start();
      await client.request("initialize", { cwd: home, provider: runtime.provider, model: runtime.model }, 15000);
      const result = await client.prompt("connection-test", "你好，请只回复连接正常。", this.timeoutMs);
      if (result.endReason?.kind !== "completed") throw new Error(classifyTurnFailure({ endReason: result.endReason, events: result.events, stderr: client.stderrTail }));
      if (!result.texts.some((t) => t.trim()) || result.events.some((e) => e.type === "tool/call")) throw new Error("model_test_invalid_response");
      failed = false;
      return { connected: true, durationMs: Date.now() - start }; // Never return provider text (it may echo credentials).
    } catch (e) {
      const known = ["invalid_key", "insufficient_balance", "rate_limited", "model_unavailable", "network", "model_test_invalid_response"];
      throw new Error(known.includes(e.message) ? e.message : /timeout|turn_timeout/.test(e.message) ? "model_test_timeout" : "model_test_failed");
    } finally {
      if (client?.child) {
        if (failed) { client.child.kill(); await client.exited; }
        else await client.shutdown();
      }
      if (this.client === client) this.client = null;
      if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-model-connection-")) fs.rmSync(home, { recursive: true, force: true });
    }
  }
  async stop() { this.stopped = true; this.client?.child?.kill(); await this.running?.catch(() => {}); }
}
