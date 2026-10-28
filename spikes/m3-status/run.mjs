/** Observe rc2 error shapes against loopback-only failures; never a paid model call. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import http from "node:http";
const home = mkdtempSync(join(tmpdir(), "fatfish-error-probe-"));
process.env.FATFISH_APPDATA = home;
let mode = 401;
const server = http.createServer((req, res) => {
  req.resume();
  if (mode === "network") { req.socket.destroy(); return; }
  res.writeHead(mode, { "content-type": "application/json", "retry-after": "0" });
  res.end(JSON.stringify({ type: "error", error: { type: mode === 401 ? "authentication_error" : "api_error", message: "LOCAL_FIXTURE_FAILURE" } }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.FATFISH_DEV_DEEPSEEK_BASE_URL = `http://127.0.0.1:${server.address().port}`;
const { EngineHost } = await import("../../app/core/engine-host.mjs");
const { ensureDirs, instancePaths, CORE_DIR } = await import("../../app/core/paths.mjs");
ensureDirs();
writeFileSync(join(home, "secrets", "deepseek_api_key"), "sk-local-error-fixture");
const patch = join(home, "no-retry.patch.yml");
writeFileSync(patch, "- id: llm-retry\n  disabled: true\n");
const host = new EngineHost({ name: "external", profile: "fatfish-external", ...instancePaths("external"),
  extraPatches: [join(CORE_DIR, "profiles/common.patch.yml"), patch] });
const scrub = (value, key = "") => typeof value === "string" && /message|text|key/i.test(key) ? "[redacted]" :
  Array.isArray(value) ? value.map((v) => scrub(v)) : value && typeof value === "object" ?
    Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)])) : value;
try {
  if (!await host.start()) throw new Error("runtime_init_failed");
  for (mode of [401, 402, 429, 404, "network"]) {
    const r = await host.client.prompt("probe-" + mode, "本地错误探针", 45000);
    console.log(JSON.stringify({ mode, endReason: scrub(r.endReason), events: r.events.filter((e) => ["assistant/attempt", "turn/end"].includes(e.type)).map(scrub) }));
  }
} finally {
  await host.dispose();
  await new Promise((r) => { server.close(r); server.closeAllConnections(); });
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-error-probe-")) rmSync(home, { recursive: true, force: true });
}
