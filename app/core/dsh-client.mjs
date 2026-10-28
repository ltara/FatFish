/**
 * Minimal DSH SDK client: spawn `dsh --profile <p>` and speak newline-delimited
 * JSON-RPC 2.0 over stdio (protocol of the pinned 0.2.1-rc.2 runtime).
 * Lifecycle, sessions and approvals live in engine-host.mjs.
 */
import { spawn } from "node:child_process";

export class DshClient {
  constructor({ exe, profile, args = [], env, cwd, onServerRequest, log }) {
    this.exe = exe;
    this.profile = profile;
    this.args = [...args];
    this.env = env;
    this.cwd = cwd;
    this.onServerRequest = onServerRequest || (async () => { throw new Error("no_handler"); });
    this.log = log || (() => {});
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.stderrTail = "";
  }

  start() {
    this.startedAt = Date.now();
    this.child = spawn(this.exe, ["--profile", this.profile, ...this.args], {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.#onLine(line);
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (s) => {
      this.stderrTail = (this.stderrTail + s).slice(-8000);
    });
    this.exited = new Promise((resolve) => {
      let finished = false;
      const finish = (code, sig) => {
        if (finished) return;
        finished = true;
        for (const p of this.pending.values()) p.reject(new Error(`dsh_exit_${code}_${sig}`));
        this.pending.clear();
        resolve({ code, sig });
      };
      this.child.on("exit", finish);
      this.child.on("error", () => finish(null, "spawn_error"));
    });
    this.child.stdin.on("error", () => {}); // Exit/error settles outstanding RPCs.
  }

  #send(obj) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\n");
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log("non_json_stdout", line.slice(0, 120));
      return;
    }
    if (msg.id != null && msg.method) {
      Promise.resolve()
        .then(() => this.onServerRequest(msg.method, msg.params))
        .then(
          (result) => this.#send({ id: msg.id, result }),
          (e) => this.#send({ id: msg.id, error: { code: -32603, message: String(e.message || e) } })
        );
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) for (const fn of this.listeners) fn(msg.method, msg.params);
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc_timeout_${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.#send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  onNotification(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Send one text prompt and resolve once the session goes running → idle.
   * Returns assistant texts in order plus the last turn/end reason (e.g. { kind: "completed" }).
   */
  async prompt(sessionId, text, timeoutMs = 180000) {
    const texts = [];
    const events = [];
    let endReason = null;
    let sawRunning = false;
    let off;
    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => (off(), reject(new Error("turn_timeout"))), timeoutMs);
      this.exited.then(() => (clearTimeout(t), off(), reject(new Error("engine_exited"))));
      off = this.onNotification((method, p) => {
        if (!p || p.sessionId !== sessionId) return;
        if (method === "session.event") {
          events.push(p.event);
          if (p.event?.type === "turn/end") endReason = p.event.data?.reason || null;
          const txt = assistantText(p.event);
          if (txt) texts.push(txt);
        } else if (method === "session.status") {
          if (p.status === "running") sawRunning = true;
          else if (p.status === "idle" && sawRunning) {
            clearTimeout(t);
            off();
            resolve();
          }
        }
      });
    });
    // Attach both rejection handlers immediately; a prompt RPC error must not leave
    // the turn waiter as an unhandled rejection when the process later exits.
    await Promise.all([this.request("session/prompt", { sessionId, contentBlocks: [{ type: "text", text }] }), done]);
    return { texts, events, endReason };
  }

  async shutdown() {
    try {
      await this.request("shutdown", undefined, 15000);
    } catch {
      /* fall through to kill */
    }
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    let timer;
    const r = await Promise.race([this.exited, new Promise((res) => { timer = setTimeout(() => res(null), 10000); })]);
    clearTimeout(timer);
    if (!r) this.child.kill();
    return r;
  }
}

/** Extract plain text from an assistant/message session event (`data.message.content`, reasoning skipped). */
export function assistantText(ev) {
  if (!ev || ev.type !== "assistant/message") return "";
  const blocks = ev.data?.message?.content || [];
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
}
