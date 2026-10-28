"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fatfish-clear-repro-"));
(async () => {
  let main;
  try {
    main = await require("./clear-main-fixture.cjs").fixture(root);
    fs.mkdirSync(path.join(root, "secrets"), { recursive: true }); fs.writeFileSync(path.join(root, "secrets/deepseek_api_key"), "sk-clear-repro-not-a-key");
    fs.mkdirSync(path.join(root, "chat")); fs.writeFileSync(path.join(root, "chat/history.json"), "[]");
    const result = await main.call("clear-local-data", true);
    console.log(JSON.stringify({ actualMain: true, nativeUI: false, paidCalls: 0, acceptedGenericConfirmation: result.ok === true, keyDeletedWithoutSeparateConsent: !fs.existsSync(path.join(root, "secrets/deepseek_api_key")), chatDataLeftBehind: fs.existsSync(path.join(root, "chat/history.json")), servicesStoppedBeforeClear: main.stopped() > 0 }));
  } finally { await main?.dispose(); if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "fatfish-clear-repro-")) fs.rmSync(root, { recursive: true, force: true }); }
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
