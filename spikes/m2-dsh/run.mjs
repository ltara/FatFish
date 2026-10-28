/**
 * M2 DSH spike scenarios (Windows). Usage:
 *   DSH_EXE=... SPIKE_HOME=... DEEPSEEK_API_KEY=... node run.mjs <scenario> [profile]
 * Scenarios: boot | persona | memory | resume | approval | schedule | privacy
 * Results append to <SPIKE_HOME>/results.jsonl. Never prints the API key.
 */
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, appendFileSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DshClient, assistantText } from "../../app/core/dsh-client.mjs";
import { installProfile, engineEnv } from "../../app/core/engine-host.mjs";
import { CORE_DIR } from "../../app/core/paths.mjs";
import { PluginGateway } from "../../app/core/gateway.mjs";
import { startModelProxy as startRecordingProxy } from "../../app/core/dev/model-proxy.mjs";
import toolContract from "../../app/core/tool-contract.cjs";

const scenario = process.argv[2] || "boot";
const profile = process.argv[3] || (scenario === "approval" ? "fatfish-local" : "fatfish-external");
const EXE = process.env.DSH_EXE;
const HOME = process.env.SPIKE_HOME;
const MODEL = process.env.SPIKE_MODEL || "deepseek-flash";
if (!EXE || !HOME) throw new Error("set DSH_EXE and SPIKE_HOME");
if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY missing");

const WORK = join(HOME, "workspace");
// Must sit outside both the workspace and %TEMP% (workspace-write grants temp).
const OUTSIDE = process.env.SPIKE_OUTSIDE || join(process.env.USERPROFILE || HOME, "fatfish-spike-outside");
mkdirSync(WORK, { recursive: true });
if (scenario === "approval") mkdirSync(OUTSIDE, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const record = (r) => {
  appendFileSync(join(HOME, "results.jsonl"), JSON.stringify({ scenario, profile, at: new Date().toISOString(), ...r }) + "\n");
  log("RESULT", JSON.stringify(r, null, 1));
};

// --- privacy probes: OTLP sink + recording forward proxy to the model API ---
const probe = { otlpHits: 0, modelRequests: 0, sessionLogField: 0, extraFields: new Set(), remotes: new Set() };
function startOtlpSink() {
  return new Promise((res) => {
    const s = http.createServer((req, r) => {
      probe.otlpHits++;
      req.resume();
      r.end("{}");
    });
    s.listen(0, "127.0.0.1", () => res(s));
  });
}
const STD_FIELDS = new Set(["model", "messages", "stream", "max_tokens", "temperature", "tools", "tool_choice",
  "thinking", "reasoning_effort", "stream_options", "top_p", "stop", "metadata", "system", "user", "response_format"]);
let recordingProxy;
async function startModelProxy() {
  recordingProxy = await startRecordingProxy();
  return recordingProxy;
}
function sampleRemotes(pid) {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      `Get-NetTCPConnection -OwningProcess ${pid} -ErrorAction SilentlyContinue | ForEach-Object { $_.RemoteAddress + ':' + $_.RemotePort }`],
      { encoding: "utf8", windowsHide: true });
    for (const l of out.split(/\r?\n/)) if (l.trim() && !/^(0\.0\.0\.0|::|127\.0\.0\.1)/.test(l.trim())) probe.remotes.add(l.trim());
  } catch {
    /* ignore */
  }
}
function memMB(pid) {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`],
      { encoding: "utf8", windowsHide: true });
    return Math.round(Number(out.trim()) / 1048576);
  } catch {
    return null;
  }
}

// --- harness ---
const approvals = [];
let approvalAnswer = "rejected";
// Core-side approval endpoint answered for the fatfish-approval plugin.
async function startApprovalServer() {
  const gateway = new PluginGateway({ onApproval: async (p) => {
    approvals.push(p);
    log("APPROVAL(plugin)", "tool=" + p.toolName, "instance=" + p.instance);
    return approvalAnswer;
  } });
  const token = gateway.register("local", () => true); // Isolated spike sessions only.
  await gateway.start();
  return { url: gateway.url, token };
}

async function boot({ useProxy = false, persona } = {}) {
  const env = engineEnv({ DSH_HOME: HOME, TZ: "Asia/Shanghai", DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY });
  const managed = ["fatfish-external", "fatfish-local"].includes(profile);
  if (managed) installProfile(profile, HOME);
  const approvalSrv = await startApprovalServer();
  env.FATFISH_GATEWAY_URL = approvalSrv.url;
  env.FATFISH_GATEWAY_TOKEN = approvalSrv.token;
  if (persona) env.FATFISH_PERSONA = persona;
  if (useProxy) {
    const sink = await startOtlpSink();
    const proxy = await startModelProxy();
    env.DSH_TELEMETRY_OTLP_URL = `http://127.0.0.1:${sink.address().port}/v1/logs`;
    env.DEEPSEEK_BASE_URL = proxy.url;
  }
  const c = new DshClient({
    exe: EXE, profile, args: managed ? ["--patch", join(CORE_DIR, "profiles", "common.patch.yml")] : [], env, cwd: WORK, log,
    onServerRequest: async (method, params) => {
      if (method === "approval/request") {
        approvals.push(params);
        log("APPROVAL", JSON.stringify(params));
        return { outcome: approvalAnswer };
      }
      if (method === "user-question/ask") {
        log("QUESTION", JSON.stringify(params).slice(0, 300));
        return { answers: (params.questions || []).map((q) => ({ id: q.id, selected: [] })) };
      }
      throw new Error("unhandled_" + method);
    },
  });
  c.start();
  const t0 = Date.now();
  const init = await c.request("initialize", {
    cwd: WORK, provider: "deepseek-official", model: MODEL,
  }, 60000).catch((e) => {
    log("init_failed", e.message, c.stderrTail.slice(-1500));
    throw e;
  });
  const initMs = Date.now() - t0;
  log("initialized", JSON.stringify(init), initMs + "ms", "pid=" + c.child.pid);
  return { c, initMs };
}

