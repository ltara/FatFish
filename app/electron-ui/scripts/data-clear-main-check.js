"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const model = require("../../core/model-config.cjs"), { fixture } = require("./clear-main-fixture.cjs");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "fatfish-clear-main-")), results = [];
const evidenceAt = process.argv.indexOf("--evidence"), evidence = evidenceAt < 0 ? null : path.resolve(process.argv[evidenceAt + 1]);
const check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
const opts = (includeKeys = false, includeLicense = false) => ({ confirmed: true, includeKeys, includeLicense });
let main;
async function setup(n) {
  const root = path.join(base, "root-" + n); fs.mkdirSync(root); const m = await fixture(root);
  model.save(root, { provider: "custom", api: "openai-completions", baseURL: "https://model.fatfish.test/v1", model: "fixture", key: "sk-clear-main-fixture-only" });
  fs.mkdirSync(path.join(root, "chat")); fs.writeFileSync(path.join(root, "chat/history.json"), "[]");
  return { root, main: m, before: model.read(root), license: fs.readFileSync(path.join(root, "license.json")) };
}
(async () => {
  try {
    let s = await setup(1); main = s.main;
    for (const id of ["get-data-clear-plan", "clear-local-data"]) assert.equal((await main.handlers.get(id)({ sender: {}, senderFrame: {} }, opts())).error, "forbidden");
    check("foreign windows/frames cannot preview or clear application data", main.stopped() === 0 && fs.existsSync(path.join(s.root, "chat/history.json")));
    for (const bad of [true, false, { confirmed: true }, { ...opts(), includeLicense: "true" }, { ...opts(), root: base }]) assert.equal((await main.call("clear-local-data", bad)).error, "clear_args_invalid");
    check("Main rejects legacy/truthy/widened confirmation before stopping or deleting", main.stopped() === 0 && model.read(s.root).key === s.before.key);
    const plan = await main.call("get-data-clear-plan", { includeKeys: false, includeLicense: false });
    check("Main plan exposes only trusted count metadata", plan.ok && Number.isSafeInteger(plan.data.count) && Object.keys(plan.data).join() === "count");
    let resolve; main.setPending(new Promise((r) => { resolve = r; })); const inFlight = main.call("model-get"); await Promise.resolve();
    check("an active protected command prevents clear instead of racing its late writes", (await main.call("clear-local-data", opts())).error === "clear_busy" && main.stopped() === 0);
    resolve({ ok: true, data: {} }); await inFlight; main.setPending(null);
    main.setStopFailure(true); const stopFailed = await main.call("clear-local-data", opts());
    check("a failed safe-stop aborts before data deletion", stopFailed.error === "clear_stop_failed" && fs.existsSync(path.join(s.root, "chat/history.json")) && model.read(s.root).key === s.before.key);
    check("commands cannot restart or write data after reset lock has begun", (await main.call("model-test", {})).error === "data_reset_locked" && (await main.call("get-onboarding")).error === "data_reset_locked");
    check("a failed stop is not falsely presented as stopped or private app state", (await main.call("get-status")).data_clear_locked === true && (await main.call("get-status")).presentation.label === "需退出" && !(await main.call("get-status")).appdata);
    main.setStopFailure(false); const result = await main.call("clear-local-data", opts());
    check("explicit retry stops services then clears all local display data", result.ok && result.exiting === true && main.stopped() === 1 && !fs.existsSync(path.join(s.root, "chat")) && !fs.existsSync(path.join(s.root, "runtime")));
    check("actual Main default keeps valid license and custom model credentials", fs.readFileSync(path.join(s.root, "license.json")).equals(s.license) && model.read(s.root).keyRef === s.before.keyRef && model.read(s.root).key === s.before.key);
    check("cleared progress cannot be recreated from old in-memory pending receipts", vm.runInContext("onboarding.pending.size", main.context) === 0 && (await main.call("get-onboarding")).error === "data_reset_locked");
    main.timers.find((t) => t.ms === 200).fn();
    check("success schedules exit, never an automatic relaunch", main.quits() === 1);
    await main.dispose(); main = null;
    for (const [n, keys, license] of [[2, true, false], [3, false, true], [4, true, true]]) {
      s = await setup(n); main = s.main; const r = await main.call("clear-local-data", opts(keys, license));
      check("Main independently honors key/license scopes: " + keys + "/" + license, r.ok && fs.existsSync(path.join(s.root, "license.json")) === !license && fs.existsSync(path.join(s.root, "secrets", s.before.keyRef)) === !keys);
      await main.dispose(); main = null;
    }
    const channels = new Map(), exposed = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8"), { require: () => ({ contextBridge: { exposeInMainWorld: (_name, api) => Object.assign(exposed, api) }, ipcRenderer: { invoke: (id, args) => { channels.set(id, args); }, on() {}, removeListener() {} } }) });
    exposed.getDataClearPlan({ includeKeys: true, includeLicense: false }); exposed.clearLocalData(opts(false, true));
    check("preload forwards scope objects unchanged and offers no filesystem path API", channels.get("get-data-clear-plan").includeKeys === true && channels.get("clear-local-data").includeLicense === true && !exposed.clearDataPath);
    console.log(`${results.length}/${results.length} data-clear Main checks passed (actual Main/preload, VM shell, no windows/paid calls)`);
  } finally { await main?.dispose(); if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "data-clear-main-report.json"), JSON.stringify({ results, nativeUI: false, paidCalls: 0, actualUserData: false }, null, 2)); } if (path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep + "fatfish-clear-main-")) fs.rmSync(base, { recursive: true, force: true }); }
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
