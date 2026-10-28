/**
 * AppData layout + small readers shared by Core modules.
 * Root: FATFISH_APPDATA, else %APPDATA%\FatFish, else ~/.fatfish (dev).
 */
import { readFileSync, existsSync, mkdirSync, cpSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import channelConfig from "./channel-config.cjs";
import modelConfig from "./model-config.cjs";

export const CORE_DIR = dirname(fileURLToPath(import.meta.url));

export function resolveAppDataRoot() {
  if (process.env.FATFISH_APPDATA) return process.env.FATFISH_APPDATA;
  if (process.env.APPDATA) return join(process.env.APPDATA, "FatFish");
  return join(homedir(), ".fatfish");
}

export const root = resolveAppDataRoot();
export const paths = {
  root,
  config: join(root, "config.json"),
  key: join(root, "secrets", "deepseek_api_key"),
  token: join(root, "secrets", "local_token"),
  persona: join(root, "persona.txt"),
  personas: join(root, "personas.json"),
  outboundPaused: join(root, "runtime", "outbound_paused"),
  dshHome: join(root, "dsh"),
  workspace: join(root, "workspace"),
};

export function instancePaths(name) {
  if (!["external", "local"].includes(name)) throw new Error("unknown_instance");
  return { dshHome: join(paths.dshHome, name), workspace: join(paths.workspace, name) };
}

/** Preserve original data; keep legacy owner session IDs via a routing map. */
export function migrateLegacySessions() {
  const home = instancePaths("external").dshHome;
  const legacy = join(paths.dshHome, "sessions");
  const marker = join(home, "legacy-session.json");
  const cfg = loadConfig();
  const owner = Array.isArray(cfg.owners) ? String(cfg.owners.find((o) => o?.channel === "qq")?.account || "") : String(cfg.owner_qq || "").trim();
  if (!existsSync(legacy) || !owner) return "owner-main";
  mkdirSync(home, { recursive: true });
  if (!existsSync(marker)) {
    const sessionId = `owner-qq-${owner}`;
    // A retry after interrupted copying cannot overwrite newer session data.
    cpSync(legacy, join(home, "sessions"), { recursive: true, force: false, errorOnExist: false });
    writeFileSync(marker, JSON.stringify({ version: 1, sessionId, owner }));
  }
  const m = JSON.parse(readFileSync(marker, "utf8"));
  return m.owner === owner && m.sessionId === `owner-qq-${owner}` ? m.sessionId : "owner-main";
}

export function ensureDirs() {
  for (const d of ["secrets", "logs", "runtime", "dsh", "workspace"]) mkdirSync(join(root, d), { recursive: true });
}

function readText(p) {
  try {
    return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
  } catch {
    return "";
  }
}

const CONFIG_DEFAULTS = {
  onebot_url: "ws://127.0.0.1:3001",
  owner_qq: "",
  model: { provider: "deepseek-official", model: "deepseek-flash" },
};

export function loadConfig() {
  try {
    if (existsSync(paths.config)) {
      const j = JSON.parse(readFileSync(paths.config, "utf8"));
      return { ...CONFIG_DEFAULTS, ...j, qq_enabled: channelConfig.qqEnabled(j), model: { ...CONFIG_DEFAULTS.model, ...(j.model || {}) } };
    }
  } catch {
    /* fall back to defaults */
  }
  return { ...CONFIG_DEFAULTS, qq_enabled: false };
}

export const loadKey = () => { try { return modelConfig.read(root).key; } catch { return null; } };
export const loadToken = () => readText(paths.token);
export const isOutboundPaused = () => readText(paths.outboundPaused) === "1";

/** Active persona body: personas.json active item → persona.txt → "" (profile has a default). */
export function loadPersona() {
  try {
    if (existsSync(paths.personas)) {
      const j = JSON.parse(readFileSync(paths.personas, "utf8"));
      const items = Array.isArray(j.items) ? j.items : [];
      const active = items.find((x) => x && x.id === j.activePersonaId) || items[0];
      const body = String(active?.body || "").trim();
      if (body) return body;
    }
  } catch {
    /* fall through */
  }
  return readText(paths.persona);
}

/** Metadata-only logger: never pass message text or secrets here. */
export function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

export function redact(s) {
  return String(s ?? "")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***");
}
