/** Real main/preload/renderer/Core/runtime and native tray; loopback-only fixtures. */
"use strict";
const electron = require("electron");
const { app, BrowserWindow } = electron;
const fs = require("node:fs");
const { join, resolve, sep } = require("node:path");
const { tmpdir } = require("node:os");
const { once } = require("node:events");
const { pathToFileURL } = require("node:url");
const home = resolve(process.env.FATFISH_STATUS_TEST_HOME || "");
if (!home.startsWith(resolve(tmpdir()) + sep + "fatfish-status-ui-")) throw new Error("isolated runner required");
const licensed = require("../../core/dev/license-fixture.cjs").licensedFixture(home); Object.assign(process.env, licensed.env);
const licensedUi = licensed.ui({ setupComplete: true });
const outIndex = process.argv.indexOf("--evidence");
const out = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : home;
fs.mkdirSync(out, { recursive: true });
process.env.FATFISH_APPDATA = home;
delete process.env.FATFISH_SMOKE;
app.setPath("userData", join(home, "window-profile"));
let services, proxy, backend, socket, win, fault = null, tray;
const observed = {}, results = [], sent = [];
const NativeTray = electron.Tray;
for (const [name, capture] of Object.entries({ setToolTip: (value) => { observed.tooltip = value; },
  setContextMenu: (value) => { observed.menu = value; }, setImage: (value) => { observed.bitmap = value.toBitmap().toString("hex"); } })) {
  const original = NativeTray.prototype[name];
  NativeTray.prototype[name] = function (value) { tray = this; capture(value); return original.call(this, value); };
}
const serviceRef = require(join(licensedUi, "service-manager")), Original = serviceRef.ServiceManager;
serviceRef.ServiceManager = class extends Original {
  constructor(opts) { super(opts); services = this; this.killBackendHelpers = () => {}; }
};
const seed = new Original({ appDataRoot: home }); seed.ensureAppData();
fs.writeFileSync(join(home, "runtime/risk_ok"), "1");
fs.writeFileSync(join(home, "secrets/deepseek_api_key"), "sk-status-ui-not-a-key");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, ms = 45000) => { const until = Date.now() + ms; while (Date.now() < until) { if (await fn()) return; await sleep(25); } throw new Error("status UI fixture timeout"); };
const check = (name, ok) => { results.push({ name, pass: !!ok }); console.log((ok ? "PASS " : "FAIL ") + name); if (!ok) throw new Error(name); };
const js = (s) => win.webContents.executeJavaScript(s, true);
const inbound = () => socket.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend", self_id: 90000,
  user_id: 10001, message: [{ type: "text", data: { text: "本地状态验收" } }] }));
