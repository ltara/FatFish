"use strict";
const fs = require("node:fs"), path = require("node:path");
const { readConfig, inspect, inspectExecutable, hash } = require("./protection.cjs");
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--app-dir" || args[2] !== "--config" || !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) throw new Error("release_verify_arguments");
  const root = path.resolve(args[1]), config = readConfig(args[3]), resources = path.join(root, "resources"), file = path.join(resources, "protection-manifest.json");
  const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error("release_manifest_invalid");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest.publicKeySha256 !== hash(Buffer.from(config.publicKey, "base64"))) throw new Error("release_public_key_mismatch");
  inspect(resources, manifest); inspectExecutable(root, manifest);
  console.log("Protected artifact checks passed (local build audit, not a cryptographic publisher signature).");
} catch (e) {
  console.error(/^release_/.test(e.message) ? e.message : "release_artifact_invalid"); process.exitCode = 1;
}
