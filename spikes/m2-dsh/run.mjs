/**
 * M2 DSH spike scenarios (Windows). Usage:
 *   DSH_EXE=... SPIKE_HOME=... DEEPSEEK_API_KEY=... node run.mjs <scenario> [profile]
 * Scenarios: boot | persona | memory | resume | approval | schedule | privacy
 * Results append to <SPIKE_HOME>/results.jsonl. Never prints the API key.
 */
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdirSync, appendFileSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DshClient, assistantText } from "./dsh-client.mjs";

const scenario = process.argv[2] || "boot";
const profile = process.argv[3] || "fatfish";
const EXE = process.env.DSH_EXE;
const HOME = process.env.SPIKE_HOME;
const MODEL = process.env.SPIKE_MODEL || "deepseek-flash";
if (!EXE || !HOME) throw new Error("set DSH_EXE and SPIKE_HOME");
if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY missing");

const WORK = join(HOME, "workspace");
// Must sit outside both the workspace and %TEMP% (workspace-write grants temp).
const OUTSIDE = process.env.SPIKE_OUTSIDE || join(process.env.USERPROFILE || HOME, "fatfish-spike-outside");
mkdirSync(WORK, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
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
function startModelProxy() {
  return new Promise((res) => {
    const s = http.createServer((req, r) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        if (req.method === "POST") {
          probe.modelRequests++;
          try {
            const j = JSON.parse(body.toString("utf8"));
            if ("dsh_session_log" in j) probe.sessionLogField++;
            for (const k of Object.keys(j)) if (!STD_FIELDS.has(k)) probe.extraFields.add(k);
          } catch {
            /* non-json */
          }
        }
        const headers = { ...req.headers, host: "api.deepseek.com" };
        delete headers["content-length"];
        headers["content-length"] = String(body.length);
        const up = https.request({ host: "api.deepseek.com", path: req.url, method: req.method, headers }, (ur) => {
          r.writeHead(ur.statusCode, ur.headers);
          ur.pipe(r);
        });
        up.on("error", (e) => (r.writeHead(502), r.end(String(e.message))));
        up.end(body);
      });
    });
    s.listen(0, "127.0.0.1", () => res(s));
  });
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
function startApprovalServer(token) {
  return new Promise((res) => {
    const s = http.createServer((req, r) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.headers.authorization !== `Bearer ${token}`) return r.writeHead(401).end();
        const p = JSON.parse(body || "{}");
        approvals.push(p);
        log("APPROVAL(plugin)", JSON.stringify(p));
        r.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ outcome: approvalAnswer }));
      });
    });
    s.listen(0, "127.0.0.1", () => res(s));
  });
}

async function boot({ useProxy = false, persona } = {}) {
  const env = { ...process.env, DSH_HOME: HOME, TZ: "Asia/Shanghai" };
  const approvalToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const approvalSrv = await startApprovalServer(approvalToken);
  env.FATFISH_APPROVAL_URL = `http://127.0.0.1:${approvalSrv.address().port}/approval`;
  env.FATFISH_APPROVAL_TOKEN = approvalToken;
  if (persona) env.FATFISH_PERSONA = persona;
  if (useProxy) {
    const sink = await startOtlpSink();
    const proxy = await startModelProxy();
    env.DSH_TELEMETRY_OTLP_URL = `http://127.0.0.1:${sink.address().port}/v1/logs`;
    env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${proxy.address().port}`;
  }
  const c = new DshClient({
    exe: EXE, profile, env, cwd: WORK, log,
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
    approvalRequests: true, capabilities: { userQuestions: true },
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
    record({
      modelRequests: probe.modelRequests, sessionLogField: probe.sessionLogField,
      extraFields: [...probe.extraFields], otlpHits: probe.otlpHits, remotes: [...probe.remotes],
    });
    await c.shutdown();
  }
} catch (e) {
  record({ error: String(e.message || e) });
  process.exitCode = 1;
}
process.exit();
