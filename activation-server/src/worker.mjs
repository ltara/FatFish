/** Activation only: no model calls, owner data, plaintext codes in storage, or request-body logging. */
const encoder = new TextEncoder(), hex64 = /^[0-9a-f]{64}$/;
export const codeHash = async (code) => hash(normalizeCode(code));
async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map((n) => n.toString(16).padStart(2, "0")).join(""); }
export function normalizeCode(value) {
  if (typeof value !== "string") throw new Error("invalid_code");
  const code = value.trim().toUpperCase();
  if (!/^FF[0-9A-F]{32}$/.test(code) && !/^FF-(?:[0-9A-F]{8}-){3}[0-9A-F]{8}$/.test(code)) throw new Error("invalid_code");
  return code.replaceAll("-", "");
}
const response = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
const deny = (status, error) => response(status, { ok: false, error });
const only = (data, fields) => data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === fields.length && fields.every((f) => Object.hasOwn(data, f));
const isHash = (s) => typeof s === "string" && hex64.test(s);
async function bodyOf(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new Error("invalid_request");
  const reader = request.body?.getReader(); if (!reader) throw new Error("invalid_request");
  let size = 0; const chunks = [];
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16384) throw new Error("invalid_request"); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  try { const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; } return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("invalid_request"); }
}
async function authorized(request, env) {
  if (typeof env.ADMIN_TOKEN !== "string" || env.ADMIN_TOKEN.length < 32) return false;
  const token = request.headers.get("authorization") || ""; if (token.length > 1024) return false;
  const a = await hash(token), b = await hash("Bearer " + env.ADMIN_TOKEN); let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function limited(request, env) {
  if (typeof env.RATE_SALT !== "string" || env.RATE_SALT.length < 32) throw new Error("unavailable");
  // Cloudflare supplies this header in production. A direct origin bypass must not be deployed.
  const ip = request.headers.get("CF-Connecting-IP") || "local", minute = Math.floor(Date.now() / 60000);
  const subject = await hash(env.RATE_SALT + ":" + ip);
  const row = await env.DB.prepare(`INSERT INTO rate_limits(subject, minute, attempts) VALUES (?, ?, 1)
    ON CONFLICT(subject) DO UPDATE SET minute=excluded.minute,
      attempts=CASE WHEN rate_limits.minute=excluded.minute THEN rate_limits.attempts+1 ELSE 1 END RETURNING attempts`).bind(subject, minute).first();
  // Bounded historical retention; this does not pretend to defeat distributed abuse.
  await env.DB.prepare("DELETE FROM rate_limits WHERE minute < ?").bind(minute - 10).run();
  return row.attempts > 10;
}
async function signedLicense(env, code_hash, fingerprint, issued_at, edition) {
  if (typeof env.LICENSE_PRIVATE_KEY !== "string" || env.LICENSE_PRIVATE_KEY.length > 1024) throw new Error("unavailable");
  const raw = Uint8Array.from(atob(env.LICENSE_PRIVATE_KEY), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", raw, { name: "Ed25519" }, false, ["sign"]);
  const bytes = encoder.encode(JSON.stringify({ version: 1, product: "fatfish", code_hash, fingerprint, issued_at, edition }));
  const encode = (value) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return { payload: encode(bytes), signature: encode(await crypto.subtle.sign("Ed25519", key, bytes)) };
}
async function activate(request, env) {
  if (await limited(request, env)) return deny(429, "rate_limited");
  const data = await bodyOf(request);
  if (!only(data, ["code", "fingerprint"]) || !isHash(data.fingerprint)) return deny(400, "invalid_request");
  let code_hash; try { code_hash = await codeHash(data.code); } catch { return deny(400, "invalid_code"); }
  const code = await env.DB.prepare("SELECT edition FROM codes WHERE code_hash=? AND status='active'").bind(code_hash).first();
  if (!code) return deny(400, "invalid_code");
  const now = new Date().toISOString();
  // Sign before allocating a device, so missing/bad signing configuration never consumes a slot.
  const license = await signedLicense(env, code_hash, data.fingerprint, now, code.edition);
  // The capacity and revocation conditions are checked in this ONE write statement, not a read/write pair.
  const allocated = await env.DB.prepare(`INSERT INTO devices(code_hash, fingerprint, first_seen, last_seen)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM codes c WHERE c.code_hash=? AND c.status='active' AND
      (EXISTS (SELECT 1 FROM devices d WHERE d.code_hash=c.code_hash AND d.fingerprint=?) OR
       (SELECT count(*) FROM devices d WHERE d.code_hash=c.code_hash)<c.max_devices))
    ON CONFLICT(code_hash, fingerprint) DO UPDATE SET last_seen=excluded.last_seen RETURNING fingerprint`)
    .bind(code_hash, data.fingerprint, now, now, code_hash, data.fingerprint).first();
  if (!allocated) {
    const active = await env.DB.prepare("SELECT 1 AS active FROM codes WHERE code_hash=? AND status='active'").bind(code_hash).first();
    return deny(400, active ? "device_limit" : "invalid_code");
  }
  return response(200, { ok: true, license });
}
async function admin(request, env, url) {
  if (!await authorized(request, env)) return deny(401, "unauthorized");
  if (request.method === "GET" && url.pathname === "/admin/code") {
    const code_hash = url.searchParams.get("code_hash"); if (!isHash(code_hash)) return deny(400, "invalid_request");
    const code = await env.DB.prepare("SELECT * FROM codes WHERE code_hash=?").bind(code_hash).first();
    if (!code) return deny(404, "not_found");
    const devices = await env.DB.prepare("SELECT fingerprint, first_seen, last_seen FROM devices WHERE code_hash=? ORDER BY fingerprint").bind(code_hash).all();
    return response(200, { ok: true, code, devices: devices.results });
  }
  if (request.method !== "POST") return deny(404, "not_found");
  const data = await bodyOf(request);
  if (url.pathname === "/admin/codes") {
    if (!only(data, ["code_hashes", "edition", "max_devices"]) || data.edition !== "v1" || ![1, 2].includes(data.max_devices) || !Array.isArray(data.code_hashes) || data.code_hashes.length < 1 || data.code_hashes.length > 100 || data.code_hashes.some((h) => !isHash(h)) || new Set(data.code_hashes).size !== data.code_hashes.length) return deny(400, "invalid_request");
    const now = new Date().toISOString(), results = await env.DB.batch(data.code_hashes.map((h) => env.DB.prepare("INSERT INTO codes(code_hash, edition, max_devices, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(code_hash) DO NOTHING").bind(h, data.edition, data.max_devices, now)));
    return response(200, { ok: true, created: results.reduce((n, r) => n + r.meta.changes, 0) });
  }
  if (url.pathname === "/admin/revoke") {
    if (!only(data, ["code_hash"]) || !isHash(data.code_hash)) return deny(400, "invalid_request");
    const result = await env.DB.prepare("UPDATE codes SET status='revoked' WHERE code_hash=?").bind(data.code_hash).run();
    return response(200, { ok: true, found: result.meta.changes > 0 });
  }
  if (url.pathname === "/admin/unbind") {
    if (!only(data, ["code_hash", "fingerprint"]) || !isHash(data.code_hash) || !isHash(data.fingerprint)) return deny(400, "invalid_request");
    const result = await env.DB.prepare("DELETE FROM devices WHERE code_hash=? AND fingerprint=?").bind(data.code_hash, data.fingerprint).run();
    return response(200, { ok: true, removed: result.meta.changes > 0 });
  }
  return deny(404, "not_found");
}
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.headers.has("origin")) return deny(403, "forbidden"); // Only native client/admin CLI, not arbitrary websites.
      if (url.pathname === "/health" && request.method === "GET") return response(200, { ok: true });
      if (url.pathname === "/activate" && request.method === "POST") return await activate(request, env);
      if (url.pathname.startsWith("/admin/")) return await admin(request, env, url);
      return deny(404, "not_found");
    } catch (e) { return deny(e.message === "invalid_request" ? 400 : 503, e.message === "invalid_request" ? "invalid_request" : "unavailable"); }
  },
};
