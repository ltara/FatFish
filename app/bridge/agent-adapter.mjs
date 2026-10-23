/**
 * Optional local assistant-engine adapter (M1 first knife).
 * Flag default OFF. Engine is NEVER required for companion path.
 * Zero tools: headless/sdk text only. Spawn/timeout/crash → caller falls back.
 * Product copy: "本机助手引擎（试验）" — never name upstream brands in UI.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PINNED = "0.2.1-rc.2";
const DEFAULT_TIMEOUT_MS = 45000;

function resolveAppDataRoot() {
  if (process.env.FATFISH_APPDATA) return process.env.FATFISH_APPDATA;
  if (process.env.APPDATA) return join(process.env.APPDATA, "FatFish");
  return join(homedir(), ".fatfish");
}

function readAgentEngineFlag(config) {
  const ae = config && config.agent_engine;
  if (ae && typeof ae === "object") {
    return {
      enabled: ae.enabled === true,
      timeout_ms: Number(ae.timeout_ms) > 0 ? Number(ae.timeout_ms) : DEFAULT_TIMEOUT_MS,
      pinned_version: String(ae.pinned_version || PINNED),
    };
  }
  // flat key support
  if (config && config["agent_engine.enabled"] === true) {
    return { enabled: true, timeout_ms: DEFAULT_TIMEOUT_MS, pinned_version: PINNED };
  }
  return { enabled: false, timeout_ms: DEFAULT_TIMEOUT_MS, pinned_version: PINNED };
}

/**
 * Candidate sidecar roots (first hit wins). Not inside main Setup.
 */
function candidateEngineRoots(bundleRoot) {
  const roots = [];
  if (process.env.FATFISH_AGENT_ENGINE) roots.push(process.env.FATFISH_AGENT_ENGINE);
  const appData = resolveAppDataRoot();
  roots.push(join(appData, "agent-engine"));
  roots.push(join(appData, "vendor", "agent-engine"));
  if (bundleRoot) {
    roots.push(join(bundleRoot, "vendor", "agent-engine"));
    roots.push(join(bundleRoot, "agent-engine"));
  }
  // repo-relative when running from source
  roots.push(join(__dirname, "..", "..", "vendor", "agent-engine"));
  return roots;
}

