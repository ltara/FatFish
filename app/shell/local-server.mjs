/**
 * FatFish local settings server — bind 127.0.0.1 only.
 * POST /api/save-key  { "key": "..." } → %AppData%/FatFish/secrets/deepseek_api_key
 * Never echo the key back.
 */
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, "..", "web");

function resolveAppDataRoot() {
  if (process.env.FATFISH_APPDATA) return process.env.FATFISH_APPDATA;
  if (process.env.APPDATA) return join(process.env.APPDATA, "FatFish");
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, "FatFish");
  return join(homedir(), ".local", "share", "FatFish");
}

const root = resolveAppDataRoot();
const secretsDir = join(root, "secrets");
const keyPath = join(secretsDir, "deepseek_api_key");
const configPath = join(root, "config.json");

function loadPort() {
  try {
    if (existsSync(configPath)) {
      const j = JSON.parse(readFileSync(configPath, "utf8"));
      return Number(j.settings_port) || 8787;
    }
  } catch { /* ignore */ }
  return Number(process.env.FATFISH_SETTINGS_PORT) || 8787;
}

const PORT = loadPort();
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function cors(res, req) {
  // Local-only server: allow Electron/Tauri webview origins + loopback settings UI.
  const origin = (req && req.headers && req.headers.origin) || "";
  const allowed =
    !origin ||
    origin.startsWith("http://127.0.0.1") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("https://tauri.localhost") ||
    origin.startsWith("http://tauri.localhost") ||
    origin.startsWith("tauri://") ||
    origin.startsWith("file://") ||
    origin === "null";
  res.setHeader("Access-Control-Allow-Origin", allowed ? (origin || "*") : "http://127.0.0.1:" + PORT);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj, req) {
  cors(res, req);
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/risk.html" : urlPath;
  rel = rel.replace(/\?.*$/, "");
  if (rel.includes("..")) {
    res.writeHead(400);
    res.end("bad path");
    return;
  }
  const file = join(webRoot, rel);
  if (!file.startsWith(webRoot) || !existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = extname(file);
  cors(res, req);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  res.end(readFileSync(file));
}

const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || "").split(":")[0];
  if (host && host !== "127.0.0.1" && host !== "localhost") {
    res.writeHead(403);
    res.end("local only");
    return;
  }

  if (req.method === "OPTIONS") {
    cors(res, req);
    res.writeHead(204);
    res.end();
    return;
  }

  const u = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (req.method === "POST" && u.pathname === "/api/save-key") {
    try {
      const raw = await readBody(req);
      const data = JSON.parse(raw || "{}");
      const key = typeof data.key === "string" ? data.key.trim() : "";
      if (!key) {
        sendJson(res, 400, { ok: false, error: "empty_key" }, req);
        return;
      }
      mkdirSync(secretsDir, { recursive: true });
      writeFileSync(keyPath, key + "\n", { encoding: "utf8", mode: 0o600 });
      console.log(new Date().toISOString(), "key_saved", "present");
      sendJson(res, 200, { ok: true }, req);
    } catch (e) {
      console.log(new Date().toISOString(), "save_key_error", String(e.message || e).slice(0, 120));
      sendJson(res, 500, { ok: false, error: "save_failed" }, req);
    }
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/status") {
    const hasKey = existsSync(keyPath) && readFileSync(keyPath, "utf8").trim().length > 0;
    sendJson(res, 200, { ok: true, key: hasKey ? "present" : "missing" }, req);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res, u.pathname);
    return;
  }

  res.writeHead(405);
  res.end("method not allowed");
});

server.listen(PORT, HOST, () => {
  console.log(new Date().toISOString(), `local-server http://${HOST}:${PORT} web=${webRoot} root=${root}`);
});
