"use strict";
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve, sep } = require("node:path");
const { spawnSync } = require("node:child_process");
const home = mkdtempSync(join(tmpdir(), "fatfish-pairing-ui-"));
const env = { ...process.env, FATFISH_PAIRING_TEST_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
let result;
try {
  result = spawnSync(require("electron"), [join(__dirname, "pairing-ui-test.js"), ...process.argv.slice(2)], {
    env, stdio: "inherit", windowsHide: true, timeout: process.argv.includes("--review") ? 600000 : 120000,
  });
} finally {
  // Window-profile cache files are locked until the desktop process exits.
  const target = resolve(home), base = resolve(tmpdir()) + sep;
  if (target.startsWith(base + "fatfish-pairing-ui-")) rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.exit(result?.status ?? 1);
