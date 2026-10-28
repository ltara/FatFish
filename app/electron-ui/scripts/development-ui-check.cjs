"use strict";
// Isolated filesystem / VM checks only. Never starts Electron, Core, an account or a model.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm"), { EventEmitter } = require("node:events");
const { startDevelopmentUiSync, classify, instrumentPreload } = require("./development-ui-sync.cjs");
const ui = path.resolve(__dirname, ".."), root = fs.mkdtempSync(path.join(os.tmpdir(), "fatfish-hot-check-"));
let count = 0, sync;
const check = (name, value) => { assert.ok(value, name); ++count; console.log("PASS " + name); };
const write = (name, value) => { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, value); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, message, timeout = 12000) { const end = Date.now() + timeout; while (!test()) { if (Date.now() > end) throw Error(message); await pause(25); } }
async function preloadChecks() {
  const bridges = {}, sent = [], subscribed = [], source = fs.readFileSync(path.join(ui, "preload.js"), "utf8");
  let invoke;
  const fake = { contextBridge: { exposeInMainWorld: (name, api) => { bridges[name] = api; } }, ipcRenderer: { invoke: (...args) => invoke(...args), send: (...args) => sent.push(args), on: (...args) => subscribed.push(args), removeListener() {} } };
  vm.runInNewContext(instrumentPreload(source), { require: name => { assert.equal(name, "electron"); return fake; } });
  check("production preload has no development bridge", !source.includes("fatfishDevelopment"));
  check("instrumentation preserves all existing API names", Object.keys(bridges.fatfish).length > 40 && Object.keys(bridges.fatfishDevelopment).join() === "getPending,requestReload");
  let resolve; invoke = () => new Promise(done => { resolve = done; });
  const pending = bridges.fatfish.getAbout(); check("pending IPC increments before dispatch", bridges.fatfishDevelopment.getPending() === 1);
  resolve({ synthetic: true }); await pending; check("successful IPC drains pending count", bridges.fatfishDevelopment.getPending() === 0);
  invoke = () => Promise.reject(Error("synthetic")); await assert.rejects(bridges.fatfish.getAbout());
  check("rejected IPC also drains pending count", bridges.fatfishDevelopment.getPending() === 0);
  invoke = () => { throw Error("synthetic"); }; assert.throws(() => bridges.fatfish.getAbout());
  check("synchronous IPC errors drain pending count", bridges.fatfishDevelopment.getPending() === 0);
  bridges.fatfish.onStatusChanged(() => {}); check("subscriptions are not turned into invocations", subscribed.length === 1 && bridges.fatfishDevelopment.getPending() === 0);
  for (const rev of [-1, NaN, "3", 0, {}]) bridges.fatfishDevelopment.requestReload(rev);
  bridges.fatfishDevelopment.requestReload(3);
  check("development bridge sends only fixed-channel integer metadata", sent.length === 1 && sent[0].join() === "development-ui-reload,3");
  assert.throws(() => instrumentPreload("changed contract")); check("changed preload contract fails closed", true);
}
function guardChecks() {
  const source = fs.readFileSync(path.join(ui, "renderer/renderer.js"), "utf8"), start = source.indexOf("  function developmentReloadState()"), end = source.indexOf("\n  if (window.fatfishDevelopment)", start);
  const html = fs.readFileSync(path.join(ui, "renderer/index.html"), "utf8");
  check("real first frame mounts the persona confirmation inside a hidden group", /id="persona-delete-confirm"[^>]*\bhidden[^>]*>[\s\S]*?class="owner-confirm"/.test(html));
  check("real first frame has no active owner-unbind confirmation", html.includes('<div id="owners-list"></div>'));
  const hiddenPersonaConfirm = { parentElement: { hidden: true } };
  let ownerConfirm = null;
  const elements = new Map(), element = id => { if (!elements.has(id)) elements.set(id, { value: "", hidden: true, checked: false, classList: { contains: () => true } }); return elements.get(id); };
  const context = { bootPhase: "main", chatSending: false, chatState: { busy: false, approvals: [] }, qqSettingBusy: false, workspaceBusy: false, pairingView: { open: false }, qqRiskOpen: false,
    modelView: { isBusy: () => false, isDirty: () => false }, wizardModelView: null,
    memoryView: { getReloadState: () => ({ busy: false, dirty: false, confirming: false }) },
    $: id => id === ".owner-confirm" ? hiddenPersonaConfirm : id === "#owners-list .owner-confirm" ? ownerConfirm : element(id), $$: () => [] };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const state = () => context.developmentReloadState();
  check("idle renderer allows refresh", state() === null);
  ownerConfirm = {}; check("active owner-unbind confirmation still blocks refresh", state() === "busy");
  ownerConfirm = null; check("cancelled owner-unbind confirmation releases the guard", state() === null);
  const client = clientFixture(); client.window.__fatfishDevelopmentReloadState = state;
  ownerConfirm = {}; client.window.__fatfishDevelopmentUpdates.apply({ revision: 1, cssOnly: false }); client.loaded(); client.tick();
  check("actual guard keeps pending UI update blocked during owner confirmation", client.requests.length === 0);
  ownerConfirm = null; client.tick(); client.tick();
  check("actual guard applies queued UI update once after confirmation ends despite hidden persona prompt", client.requests.join() === "1");
  client.window.__fatfishDevelopmentUpdates.dispose();
  for (const name of ["chatSending", "qqSettingBusy", "workspaceBusy", "qqRiskOpen"]) { context[name] = true; check(name + " blocks refresh", state() === "busy"); context[name] = false; }
  context.chatState.busy = true; check("in-flight model work blocks refresh", state() === "busy"); context.chatState.busy = false;
  context.chatState.approvals = [{}]; check("pending approval blocks refresh", state() === "busy"); context.chatState.approvals = [];
  element("#chat-input").value = "synthetic unsent draft"; check("unsent chat is not discarded", state() === "draft"); element("#chat-input").value = "";
  context.modelView.isDirty = () => true; check("unsaved model settings block refresh", state() === "draft"); context.modelView.isDirty = () => false;
  context.wizardModelView = { isBusy: () => false, isDirty: () => true }; check("onboarding draft blocks refresh", state() === "draft"); context.wizardModelView = null;
  context.memoryView.getReloadState = () => ({ dirty: true }); check("public profile draft blocks refresh", state() === "draft");
  context.memoryView.getReloadState = () => ({ confirming: true }); check("memory confirmation blocks refresh", state() === "busy"); context.memoryView.getReloadState = () => ({});
  element("#data-clear-confirm").hidden = false; check("data-clear confirmation blocks refresh", state() === "busy"); element("#data-clear-confirm").hidden = true;
  element("#persona-editor").classList.contains = () => false; check("open persona editor blocks refresh even on hidden page", state() === "editor"); element("#persona-editor").classList.contains = () => true;
  context.$$ = () => [{ value: "synthetic-key-not-persisted" }]; check("typed key blocks refresh without exposing it", state() === "draft"); context.$$ = () => [];
  context.bootPhase = "activation"; element("#activation-code").value = "synthetic"; check("activation draft blocks refresh", state() === "draft"); element("#activation-code").value = "";
  context.bootPhase = "login"; check("active login flow waits", state() === "starting");
  check("guard is only installed behind the development bridge", source.includes('if (window.fatfishDevelopment) window.__fatfishDevelopmentReloadState = developmentReloadState;'));
}
function clientFixture(page = "settings") {
  const links = [], timers = new Map(), stored = new Map(), requests = [], rootNode = {}, hints = [];
  let timerID = 0, pending = 0, blocked = null, clicks = 0;
  function link(href) { return { href, cloneNode() { return link(this.href); }, after(other) { links.splice(links.indexOf(this) + 1, 0, other); }, remove() { const i = links.indexOf(this); if (i >= 0) links.splice(i, 1); } }; }
  links.push(link("file:///synthetic/renderer/styles.css"), link("file:///synthetic/renderer/assets/ui.min.css"));
  const nav = { getAttribute: () => page, click: () => ++clicks };
  const doc = { body: { appendChild: el => hints.push(el), classList: { contains: () => false } },
    createElement: () => ({ style: {}, setAttribute() {}, remove() {} }),
    querySelector: sel => sel === "#ui-root" ? rootNode : sel === "#main-app" ? { style: { visibility: "visible" } } : nav,
    querySelectorAll: () => links.slice() };
  const window = { fatfishDevelopment: { getPending: () => pending, requestReload: rev => requests.push(rev) }, __fatfishDevelopmentReloadState: () => blocked };
  const context = { window, document: doc, URL, location: { href: "file:///synthetic/renderer/index.html" }, sessionStorage: { setItem: (k, v) => stored.set(k, v), getItem: k => stored.get(k), removeItem: k => stored.delete(k) },
    setInterval: (fn, ms) => { const id = ++timerID; timers.set(id, { fn, ms }); return id; }, clearInterval: id => timers.delete(id) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "development-ui-client.js"), "utf8"), context);
  return { window, links, stored, requests, rootNode, hints, timers, pending: v => { pending = v; }, blocked: v => { blocked = v; }, clicks: () => clicks,
    tick: () => { for (const timer of timers.values()) if (timer.ms === 250) timer.fn(); },
    loaded: () => { for (const node of links.slice()) if (node.onload) { const cb = node.onload; node.onload = null; cb(); } } };
}
function clientChecks() {
  const c = clientFixture(), api = c.window.__fatfishDevelopmentUpdates;
  api.apply({ revision: 1, cssOnly: true }); check("CSS uses replacement links, keeping originals until load", c.links.length === 4 && c.requests.length === 0);
  api.apply({ revision: 2, cssOnly: true }); check("rapid CSS saves are coalesced", c.links.length === 4);
  c.loaded(); c.loaded(); check("CSS swaps do not reload document", c.links.length === 2 && c.requests.length === 0 && c.links.every(link => link.href.endsWith("fatfish-hot=2")));
  c.blocked("draft"); api.apply({ revision: 3, cssOnly: false }); c.loaded(); c.tick();
  check("component updates wait for drafts", c.requests.length === 0 && !c.rootNode.inert && c.hints[0].textContent.includes("保存"));
  api.apply({ revision: 4, cssOnly: true }); c.loaded(); c.blocked(null); c.pending(1); c.tick(); check("pending IPC blocks refresh", c.requests.length === 0);
  c.pending(0); c.tick(); c.tick(); check("full reload remains pending across later CSS update and occurs once", c.requests.join() === "4" && c.rootNode.inert);
  check("only page enum is persisted, never input/key/chat", c.stored.size === 1 && c.stored.get("fatfish-development-page") === "settings");
  const channel = clientFixture("channels");
  channel.window.__fatfishDevelopmentUpdates.apply({ revision: 1, cssOnly: false }); channel.loaded();
  check("new channel destination survives development hot refresh", channel.stored.size === 1 && channel.stored.get("fatfish-development-page") === "channels");
  for (const timer of channel.timers.values()) if (timer.ms === 200) timer.fn();
  check("channel restoration only selects navigation and consumes the stored enum", channel.clicks() === 1 && channel.stored.size === 0);
  channel.window.__fatfishDevelopmentUpdates.dispose();
  check("stale and malformed update records are ignored", api.apply({ revision: 4, cssOnly: false }) === false && api.apply({ revision: 5, cssOnly: "yes" }) === false);
  api.dispose(); check("disposing update client clears timers", c.timers.size === 0);
  const failed = clientFixture(), failedApi = failed.window.__fatfishDevelopmentUpdates;
  failedApi.apply({ revision: 1, cssOnly: false });
  for (const node of failed.links.slice()) if (node.onerror) node.onerror(); failed.tick();
  check("stylesheet failure retains old links and blocks reload", failed.links.length === 2 && !failed.requests.length);
  failedApi.apply({ revision: 2, cssOnly: true }); failed.loaded(); check("next successful save can recover from stylesheet failure", failed.requests.join() === "2"); failedApi.dispose();
}
async function hostChecks() {
  const handlers = new Map(), intervals = [], contents = new EventEmitter(), win = new EventEmitter(), app = new EventEmitter();
  let record, reloads = 0, copying = false; const applied = [];
  Object.assign(contents, { mainFrame: {}, isLoading: () => false, reloadIgnoringCache: () => { ++reloads; }, executeJavaScript: async code => { applied.push(code); } });
  Object.assign(win, { webContents: contents, isDestroyed: () => false, setTitle() {} });
  Object.assign(app, { isPackaged: false, setPath() {}, whenReady: () => Promise.resolve() });
  const config = { ui: path.join(root, "host/ui"), runRoot: path.join(root, "host"), dataRoot: path.join(root, "host-data"), repo: root };
  const fakeFS = { readFileSync: file => String(file).endsWith("ui-update.json") ? JSON.stringify(record) : String(file).endsWith("development-config.json") ? JSON.stringify(config) : "// synthetic injection", existsSync: file => String(file).endsWith("ui-sync-busy") && copying };
  const context = { process: { env: { FATFISH_DEVELOPMENT_CONFIG: path.join(root, "development-config.json") } },
    require: name => name === "node:fs" ? fakeFS : name === "node:path" ? path : name === "electron" ? { app, BrowserWindow: { getAllWindows: () => [win] }, ipcMain: { on: (name, fn) => handlers.set(name, fn) } } : name === "node:module" ? { Module: { _initPaths() {} } } : name.endsWith("service-manager.js") ? { ServiceManager: class {} } : {},
    setInterval: (fn, ms) => { const value = { fn, ms, unref() {} }; intervals.push(value); return value; }, clearInterval() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "development-client-host.js"), "utf8"), context); await pause(0);
  const poll = intervals.find(timer => timer.ms === 250).fn, reload = handlers.get("development-ui-reload"), event = { sender: contents, senderFrame: contents.mainFrame };
  record = { revision: 2, cssOnly: true, reloadRevision: 1 }; await poll();
  check("host does not lose skipped component updates behind a later CSS save", applied.at(-1).includes('"cssOnly":false'));
  reload({ sender: {}, senderFrame: contents.mainFrame }, 2); reload({ sender: contents, senderFrame: {} }, 2); reload(event, "2"); reload(event, 3);
  check("host rejects foreign frames, unknown revisions and malformed reloads", reloads === 0);
  copying = true; reload(event, 2); await poll(); check("reload waits until the renderer copy is complete", reloads === 0);
  copying = false; await poll(); reload(event, 2); check("host reloads exactly once per accepted revision", reloads === 1);
  contents.emit("did-finish-load"); await pause(0); record = { revision: 3, cssOnly: true, reloadRevision: 1 }; await poll();
  check("CSS after applied full refresh stays CSS-only", applied.at(-1).includes('"cssOnly":true'));
  const before = applied.length; record = { revision: 4, cssOnly: true, reloadRevision: 5 }; await poll(); check("host rejects invalid cumulative revision", applied.length === before);
}
async function compilerChecks() {
  const sourceUi = path.join(root, "compiler-ui"), runRoot = path.join(root, "compiler-run"), copyUi = path.join(runRoot, "app/electron-ui"), dataRoot = path.join(root, "compiler-data");
  for (const directory of [sourceUi, copyUi, dataRoot]) fs.mkdirSync(directory, { recursive: true });
  for (const name of ["renderer-src", "renderer", "vite.config.mjs", "tsconfig.json", "package.json", "preload.js"]) fs.cpSync(path.join(ui, name), path.join(sourceUi, name), { recursive: true });
  write(path.join(sourceUi, "scripts/build-ui.mjs"), fs.readFileSync(path.join(ui, "scripts/build-ui.mjs")));
  const dependencies = path.join(sourceUi, "node_modules"); fs.symlinkSync(path.join(ui, "node_modules"), dependencies, process.platform === "win32" ? "junction" : "dir");
  try {
    sync = await startDevelopmentUiSync({ sourceUi, copyUi, runRoot, dataRoot });
    const html = () => fs.readFileSync(path.join(copyUi, "renderer/index.html"), "utf8"), record = () => JSON.parse(fs.readFileSync(path.join(runRoot, "ui-update.json")));
    check("real Vite compiler generates an activation-locked isolated UI copy", html().includes('body class="activation-locked"') && fs.statSync(path.join(copyUi, "renderer/assets/ui.min.js")).size > 50000);
    const appFile = path.join(sourceUi, "renderer-src/App.tsx"); fs.appendFileSync(appFile, "\n// synthetic hot-update compile check\n");
    await until(() => sync.getRevision() > 0, "real Vite comment rebuild timed out", 60000);
    check("non-rendering source edit needs no document refresh", record().cssOnly);
    const source = fs.readFileSync(appFile, "utf8"); assert.ok(source.includes("<h2>首页</h2>"));
    fs.writeFileSync(appFile, source.replace("<h2>首页</h2>", "<h2>隔离热更新验证标题</h2>"));
    await until(() => html().includes("隔离热更新验证标题"), "real Vite JSX rebuild timed out", 60000);
    check("real JSX save rebuilds first frame and requests full refresh", !record().cssOnly && record().reloadRevision > 0);
    check("published copy is complete before update record is consumed", !fs.existsSync(path.join(runRoot, "ui-sync-busy")));
  } finally { await sync?.close(); sync = null; fs.unlinkSync(dependencies); }
}
async function filesystemChecks() {
  const sourceUi = path.join(root, "source-ui"), sourceCore = path.join(root, "source-core"), runRoot = path.join(root, "run"), copyUi = path.join(runRoot, "app/electron-ui"), dataRoot = path.join(root, "data");
  for (const dir of [sourceUi, sourceCore, copyUi, dataRoot]) fs.mkdirSync(dir, { recursive: true });
  write(path.join(dataRoot, "sentinel"), "unchanged synthetic user data");
  write(path.join(sourceUi, "preload.js"), fs.readFileSync(path.join(ui, "preload.js")));
  write(path.join(sourceUi, "renderer-src/App.tsx"), "component-1"); write(path.join(sourceUi, "renderer/styles.css"), "style-1");
  for (const name of ["renderer", "status-view", "activation-view", "chat-render", "memory-view", "model-view", "onboarding-view", "data-clear-view", "persona-actions"]) write(path.join(sourceUi, "renderer", name + ".js"), "// synthetic " + name);
  let builds = 0, inBuild = 0, maximum = 0, fail = false;
  const log = [], build = async () => { ++builds; maximum = Math.max(maximum, ++inBuild); await pause(35); --inBuild; if (fail) throw Error("synthetic compile error"); write(path.join(sourceUi, "renderer/index.html"), "synthetic html"); write(path.join(sourceUi, "renderer/assets/ui.min.js"), fs.readFileSync(path.join(sourceUi, "renderer-src/App.tsx"))); write(path.join(sourceUi, "renderer/assets/ui.min.css"), "synthetic css"); };
  sync = await startDevelopmentUiSync({ sourceUi, sourceCore, copyUi, runRoot, dataRoot, build, log: msg => log.push(msg), debounceMs: 40 });
  const record = () => JSON.parse(fs.readFileSync(path.join(runRoot, "ui-update.json"))), copied = name => fs.readFileSync(path.join(copyUi, name), "utf8");
  check("initial build is available without issuing a reload", builds === 1 && !fs.existsSync(path.join(runRoot, "ui-update.json")) && copied("renderer/index.html") === "synthetic html");
  check("only isolated copied preload receives instrumentation", copied("preload.js").includes('"fatfishDevelopment"') && !fs.readFileSync(path.join(sourceUi, "preload.js"), "utf8").includes("fatfishDevelopment"));
  write(path.join(sourceUi, "renderer/styles.css"), "style-2");
  await until(() => sync.getRevision() >= 1, "CSS watcher did not fire");
  check("actual CSS file save synchronizes without document reload", copied("renderer/styles.css") === "style-2" && record().cssOnly && record().reloadRevision === 0);
  write(path.join(sourceUi, "renderer/renderer.js"), "// controller-2");
  await until(() => record().reloadRevision > 0, "controller watcher did not fire");
  check("controller save queues a full refresh", copied("renderer/renderer.js").includes("controller-2") && !record().cssOnly);
  write(path.join(sourceUi, "renderer/styles.css"), "style-3"); await until(() => record().cssOnly, "style coalescing did not finish");
  check("metadata remembers unconsumed component reload across CSS saves", record().reloadRevision > 0 && record().reloadRevision < record().revision);
  write(path.join(sourceUi, "renderer-src/App.tsx"), "component-2"); await until(() => copied("renderer/assets/ui.min.js") === "component-2", "component watcher did not build");
  check("component change rebuilds and syncs current bundle", !record().cssOnly);
  const previous = sync.getRevision(); fail = true; write(path.join(sourceUi, "renderer-src/App.tsx"), "broken component");
  await until(() => log.some(msg => msg.includes("更新失败")), "failed build not reported");
  check("failed compilation keeps current copy and published revision", copied("renderer/assets/ui.min.js") === "component-2" && sync.getRevision() === previous);
  fail = false; write(path.join(sourceUi, "renderer-src/App.tsx"), "component-3");
  for (let n = 0; n < 20; ++n) sync.schedule("renderer-src/App.tsx"); await sync.flush();
  check("rapid edits are serialized and recover after compile failure", maximum === 1 && copied("renderer/assets/ui.min.js") === "component-3");
  await pause(100); await sync.flush(); const stable = sync.getRevision(); await pause(100);
  check("generated outputs do not trigger rebuild loops", sync.getRevision() === stable);
  write(path.join(sourceUi, "main.js"), "// requires restart"); write(path.join(sourceCore, "server.mjs"), "// requires restart");
  await until(() => log.some(msg => msg.includes("手动重开")), "restart notification missing"); await pause(100);
  check("main/Core edits never restart or hot-copy backend code", sync.getRevision() === stable && !fs.existsSync(path.join(copyUi, "main.js")));
  write(path.join(dataRoot, "other-data"), "not watched"); await pause(100); check("application data is neither watched nor modified", sync.getRevision() === stable && fs.readFileSync(path.join(dataRoot, "sentinel"), "utf8") === "unchanged synthetic user data");
  await sync.close(); sync = null; write(path.join(sourceUi, "renderer/styles.css"), "after-close"); await pause(100);
  check("shutdown closes watchers before copied code cleanup", copied("renderer/styles.css") === "style-3");
  await assert.rejects(startDevelopmentUiSync({ sourceUi, copyUi, runRoot, dataRoot: copyUi, build })); check("overlapping data/code roots fail closed", true);
  const linked = path.join(sourceUi, "renderer/linked"); fs.symlinkSync(dataRoot, linked, process.platform === "win32" ? "junction" : "dir");
  try { await assert.rejects(startDevelopmentUiSync({ sourceUi, copyUi, runRoot, dataRoot, build })); check("renderer symlinks to data are rejected", true); } finally { fs.unlinkSync(linked); }
}
(async () => {
  try {
    for (const [file, expected] of [["renderer/styles.css", "style"], ["renderer-src/App.tsx", "build"], ["renderer-src/components/ui/button.tsx", "build"], ["renderer/memory-view.js", "controller"], ["main.js", "restart"], ["preload.js", "restart"], ["chat-store.js", "restart"], ["renderer/index.html", null], ["renderer/assets/ui.min.js", null], ["node_modules/file.js", null]]) check("routes " + file, classify(file) === expected);
    await preloadChecks(); guardChecks(); clientChecks(); await hostChecks(); await filesystemChecks();
    if (process.argv.includes("--real-build")) await compilerChecks();
    const pkg = JSON.parse(fs.readFileSync(path.join(ui, "package.json")));
    check("development host/client/watcher are excluded from shipped files", !pkg.build.files.some(file => file.startsWith("scripts")));
    check("production sandbox and file navigation remain unchanged", /sandbox: true/.test(fs.readFileSync(path.join(ui, "main.js"), "utf8")) && /loadFile\(/.test(fs.readFileSync(path.join(ui, "main.js"), "utf8")));
    console.log(`PASS ${count} isolated development hot-update checks`);
  } finally {
    await sync?.close(); const actual = fs.realpathSync.native(root);
    assert.equal(path.dirname(actual).toLowerCase(), fs.realpathSync.native(os.tmpdir()).toLowerCase()); assert.ok(path.basename(actual).startsWith("fatfish-hot-check-"));
    fs.rmSync(actual, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
