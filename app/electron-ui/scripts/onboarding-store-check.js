/** Setup receipts, restart and write failure behavior. Plain Node, no native shell or model calls. */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), { join, resolve, sep } = require("node:path"), { tmpdir } = require("node:os");
const { OnboardingStore, bindingHash, modelToken } = require("../onboarding-store");
const home = fs.mkdtempSync(join(tmpdir(), "fatfish-onboarding-store-")), file = join(home, "onboarding.json"), store = new OnboardingStore(home);
let count = 0; const check = (name, ok) => { assert.ok(ok, name); count++; console.log("PASS " + name); };
const facts = { riskAccepted: false, model: { generation: 0, token: "a".repeat(64) }, qq: { enabled: false, online: false, owners: [] } };
const proof = () => ({ ...facts.model }), remote = () => ({ generation: facts.model.generation, bindingHash: bindingHash("qq", "10001") });
try {
  check("new setup is read-only and begins at consent", store.snapshot(facts).phase === "risk" && !fs.existsSync(file));
  facts.riskAccepted = true; check("consent alone requires saved-model test", store.snapshot(facts).phase === "model");
  store.record("local", proof(), facts); check("a chat cannot substitute for an untested model", !store.snapshot(facts).baseComplete);
  store.record("model", proof(), facts); check("a confirmed current-model test advances to local trial", store.snapshot(facts).phase === "local" && store.snapshot(facts).modelReady);
  check("model-test receipt survives restart without another request", new OnboardingStore(home).snapshot(facts).phase === "local");
  store.setDeferred(true, facts); check("postponing is not completion and suppresses automatic wizard", store.snapshot(facts).deferred && !store.snapshot(facts).baseComplete && !store.snapshot(facts).needsWizard);
  store.setDeferred(false, facts); check("explicit resume returns to the missing step", store.snapshot(facts).phase === "local" && store.snapshot(facts).needsWizard);
  facts.model = { generation: 1, token: "b".repeat(64) }; check("changed pending model invalidates the old test receipt", store.snapshot(facts).phase === "model");
  store.record("model", { generation: 0, token: "a".repeat(64) }, facts); check("late test result cannot certify a newer route", !store.snapshot(facts).modelReady);
  store.record("model", proof(), facts); store.record("local", proof(), facts);
  check("only verified test plus successful local chat completes base setup", store.snapshot(facts).baseComplete && store.snapshot(facts).phase === "done" && !store.snapshot(facts).needsWizard);
  check("completed local setup has no QQ dependency", !facts.qq.enabled && !store.snapshot(facts).qqActive && !store.snapshot(facts).qqComplete);
  store.startQQ(facts); check("optional QQ begins with a separate risk step", store.snapshot(facts).phase === "qq-risk");
  facts.qq.enabled = true; check("enabled but offline requires login", store.snapshot(facts).phase === "qq-login");
  facts.qq.online = true; check("login alone requires owner pairing", store.snapshot(facts).phase === "qq-pair");
  facts.qq.owners = [remote().bindingHash]; check("pairing alone cannot masquerade as remote conversation", store.snapshot(facts).phase === "qq-trial" && !store.snapshot(facts).qqComplete);
  store.record("remote", { ...remote(), bindingHash: "f".repeat(64) }, facts); check("reply to an unbound account is not setup evidence", !store.snapshot(facts).qqComplete);
  store.record("remote", { ...remote(), generation: 0 }, facts); check("late reply from another model generation does not complete QQ", !store.snapshot(facts).qqComplete);
  store.record("remote", remote(), facts); check("confirmed current owner delivery completes optional QQ", store.snapshot(facts).qqComplete && !store.snapshot(facts).qqActive && !store.snapshot(facts).needsWizard);
  facts.model = { generation: 2, token: "c".repeat(64) }; facts.qq.online = false;
  check("later settings changes do not reopen a historically completed first-run wizard", store.snapshot(facts).phase === "done" && store.snapshot(facts).baseComplete);
  check("completed setup remains completed after process restart", new OnboardingStore(home).snapshot(facts).baseComplete);
  facts.riskAccepted = false; check("missing consent still requires consent even after historical completion", store.snapshot(facts).phase === "risk"); facts.riskAccepted = true;
  const stable = fs.readFileSync(file, "utf8"), rename = fs.renameSync;
  try { fs.renameSync = (from, to) => { if (to === file) throw new Error("fixture_disk_failure"); return rename(from, to); }; assert.throws(() => store.record("model", proof(), facts), /onboarding_save_failed/); }
  finally { fs.renameSync = rename; }
  check("failed receipt persistence retains previous bytes and cleans only its temp", fs.readFileSync(file, "utf8") === stable && !fs.readdirSync(home).some((s) => s.endsWith(".tmp")));
  check("disk recovery reread persists the in-memory result without retesting", store.snapshot(facts).modelReady);
  const valid = fs.readFileSync(file, "utf8"); fs.writeFileSync(file, "broken-json");
  assert.throws(() => store.snapshot(facts), /onboarding_invalid/); check("corrupt progress is not silently overwritten", fs.readFileSync(file, "utf8") === "broken-json"); fs.writeFileSync(file, valid);
  const smallRoot = join(home, "fresh"); fs.mkdirSync(smallRoot); const fresh = new OnboardingStore(smallRoot);
  assert.throws(() => fresh.startQQ(facts), /onboarding_base_incomplete/); check("optional branch cannot fake unfinished base completion", !fresh.snapshot(facts).baseComplete);
  const secret = "sk-onboarding-fixture-secret", token = modelToken({ generation: 1, route: { provider: "custom", model: "model" }, key: secret });
  check("receipt token changes with key and is not the key itself", /^[0-9a-f]{64}$/.test(token) && token !== modelToken({ generation: 1, route: { provider: "custom", model: "model" }, key: secret + "2" }));
  check("persistent progress has no message, raw account or credential", !fs.readFileSync(file, "utf8").includes(secret) && !fs.readFileSync(file, "utf8").includes("10001") && !fs.readFileSync(file, "utf8").includes("message"));
  console.log(`${count}/${count} onboarding store checks passed (no windows or model calls)`);
} finally { if (resolve(home).startsWith(resolve(tmpdir()) + sep + "fatfish-onboarding-store-")) fs.rmSync(home, { recursive: true, force: true }); }
