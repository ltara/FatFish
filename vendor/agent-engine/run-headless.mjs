#!/usr/bin/env node
/**
 * Optional sidecar / mock for M1 verify.
 * Real installs may replace this with a launcher that boots the pinned engine.
 * Zero tools: print final text only.
 */
const args = process.argv.slice(2).filter((a) => a !== "--zero-tools");
const job = args.join(" ").trim() || "";
const persona = process.env.FATFISH_AGENT_PERSONA || "";
// Extract user turn if present
let user = job;
const m = job.match(/\[用户私聊\]\s*([\s\S]*?)(?:\n\n请仅输出|$)/);
if (m) user = m[1].trim();
const reply =
  "（本机助手引擎试验）已收到：" +
  (user || "空消息").slice(0, 120) +
  (persona ? "｜人设已注入" : "");
process.stdout.write(reply + "\n");
process.exit(0);