const SID = "fatfish-spike-owner";
const idFile = join(HOME, "spike-ids.json");
const ids = existsSync(idFile) ? JSON.parse(readFileSync(idFile, "utf8")) : {};

try {
  if (scenario === "boot") {
    const { c, initMs } = await boot();
    const r = await c.prompt("boot-" + Date.now(), "你好，用一句话介绍你自己。");
    const mem = memMB(c.child.pid);
    record({ initMs, memMB: mem, reply: r.texts.join(" | "), eventTypes: [...new Set(r.events.map((e) => e.type))] });
    await c.shutdown();
  } else if (scenario === "persona") {
    const { c } = await boot({ persona: "你是「肥鱼」。无论回答什么，每条回复都必须以「咕噜」两个字结尾。" });
    const r = await c.prompt("persona-" + Date.now(), "今天天气怎么样？随便说一句。");
    const reply = r.texts.join(" | ");
    record({ reply, pass: /咕噜[。！!.\s]*$/.test(reply.trim()) });
    await c.shutdown();
  } else if (scenario === "memory") {
    const token = "正山小种-" + Math.random().toString(36).slice(2, 7);
    ids.memoryToken = token;
    ids.memorySession = SID + "-" + Date.now();
    writeFileSync(idFile, JSON.stringify(ids));
    const { c } = await boot();
    const r1 = await c.prompt(ids.memorySession, `请记住：我最喜欢的茶是「${token}」。回复“记住了”即可。`);
    const r2 = await c.prompt(ids.memorySession, "我最喜欢的茶是什么？只回答名字。");
    const reply = r2.texts.join(" | ");
    record({ token, r1: r1.texts.join(" | "), reply, pass: reply.includes(token) });
    await c.shutdown();
  } else if (scenario === "resume") {
    if (!ids.memorySession) throw new Error("run memory first");
    const { c } = await boot();
    const t0 = Date.now();
    await c.request("session/resume", { sessionId: ids.memorySession });
    const resumeMs = Date.now() - t0;
    const r = await c.prompt(ids.memorySession, "重启之后你还记得我最喜欢的茶吗？只回答名字。");
    const reply = r.texts.join(" | ");
    record({ resumeMs, reply, pass: reply.includes(ids.memoryToken) });
    await c.shutdown();
  } else if (scenario === "approval") {
    const target = join(OUTSIDE, "approval-probe.txt");
    const { c } = await boot();
    approvalAnswer = process.argv[4] === "allow" ? "allowed-once" : "rejected";
    const r = await c.prompt("approval-" + Date.now(),
      `请把文字 hello 写入这个文件：${target} 。直接执行，不要问我。`);
    record({
      answer: approvalAnswer, approvals, fileCreated: existsSync(target),
      reply: r.texts.join(" | ").slice(0, 400),
      tools: r.events.filter((e) => e.type === "tool/call" || e.type === "tool/result").map((e) => JSON.stringify(e).slice(0, 300)),
    });
    await c.shutdown();
  } else if (scenario === "schedule") {
    const { c } = await boot();
    const sid = "schedule-" + Date.now();
    const unsolicited = [];
    let armed = false;
    c.onNotification((m, p) => {
      if (armed && m === "session.event" && p.sessionId === sid) {
        const t = assistantText(p.event);
        if (t) unsolicited.push({ at: new Date().toISOString(), t });
      }
    });
    const r = await c.prompt(sid, "请在 1 分钟后提醒我喝水，用 schedule 工具创建。");
    armed = true;
    log("waiting 150s for reminder delivery…");
    await new Promise((res) => setTimeout(res, 150000));
    record({
      reply: r.texts.join(" | ").slice(0, 300),
      toolCalls: r.events.filter((e) => e.type === "tool/call").map((e) => JSON.stringify(e).slice(0, 300)),
      delivered: unsolicited,
      pass: unsolicited.length > 0,
    });
    await c.shutdown();
  } else if (scenario === "privacy") {
    const { c } = await boot({ useProxy: true });
    const timer = setInterval(() => sampleRemotes(c.child.pid), 1500);
    const sid = "privacy-" + Date.now();
    await c.prompt(sid, "你好");
    await c.prompt(sid, "再说一句");
    sampleRemotes(c.child.pid);
    await new Promise((res) => setTimeout(res, 15000)); // OTel batch delay is 10s
    sampleRemotes(c.child.pid);
    clearInterval(timer);
    probe.modelRequests = recordingProxy.requests.length;
    for (const request of recordingProxy.requests) {
      if ("dsh_session_log" in request) probe.sessionLogField++;
      for (const key of Object.keys(request)) if (!STD_FIELDS.has(key)) probe.extraFields.add(key);
    }
    const expectedTools = profile === "fatfish-external" ? toolContract.externalToolsMatch : profile === "fatfish-local" ? toolContract.localToolsMatch : null;
    const toolsMatch = expectedTools ? recordingProxy.requests.every(expectedTools) : null;
    const toolNames = [...new Set(recordingProxy.requests.flatMap((r) => (r.tools || []).map((t) => t.name)))].sort();
    const pass = toolsMatch !== false && probe.modelRequests >= 2 && probe.sessionLogField === 0 &&
      !probe.extraFields.has("dsh_plugin_packages") && probe.otlpHits === 0 && probe.remotes.size === 0;
    if (!pass) process.exitCode = 1;
    record({
      pass, toolsMatch, toolNames, modelRequests: probe.modelRequests, sessionLogField: probe.sessionLogField,
      extraFields: [...probe.extraFields], otlpHits: probe.otlpHits, remotes: [...probe.remotes],
    });
    await c.shutdown();
  }
} catch (e) {
  record({ error: String(e.message || e) });
  process.exitCode = 1;
}
process.exit(process.exitCode || 0);