function pickExisting(paths) {
  for (const p of paths) {
    try {
      if (p && existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Resolve how to launch the optional engine.
 * Supports:
 *  - run-headless.mjs / run-headless.js (FatFish thin wrapper / mock)
 *  - node_modules/@deepseek-ai/dsh (npx-style local install)
 *  - dsh.cmd / dsh / bin/dsh
 */
function resolveEngineLaunch(bundleRoot) {
  for (const root of candidateEngineRoots(bundleRoot)) {
    if (!existsSync(root)) continue;

    const wrappers = [
      join(root, "run-headless.mjs"),
      join(root, "run-headless.js"),
      join(root, "bin", "run-headless.mjs"),
    ];
    const wrapper = pickExisting(wrappers);
    if (wrapper) {
      return { kind: "wrapper", root, entry: wrapper, nodeNeeded: true };
    }

    const dshPkg = join(root, "node_modules", "@deepseek-ai", "dsh", "package.json");
    if (existsSync(dshPkg)) {
      try {
        const pkg = JSON.parse(readFileSync(dshPkg, "utf8"));
        const binRel =
          (pkg.bin && (pkg.bin.dsh || pkg.bin["@deepseek-ai/dsh"])) ||
          pkg.main ||
          "dist/bin.js";
        const entry = join(root, "node_modules", "@deepseek-ai", "dsh", binRel);
        if (existsSync(entry)) {
          return { kind: "dsh-pkg", root, entry, nodeNeeded: true, version: pkg.version || "" };
        }
      } catch {
        /* continue */
      }
    }

    const bins = [
      join(root, "dsh.cmd"),
      join(root, "dsh.exe"),
      join(root, "dsh"),
      join(root, "bin", "dsh.cmd"),
      join(root, "bin", "dsh"),
    ];
    const bin = pickExisting(bins);
    if (bin) {
      return { kind: "dsh-bin", root, entry: bin, nodeNeeded: false };
    }
  }
  return null;
}

function isEngineAvailable(bundleRoot) {
  return !!resolveEngineLaunch(bundleRoot);
}

/**
 * Run one headless turn. Returns final assistant text or throws.
 * Zero tools: prompt is text-only; no tool flags passed.
 */
function runHeadless({ apiKey, persona, userText, timeoutMs, bundleRoot, log }) {
  const launch = resolveEngineLaunch(bundleRoot);
  if (!launch) {
    const err = new Error("agent_engine_unavailable");
    err.code = "unavailable";
    throw err;
  }

  const job =
    (persona ? `[人设]\n${persona}\n\n` : "") +
    `[用户私聊]\n${userText}\n\n` +
    "请仅输出对用户的最终回复正文，不要工具调用，不要解释过程。";

  const env = {
    ...process.env,
    DEEPSEEK_API_KEY: apiKey || process.env.DEEPSEEK_API_KEY || "",
    // common aliases some runtimes read
    OPENAI_API_KEY: apiKey || process.env.OPENAI_API_KEY || "",
    FATFISH_AGENT_ZERO_TOOLS: "1",
    FATFISH_AGENT_PERSONA: persona || "",
  };
  // Never inherit a forced enable from parent in unexpected ways
  delete env.FATFISH_FORCE_AGENT;

  let cmd;
  let args;
  if (launch.kind === "wrapper") {
    cmd = process.execPath;
    args = [launch.entry, "--zero-tools", job];
  } else if (launch.kind === "dsh-pkg") {
    cmd = process.execPath;
    args = [launch.entry, "--profile", "headless", job];
  } else {
    cmd = launch.entry;
    args = ["--profile", "headless", job];
  }

  if (typeof log === "function") {
    log("agent_engine_spawn", launch.kind, launch.root);
  }

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cmd, args, {
      cwd: launch.root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 1500);
      const err = new Error("agent_engine_timeout");
      err.code = "timeout";
      reject(err);
    }, timeoutMs || DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (b) => {
      stdout += b.toString("utf8");
      if (stdout.length > 200000) stdout = stdout.slice(-100000);
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString("utf8");
      if (stderr.length > 50000) stderr = stderr.slice(-20000);
    });

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = new Error("agent_engine_spawn_error:" + (e && e.message ? e.message : "unknown"));
      err.code = "spawn";
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const err = new Error(
          "agent_engine_exit_" + code + ":" + (stderr || stdout).slice(0, 200)
        );
        err.code = "crash";
        reject(err);
        return;
      }
      const text = extractFinalText(stdout);
      if (!text) {
        const err = new Error("agent_engine_empty_output");
        err.code = "empty";
        reject(err);
        return;
      }
      resolve(text);
    });
  });
}

function extractFinalText(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) return "";
  // Prefer last non-empty line block; strip common CLI noise prefixes
  const lines = raw.split(/\r?\n/).map((l) => l.trimEnd());
  const useful = lines.filter(
    (l) =>
      l &&
      !/^\[dsh\]/i.test(l) &&
      !/^boot\b/i.test(l) &&
      !/^connecting\b/i.test(l) &&
      !/^npm\s/i.test(l)
  );
  const body = (useful.length ? useful : lines).join("\n").trim();
  return body.slice(0, 4000);
}

/**
 * High-level: try engine when enabled+available; else return { used:false }.
 * Never throws for "disabled" — only throws on hard programming errors.
 */
async function tryAgentReply({
  config,
  apiKey,
  persona,
  userText,
  bundleRoot,
  log,
}) {
  const flag = readAgentEngineFlag(config || {});
  if (!flag.enabled) {
    return { used: false, reason: "flag_off" };
  }
  if (!isEngineAvailable(bundleRoot)) {
    if (typeof log === "function") log("agent_engine_skip", "sidecar_missing");
    return { used: false, reason: "sidecar_missing" };
  }
  try {
    const text = await runHeadless({
      apiKey,
      persona,
      userText,
      timeoutMs: flag.timeout_ms,
      bundleRoot,
      log,
    });
    return { used: true, text, pinned: flag.pinned_version };
  } catch (e) {
    if (typeof log === "function") {
      log("agent_engine_fallback", e && e.code ? e.code : "error", String(e.message || e).slice(0, 120));
    }
    return { used: false, reason: (e && e.code) || "error", error: e };
  }
}

export {
  PINNED,
  readAgentEngineFlag,
  isEngineAvailable,
  resolveEngineLaunch,
  tryAgentReply,
  candidateEngineRoots,
};
