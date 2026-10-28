/** Development only. A byte-identical isolated app copy except for an ephemeral PUBLIC trust anchor.
 * No private key is written and no production environment/key bypass is introduced.
 */
"use strict";
const fs = require("node:fs"), path = require("node:path"), { createHash, generateKeyPairSync, sign } = require("node:crypto");
const source = path.resolve(__dirname, ".."), cache = new Map();
function licensedFixture(home) {
  const root = path.resolve(home); if (cache.has(root)) return cache.get(root);
  const appRoot = path.join(root, ".licensed-fixture"), core = path.join(appRoot, "app/core");
  fs.mkdirSync(core, { recursive: true });
  fs.cpSync(source, core, { recursive: true, filter: (file) => !/^(?:dev|node_modules)(?:[\\/]|$)/.test(path.relative(source, file)) });
  fs.cpSync(path.join(source, "node_modules/ws"), path.join(core, "node_modules/ws"), { recursive: true });
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  fs.writeFileSync(path.join(core, "license-trust.cjs"), '"use strict"; module.exports=Object.freeze(' + JSON.stringify({ publicKey, activationURL: null }) + ');\n');
  const fingerprint = require("../device-fingerprint.cjs").fingerprint();
  const issue = (overrides = {}) => {
    const json = JSON.stringify({ version: 1, product: "fatfish", code_hash: "a".repeat(64), fingerprint, issued_at: "2026-10-26T00:00:00.000Z", edition: "v1", ...overrides });
    const bytes = Buffer.from(json); return { payload: bytes.toString("base64url"), signature: sign(null, bytes, keys.privateKey).toString("base64url") };
  };
  fs.writeFileSync(path.join(root, "license.json"), JSON.stringify(issue()) + "\n", { mode: 0o600 });
  // Preserve the actual locked executable path without copying binaries or linking user directories.
  const exe = path.resolve(source, "../../vendor/dsh/deepseek-harness-sdk-runtime-win-x64.exe");
  const manifest = [];
  const visit = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory()) visit(p); else if (!p.includes(path.sep + "node_modules" + path.sep) && entry.name !== "license-trust.cjs") { const relative = path.relative(core, p), original = fs.readFileSync(path.join(source, relative)), copy = fs.readFileSync(p); if (!original.equals(copy)) throw new Error("licensed_fixture_source_mismatch"); manifest.push({ path: relative, sha256: createHash("sha256").update(copy).digest("hex") }); } } };
  visit(core);
  let uiCopy;
  const ui = ({ setupComplete = false } = {}) => {
    if (uiCopy) return uiCopy;
    const original = path.resolve(source, "../electron-ui"); uiCopy = path.join(appRoot, "app/electron-ui");
    const files = JSON.parse(fs.readFileSync(path.join(original, "package.json"), "utf8")).build.files;
    for (const entry of files) {
      const name = entry.replace(/\/\*\*\/\*$/, ""), from = path.resolve(original, name), to = path.resolve(uiCopy, name);
      if (name.includes("*") || !from.startsWith(original + path.sep) || !to.startsWith(uiCopy + path.sep)) throw new Error("unsafe_ui_fixture_manifest");
      fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true });
    }
    // Dependency lookup only, not a trust override. Native tests use the installed pinned shell/dependencies.
    process.env.NODE_PATH = path.join(original, "node_modules") + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : "");
    require("node:module").Module._initPaths();
    // Existing feature UI suites exercise an already-configured installation, not first-run acceptance.
    // Fresh onboarding suites must leave this option false and earn receipts through real operations.
    if (setupComplete && !fs.existsSync(path.join(root, "onboarding.json"))) fs.writeFileSync(path.join(root, "onboarding.json"), JSON.stringify({ version: 1, deferred: false, baseComplete: true, tested: null, qqActive: false, qqComplete: false }) + "\n");
    return uiCopy;
  };
  const result = { core, ui, entry: path.join(core, "server.mjs"), env: { FATFISH_DSH_EXE: exe }, publicKey, fingerprint, issue, manifest,
    gate: () => require(path.join(core, "license-gate.cjs")) };
  cache.set(root, result); return result;
}
module.exports = { licensedFixture };
