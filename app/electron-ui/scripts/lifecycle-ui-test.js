/** Real desktop/IPC lifecycle with isolated data and local model/message fixtures. */
"use strict";
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const { join, resolve, sep } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const { once } = require("node:events");
const home = resolve(process.env.FATFISH_LIFECYCLE_TEST_HOME || "");
if (!home.startsWith(resolve(tmpdir()) + sep + "fatfish-lifecycle-ui-")) throw new Error("isolated runner required");
const licensed = require("../../core/dev/license-fixture.cjs").licensedFixture(home); Object.assign(process.env, licensed.env);
const licensedUi = licensed.ui({ setupComplete: true });
const phase = process.argv.includes("--restart") ? "restart" : "initial";
const marker = "lifecycle-persona-marker";
process.env.FATFISH_APPDATA = home;
process.env.FATFISH_SMOKE = "1";
app.setPath("userData", join(home, "window-profile"));
app.quit = () => {};
const moduleRef = require(join(licensedUi, "service-manager"));
const Original = moduleRef.ServiceManager;
let services, proxy, backend, win, socket;
const sent = [], results = [];
moduleRef.ServiceManager = class extends Original {
  constructor(opts) { super(opts); services = this; this.killBackendHelpers = () => {}; }
  readWebUiToken() { return "local-test-token"; }
};
const login = require(join(licensedUi, "login-api"));
login.getLoginSession = async () => ({ ok: true, phase: "success", isLogin: true, uin: "90000", nick: "肥鱼", credential: "local-test" });
login.ensureOnebotWsServer = async () => ({ ok: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return; await sleep(30); }
  throw new Error("lifecycle fixture timeout");
};
const check = (name, value) => { results.push({ name, pass: !!value }); console.log((value ? "PASS " : "FAIL ") + name); if (!value) throw new Error(name); };
const js = (s) => win.webContents.executeJavaScript(s, true);
const inbound = () => socket.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend", self_id: 90000,
  user_id: 10001, message: [{ type: "text", data: { text: "测试下一句" } }] }));
require(join(licensedUi, "main"));
app.whenReady().then(async () => {
  let code = 1;
  try {
    win = BrowserWindow.getAllWindows()[0];
    const { WebSocketServer } = require("../../core/node_modules/ws");
    backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    backend.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (b) => {
        const m = JSON.parse(b);
        const data = m.action === "get_login_info" ? { user_id: 90000, nickname: "肥鱼" } : { message_id: sent.length + 1 };
        if (m.action === "send_private_msg") sent.push(m.params.message.map((p) => p.data.text).join(""));
        ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: m.echo, data }));
      });
    });
    await once(backend, "listening");
    services.ensureAppData();
    fs.writeFileSync(join(home, "runtime", "risk_ok"), "1");
    fs.writeFileSync(join(home, "secrets", "deepseek_api_key"), "sk-lifecycle-not-a-key");
    const port = backend.address().port;
    fs.writeFileSync(join(home, "config.json"), JSON.stringify({ onebot_url: `ws://127.0.0.1:${port}`, onebot_port: port,
      login_ui_port: port, owners: [{ channel: "qq", account: "10001", boundAt: new Date().toISOString(), label: "" }] }));
    const model = await import(pathToFileURL(join(__dirname, "../../core/dev/model-proxy.mjs")));
    proxy = await model.startModelProxy({ reply: (r) => JSON.stringify([r.system, r.messages]).includes(marker) ? marker : "初始人格回复" });
    process.env.FATFISH_DEV_DEEPSEEK_BASE_URL = proxy.url;
    await services.startAll();
    await wait(() => services.getCore().engine === "ready" && socket);
    await win.loadFile(join(__dirname, "../renderer/index.html"));
    await wait(() => js("document.querySelector('#main-app').style.visibility === 'visible' || !document.querySelector('#login-success').classList.contains('hidden')"));
    if (await js("document.querySelector('#main-app').style.visibility !== 'visible'")) await js("document.querySelector('#btn-login-continue').click()");
    await wait(() => js("document.querySelector('#main-app').style.visibility === 'visible'"));
    const status = await js("window.fatfish.getStatus()");
    check("real status reports Core and channel backend running", status.phase === "running" && status.core_running && status.backend_ready);
    check("removed navigation and API are absent", await js("!document.querySelector('[data-page=features]') && !('getAgentEngine' in window.fatfish)"));
    if (phase === "initial") {
      const saved = await js("window.fatfish.saveApiKey('sk-lifecycle-replaced-not-a-key')");
      check("key saves directly through main IPC", saved.ok && fs.readFileSync(join(home, "secrets/deepseek_api_key"), "utf8").includes("replaced"));
      const item = await js(`window.fatfish.personaCreate({title:'验收人格',body:${JSON.stringify("你是肥鱼，标记：" + marker)}})`);
      const applied = await js(`window.fatfish.personaApply(${JSON.stringify(item.item.id)})`);
      check("persona application reports next-turn semantics", applied.ok && applied.message.includes("下一句起生效"));
      inbound(); await wait(() => sent.length === 1);
      check("main persona IPC actually reloads the engine", sent[0] === marker);
      await js("document.querySelector('#btn-pause-toggle').click()");
      await wait(() => services.getCore().paused && fs.readFileSync(join(home, "runtime/outbound_paused"), "utf8").trim() === "1");
      check("pause button persists and acknowledges Core state", await js("document.querySelector('#btn-pause-toggle').textContent.includes('恢复')"));
    } else {
      check("full Electron process restart restores pause", status.outbound_paused && services.getCore().paused);
      inbound(); await sleep(200);
      check("no model request or reply while restored pause is active", proxy.requests.length === 0 && sent.length === 0);
      await js("document.querySelector('#btn-pause-toggle').click()");
      await wait(() => !services.getCore().paused);
      inbound(); await wait(() => sent.length === 1);
      check("persisted persona works after desktop restart and resume", sent[0] === marker);
    }
    code = 0;
  } catch (e) { console.error(e.stack); }
  finally {
    fs.writeFileSync(join(home, `${phase}-report.json`), JSON.stringify({ phase, results }));
    if (services) await services.stopAll();
    if (backend) await new Promise((r) => { for (const c of backend.clients) c.terminate(); backend.close(r); });
    if (proxy) await proxy.close();
    app.exit(code);
  }
});
