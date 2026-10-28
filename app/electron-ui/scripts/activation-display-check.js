/** Actual crypto + Main/preload/about function, plain objects only. No native UI or paid calls. */
"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm"), http = require("node:http"), assert = require("node:assert/strict"), { createHash } = require("node:crypto");
const display = require("../activation-display"), clear = require("../data-clear");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fatfish-activation-display-")), results = [];
const evidenceAt = process.argv.indexOf("--evidence"), evidence = evidenceAt < 0 ? null : path.resolve(process.argv[evidenceAt + 1]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex"), check = (name, value) => { results.push({ name, pass: !!value }); assert.ok(value, name); console.log("PASS " + name); };
let main, server, requests = 0, fail = false;
(async () => {
  try {
    const fixture = require("../../core/dev/license-fixture.cjs").licensedFixture(root), file = path.join(root, "activation-display.json"), license = path.join(root, "license.json"), code = "FF" + "A".repeat(28) + "7B2C";
    server = http.createServer(async (request, response) => {
      requests++; let bytes = ""; for await (const chunk of request) bytes += chunk;
      const data = JSON.parse(bytes), envelope = fixture.issue({ code_hash: hash(data.code) });
      response.writeHead(fail ? 400 : 200, { "content-type": "application/json" }).end(JSON.stringify(fail ? { ok: false, error: "invalid_code" } : { ok: true, license: envelope }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    // Public config only, in the already-isolated test copy; no production trust override.
    fs.writeFileSync(path.join(fixture.core, "license-trust.cjs"), '"use strict"; module.exports=' + JSON.stringify({ publicKey: fixture.publicKey, activationURL: "http://127.0.0.1:" + server.address().port + "/activate" }) + ";\n");
    main = await require("./clear-main-fixture.cjs").fixture(root);
    check("old valid license without metadata remains valid and exposes no invented tail", (await main.call("get-license")).valid && !Object.hasOwn(await main.call("get-license"), "codeTail"));
    fs.unlinkSync(license);
    const activated = await main.call("activate-license", code.toLowerCase());
    check("actual Main and real license client activate against a local signed response", activated.ok && requests === 1);
    const state = await main.call("get-license"), raw = fs.readFileSync(file, "utf8");
    check("only four normalized original code characters are persisted", JSON.parse(raw).codeTail === "7B2C" && !raw.includes(code) && !raw.includes(fixture.fingerprint));
    check("display metadata is bound to exact installed license bytes", JSON.parse(raw).licenseHash === hash(fs.readFileSync(license)) && state.codeTail === "7B2C");
    check("Main response exposes only verified state and optional tail", Object.keys(state).sort().join("|") === "codeTail|edition|valid" && !JSON.stringify(state).includes(code));
    let api;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8"), { require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: { invoke: (name, ...args) => main.call(name, ...args) } }) });
    check("actual preload forwards bounded metadata without exposing filesystem paths", (await api.getLicense()).codeTail === "7B2C" && !JSON.stringify(await api.getLicense()).includes(root));
    const source = fs.readFileSync(path.join(__dirname, "../renderer/renderer.js"), "utf8"), start = source.indexOf("  function licenseSummary(state) {"), end = source.indexOf("  async function restartServices()", start);
    assert.ok(start >= 0 && end > start);
    const elements = new Map(), query = id => { if (!elements.has(id)) elements.set(id, { textContent: "" }); return elements.get(id); }, view = vm.createContext({ api, $: query });
    vm.runInContext(source.slice(start, end), view); await vm.runInContext("loadAbout()", view);
    check("actual renderer about function reads actual preload/Main and shows the tail", query("#about-license").textContent === "已激活 · 本机 · 激活码尾号 7B2C");
    check("old license fallback is honest and does not slice code hash", vm.runInContext('licenseSummary({valid:true, code_hash:"abcdef1234"})', view) === "已激活 · 本机");
    for (const value of [null, "7b2c", "12345", 1234, "<b>", "FULL-ACTIVATION-CODE"]) {
      view.testState = { valid: true, codeTail: value }; check("renderer rejects malformed tail type/format " + results.length, vm.runInContext("licenseSummary(testState)", view) === "已激活 · 本机");
    }
    check("invalid verification state can never show activation or tail", vm.runInContext('licenseSummary({valid:false,codeTail:"7B2C"})', view) === "尚未激活" && display.read(root, { valid: false }) === null);
    check("fresh process/module instance can read metadata without activation networking", require("node:child_process").execFileSync(process.execPath, ["-e", "process.stdout.write(require(process.argv[1]).read(process.argv[2],{valid:true})||'')", path.resolve(__dirname, "../activation-display.js"), root], { windowsHide: true, encoding: "utf8" }) === "7B2C" && requests === 1);
    check("wrong input code cannot overwrite the existing receipt", !display.save(root, "FF" + "B".repeat(32)) && fs.readFileSync(file, "utf8") === raw);
    const validLicense = fs.readFileSync(license), changed = fixture.issue({ code_hash: "b".repeat(64) });
    new (fixture.gate().LicenseGate)(root).install(changed);
    check("another valid signed license does not inherit the previous code tail", (await main.call("get-license")).valid && !Object.hasOwn(await main.call("get-license"), "codeTail"));
    fs.writeFileSync(license, validLicense); fs.writeFileSync(license, Buffer.concat([validLicense, Buffer.from(" ")]));
    check("authentic receipt cannot unlock a tampered license", !(await main.call("get-license")).valid && !Object.hasOwn(await main.call("get-license"), "codeTail"));
    fs.writeFileSync(license, validLicense);
    for (const data of ["bad-json", raw.trim(), JSON.stringify({ ...JSON.parse(raw), codeTail: 1234 }) + "\n", JSON.stringify({ ...JSON.parse(raw), licenseHash: "b".repeat(64) }) + "\n", "x".repeat(513)]) {
      fs.writeFileSync(file, data); check("bad display data never invalidates the signed offline license " + results.length, (await main.call("get-license")).valid && !Object.hasOwn(await main.call("get-license"), "codeTail"));
    }
    fs.unlinkSync(file); fs.mkdirSync(file);
    const again = await main.call("activate-license", code);
    check("display write failure does not negate successful activation or trigger automatic retry", again.ok && requests === 2 && (await main.call("get-license")).valid && !Object.hasOwn(await main.call("get-license"), "codeTail"));
    fs.rmdirSync(file); check("valid display can be explicitly reconstructed with the original code", display.save(root, code));
    const preserved = fs.readFileSync(file, "utf8"), before = fs.readFileSync(license); fail = true;
    check("rejected activation changes neither prior license nor display", !(await main.call("activate-license", code)).ok && requests === 3 && fs.readFileSync(file, "utf8") === preserved && fs.readFileSync(license).equals(before));
    const outside = path.join(root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep.txt"), "preserved");
    fs.unlinkSync(file); fs.symlinkSync(outside, file, "junction");
    check("display junction is neither followed nor overwritten", display.read(root, { valid: true }) === null && !display.save(root, code) && fs.readFileSync(path.join(outside, "keep.txt"), "utf8") === "preserved");
    fs.unlinkSync(file); display.save(root, code);
    clear.clear(root, { confirmed: true, includeKeys: false, includeLicense: false });
    check("default data clear preserves the license and its display receipt", fs.existsSync(license) && fs.existsSync(file));
    clear.clear(root, { confirmed: true, includeKeys: false, includeLicense: true });
    check("separate license consent clears display before license and preserves unrelated files", !fs.existsSync(license) && !fs.existsSync(file) && fs.existsSync(path.join(outside, "keep.txt")));
    check("display metadata alone cannot grant activation", !(await main.call("get-license")).valid);
    check("production license trust remains unconfigured; license verifier unchanged", require("../../core/license-trust.cjs").publicKey === null);
    console.log(`${results.length}/${results.length} activation display checks passed (no windows or paid calls)`);
  } finally {
    await main?.dispose(); if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "activation-display-report.json"), JSON.stringify({ results, nativeUI: false, realQQ: false, paidCalls: 0, actualMainPreloadRenderer: true,
      source: ["activation-display.js", "main.js", "preload.js", "renderer/renderer.js", "data-clear.js"].map(name => ({ path: name, sha256: hash(fs.readFileSync(path.resolve(__dirname, "..", name))) })) }, null, 2)); }
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "fatfish-activation-display-")) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
