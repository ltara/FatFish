"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const clear = require("../data-clear"), model = require("../../core/model-config.cjs");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "fatfish-data-clear-")), results = [];
const evidenceAt = process.argv.indexOf("--evidence"), evidence = evidenceAt < 0 ? null : path.resolve(process.argv[evidenceAt + 1]);
const check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
const args = (includeKeys = false, includeLicense = false) => ({ confirmed: true, includeKeys, includeLicense });
let serial = 0;
function removeFixture(root, relative) {
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(base) + path.sep) || !file.startsWith(path.resolve(root) + path.sep)) throw new Error("unsafe_fixture_cleanup");
  fs.rmSync(file, { recursive: true });
}
function write(root, rel, data = "fixture") { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; }
function setup() {
  const root = path.join(base, "root-" + ++serial); fs.mkdirSync(root);
  const key = "sk-data-clear-not-real-FFFFFFFF", route = { provider: "custom", api: "openai-completions", baseURL: "https://model.fatfish.test/v1", model: "fixture" };
  model.save(root, { ...route, key }); const before = model.read(root);
  const raw = JSON.parse(fs.readFileSync(path.join(root, "config.json"))); raw.owners = [{ channel: "qq", account: "10001" }]; raw.channels = { qq: { enabled: true } }; raw.local_workspace = path.join(base, "user-workspace"); write(root, "config.json", JSON.stringify(raw));
  const license = write(root, "license.json", "SIGNED_LICENSE_PLACEHOLDER");
  for (const f of ["personas.json", "persona.txt", "onboarding.json", "reminders.json", "activity.jsonl"]) write(root, f);
  for (const d of ["chat", "dsh/external/sessions", "dsh/local/sessions", "memory", "inbox", "activity", "companion-home", "logs", "runtime"]) write(root, d + "/data.json");
  write(root, "runtime/risk_ok", "1"); write(root, "secrets/deepseek_api_key", "sk-retained-legacy-key"); write(root, "secrets/local_token");
  write(root, "secrets/not-a-model-secret"); write(root, "workspace/local/user.txt"); write(root, "workspace/external/user.txt"); write(root, "unknown-user-file.txt");
  const outside = write(base, "user-workspace/user.txt", "OUTSIDE_PRESERVED");
  return { root, key, before, license, outside };
}
try {
  let s = setup();
  for (const invalid of [true, false, null, {}, args("true"), { ...args(), path: base }, { ...args(), confirmed: 1 }]) assert.throws(() => clear.clear(s.root, invalid), /clear_args_invalid/);
  check("generic/truthy confirmations and arbitrary path arguments cannot authorize deletion", model.read(s.root).key === s.key && fs.existsSync(s.license));
  const preview = clear.preview(s.root, { includeKeys: false, includeLicense: false });
  check("preview returns only a count without changing settings or data", Object.keys(preview).join() === "count" && preview.count > 10 && fs.existsSync(path.join(s.root, "chat/data.json")));
  const result = clear.clear(s.root, args());
  check("default clear completes known application data groups", result.count === preview.count && ["chat", "dsh", "memory", "reminders.json", "inbox", "companion-home", "onboarding.json", "runtime", "logs", "activity", "activity.jsonl", "personas.json", "persona.txt"].every((f) => !fs.existsSync(path.join(s.root, f))));
  const after = model.read(s.root);
  check("default preserves the custom key's exact route, generation and key reference", after.key === s.key && after.keyRef === s.before.keyRef && after.generation === s.before.generation && JSON.stringify(after.route) === JSON.stringify(s.before.route));
  check("retained config contains no owner/channel/workspace settings or raw credential", Object.keys(JSON.parse(fs.readFileSync(path.join(s.root, "config.json")))).join() === "model" && !fs.readFileSync(path.join(s.root, "config.json"), "utf8").includes(s.key));
  check("default preserves the license and both legacy/current model key files", fs.readFileSync(s.license, "utf8") === "SIGNED_LICENSE_PLACEHOLDER" && fs.existsSync(path.join(s.root, "secrets/deepseek_api_key")) && fs.existsSync(path.join(s.root, "secrets", s.before.keyRef)));
  check("all workspace files, external user files and unknown files are preserved", fs.existsSync(path.join(s.root, "workspace/local/user.txt")) && fs.existsSync(path.join(s.root, "workspace/external/user.txt")) && fs.existsSync(path.join(s.root, "unknown-user-file.txt")) && fs.readFileSync(s.outside, "utf8") === "OUTSIDE_PRESERVED");
  check("owned access token is removed without clearing an unrelated secret", !fs.existsSync(path.join(s.root, "secrets/local_token")) && fs.existsSync(path.join(s.root, "secrets/not-a-model-secret")));
  s = setup(); clear.clear(s.root, args(true));
  check("separate key consent clears all owned model keys and their config, but not license", !fs.existsSync(path.join(s.root, "secrets", s.before.keyRef)) && !fs.existsSync(path.join(s.root, "secrets/deepseek_api_key")) && !fs.existsSync(path.join(s.root, "config.json")) && fs.existsSync(s.license));
  s = setup(); clear.clear(s.root, args(false, true));
  check("separate license consent removes only license while preserving model authentication scope", !fs.existsSync(s.license) && model.read(s.root).key === s.key && model.read(s.root).route.baseURL === s.before.route.baseURL);
  s = setup(); clear.clear(s.root, args(true, true));
  check("both independent consents clear keys/license without affecting workspace files", !fs.existsSync(s.license) && !fs.existsSync(path.join(s.root, "config.json")) && !fs.existsSync(path.join(s.root, "secrets", s.before.keyRef)) && fs.existsSync(s.outside));
  s = setup(); fs.symlinkSync(path.join(base, "user-workspace"), path.join(s.root, "dsh/link"), "junction"); clear.clear(s.root, args());
  check("nested Windows junction is unlinked, never traversed into user files", !fs.existsSync(path.join(s.root, "dsh")) && fs.readFileSync(s.outside, "utf8") === "OUTSIDE_PRESERVED");
  s = setup(); removeFixture(s.root, "memory"); fs.symlinkSync(path.join(base, "user-workspace"), path.join(s.root, "memory"), "junction"); clear.clear(s.root, args());
  check("a top-level owned-data junction is removed without deleting its target", !fs.existsSync(path.join(s.root, "memory")) && fs.existsSync(s.outside));
  const linkRoot = path.join(base, "linked-root"); fs.symlinkSync(path.join(base, "user-workspace"), linkRoot, "junction"); assert.throws(() => clear.preview(linkRoot, { includeKeys: true, includeLicense: true }), /clear_path_invalid/);
  check("the data root itself cannot be a junction or volume root", fs.existsSync(s.outside));
  assert.throws(() => clear.preview(path.parse(base).root, { includeKeys: true, includeLicense: true }), /clear_path_invalid/);
  s = setup(); removeFixture(s.root, "secrets"); fs.symlinkSync(path.join(base, "user-workspace"), path.join(s.root, "secrets"), "junction"); assert.throws(() => clear.clear(s.root, args(true)), /clear_path_invalid/);
  check("a secrets-parent junction blocks the whole operation before deletion", fs.existsSync(path.join(s.root, "chat/data.json")) && fs.existsSync(s.outside));
  s = setup(); write(s.root, "config.json", "broken-json"); assert.throws(() => clear.clear(s.root, args()), /clear_model_invalid/);
  check("corrupt model settings cannot silently lose a retained custom key's route", fs.existsSync(path.join(s.root, "chat/data.json")) && fs.existsSync(path.join(s.root, "secrets", s.before.keyRef)));
  clear.clear(s.root, args(true)); check("explicit key-clear consent permits resetting corrupt config without touching license", !fs.existsSync(path.join(s.root, "config.json")) && fs.existsSync(s.license));
  s = setup(); fs.unlinkSync(path.join(s.root, "reminders.json")); fs.mkdirSync(path.join(s.root, "reminders.json")); write(s.root, "reminders.json/unexpected.txt"); assert.throws(() => clear.clear(s.root, args(true)), /clear_path_invalid/);
  check("an unexpected directory at a file-only target is rejected in preflight", fs.existsSync(path.join(s.root, "chat/data.json")) && fs.existsSync(path.join(s.root, "reminders.json/unexpected.txt")));
  s = setup(); const oldConfig = fs.readFileSync(path.join(s.root, "config.json")); const failedWrite = Object.create(fs); failedWrite.writeFileSync = () => { throw new Error("disk_failed"); };
  assert.throws(() => clear.clear(s.root, args(), failedWrite), /clear_failed/);
  check("retained-config write failure occurs before any data deletion and keeps original bytes", fs.readFileSync(path.join(s.root, "config.json")).equals(oldConfig) && fs.existsSync(path.join(s.root, "chat/data.json")));
  check("a failed config write removes only its own temporary file", !fs.readdirSync(s.root).some((f) => f.startsWith("clear-model-")));
  const failedDelete = Object.create(fs); failedDelete.unlinkSync = (file) => { if (file.endsWith("onboarding.json")) throw new Error("file_locked"); return fs.unlinkSync(file); };
  assert.throws(() => clear.clear(s.root, args(false, true), failedDelete), /clear_failed/);
  check("partial deletion is reported as failure and license remains until every earlier item succeeds", fs.existsSync(path.join(s.root, "onboarding.json")) && fs.existsSync(s.license) && fs.existsSync(path.join(s.root, "secrets", s.before.keyRef)));
  clear.clear(s.root, args(false, true)); check("explicit retry completes the remaining data with the selected scopes", !fs.existsSync(s.license) && model.read(s.root).key === s.key);
  console.log(`${results.length}/${results.length} data-clear checks passed (temporary filesystem, no windows/model calls)`);
} finally {
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "data-clear-report.json"), JSON.stringify({ results, nativeUI: false, paidCalls: 0, actualUserData: false }, null, 2)); }
  if (path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep + "fatfish-data-clear-")) fs.rmSync(base, { recursive: true, force: true });
}
