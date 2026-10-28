"use strict";
const fs = require("node:fs");
const { join, resolve, sep } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");
const home = fs.mkdtempSync(join(tmpdir(), "fatfish-status-ui-"));
const env = { ...process.env, FATFISH_STATUS_TEST_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
let result;
try {
  result = spawnSync(require("electron"), [join(__dirname, "status-ui-test.js"), ...process.argv.slice(2)], { env, stdio: "inherit", windowsHide: true, timeout: 180000 });
} finally {
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-status-ui-")) fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.exit(result?.status ?? 1);
