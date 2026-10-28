"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm"), { createHash } = require("node:crypto");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "fatfish-persona-data-")), results = [];
const evidenceAt = process.argv.indexOf("--evidence"), evidence = evidenceAt < 0 ? null : path.resolve(process.argv[evidenceAt + 1]);
const check = (name, ok) => { results.push({ name, pass: !!ok }); assert.ok(ok, name); console.log("PASS " + name); };
const hash = (s) => createHash("sha256").update(s).digest("hex"); let main, view;
(async () => {
  try {
    main = await require("./clear-main-fixture.cjs").fixture(base);
    const list = () => main.call("persona-list"), file = path.join(base, "personas.json"), requests = [];
    const initial = await list(); assert.ok(initial.items.length > 0);
    const created = await main.call("persona-create", { title: "仅临时测试的人格", summary: "无外部服务", body: "固定素材，不调用模型。" }); assert.ok(created.ok && created.item.id);
    const api = { personaDelete: async (id, confirmed) => { requests.push({ op: "delete", id, confirmed }); return main.call("persona-delete", id, confirmed); }, personaImportText: async (text) => { requests.push({ op: "import" }); return main.call("persona-import-text", text); } };
    view = require("./persona-action-fixture.cjs").fixture({ api }); view.enter("editor", created.item.id);
    const before = hash(fs.readFileSync(file)); view.controller.askDelete(); await view.el("btn-persona-delete-no").fire("click");
    check("actual Main-backed library does not change after an armed/cancelled delete", hash(fs.readFileSync(file)) === before && requests.length === 0);
    view.controller.askDelete(); view.state.clock += 5001; await view.controller.confirmDelete();
    check("expired confirmation cannot reach actual Main or change persona bytes", hash(fs.readFileSync(file)) === before && requests.length === 0);
    view.controller.askDelete(); await view.controller.confirmDelete();
    check("explicit scoped confirmation reaches actual Main and deletes only the selected persona", requests.length === 1 && requests[0].id === created.item.id && requests[0].confirmed === true && !(await list()).items.some((i) => i.id === created.item.id) && (await list()).items.length === initial.items.length);
    check("actual deletion does not move the active ID to the deleted object", (await list()).activePersonaId === initial.activePersonaId);
    const stable = hash(fs.readFileSync(file)), active = (await list()).activePersonaId;
    view.enter("import"); view.el("persona-import-text").value = " \n "; const at = requests.length; await view.controller.importDraft();
    check("empty input shows inline feedback without any Main request", requests.length === at && view.el("persona-import-msg").textContent.includes("请先粘贴"));
    const raw = "# 临时素材标题\n只整理成本机草稿，不能自动应用。"; view.el("persona-import-text").value = raw; await view.controller.importDraft();
    check("actual Main parser returns the original body to an editable draft", view.drafts.length === 1 && view.drafts[0].body === raw && view.el("persona-edit-body").value === raw && view.el("persona-edit-id").value === "");
    check("import never persists or applies a persona", hash(fs.readFileSync(file)) === stable && (await list()).activePersonaId === active && requests.filter((r) => r.op === "import").length === 1);
    check("successful draft transition clears only its source input", view.el("persona-import-text").value === "" && view.state.mode === "editor");
    let current = await list(), monotonic = true;
    for (let i = 0; current.items.length > 1 && i < initial.items.length + 2; i++) {
      const previous = current.items.length; view.enter("editor", current.items[0].id); view.controller.askDelete(); await view.controller.confirmDelete(); current = await list();
      if (current.items.length >= previous) { monotonic = false; break; }
    }
    check("acknowledged sample removal stays removed through actual Main refreshes", monotonic && current.items.length === 1);
    view.enter("editor", current.items[0].id); view.controller.askDelete(); await view.controller.confirmDelete();
    check("actual last-persona deletion restores builtins and communicates that result", (await list()).items.length > 0 && view.el("persona-msg").textContent.includes("恢复内置"));
    view.controller.dispose(); view = null;
    // Execute the real renderer initialization and panel/wrapper functions with plain objects only.
    const source = fs.readFileSync(path.join(__dirname, "../renderer/renderer.js"), "utf8"), f = require("./persona-action-fixture.cjs").fixture();
    const context = vm.createContext({ window: {}, api, $: f.query, setTimeout: () => 1, clearTimeout() {}, document: { activeElement: null, querySelector: f.query }, refreshStatus() {}, loadPersona: async () => {}, openPersonaEditor: async () => {}, });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer/persona-actions.js"), "utf8"), context);
    const start = source.indexOf('  let personaView = "list";'), end = source.indexOf('  function filterPersonaItems', start);
    vm.runInContext(source.slice(start, end) + "\nthis.actions=personaActions;this.panel=showPersonaPanel;", context);
    context.panel("editor"); f.el("persona-edit-id").value = (await list()).items[0].id; context.actions.askDelete();
    check("real renderer initialization binds the inline action without invoking a native dialog", !f.el("persona-delete-confirm").hidden);
    context.panel("import"); await context.actions.confirmDelete();
    check("real panel navigation invalidates an earlier delete scope", f.el("persona-delete-confirm").hidden);
    const wrappers = source.slice(source.indexOf("  function deletePersonaEditor()"), source.indexOf("  function wirePersona()"));
    vm.runInContext(wrappers + "\nthis.importText=runImportDraft;", context); f.el("persona-import-text").value = ""; await context.importText();
    check("real import wrapper delegates empty-input feedback to the actual controller", f.el("persona-import-msg").textContent.includes("请先粘贴")); context.actions.dispose(); f.controller.dispose();
    console.log(`${results.length}/${results.length} persona data checks passed (actual Main/parser/store, plain renderer objects, no windows/paid calls)`);
  } finally {
    view?.controller.dispose(); await main?.dispose();
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); const sources = ["main.js", "preload.js", "persona-lib.js", "renderer/persona-actions.js", "renderer/renderer.js", "renderer/index.html", "renderer/styles.css"].map((p) => ({ path: p, sha256: hash(fs.readFileSync(path.join(__dirname, "..", p))) })); fs.writeFileSync(path.join(evidence, "persona-data-report.json"), JSON.stringify({ results, sources, nativeUI: false, DOM: false, paidCalls: 0, actualUserData: false }, null, 2)); }
    if (path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep + "fatfish-persona-data-")) fs.rmSync(base, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
