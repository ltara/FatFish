"use strict";
const fs = require("node:fs");
const { join, resolve, sep } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");
const home = fs.mkdtempSync(join(tmpdir(), "fatfish-lifecycle-ui-"));
const env = { ...process.env, FATFISH_LIFECYCLE_TEST_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
let status = 0;
try {
  for (const args of [[], ["--restart"]]) {
    const r = spawnSync(require("electron"), [join(__dirname, "lifecycle-ui-test.js"), ...args], { env, stdio: "inherit", windowsHide: true, timeout: 120000 });
    if (r.status !== 0) { status = r.status || 1; break; }
  }
  if (!status) console.log("desktop lifecycle passed across two Electron processes (no paid calls)");
} finally {
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-lifecycle-ui-")) fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.exit(status);
