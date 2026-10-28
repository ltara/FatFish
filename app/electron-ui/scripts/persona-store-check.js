"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { execFileSync } = require("node:child_process");
const lib = require("../persona-lib"), base = fs.mkdtempSync(path.join(os.tmpdir(), "fatfish-persona-store-")), results = [];
const evidenceAt = process.argv.indexOf("--evidence"), evidence = evidenceAt < 0 ? null : path.resolve(process.argv[evidenceAt + 1]);
const check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
try {
  const root = path.join(base, "fresh"), first = lib.readStore(root), file = path.join(root, "personas.json");
  check("fresh library seeds examples once and records a version", first.samplesVersion === 1 && first.items.length > 1 && JSON.parse(fs.readFileSync(file)).samplesVersion === 1);
  const id = first.items[0].id, deleted = lib.deletePersona(root, id, true);
  check("deletion acknowledgement removes exactly the chosen sample on disk", deleted.ok && !JSON.parse(fs.readFileSync(file)).items.some((i) => i.id === id));
  for (let i = 0; i < 5; i++) lib.listPersonas(root);
  check("repeated normal list reads cannot resurrect a deleted example", !lib.readStore(root).items.some((i) => i.id === id));
  lib.ensurePersonaLib(root); lib.getActiveMeta(root); lib.getActiveBody(root);
  check("startup/active-persona readers do not reinsert the removed example", !lib.readStore(root).items.some((i) => i.id === id));
  const probe = `const l=require(${JSON.stringify(path.resolve(__dirname, "../persona-lib.js"))});process.stdout.write(JSON.stringify(l.readStore(${JSON.stringify(root)}).items.some(i=>i.id===${JSON.stringify(id)})));`;
  check("a fresh Node process sees the same durable deletion", execFileSync(process.execPath, ["-e", probe], { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) === "false");
  let store = lib.readStore(root); const nonActive = store.items.find((i) => i.id !== store.activePersonaId);
  if (nonActive) { const active = store.activePersonaId; lib.deletePersona(root, nonActive.id, true); check("deleting an inactive remaining example preserves the active selection", lib.readStore(root).activePersonaId === active); }
  store = lib.readStore(root); assert.equal(store.items.length, 1); const restored = lib.deletePersona(root, store.items[0].id, true);
  check("deleting the last persona intentionally restores the builtin library", restored.ok && restored.restoredBuiltin === true && lib.readStore(root).items.length === first.items.length);
  const after = fs.readFileSync(file); lib.readStore(root); lib.listPersonas(root);
  check("stable seeded reads do not rewrite timestamps or disk bytes", fs.readFileSync(file).equals(after));
  const legacy = path.join(base, "legacy"); fs.mkdirSync(legacy);
  const custom = { id: "user-owned", title: "用户原有内容", summary: "保持原样", body: "CUSTOM_BODY_SENTINEL", updatedAt: "2026-10-25T00:00:00.000Z", lastAppliedAt: "" };
  const edited = { ...first.items[0], title: "用户修改过的内置名称", body: "EDITED_BUILTIN_SENTINEL" };
  fs.writeFileSync(path.join(legacy, "personas.json"), JSON.stringify({ activePersonaId: custom.id, items: [custom, edited] }));
  const migrated = lib.readStore(legacy);
  check("legacy library receives a one-time sample version and missing defaults", migrated.samplesVersion === 1 && first.items.every((i) => migrated.items.some((m) => m.id === i.id)));
  check("one-time migration preserves custom content, ID and active selection", migrated.activePersonaId === custom.id && migrated.items.some((i) => i.id === custom.id && i.body === custom.body && i.updatedAt === custom.updatedAt));
  check("migration never overwrites a user's edited builtin ID/content", migrated.items.find((i) => i.id === edited.id).body === edited.body && migrated.items.find((i) => i.id === edited.id).title === edited.title);
  const removed = first.items[1].id; lib.deletePersona(legacy, removed, true); lib.ensurePersonaLib(legacy);
  check("a migrated library also honors later sample deletion across startup readers", !lib.readStore(legacy).items.some((i) => i.id === removed));
  const active = lib.getActiveBody(legacy), imported = lib.importFromText("# 仅草稿\n不自动保存或应用");
  check("draft parsing cannot reset sample migration state or the active body", imported.ok && lib.getActiveBody(legacy) === active && !lib.readStore(legacy).items.some((i) => i.id === removed));
  const future = path.join(base, "future"); fs.mkdirSync(future); fs.writeFileSync(path.join(future, "personas.json"), JSON.stringify({ samplesVersion: 2, activePersonaId: custom.id, items: [custom] }));
  check("an already-seeded higher marker is not downgraded or seeded again", lib.readStore(future).samplesVersion === 2 && lib.readStore(future).items.length === 1);
  lib.createPersona(future, { title: "新增", summary: "", body: "新内容" });
  check("ordinary writes preserve a higher existing sample marker", JSON.parse(fs.readFileSync(path.join(future, "personas.json"))).samplesVersion === 2);
  const beforeDenied = fs.readFileSync(path.join(legacy, "personas.json")); const denied = lib.deletePersona(legacy, custom.id, false);
  check("unconfirmed delete still leaves every byte untouched", !denied.ok && fs.readFileSync(path.join(legacy, "personas.json")).equals(beforeDenied));
  console.log(`${results.length}/${results.length} persona store checks passed (real temp files/new Node process, no windows/paid calls)`);
} finally {
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "persona-store-report.json"), JSON.stringify({ results, nativeUI: false, paidCalls: 0, actualUserData: false }, null, 2)); }
  if (path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep + "fatfish-persona-store-")) fs.rmSync(base, { recursive: true, force: true });
}
