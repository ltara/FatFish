/** Shared algorithm, independently invoked in each process. No flag, IPC bool, or environment license bypass. */
"use strict";
const fs = require("node:fs"), path = require("node:path"), { createPublicKey, verify, randomUUID, createHash } = require("node:crypto");
const trust = require("./license-trust.cjs"), device = require("./device-fingerprint.cjs");
const hex = /^[0-9a-f]{64}$/;
const exact = (v, keys) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).join("|") === keys.join("|");
function decode(value, max) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("license_invalid");
  const bytes = Buffer.from(value, "base64url"); if (bytes.toString("base64url") !== value) throw new Error("license_invalid"); return bytes;
}
function verifyBytes(raw, fingerprint, publicKey = trust.publicKey) {
  try {
    if (!publicKey || typeof publicKey !== "string") throw new Error("license_unconfigured");
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 16384 || !hex.test(fingerprint)) throw new Error("license_invalid");
    const license = JSON.parse(raw);
    if (!exact(license, ["payload", "signature"]) || JSON.stringify(license) + "\n" !== raw) throw new Error("license_invalid");
    const bytes = decode(license.payload, 8192), signature = decode(license.signature, 128);
    if (signature.length !== 64) throw new Error("license_invalid");
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "ed25519" || !verify(null, bytes, key, signature)) throw new Error("license_invalid");
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes), payload = JSON.parse(json);
    if (!exact(payload, ["version", "product", "code_hash", "fingerprint", "issued_at", "edition"]) || JSON.stringify(payload) !== json || payload.version !== 1 || payload.product !== "fatfish" || payload.edition !== "v1" || !hex.test(payload.code_hash) || !hex.test(payload.fingerprint) || typeof payload.issued_at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(payload.issued_at) || new Date(payload.issued_at).toISOString() !== payload.issued_at) throw new Error("license_invalid");
    if (payload.fingerprint !== fingerprint) throw new Error("license_wrong_device");
    return { valid: true, edition: payload.edition }; // No code, fingerprint or license content goes to UI.
  } catch (e) { return { valid: false, error: ["license_unconfigured", "license_wrong_device"].includes(e.message) ? e.message : "license_invalid" }; }
}
function activationURL() {
  try {
    const u = new URL(trust.activationURL);
    if (u.username || u.password || u.search || u.hash || !(u.protocol === "https:" || u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))) throw new Error();
    return u.href;
  } catch { throw new Error("license_unconfigured"); }
}
class LicenseGate {
  constructor(root) { this.root = root; this.file = path.join(root, "license.json"); }
  inspect() {
    if (!trust.publicKey) return { valid: false, error: "license_unconfigured" };
    try {
      const stat = fs.lstatSync(this.file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return { valid: false, error: "license_invalid" };
      return verifyBytes(fs.readFileSync(this.file, "utf8"), device.fingerprint());
    } catch (e) { return { valid: false, error: e.code === "ENOENT" ? "activation_required" : e.message === "device_unavailable" ? e.message : "license_invalid" }; }
  }
  requireValid() { const state = this.inspect(); if (!state.valid) throw new Error(state.error); return state; }
  install(license) {
    const raw = JSON.stringify(license) + "\n", state = verifyBytes(raw, device.fingerprint());
    if (!state.valid) throw new Error(state.error);
    const temp = this.file + "." + randomUUID() + ".tmp"; let fd;
    try {
      fs.mkdirSync(this.root, { recursive: true });
      if (fs.lstatSync(this.root).isSymbolicLink()) throw new Error();
      try { const s = fs.lstatSync(this.file); if (!s.isFile() || s.isSymbolicLink()) throw new Error("license_save_failed"); } catch (e) { if (e.code !== "ENOENT") throw e; }
      fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, raw, "utf8"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.file); return state;
    } catch { throw new Error("license_save_failed"); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch { /* only this transaction's file */ } }
  }
  async activate(value) {
    if (this.activating) throw new Error("activation_busy");
    if (!trust.publicKey) throw new Error("license_unconfigured");
    const url = activationURL(), code = typeof value === "string" ? value.trim().toUpperCase().replace(/[ \t\r\n-]/g, "") : "";
    if (!/^FF[0-9A-F]{32}$/.test(code)) throw new Error("invalid_code");
    const fingerprint = device.fingerprint(); this.activating = true;
    try {
      let response;
      try { response = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, fingerprint }), signal: AbortSignal.timeout(15000) }); }
      catch { throw new Error("activation_network"); }
      let bytes = 0, text = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
      try { for await (const part of response.body) { bytes += part.length; if (bytes > 16384) throw new Error(); text += decoder.decode(part, { stream: true }); } text += decoder.decode(); }
      catch { throw new Error("activation_response_invalid"); }
      let data; try { data = JSON.parse(text); } catch { throw new Error("activation_response_invalid"); }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("activation_response_invalid");
      if (!response.ok || data.ok !== true) throw new Error(["invalid_code", "device_limit", "rate_limited"].includes(data.error) ? data.error : "activation_unavailable");
      const verified = verifyBytes(JSON.stringify(data.license) + "\n", fingerprint);
      if (!verified.valid) throw new Error(verified.error);
      const payload = JSON.parse(decode(data.license.payload, 8192).toString("utf8"));
      if (payload.code_hash !== createHash("sha256").update(code).digest("hex")) throw new Error("activation_response_invalid");
      return this.install(data.license);
    } finally { this.activating = false; }
  }
}
module.exports = { LicenseGate, verifyBytes };
