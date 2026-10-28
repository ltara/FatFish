/** Locked SDK capability composition only: never calls a desktop tool, captures images, or launches a driver. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DshClient } from "../../app/core/dsh-client.mjs";
import { installProfile, engineEnv, resolveDshExe } from "../../app/core/engine-host.mjs";
import { CORE_DIR } from "../../app/core/paths.mjs";
import { startModelProxy } from "../../app/core/dev/model-proxy.mjs";
import toolContract from "../../app/core/tool-contract.cjs";
const EXPECTED_SHA256 = "f9ed01f241df37c50c702d81b6c226d576210b8f3947699735ca90285ea13365";
const evidenceArg = process.argv.indexOf("--evidence"), evidence = evidenceArg < 0 ? null : resolve(process.argv[evidenceArg + 1]);
const home = fs.mkdtempSync(join(tmpdir(), "fatfish-computer-capability-")), exe = resolveDshExe(), results = [], checks = [];
const sourceProfiles = ["fatfish-local", "fatfish-external"].map((name) => join(CORE_DIR, "profiles", name, "cordis.patch.yml"));
const original = sourceProfiles.map((p) => fs.readFileSync(p, "utf8"));
const check = (name, ok) => { checks.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
let proxy, client, version = null;
try {
  check("probe uses Windows and the pinned shipped SDK binary", process.platform === "win32" && exe && createHash("sha256").update(fs.readFileSync(exe)).digest("hex") === EXPECTED_SHA256);
  version = execFileSync(exe, ["--version"], { encoding: "utf8", windowsHide: true, env: engineEnv({ DSH_HOME: home }) }).trim();
  check("runtime self-report remains the locked rc2 version", version === "0.2.1-rc.2");
  proxy = await startModelProxy({ reply: () => "仅验证工具目录，不执行任何工具。" });
  const missingDriver = join(home, "missing-driver-do-not-install.exe");
  check("MCP probe points only to a definitely absent driver", !fs.existsSync(missingDriver));
  const scenarios = [
    { name: "baseline", rows: [] },
    { name: "service", rows: [{ id: "computer-use", name: "@deepseek-ai/dsh-computer-use" }] },
    { name: "native", rows: [{ id: "computer-use", name: "@deepseek-ai/dsh-computer-use" }, { id: "computer-use-native-probe", name: "@deepseek-ai/dsh-experimental-computer-use-cua-driver-native" }] },
    { name: "mcp-missing-driver", rows: [{ id: "computer-use", name: "@deepseek-ai/dsh-computer-use" }, { id: "computer-use-mcp-probe", name: "@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp", config: { command: missingDriver, args: [], reconnect: { enabled: false, maxAttempts: 1 } } }] },
  ];
  for (const scenario of scenarios) {
    const root = join(home, scenario.name); fs.mkdirSync(root); installProfile("fatfish-local", root);
    const patch = join(root, "probe.patch.yml"); fs.writeFileSync(patch, JSON.stringify(scenario.rows.length ? [{ insert: scenario.rows }] : []));
    const from = proxy.requests.length, env = engineEnv({ DSH_HOME: root, DEEPSEEK_API_KEY: "sk-computer-probe-not-a-key", DEEPSEEK_BASE_URL: proxy.url });
    delete env.NODE_PATH;
    client = new DshClient({ exe, profile: "fatfish-local", args: ["--patch", join(CORE_DIR, "profiles/common.patch.yml"), "--patch", patch], env, cwd: root });
    client.start(); let initialized = false, promptCompleted = false, errorCode = null, toolCalls = 0, imageEvents = 0;
    client.onNotification((_method, params) => { const type = params?.event?.type || ""; if (type === "tool/call") toolCalls++; if (/image|screenshot/i.test(type)) imageEvents++; });
    try {
      await client.request("initialize", { cwd: root, provider: "deepseek-official", model: "deepseek-flash" }, 15000); initialized = true;
      const reply = await client.prompt("capability-" + scenario.name, "只回复一句话，不要调用工具。"); promptCompleted = reply.endReason?.kind === "completed";
    } catch (e) { errorCode = /^rpc_timeout_/.test(e.message) ? "initialize_timeout" : "composition_unavailable"; }
    await new Promise((r) => setTimeout(r, 200));
    const requests = proxy.requests.slice(from), stderr = client.stderrTail.replaceAll(home, "<probe-home>").replaceAll(home.replaceAll("\\", "/"), "<probe-home>");
    const toolNames = [...new Set(requests.flatMap((r) => (r.tools || []).map((t) => t.name)))].sort();
    results.push({ scenario: scenario.name, initialized, promptCompleted, errorCode, toolCalls, imageEvents, modelRequests: requests.length, toolNames, baselineToolsMatch: requests.length > 0 && requests.every(toolContract.localToolsMatch), stderr });
    await client.shutdown(); client = null;
    check(scenario.name + " never executes a tool or captures an image", toolCalls === 0 && imageEvents === 0);
    console.log("SCENARIO " + JSON.stringify({ scenario: scenario.name, initialized, promptCompleted, errorCode, toolCalls, imageEvents,
      modelRequests: requests.length, toolCount: toolNames.length, importMissing: stderr.includes("ERR_MODULE_NOT_FOUND") }));
  }
  check("baseline profile still has its exact twenty-one tools", results[0].promptCompleted && results[0].baselineToolsMatch);
  const missingPackage = (result, pkg) => result.stderr.includes("Cannot find package '" + pkg + "'") && result.stderr.includes("ERR_MODULE_NOT_FOUND") && result.baselineToolsMatch;
  check("computer-use service cannot import from the shipped SDK composition", missingPackage(results[1], "@deepseek-ai/dsh-computer-use"));
  check("native provider is missing, not merely awaiting a desktop permission", missingPackage(results[2], "@deepseek-ai/dsh-experimental-computer-use-cua-driver-native"));
  check("MCP provider is missing before any driver could be launched", missingPackage(results[3], "@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp"));
  check("initialize success is not mistaken for a loaded computer-use capability", results.slice(1).every((r) => r.initialized && r.stderr.includes("did not activate") && r.baselineToolsMatch));
  check("production local and external profiles are not modified", sourceProfiles.every((p, i) => fs.readFileSync(p, "utf8") === original[i]));
  console.log(`${checks.length}/${checks.length} capability safety checks passed (no desktop actions/paid calls)`);
} finally {
  await client?.shutdown(); await proxy?.close();
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(join(evidence, "computer-capability-report.json"), JSON.stringify({ binarySha256: EXPECTED_SHA256, version, paidCalls: 0, desktopActions: 0, screenshots: 0, productionProfileChanged: false, checks, results }, null, 2)); }
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-computer-capability-")) fs.rmSync(home, { recursive: true, force: true });
}
