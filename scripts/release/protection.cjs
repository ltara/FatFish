"use strict";
// Build-only. This module and its dependencies must never be copied to the client.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createHash, createPublicKey } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar"), obfuscator = require("javascript-obfuscator");
const resedit = require("resedit");
const repo = path.resolve(__dirname, "../..");
const CORE = ["license-trust.cjs", "device-fingerprint.cjs", "license-gate.cjs", "server.mjs", "engine-host.mjs", "model-service.mjs"];
const UI = ["main.js", "service-manager.js"];
const MODULES = [...CORE.map((p) => `core/${p}`), ...UI.map((p) => `app.asar/${p}`)];
const contexts = new Map();
const hash = (s) => createHash("sha256").update(s).digest("hex");
const fail = (code) => { throw new Error(code); };

function within(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("release_path_invalid");
  return path.resolve(file);
}
function regular(root, relative) {
  const dest = within(root, path.join(root, relative));
  let cursor = path.resolve(root);
  if (!fs.lstatSync(cursor).isDirectory() || fs.lstatSync(cursor).isSymbolicLink()) fail("release_path_invalid");
  for (const part of path.relative(cursor, dest).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) fail("release_path_invalid");
  }
  if (!fs.lstatSync(dest).isFile()) fail("release_file_invalid");
  return dest;
}
function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== "activationURL|publicKey|version" || value.version !== 1) fail("release_config_invalid");
  if (typeof value.publicKey !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.publicKey) || value.publicKey.length > 512) fail("release_public_key_invalid");
  try {
    const bytes = Buffer.from(value.publicKey, "base64");
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || bytes.toString("base64") !== value.publicKey || !key.export({ format: "der", type: "spki" }).equals(bytes)) throw new Error();
  } catch { fail("release_public_key_invalid"); }
  try {
    const url = new URL(value.activationURL);
    // Release endpoints are named public HTTPS hosts, never localhost, an IP literal or a private signing service URL.
    if (typeof value.activationURL !== "string" || url.href !== value.activationURL || url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/activate" || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal)$/i.test(url.hostname)) throw new Error();
  } catch { fail("release_activation_url_invalid"); }
  return Object.freeze({ version: 1, publicKey: value.publicKey, activationURL: value.activationURL });
}
function readConfig(file) {
  try {
    if (typeof file !== "string" || !path.isAbsolute(file)) fail("release_config_required");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) fail("release_config_invalid");
    return validateConfig(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (e) {
    if (/^release_/.test(e.message)) throw e;
    fail("release_config_invalid");
  }
}
function sourceSnapshot(core = path.join(repo, "app/core"), ui = path.join(repo, "app/electron-ui")) {
  return new Map([
    ...CORE.map((p) => [`core/${p}`, fs.readFileSync(regular(core, p), "utf8")]),
    ...UI.map((p) => [`app.asar/${p}`, fs.readFileSync(regular(ui, p), "utf8")]),
  ]);
}
function assertArchive(archive) {
  asar.uncache(archive);
  for (const item of asar.listPackage(archive)) {
    const name = item.replaceAll("\\", "/").replace(/^\//, "");
    if (!name || name.includes(":") || name.split("/").some((p) => !p || p === "." || p === "..")) fail("release_archive_path_invalid");
    const entry = asar.statFile(archive, path.normalize(name), false);
    if (entry.link || entry.unpacked) fail("release_archive_layout_unsupported");
    if (/(?:^|\/)(?:dev|scripts|activation-server|secrets)(?:\/|$)|\.(?:map|bak|pem|key)$|(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.dev\.vars(?:\.|$)/i.test(name) && !name.startsWith("node_modules/")) fail("release_unwanted_file");
  }
}
const plainMarkers = [
  "function verifyBytes(", "function fromParts(", "fatfish-license-device-v1",
  "payload.fingerprint !== fingerprint", "verify(null, bytes, key, signature)",
  "Build-time trust anchor", "BEGIN PRIVATE KEY", "BEGIN ED25519 PRIVATE KEY",
];
function scanText(text) {
  if (plainMarkers.some((v) => text.includes(v)) || /sourceMappingURL=|-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text)) fail("release_plaintext_detected");
}
function syntax(text, filename, temp) {
  const dest = path.join(temp, path.basename(filename));
  fs.writeFileSync(dest, text, { flag: "wx" });
  execFileSync(process.execPath, ["--check", dest], { windowsHide: true, timeout: 15000, stdio: "pipe", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
}
function transform(text, name) {
  return obfuscator.obfuscate(text, {
    target: "node", compact: true, sourceMap: false, seed: 573221,
    identifierNamesGenerator: "hexadecimal", renameGlobals: name !== "app.asar/main.js", renameProperties: false,
    controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.35,
    deadCodeInjection: false, debugProtection: false, selfDefending: false, disableConsoleOutput: false,
    stringArray: true, stringArrayEncoding: ["base64"], stringArrayThreshold: 1,
    splitStrings: true, splitStringsChunkLength: 8, transformObjectKeys: true,
  }).getObfuscatedCode() + "\n";
}
function removeTemp(temp) {
  // Never recursively remove a caller-supplied output/source directory.
  if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + "fatfish-protection-")) fail("release_cleanup_path_invalid");
  fs.rmSync(temp, { recursive: true, force: true });
}
function inspect(resources, manifest) {
  const archive = regular(resources, "app.asar");
  assertArchive(archive);
  if (!manifest || manifest.version !== 1 || manifest.toolVersion !== "4.1.1" || manifest.modules.map((m) => m.path).join("|") !== MODULES.join("|")) fail("release_manifest_invalid");
  for (const m of manifest.modules) {
    const bytes = m.path.startsWith("app.asar/") ? asar.extractFile(archive, m.path.slice(9)) : fs.readFileSync(regular(resources, m.path));
    if (hash(bytes) !== m.protectedSha256 || m.protectedSha256 === m.sourceSha256) fail("release_module_changed");
    scanText(bytes.toString("utf8"));
  }
  if (hash(fs.readFileSync(archive)) !== manifest.appAsarSha256) fail("release_archive_changed");
  // Reject accidental dev/test source, backups, source maps and signing keys outside dependencies too.
  function walk(root, prefix = "") {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      const rel = prefix + ent.name;
      if (ent.isSymbolicLink()) fail("release_path_invalid");
      if (rel === "node_modules") continue;
      if (/(?:^|\/)(?:dev|secrets)(?:\/|$)|\.(?:map|bak|pem|key)$|(?:^|\/)\.env(?:\.|$)/i.test(rel)) fail("release_unwanted_file");
      const file = path.join(root, ent.name);
      if (ent.isDirectory()) walk(file, rel + "/");
      else if (!ent.isFile()) fail("release_file_invalid");
      else if (/\.(?:js|cjs|mjs|json|ya?ml|txt)$/i.test(ent.name)) scanText(fs.readFileSync(file, "utf8"));
    }
  }
  walk(path.join(resources, "core"));
  for (const item of asar.listPackage(archive)) {
    const name = item.replaceAll("\\", "/").replace(/^\//, "");
    if (!name.startsWith("node_modules/") && /\.(?:js|cjs|mjs|json|html|txt)$/i.test(name) && !asar.statFile(archive, path.normalize(name), false).files) scanText(asar.extractFile(archive, path.normalize(name)).toString("utf8"));
  }
  for (const forbidden of ["activation-server", "secrets", "release-config.json", "app.asar.unpacked"]) {
    if (fs.existsSync(path.join(resources, forbidden))) fail("release_unwanted_file");
  }
  return true;
}
async function protect(resources, config, sources) {
  config = validateConfig(config);
  const archive = regular(resources, "app.asar");
  assertArchive(archive);
  const originals = new Map();
  for (const name of MODULES) {
    const text = name.startsWith("app.asar/") ? asar.extractFile(archive, name.slice(9)).toString("utf8") : fs.readFileSync(regular(resources, name), "utf8");
    if (!sources.has(name) || text !== sources.get(name)) fail("release_source_mismatch");
    originals.set(name, text);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fatfish-protection-"));
  try {
    const transformed = new Map();
    for (const name of MODULES) {
      const text = name === "core/license-trust.cjs" ? `"use strict";module.exports=Object.freeze(${JSON.stringify({ publicKey: config.publicKey, activationURL: config.activationURL })});\n` : originals.get(name);
      const output = transform(text, name);
      scanText(output); syntax(output, name, temp); transformed.set(name, output);
    }
    // All eight transforms parse before changing any copied build resource.
    const app = path.join(temp, "app");
    asar.extractAll(archive, app);
    for (const p of UI) fs.writeFileSync(path.join(app, p), transformed.get(`app.asar/${p}`));
    const nextArchive = path.join(temp, "protected.asar");
    await asar.createPackage(app, nextArchive);
    const manifest = {
      version: 1, tool: "javascript-obfuscator", toolVersion: "4.1.1",
      publicKeySha256: hash(Buffer.from(config.publicKey, "base64")),
      modules: MODULES.map((name) => ({ path: name, sourceSha256: hash(originals.get(name)), protectedSha256: hash(transformed.get(name)) })),
      appAsarSha256: hash(fs.readFileSync(nextArchive)),
    };
    for (const p of CORE) fs.writeFileSync(regular(resources, `core/${p}`), transformed.get(`core/${p}`));
    asar.uncache(archive); fs.copyFileSync(nextArchive, archive); asar.uncache(archive);
    inspect(resources, manifest); // Throw before electron-builder signs or creates an installer on any mismatch.
    fs.writeFileSync(path.join(resources, "protection-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    return manifest;
  } finally { removeTemp(temp); }
}
function contextPath(context) {
  if (context.electronPlatformName !== "win32" || context.arch !== 1 || !path.isAbsolute(context.appOutDir || "")) fail("release_target_invalid");
  const out = path.resolve(context.appOutDir);
  const configuredDist = path.join(repo, "app/electron-ui/dist") + path.sep;
  if (out === repo || out.startsWith(path.join(repo, "app") + path.sep) && !out.startsWith(configuredDist)) fail("release_output_path_invalid");
  return out;
}
function executableName(context) {
  const name = context.packager?.appInfo?.productFilename;
  if (typeof name !== "string" || !name || /[\\/:\x00-\x1f]/.test(name) || /[. ]$/.test(name)) fail("release_executable_invalid");
  return name + ".exe";
}
function inspectExecutable(appOutDir, manifest, afterSigning = false) {
  const m = manifest.executable;
  if (!m || typeof m.file !== "string" || path.basename(m.file) !== m.file || !m.file.endsWith(".exe")) fail("release_integrity_invalid");
  const bytes = fs.readFileSync(regular(appOutDir, m.file));
  const resources = resedit.NtExecutableResource.from(resedit.NtExecutable.from(bytes));
  const entries = resources.entries.filter((e) => e.type === "INTEGRITY" && e.id === "ELECTRONASAR");
  const headerHash = hash(asar.getRawHeader(regular(appOutDir, "resources/app.asar")).headerString);
  const list = entries.length === 1 ? JSON.parse(Buffer.from(entries[0].bin).toString("utf8")) : null;
  if ((!afterSigning && hash(bytes) !== m.sha256) || m.asarHeaderSha256 !== headerHash || !Array.isArray(list) || list.length !== 1 || list[0].file !== "resources\\app.asar" || list[0].alg !== "SHA256" || list[0].value !== headerHash) fail("release_integrity_invalid");
  return true;
}
function updateIntegrity(appOutDir, filename, manifest) {
  // Builder 25.1.8 embeds the old ASAR hash before afterPack. Replace it, not append a duplicate,
  // after the archive transform and before signing. Never disable Electron's integrity validation.
  const file = regular(appOutDir, filename), exe = resedit.NtExecutable.from(fs.readFileSync(file));
  const resources = resedit.NtExecutableResource.from(exe);
  const entries = resources.entries.filter((e) => e.type === "INTEGRITY" && e.id === "ELECTRONASAR");
  if (entries.length !== 1) fail("release_integrity_resource_missing");
  const headerHash = hash(asar.getRawHeader(regular(appOutDir, "resources/app.asar")).headerString);
  entries[0].bin = Buffer.from(JSON.stringify([{ file: "resources\\app.asar", alg: "SHA256", value: headerHash }]));
  resources.outputResource(exe); fs.writeFileSync(file, Buffer.from(exe.generate()));
  manifest.executable = { file: filename, sha256: hash(fs.readFileSync(file)), asarHeaderSha256: headerHash };
  inspectExecutable(appOutDir, manifest);
}
async function beforePack(context) {
  const out = contextPath(context), config = readConfig(process.env.FATFISH_RELEASE_CONFIG);
  if (contexts.has(out)) fail("release_build_already_started");
  const ui = JSON.parse(fs.readFileSync(path.join(repo, "app/electron-ui/package.json"), "utf8"));
  if (ui.devDependencies.electron !== "33.4.11" || ui.devDependencies["electron-builder"] !== "25.1.8" || context.packager?.info?.framework?.version !== "33.4.11" || require(path.join(repo, "app/electron-ui/node_modules/electron-builder/package.json")).version !== "25.1.8") fail("release_runtime_version_changed");
  for (const [name, version] of [["javascript-obfuscator", "4.1.1"], ["@electron/asar", "3.4.1"], ["resedit", "1.7.2"]]) {
    if (JSON.parse(fs.readFileSync(path.join(__dirname, "node_modules", name, "package.json"), "utf8")).version !== version) fail("release_tool_version_changed");
  }
  contexts.set(out, { config, sources: sourceSnapshot() });
}
async function afterPack(context) {
  const out = contextPath(context), saved = contexts.get(out);
  if (!saved) fail("release_preflight_required");
  contexts.delete(out);
  const name = executableName(context);
  regular(out, name);
  const manifest = await protect(path.join(out, "resources"), saved.config, saved.sources);
  updateIntegrity(out, name, manifest);
  fs.writeFileSync(path.join(out, "resources/protection-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
async function afterSign(context) {
  const out = contextPath(context), resources = path.join(out, "resources"), file = regular(resources, "protection-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  inspect(resources, manifest); inspectExecutable(out, manifest, true);
  // Builder may edit/sign the PE after afterPack. Check the embedded ASAR metadata first,
  // then record these final executable bytes without touching its signature.
  manifest.executable.sha256 = hash(fs.readFileSync(regular(out, manifest.executable.file)));
  manifest.executable.finalizedAfterSign = true;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  inspectExecutable(out, manifest);
  return manifest;
}
module.exports = { beforePack, afterPack, afterSign, validateConfig, readConfig, sourceSnapshot, protect, inspect, inspectExecutable, MODULES, CORE, UI, hash };