const status = () => js("window.fatfish.getStatus()");
const shot = async (name, width = 960, height = 640) => {
  win.setSize(width, height);
  win.showInactive(); await sleep(200);
  await js("document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => true)");
  fs.writeFileSync(join(out, name + ".png"), (await win.webContents.capturePage()).toPNG());
  win.hide();
};
(async () => {
  let exitCode = 1;
  try {
    const { WebSocketServer } = require("../../core/node_modules/ws");
    backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    backend.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (buf) => {
        const m = JSON.parse(buf);
        if (m.action === "send_private_msg") sent.push(m.params.message.map((p) => p.data.text).join(""));
        ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: m.echo,
          data: m.action === "get_login_info" ? { user_id: 90000, nickname: "肥鱼" } : { message_id: sent.length } }));
      });
    });
    await once(backend, "listening");
    const port = backend.address().port;
    fs.writeFileSync(join(home, "config.json"), JSON.stringify({ owners: [{ channel: "qq", account: "10001", boundAt: new Date().toISOString(), label: "" }],
      onebot_url: `ws://127.0.0.1:${port}`, onebot_port: port, login_ui_port: port }));
    const model = await import(pathToFileURL(join(__dirname, "../../core/dev/model-proxy.mjs")));
    proxy = await model.startModelProxy({ reply: () => "成功回复", failure: () => fault });
    process.env.FATFISH_DEV_DEEPSEEK_BASE_URL = proxy.url;
    require(join(licensedUi, "main"));
    await app.whenReady();
    await wait(() => services && services.getCore().engine === "ready" && services.getCore().self.qq);
    win = BrowserWindow.getAllWindows()[0]; win.hide();
    await win.loadFile(join(__dirname, "../renderer/index.html"));
    await wait(() => js("document.querySelector('#main-app').style.visibility === 'visible'"));
    await wait(() => observed.tooltip === "肥鱼 · 在线");
    check("homepage derives login from the live channel, not login-page cache", (await status()).qq_online);
    check("native tray and home share the online state", await js("document.querySelector('#chip-qq-text').textContent === '伙伴 · 在线'"));
    const onlineBitmap = observed.bitmap;
    await shot("status-online");
    for (const [mode, label, wording] of [[401, "密钥无效", "密钥"], ["network", "连接中断", "连不上"]]) {
      fault = mode; const n = sent.length;
      inbound(); await wait(() => sent.length > n);
      await wait(() => observed.tooltip === "肥鱼 · " + label);
      await wait(() => js(`document.querySelector('#chip-reply-text').textContent === ${JSON.stringify(label)}`));
      check(`${mode} reaches home and native tray through actual Core IPC`, observed.menu.items[1].label === "状态：" + label && observed.bitmap !== onlineBitmap);
      check(`${mode} creates an actionable issue and safe remote reply`, (await js("document.querySelector('#home-todo-list').textContent")).includes(wording) && sent.at(-1).includes(wording));
      if (mode === 401) check("invalid saved key is not shown as healthy", await js("document.querySelector('#chip-key-text').textContent === '无效'"));
      await shot("status-" + mode, 800, 560);
    }
    fault = "hold"; const n = sent.length, requestCount = proxy.requests.length;
    const oldPid = services.getCore().engines.external.pid;
    inbound(); await wait(() => proxy.requests.length > requestCount);
    process.kill(oldPid);
    await wait(() => observed.tooltip === "肥鱼 · 正在恢复");
    check("unexpected runtime exit is visible in the real homepage", await js("document.querySelector('#chip-reply-text').textContent === '正在恢复'"));
    await shot("status-recovering");
    await wait(() => sent.length > n && services.getCore().engine === "ready" && services.getCore().engines.external.pid !== oldPid);
    check("runtime restarts and owner gets a recovery reply", sent.at(-1).includes("恢复"));
    fault = null; inbound(); await wait(() => sent.at(-1) === "成功回复");
    await wait(() => observed.tooltip === "肥鱼 · 在线");
    await wait(() => services.getCore().stats?.replies === 1);
    await wait(() => js("document.querySelector('#today-dm').textContent === '4' && document.querySelector('#today-last-reply').textContent !== '—'"));
    check("today activity uses actual counters and last reply time", (await status()).core_stats.replies === 1 && await js("document.querySelector('#today-last-reply').textContent !== '—'"));
    check("successful turn clears stale failure in both surfaces", (await status()).last_turn_error === null && observed.bitmap === onlineBitmap);
    socket.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: 90000, status: { online: false, good: true }, interval: 30000 }));
    await wait(() => observed.tooltip === "肥鱼 · QQ 未连接");
    check("account-offline heartbeat overrides a still-connected backend", !(await status()).qq_online && services.getState().backend);
    socket.send(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: 90000, status: { online: true, good: true }, interval: 30000 }));
    await wait(() => observed.tooltip === "肥鱼 · 在线");
    check("account-online heartbeat restores live status", (await status()).qq_online);
    for (const c of backend.clients) c.terminate();
    await wait(() => observed.tooltip === "肥鱼 · QQ 未连接");
    await wait(() => js("document.querySelector('#chip-qq-text').textContent === '伙伴 · QQ 未连接'"));
    check("channel loss immediately replaces cached login in home and tray", !(await status()).qq_online);
    await shot("status-channel-offline");
    const logs = fs.readFileSync(join(home, "logs/core.log"), "utf8");
    check("runtime error logging remains metadata-only", !logs.includes("本地状态验收") && !logs.includes("sk-status-ui") && !logs.includes("LOCAL_FAILURE_FIXTURE"));
    exitCode = 0;
    console.log(`${results.length}/${results.length} status UI checks passed (no paid calls)`);
  } catch (e) { console.error(e.stack); }
  finally {
    fs.writeFileSync(join(out, "status-report.json"), JSON.stringify({ results, paidCalls: 0 }, null, 2));
    if (services) await services.stopAll();
    if (tray && !tray.isDestroyed()) tray.destroy();
    if (backend) await new Promise((r) => { for (const c of backend.clients) c.terminate(); backend.close(r); });
    if (proxy) await proxy.close();
    app.exit(exitCode);
  }
})();
