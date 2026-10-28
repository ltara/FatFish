"use strict";
// Optional, user-run, headless verification only. No app window, real model or real account.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { createHash } = require("node:crypto");
const dev = require("./development-activation.cjs"), license = require("../../core/license-gate.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fatfish-development-check-")), serverRoot = path.join(root, "server"), runRoot = path.join(root, "client");
const repo = path.resolve(__dirname, "../../.."), fp = "b".repeat(64); let service, count = 0;
const check = (name, ok) => { assert.ok(ok, name); count++; console.log("PASS " + name); };
(async () => {
  try {
    check("fixed development code has the real client's format", /^FF[0-9A-F]{32}$/.test(dev.FIXED_CODE) && dev.FIXED_CODE.endsWith("9A7C"));
    service = await dev.startDevelopmentActivation(serverRoot);
    const request = async (body, headers = {}) => { const response = await fetch(service.activationURL, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
    check("development issuer binds to loopback only", new URL(service.activationURL).hostname === "127.0.0.1");
    const bad = await request({ code: "FF" + "0".repeat(32), fingerprint: fp });
    check("wrong codes produce no license", bad.status === 400 && bad.data.error === "invalid_code" && !bad.data.license);
    const good = await request({ code: "ff-3333-3333-3333-3333-3333-3333-3333-9a7c", fingerprint: fp });
    const bytes = JSON.stringify(good.data.license) + "\n", pub = service.publicKey;
    check("fixed code issues a real signature accepted by the unchanged client algorithm", good.status === 200 && license.verifyBytes(bytes, fp, pub).valid);
    check("another device cannot use that signed license", license.verifyBytes(bytes, "c".repeat(64), pub).error === "license_wrong_device");
    check("tampering remains rejected", !license.verifyBytes(bytes + " ", fp, pub).valid);
    check("ordinary source trust does not accept the development issuer", !license.verifyBytes(bytes, fp).valid);
    const payload = JSON.parse(Buffer.from(good.data.license.payload, "base64url").toString("utf8"));
    check("payload is the existing permanent v1 contract and matches the exact code hash", Object.keys(payload).join("|") === "version|product|code_hash|fingerprint|issued_at|edition" && payload.code_hash === createHash("sha256").update(dev.FIXED_CODE).digest("hex"));
    const extra = await request({ code: dev.FIXED_CODE, fingerprint: fp, edition: "v2" });
    check("clients cannot add license fields", extra.status === 400 && !extra.data.license);
    const origin = await request({ code: dev.FIXED_CODE, fingerprint: fp }, { origin: "https://untrusted.test" });
    check("web origins cannot access the development signing route", origin.status === 400);
    await service.close(); service = await dev.startDevelopmentActivation(serverRoot);
    check("server key persists across restarts", service.publicKey === pub && license.verifyBytes(bytes, fp, service.publicKey).valid);
    const copy = dev.copyDevelopmentClient(repo, runRoot, service);
    const gateCopy = require(path.join(copy.core, "license-gate.cjs")), trustCopy = require(path.join(copy.core, "license-trust.cjs"));
    check("only the copied client uses the development public trust", trustCopy.publicKey === pub && gateCopy.verifyBytes(bytes, fp).valid);
    const copiedGate = fs.readFileSync(path.join(copy.core, "license-gate.cjs")), sourceGate = fs.readFileSync(path.join(repo, "app/core/license-gate.cjs"));
    check("source verifier is copied byte-for-byte, not replaced by a bypass", copiedGate.equals(sourceGate));
    check("private signing file stays outside the client", fs.existsSync(path.join(serverRoot, "development-signing.key")) && !fs.existsSync(path.join(runRoot, "development-signing.key")));
    check("copying code never silently installs a license or consents to risks", !fs.existsSync(path.join(runRoot, "license.json")) && !fs.existsSync(path.join(runRoot, "runtime/risk_ok")));
    console.log(`${count}/${count} development activation checks passed; no windows or paid requests`);
  } finally {
    await service?.close();
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "fatfish-development-check-") && !fs.lstatSync(root).isSymbolicLink()) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(() => { console.error("Development activation check failed; no UI or paid request was started."); process.exitCode = 1; });
