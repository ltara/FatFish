"use strict";
const fs = require("node:fs"), { join, resolve, sep } = require("node:path"), { tmpdir } = require("node:os"), { spawnSync } = require("node:child_process");
const home = fs.mkdtempSync(join(tmpdir(), "fatfish-local-ui-"));
const env = { ...process.env, FATFISH_LOCAL_TEST_HOME: home }; delete env.ELECTRON_RUN_AS_NODE;
let result;
try { result = spawnSync(require("electron"), [join(__dirname, "local-ui-test.js"), ...process.argv.slice(2)], { env, stdio: "inherit", windowsHide: true, timeout: process.argv.includes("--review") ? 480000 : 180000 }); }
finally { if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-local-ui-")) fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
process.exit(result?.status ?? 1);
