/** M3-B: actual shell + preload + renderer + Core, with isolated data and a fake chat backend. */
"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { join, resolve, sep } = require("node:path");
const { tmpdir } = require("node:os");
const { execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { pathToFileURL } = require("node:url");

const root = resolve(__dirname, "..");
const home = resolve(process.env.FATFISH_PAIRING_TEST_HOME || "");
if (!home.startsWith(resolve(tmpdir()) + sep + "fatfish-pairing-ui-")) throw new Error("use the isolated test runner");
const licensed = require("../../core/dev/license-fixture.cjs").licensedFixture(home); Object.assign(process.env, licensed.env);
const licensedUi = licensed.ui({ setupComplete: true });
const outArg = process.argv.indexOf("--evidence");
const out = outArg >= 0 ? resolve(process.argv[outArg + 1]) : join(tmpdir(), "fatfish-pairing-ui-evidence");
mkdirSync(out, { recursive: true });
process.env.FATFISH_APPDATA = home;
process.env.FATFISH_SMOKE = "1"; // No normal background services may start in this harness.
app.setPath("userData", join(home, "window-profile"));
app.quit = () => {}; // Keep the existing short window smoke hook from ending this test.

const serviceModule = require(join(licensedUi, "service-manager"));
let services, core, backend, socket, win;
const OriginalServiceManager = serviceModule.ServiceManager;
serviceModule.ServiceManager = class extends OriginalServiceManager {
  constructor(opts) { super(opts); services = this; this.killBackendHelpers = () => {}; }
};
const results = [], evidence = [];
let latestChallenge;
const reviewReplies = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok) => {
  results.push({ name, pass: !!ok });
  console.log((ok ? "PASS " : "FAIL ") + name);
  if (!ok) throw new Error(name);
};
const js = (source) => win.webContents.executeJavaScript(source, true);
const wait = async (predicate, ms = 10000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await predicate()) return; await sleep(25); }
  throw new Error("UI fixture timeout");
};
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).focus(); document.querySelector(${JSON.stringify(selector)}).click()`);
const text = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).textContent`);
const visible = (selector) => js(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).classList.contains('hidden')`);
const capture = async (name, width = 960, height = 640) => {
  win.setSize(width, height);
  await js("document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => true)");
  // A hidden window may not composite its first animation frame until capture.
  // Warm that frame, then wait for the observable final opacity and a fresh paint.
  await win.webContents.capturePage();
  await wait(() => js("!document.querySelector('#pairing-mask') || document.querySelector('#pairing-mask').classList.contains('hidden') || (getComputedStyle(document.querySelector('#pairing-mask')).opacity === '1' && document.querySelector('#pairing-mask').getAnimations({subtree:true}).every(a => a.playState !== 'running'))"));
  await js("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))).then(() => true)");
  const image = await win.webContents.capturePage();
  const path = join(out, name + ".png"); writeFileSync(path, image.toPNG());
  evidence.push({ name, path, width, height, zoom: win.webContents.getZoomFactor() });
};
const code = async () => (await text("#pairing-code")).replace(/\s/g, "");
const inbound = (from, value) => socket.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend",
  self_id: 90000, user_id: Number(from), message: [{ type: "text", data: { text: value } }] }));
const config = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8"));

require(join(licensedUi, "main"));
app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    win = BrowserWindow.getAllWindows()[0];
    const { WebSocketServer } = require("../../core/node_modules/ws");
    backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    backend.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (buf) => {
        const m = JSON.parse(buf);
        if (m.action === "get_login_info") ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: m.echo, data: { user_id: 90000, nickname: "肥鱼" } }));
        if (m.action === "send_private_msg") {
          reviewReplies.push(m.params.message.map((part) => part.data.text || "").join(""));
          ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: m.echo, data: { message_id: 1 } }));
        }
      });
    });
    await once(backend, "listening");
    mkdirSync(join(home, "runtime"), { recursive: true }); mkdirSync(join(home, "secrets"), { recursive: true });
    writeFileSync(join(home, "runtime", "risk_ok"), "1");
    writeFileSync(join(home, "secrets", "local_token"), "ui-pairing-fixture");
    writeFileSync(join(home, "config.json"), JSON.stringify({ owners: [], onebot_url: `ws://127.0.0.1:${backend.address().port}` }));
    core = services.forkCore(join(root, "..", "core", "server.mjs"), join(root, "..", "core"));
    services._children.core = core;
    services.on("core-message", (message) => { if (message.type === "identity_result" && message.pairing) latestChallenge = message.pairing; });
    await wait(() => !!socket);
    // Only first-run model/login status is simulated. All binding operations use real main IPC and Core.
    ipcMain.removeHandler("get-status");
    ipcMain.handle("get-status", () => ({ key_saved: true, qq_online: true, qq_uin_mask: "***0000", qq_nick_mask: "肥鱼",
      channel_state: "online", phase: "running", core_running: true, backend_ready: true,
      login_reachable: true, outbound_paused: false, active_persona_title: "小肥", activity: {} }));
    ipcMain.removeHandler("get-autostart"); ipcMain.handle("get-autostart", () => ({ ok: true, enabled: false }));

    // Baseline uses repository HEAD's unchanged renderer, not a fabricated drawing.
    const baseline = join(home, "baseline"); mkdirSync(baseline);
    for (const file of ["index.html", "renderer.js", "styles.css"]) {
      const content = execFileSync("git", ["show", "HEAD:app/electron-ui/renderer/" + file], { cwd: root, encoding: "utf8", windowsHide: true });
      writeFileSync(join(baseline, file), content);
    }
    await win.loadFile(join(baseline, "index.html"));
    await wait(() => js("document.querySelector('#splash').classList.contains('hidden') && document.querySelector('#main-app').style.visibility === 'visible'"));
    await click('.nav-btn[data-page="settings"]');
    await capture("baseline-settings-960"); await capture("baseline-settings-800", 800, 560);
    await win.loadFile(join(root, "renderer", "index.html"));
    await wait(() => js("document.querySelector('#splash').classList.contains('hidden') && document.querySelector('#main-app').style.visibility === 'visible'"));
    await click('.nav-btn[data-page="channels"]');
    await click('#platform-qq-summary');
    await wait(() => text("#owners-empty").then((s) => s.includes("绑定后仅回复")));
    check("channel page reads empty bindings from Core", config().owners.length === 0);
    await capture("channels-empty-960");
    await click("#btn-pairing-start"); await wait(async () => /^\d{6}$/.test(await code()));
    const first = await code();
    check("real IPC produces a selectable six-digit code", first.length === 6 && (await text("#pairing-countdown")).includes("后失效"));
    check("rendered code is copyable as six consecutive digits", await js("document.querySelector('#pairing-code').innerText") === first);
    check("dialog identifies the actual receiving account", (await text("#pairing-receiver")).includes("90000"));
    await capture("pairing-waiting-960"); await capture("pairing-waiting-800", 800, 560);
    await js("document.querySelector('#btn-pairing-cancel').focus(); document.querySelector('#btn-pairing-cancel').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))");
    check("keyboard focus remains inside dialog", await js("document.activeElement.id === 'btn-pairing-refresh'"));
    await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await wait(async () => !(await visible("#pairing-mask")));
    check("Escape restores focus to the entry", await js("document.activeElement.id === 'btn-pairing-start'"));
    inbound("10001", first); await sleep(100);
    check("cancelled UI code cannot bind", config().owners.length === 0);

    await click("#btn-pairing-start"); await wait(async () => /^\d{6}$/.test(await code()));
    const second = await code(); await click("#btn-pairing-refresh");
    await wait(async () => /^\d{6}$/.test(await code()) && (await code()) !== second);
    check("renewing changes and invalidates the old code", (await code()) !== second);
    inbound("20002", second); await wait(() => text("#pairing-msg").then((s) => s.includes("不匹配")));
    check("wrong code shows recoverable feedback", config().owners.length === 0 && /^\d{6}$/.test(await code()));
    await capture("pairing-error-800", 800, 560);

    // Expiry presentation is injected here; the actual deadline boundary is covered by identity-check.
    const active = (await services.requestCore("pairing_start")).pairing;
    services._onCoreMessage({ type: "pairing", pairingId: active.pairingId, status: "expired" });
    // That event belongs to a different challenge and must be ignored by this window.
    check("stale challenge events do not replace current UI", /^\d{6}$/.test(await code()));
    await click("#btn-pairing-refresh"); await wait(async () => /^\d{6}$/.test(await code()) && (await code()) !== active.code);
    services._onCoreMessage({ type: "pairing", pairingId: latestChallenge.pairingId, status: "expired" });
    await wait(() => text("#pairing-countdown").then((s) => s.includes("已失效")));
    check("expiry event clears the displayed code", (await code()) === "");
    await capture("pairing-expired-800", 800, 560);
    await click("#btn-pairing-refresh"); await wait(async () => /^\d{6}$/.test(await code()));
    const limitedCode = await code(), wrong = limitedCode === "999999" ? "888888" : "999999";
    for (let i = 0; i < 5; i++) inbound("20002", wrong);
    await wait(() => text("#pairing-msg").then((s) => s.includes("次数过多")));
    inbound("20002", limitedCode); await sleep(80);
    check("account lock feedback retains usable code for other accounts", config().owners.length === 0 && (await code()) === limitedCode);
    await capture("pairing-rate-limited-800", 800, 560);
    const finalCode = await code();
    inbound("10001", finalCode); await wait(() => text("#pairing-msg").then((s) => s.includes("已绑定")));
    check("pairing success uses masked sender account", (await text("#pairing-msg")).includes("***0001") && config().owners[0].account === "10001");
    check("success action does not imply undoing the binding", (await text("#btn-pairing-cancel")) === "完成");
    await capture("pairing-success-800", 800, 560);
    await wait(async () => !(await visible("#pairing-mask")));
    await capture("settings-bound-800", 800, 560);
    await capture("settings-bound-960");
    await win.webContents.reload();
    await wait(() => js("document.querySelector('#splash').classList.contains('hidden') && document.querySelector('#main-app').style.visibility === 'visible'"));
    await click('.nav-btn[data-page="channels"]'); await wait(() => text("#owners-list").then((s) => s.includes("***0001")));
    check("binding is read back after window reload", config().owners.length === 1);
    const denied = await js("window.fatfish.removeOwner('qq','10001',false)");
    check("main requires explicit removal confirmation", denied.error === "confirm_required" && config().owners.length === 1);
    await click(".owner-row button"); await capture("owner-confirm-800", 800, 560);
    await click(".owner-actions button:last-child");
    check("cancelling removal retains binding", config().owners.length === 1);
    const savedConfig = readFileSync(join(home, "config.json"), "utf8");
    writeFileSync(join(home, "config.json"), "invalid-json");
    await click(".owner-row button"); await click(".owner-actions button:first-of-type");
    await wait(() => text("#owners-msg").then((s) => s.includes("无法读取")));
    check("failed removal keeps the existing row visible", (await text("#owners-list")).includes("***0001"));
    writeFileSync(join(home, "config.json"), savedConfig);
    await click("#btn-owners-refresh"); await wait(() => text("#owners-msg").then((s) => s === ""));
    check("binding survives failed removal and refresh", config().owners.length === 1);
    await click(".owner-row button"); await click(".owner-actions button:first-of-type");
    await wait(() => config().owners.length === 0);
    check("confirmed removal persists and updates list", (await text("#owners-msg")).includes("已解除绑定"));

    // A separate window with the same preload still must not administer bindings.
    const other = new BrowserWindow({ show: false, webPreferences: { preload: join(root, "preload.js"), contextIsolation: true, sandbox: true } });
    await other.loadURL(pathToFileURL(join(root, "renderer", "index.html")).href);
    const forbidden = await other.webContents.executeJavaScript("window.fatfish.startPairing()");
    check("non-main window cannot start pairing", forbidden.error === "forbidden"); other.destroy();

    await click("#btn-pairing-start"); await wait(async () => /^\d{6}$/.test(await code()));
    win.webContents.setZoomFactor(2);
    await capture("pairing-zoom-200", 960, 640); win.webContents.setZoomFactor(1);
    const exited = once(core, "exit"); core.send({ type: "shutdown" }); await exited;
    services._children.core = null; core = null;
    await wait(() => text("#pairing-msg").then((s) => s.includes("已断开")));
    check("Core disconnect invalidates visible code", (await code()) === "");
    await click("#btn-pairing-refresh"); await wait(() => text("#pairing-msg").then((s) => s.includes("没就绪")));
    check("unavailable Core shows retry feedback", !(await js("document.querySelector('#btn-pairing-refresh').disabled")));
    await capture("pairing-unavailable-800", 800, 560);
    exitCode = 0;
  } catch (error) {
    console.error("pairing_ui_failed", error.message);
    if (win && !win.isDestroyed()) await capture("failure").catch(() => {});
  } finally {
    writeFileSync(join(out, "report.json"), JSON.stringify({ results, evidence, scope: "真实桌面壳与配对 IPC；登录状态为测试夹具；无真实 QQ、无付费模型调用。" }, null, 2));
    if (exitCode === 0 && process.argv.includes("--review")) {
      // A real interactive window plus an isolated message-sending surface for independent review.
      socket = null; reviewReplies.length = 0;
      core = services.forkCore(join(root, "..", "core", "server.mjs"), join(root, "..", "core"));
      services._children.core = core; await wait(() => !!socket);
      await win.webContents.reload();
      await wait(() => js("document.querySelector('#splash').classList.contains('hidden') && document.querySelector('#main-app').style.visibility === 'visible'"));
      win.setSize(960, 640); win.show(); win.focus();
      const http = require("node:http");
      let finishReview;
      const finished = new Promise((r) => { finishReview = r; });
      const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const helper = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/finish") { res.end("finished"); finishReview(); return; }
        if (req.method === "POST" && req.url === "/send") {
          let body = "";
          req.on("data", (chunk) => { body = (body + chunk).slice(0, 4096); });
          req.on("end", () => {
            const value = new URLSearchParams(body).get("text") || "";
            if (value && socket?.readyState === 1) inbound("10001", value);
            res.writeHead(303, { location: "/" }).end();
          }); return;
        }
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>隔离消息窗口</title><body><h1>隔离消息窗口</h1><p>发信账号：10001。消息只发送到本机测试数据，不连接真实 QQ。</p><form method="post" action="/send"><label>消息 <input name="text" autocomplete="off" required></label><button>发送</button></form><h2>收到的回复</h2><p>发送后可刷新查看回复。</p><ul>' + reviewReplies.slice(-10).map((s) => '<li>' + escape(s) + '</li>').join('') + '</ul></body></html>');
      });
      await new Promise((r) => helper.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${helper.address().port}`;
      writeFileSync(join(out, "review.json"), JSON.stringify({ app: "肥鱼", helperUrl: url, finishUrl: url + "/finish", viewport: "960x640" }, null, 2));
      console.log("review_ready", url);
      await finished;
      await new Promise((r) => { helper.close(r); helper.closeAllConnections(); });
    }
    if (core?.exitCode === null) { core.send({ type: "shutdown" }); await Promise.race([once(core, "exit"), sleep(10000)]); }
    services._children.core = null;
    if (backend) { for (const client of backend.clients) client.terminate(); await new Promise((r) => backend.close(r)); }
    // Never run broad helper cleanup from a UI test or touch the user's normal data.
    await services.stopAll();
    // The parent runner removes this unique directory after the window profile unlocks.
    console.log(`${results.filter((x) => x.pass).length}/${results.length} pairing UI checks passed; evidence: ${out}`);
    app.exit(exitCode);
  }
});
