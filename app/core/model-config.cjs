/** Core-owned model route + versioned key references. A single config rename commits both facts. */
"use strict";
const fs = require("node:fs"), path = require("node:path"), { randomUUID, createHash } = require("node:crypto");
const { readConfig } = require("./channel-config.cjs");
const presets = Object.freeze({
  "deepseek-official": { api: "native", baseURL: "https://api.deepseek.com/anthropic", model: "deepseek-flash" },
  openai: { api: "openai-responses", baseURL: "https://api.openai.com/v1" },
  anthropic: { api: "anthropic-messages", baseURL: "https://api.anthropic.com" },
  moonshotai: { api: "openai-completions", baseURL: "https://api.moonshot.cn/v1" },
  zai: { api: "openai-completions", baseURL: "https://open.bigmodel.cn/api/paas/v4" },
});
const apis = Object.freeze(["openai-completions", "openai-responses", "anthropic-messages"]);
const fields = ["provider", "model", "api", "baseURL", "contextWindow", "maxTokens"];
const keyRefOK = (s) => typeof s === "string" && /^model-[0-9a-f-]{36}\.key$/.test(s);
const keyOK = (s) => typeof s === "string" && s.length > 0 && s.length <= 4096 && /^[\x21-\x7e]+$/.test(s);
function guard(root) {
  for (const file of [path.join(root, "config.json"), path.join(root, "secrets")]) {
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error("model_path_invalid"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}
function endpoint(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) throw new Error("model_endpoint_invalid");
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash || !u.hostname) throw new Error();
    return u.href.replace(/\/+$/, "");
  } catch { throw new Error("model_endpoint_invalid"); }
}
function normalize(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("model_config_invalid");
  const provider = raw.provider ?? "deepseek-official", preset = typeof provider === "string" && Object.hasOwn(presets, provider) ? presets[provider] : null;
  if (!preset && provider !== "custom") throw new Error("model_provider_invalid");
  const model = raw.model ?? preset?.model;
  if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(model)) throw new Error("model_name_invalid");
  const api = preset?.api ?? raw.api, baseURL = endpoint(preset?.baseURL ?? raw.baseURL);
  if (provider === "custom" && !apis.includes(api)) throw new Error("model_api_invalid");
  if (preset && (raw.api !== undefined && raw.api !== api || raw.baseURL !== undefined && endpoint(raw.baseURL) !== baseURL)) throw new Error("model_preset_override");
  if (provider === "deepseek-official") return { provider, model, api, baseURL };
  const contextWindow = raw.contextWindow ?? 65536, maxTokens = raw.maxTokens ?? 4096;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 2147483647 || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) throw new Error("model_capacity_invalid");
  return { provider, model, api, baseURL, contextWindow, maxTokens };
}
function readKey(root, ref) {
  guard(root); const file = path.join(root, "secrets", ref);
  try {
    const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8192) throw new Error();
    const value = fs.readFileSync(file, "utf8").trim(); if (!keyOK(value)) throw new Error(); return value;
  } catch (e) { if (e.code === "ENOENT") return null; throw new Error("model_key_unavailable"); }
}
function read(root) {
  guard(root); const config = readConfig(path.join(root, "config.json")), raw = config.model ?? {}, route = normalize(raw), generation = raw.generation ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0 || raw.keyRef !== undefined && !keyRefOK(raw.keyRef)) throw new Error("model_config_invalid");
  let key = null, keyError = false;
  try { key = raw.keyRef ? readKey(root, raw.keyRef) : route.provider === "deepseek-official" ? readKey(root, "deepseek_api_key") : null; } catch { keyError = true; }
  return { route, generation, keyRef: raw.keyRef || null, key, keyError };
}
const authScope = (route) => JSON.stringify([route.provider, route.api, route.baseURL]);
function describe(state) {
  return { ...state.route, generation: state.generation, key_saved: !!state.key, key_tail: state.key?.length >= 8 ? state.key.slice(-4) : null, key_error: !!state.keyError };
}
function draft(root, args) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((k) => ![...fields, "key", "expectedGeneration"].includes(k))) throw new Error("model_args_invalid");
  const current = read(root), route = normalize(args);
  if (args.expectedGeneration !== undefined && (!Number.isSafeInteger(args.expectedGeneration) || args.expectedGeneration < 0)) throw new Error("model_args_invalid");
  if (args.expectedGeneration !== undefined && args.expectedGeneration !== current.generation) throw new Error("model_stale");
  const typed = args.key === undefined || args.key === "" ? null : typeof args.key === "string" ? args.key.trim() : false;
  if (typed !== null && !keyOK(typed)) throw new Error("model_key_invalid");
  const key = typed || (authScope(route) === authScope(current.route) ? current.key : null);
  if (!key) throw new Error("no_key"); // Never send a saved key to a different endpoint by accident.
  return { route, key, current, changed: JSON.stringify(route) !== JSON.stringify(current.route) || key !== current.key };
}
function save(root, args) {
  const next = draft(root, args);
  if (!next.changed) return { ...describe(next.current), changed: false };
  const generation = next.current.generation + 1; if (!Number.isSafeInteger(generation)) throw new Error("model_config_invalid");
  guard(root); const dir = path.join(root, "secrets"), ref = "model-" + randomUUID() + ".key", file = path.join(dir, ref), configFile = path.join(root, "config.json");
  const temp = configFile + "." + randomUUID() + ".tmp"; let fd, committed = false;
  try {
    fs.mkdirSync(dir, { recursive: true }); guard(root);
    fd = fs.openSync(file, "wx", 0o600); fs.writeFileSync(fd, next.key + "\n", "utf8"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const config = readConfig(configFile); config.model = { ...next.route, generation, keyRef: ref };
    fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, JSON.stringify(config, null, 2) + "\n", "utf8"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, configFile); committed = true;
  } catch { throw new Error("model_save_failed"); }
  finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* only this write's temp */ }
    if (!committed) { try { fs.unlinkSync(file); } catch { /* only this transaction's uncommitted key */ } }
  }
  // Only after the config points to the fsynced new key may its previous owned key be removed.
  const old = next.current.keyRef || (next.current.route.provider === "deepseek-official" ? "deepseek_api_key" : null);
  if (old) { try { fs.unlinkSync(path.join(dir, old)); } catch { /* cleanup failure does not undo a committed setting */ } }
  return { ...describe({ route: next.route, generation, key: next.key }), changed: true };
}
function contextSuffix(root) {
  const state = read(root), baseline = normalize();
  if (state.generation === 0 && JSON.stringify(state.route) === JSON.stringify(baseline)) return "";
  return "-m" + state.generation + "-" + createHash("sha256").update(JSON.stringify(state.route)).digest("hex").slice(0, 12);
}
function runtime(state, { noRetries = false } = {}) {
  if (state.route.provider === "deepseek-official") return { provider: "deepseek-official", model: state.route.model, env: { DEEPSEEK_API_KEY: state.key }, patch: [] };
  return { provider: "fatfish-model", model: state.route.model, env: { FATFISH_MODEL_API_KEY: state.key }, patch: [{ id: "llm-pi-ai", config: { providers: { "fatfish-model": {
    apiKeyEnv: "FATFISH_MODEL_API_KEY", api: state.route.api, baseURL: state.route.baseURL,
    models: [{ id: state.route.model, contextWindow: state.route.contextWindow, maxTokens: state.route.maxTokens }],
    ...(noRetries ? { retryPolicy: { mode: "normal", maxRetries: 0 } } : {}),
  } } } }] };
}
module.exports = { presets, apis, normalize, endpoint, read, describe, draft, save, contextSuffix, runtime };
