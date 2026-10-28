"use strict";
// Development tooling only. Not in build.files; no runtime license bypass is added to the client.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign } = require("node:crypto");
const FIXED_CODE = "FF" + "3".repeat(28) + "9A7C";
const normalizeCode = value => typeof value === "string" ? value.trim().toUpperCase().replace(/[ \t\r\n-]/g, "") : "";
const hash = value => createHash("sha256").update(value).digest("hex");
function directory(file) {
  fs.mkdirSync(file, { recursive: true, mode: 0o700 });
  const s = fs.lstatSync(file); if (!s.isDirectory() || s.isSymbolicLink()) throw Error("development_directory_invalid");
}
function loadServerKey(serverRoot) {
  directory(serverRoot); const file = path.join(serverRoot, "development-signing.key");
  try {
    const privateBytes = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" });
    const fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(fd, privateBytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw Error("development_server_key_invalid");
  const privateKey = createPrivateKey({ key: fs.readFileSync(file), format: "der", type: "pkcs8" });
  if (privateKey.asymmetricKeyType !== "ed25519") throw Error("development_server_key_invalid");
  return { privateKey, publicKey: createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64") };
}
async function startDevelopmentActivation(serverRoot) {
  const { privateKey, publicKey } = loadServerKey(serverRoot);
  const server = http.createServer(async (request, response) => {
    const reply = (status, data) => { if (!response.destroyed) response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(data)); };
    try {
      if (request.method !== "POST" || request.url !== "/activate" || request.headers.origin || !/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) { request.resume(); return reply(400, { ok: false, error: "invalid_request" }); }
      const parts = []; let bytes = 0;
      for await (const part of request) { bytes += part.length; if (bytes > 1024) { reply(413, { ok: false, error: "invalid_request" }); request.destroy(); return; } parts.push(part); }
      const data = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (!data || Array.isArray(data) || Object.keys(data).sort().join("|") !== "code|fingerprint" || typeof data.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(data.fingerprint)) return reply(400, { ok: false, error: "invalid_request" });
      if (normalizeCode(data.code) !== FIXED_CODE) return reply(400, { ok: false, error: "invalid_code" });
      const payload = Buffer.from(JSON.stringify({ version: 1, product: "fatfish", code_hash: hash(FIXED_CODE), fingerprint: data.fingerprint, issued_at: new Date().toISOString(), edition: "v1" }));
      reply(200, { ok: true, license: { payload: payload.toString("base64url"), signature: sign(null, payload, privateKey).toString("base64url") } });
    } catch { reply(400, { ok: false, error: "invalid_request" }); }
  });
  server.requestTimeout = 5000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { publicKey, activationURL: "http://127.0.0.1:" + server.address().port + "/activate",
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
function copyDevelopmentClient(repo, runRoot, trust) {
  const coreSource = path.join(repo, "app/core"), uiSource = path.join(repo, "app/electron-ui"), core = path.join(runRoot, "app/core"), ui = path.join(runRoot, "app/electron-ui");
  directory(core); directory(ui);
  for (const entry of fs.readdirSync(coreSource, { withFileTypes: true })) {
    const isDirectory = ["profiles", "channels"].includes(entry.name);
    if (!isDirectory && !/\.(?:mjs|cjs|js)$/.test(entry.name) && !["package.json", "package-lock.json"].includes(entry.name)) continue;
    if (entry.isSymbolicLink() || (isDirectory ? !entry.isDirectory() : !entry.isFile())) throw Error("development_source_link_invalid");
    fs.cpSync(path.join(coreSource, entry.name), path.join(core, entry.name), { recursive: true });
  }
  fs.cpSync(path.join(coreSource, "node_modules/ws"), path.join(core, "node_modules/ws"), { recursive: true });
  for (const entry of JSON.parse(fs.readFileSync(path.join(uiSource, "package.json"), "utf8")).build.files) {
    const name = entry.replace(/\/\*\*\/\*$/, ""), from = path.resolve(uiSource, name), to = path.resolve(ui, name);
    if (name.includes("*") || !from.startsWith(uiSource + path.sep) || !to.startsWith(ui + path.sep)) throw Error("development_copy_manifest_invalid");
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true });
  }
  // Only this copied public module changes. Never write a private key or an issued license here.
  fs.writeFileSync(path.join(core, "license-trust.cjs"), '"use strict";module.exports=Object.freeze(' + JSON.stringify({ publicKey: trust.publicKey, activationURL: trust.activationURL }) + ");\n");
  return { core, ui };
}
module.exports = { FIXED_CODE, normalizeCode, startDevelopmentActivation, copyDevelopmentClient };
