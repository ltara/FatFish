/** Actual desktop/IPC/Core/runtime, no account, local model and file fixtures only. */
"use strict";
const { app, BrowserWindow, clipboard } = require("electron");
const fs = require("node:fs");
const { resolve, join, sep } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const { once } = require("node:events");
const home = resolve(process.env.FATFISH_LOCAL_TEST_HOME || "");
if (!home.startsWith(resolve(tmpdir()) + sep + "fatfish-local-ui-")) throw new Error("isolated runner required");
const licensed = require("../../core/dev/license-fixture.cjs").licensedFixture(home); Object.assign(process.env, licensed.env);
const licensedUi = licensed.ui({ setupComplete: true });
const outArg = process.argv.indexOf("--evidence"), out = outArg >= 0 ? resolve(process.argv[outArg + 1]) : home;
fs.mkdirSync(out, { recursive: true });
const nativeTray = process.argv.includes("--native-tray");
process.env.FATFISH_APPDATA = home;
if (nativeTray) delete process.env.FATFISH_SMOKE; else process.env.FATFISH_SMOKE = "1";
process.env.FATFISH_DEV_APPROVAL_TIMEOUT_MS = "6500";
app.setPath("userData", join(home, "window-profile")); app.quit = () => {};
const moduleRef = require(join(licensedUi, "service-manager")), Original = moduleRef.ServiceManager;
let services, win, proxy, backend, fault = null, target = null, toolMode = false;
let previousClipboard;
let reply = "你好，本机对话已接通。", probes = 0, spawns = 0, loginCalls = 0;
const results = [];
let releaseFixtures;
const fixturesReady = new Promise((r) => { releaseFixtures = r; });
const trayState = {};
if (nativeTray) {
  const { Tray } = require("electron");
  for (const [name, capture] of Object.entries({ setToolTip: (v) => { trayState.tooltip = v; }, setImage: (v) => { trayState.bitmap = v.toBitmap().toString("hex"); } })) {
    const original = Tray.prototype[name]; Tray.prototype[name] = function (value) { capture(value); return original.call(this, value); };
  }
}
moduleRef.ServiceManager = class extends Original {
  constructor(opts) {
    super(opts); services = this;
    const originalProbe = this.probeTcp.bind(this); this.probeTcp = (...args) => { probes++; return originalProbe(...args); };
    this.spawnBackend = () => { spawns++; throw new Error("real_backend_forbidden"); };
  }
  resolvePaths() { return { ...super.resolvePaths(), napcatDir: null }; }
  async startAll() { await fixturesReady; return super.startAll(); }
  readWebUiToken() { return "local-only-login-fixture"; }
};
const login = require(join(licensedUi, "login-api"));
login.getLoginSession = async () => { loginCalls++; return { ok: true, isLogin: true, phase: "success", uin: "90000", nick: "肥鱼", credential: "fixture" }; };
login.ensureOnebotWsServer = async () => ({ ok: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, ms = 30000) => { const until = Date.now() + ms; while (Date.now() < until) { if (await fn()) return; await sleep(25); } throw new Error("local UI fixture timeout"); };
const check = (name, ok) => { results.push({ name, pass: !!ok }); console.log((ok ? "PASS " : "FAIL ") + name); if (!ok) throw new Error(name); };
const js = (source) => win.webContents.executeJavaScript(source, true);
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const state = () => js("window.fatfish.getChat()");
const send = async (text) => { await js(`document.querySelector('#chat-input').value=${JSON.stringify(text)}`); await click("#btn-chat-send"); };
const idle = () => wait(async () => !(await state()).busy);
const shot = async (name, width = 960, height = 640) => {
  win.setSize(width, height); await win.webContents.capturePage();
  await js("document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))).then(()=>true)");
  fs.writeFileSync(join(out, name + ".png"), (await win.webContents.capturePage()).toPNG());
};
require(join(licensedUi, "main"));
app.whenReady().then(async () => {
  let code = 1;
  try {
    previousClipboard = clipboard.readText();
    win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); services.ensureAppData();
    const { WebSocketServer } = require("../../core/node_modules/ws");
    backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    backend.on("connection", (ws) => ws.on("message", (buf) => { const m = JSON.parse(buf); ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: m.echo,
      data: m.action === "get_login_info" ? { user_id: 90000, nickname: "肥鱼" } : { message_id: 1 } })); }));
    await once(backend, "listening");
    const configFile = join(home, "config.json"), config = JSON.parse(fs.readFileSync(configFile));
    const port = backend.address().port; config.onebot_port = port; config.login_ui_port = port; config.onebot_url = `ws://127.0.0.1:${port}`;
    fs.writeFileSync(configFile, JSON.stringify(config)); fs.writeFileSync(join(home, "secrets/deepseek_api_key"), "sk-local-ui-not-a-key");
    const model = await import(pathToFileURL(join(__dirname, "../../core/dev/model-proxy.mjs")));
    proxy = await model.startModelProxy({ reply: () => reply, failure: () => fault, tool: (body) => {
      if (!toolMode || body.messages.at(-1)?.content?.some?.((c) => c.type === "tool_result")) return null;
      const definition = body.tools.find((t) => t.name === "write");
      if (!definition) throw new Error("write_tool_missing");
      const props = definition.input_schema.properties;
      return { name: "write", input: { [Object.hasOwn(props, "file_path") ? "file_path" : "path"]: target, content: "approved-fixture" } };
    } });
    process.env.FATFISH_DEV_DEEPSEEK_BASE_URL = proxy.url;
    releaseFixtures();
    await services.startAll(); await wait(() => services.getCore().channels.qq === "disabled");
    await win.loadFile(join(__dirname, "../renderer/index.html"));
    await wait(() => js("!document.querySelector('#risk-mask').classList.contains('hidden')"));
    await js("document.querySelector('#risk-ok').click()"); await click("#risk-go");
    await wait(() => js("document.querySelector('#main-app').style.visibility === 'visible'"));
    check("fresh app enters without scan or backend installation", loginCalls === 0 && probes === 0 && spawns === 0 && services.getState().phase === "running");
    check("disabled QQ is not an actionable failure", await js("!document.querySelector('#home-todo-list').textContent.includes('QQ 未连接') && document.querySelector('#btn-relogin').classList.contains('hidden')"));
    await click('[data-page="chat"]'); await wait(() => js("document.querySelector('#chat-messages').textContent.includes('试试')"));
    await send("你好，这是本机测试"); await wait(async () => (await state()).messages.some((m) => m.role === "assistant")); await idle();
    check("local message reaches the actual engine without QQ", (await state()).messages.at(-1).text === reply && loginCalls === 0 && !services.getCore().engines.external);
    check("home activity has explicit local scope and real local counts", (await js("window.fatfish.getStatus()")).activity.dm_today === "1" && (await js("window.fatfish.getStatus()")).activity.kind === "local");
    await js("document.querySelector('#chat-input').value='多行输入\\n第二行\\n第三行\\n第四行\\n第五行\\n第六行'; document.querySelector('#chat-input').dispatchEvent(new Event('input'))");
    check("composer grows within its documented size limit", await js("document.querySelector('#chat-input').offsetHeight > 36 && document.querySelector('#chat-input').offsetHeight <= 120"));
    await js("document.querySelector('#chat-input').value=''; document.querySelector('#chat-input').dispatchEvent(new Event('input'))");
    await shot("local-chat");
    await win.webContents.reload(); await wait(() => js("document.querySelector('#main-app').style.visibility === 'visible'"));
    await click('[data-page="chat"]'); await wait(() => js("document.querySelector('#chat-messages').textContent.includes('本机对话已接通')"));
    check("desktop reload reads back local display records", (await state()).messages[0].text === "你好，这是本机测试");
    toolMode = true;
    for (const [name, decision] of [["reject", "rejected"], ["allow", "allowed-once"], ["timeout", null]]) {
      target = join(home, "workspace/local", name + ".txt");
      if (name === "allow") win.minimize();
      await send("工作区写入验收 " + name);
      await wait(async () => (await state()).approvals.length === 1);
      const approvalId = (await state()).approvals[0].id;
      check(`${name} workspace operation asks before writing`, !fs.existsSync(target) && await js("!!document.querySelector('.chat-approval')"));
      if (nativeTray && name === "reject") {
        await wait(() => trayState.tooltip === "肥鱼 · 等你确认");
        check("native tray signals an actual pending local approval", trayState.tooltip === "肥鱼 · 等你确认" && !!trayState.bitmap);
      }
      if (name === "allow") check("approval restores and shows a minimized window", !win.isMinimized() && win.isVisible());
      if (name === "reject") {
        const pending = (await state()).approvals[0];
        check("no permanent allow action is exposed", await js("document.querySelectorAll('.chat-approval button').length === 2"));
        await win.webContents.reload(); await wait(() => js("!!document.querySelector('.chat-approval')"));
        check("pending approval survives renderer reload", (await state()).approvals[0].id === pending.id);
        await shot("local-approval", 800, 560);
        win.webContents.setZoomFactor(2);
        await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))).then(()=>true)");
        await js("document.querySelector('.chat-approval button[data-outcome=rejected]').scrollIntoView({block:'center'})");
        check("approval remains reachable at 200 percent zoom", await js("(()=>{const r=document.querySelector('.chat-approval button[data-outcome=rejected]').getBoundingClientRect();return document.querySelector('#chat-messages').clientHeight>50 && r.top>=0 && r.bottom<=innerHeight})()"));
        await shot("local-approval-200", 800, 560);
        win.webContents.setZoomFactor(1);
      }
      if (decision) await click(`.chat-approval button[data-outcome="${decision}"]`);
      await idle();
      check(`${name} leaves the expected filesystem result`, decision === "allowed-once" ? fs.readFileSync(target, "utf8") === "approved-fixture" : !fs.existsSync(target));
      check(`${name} closes to an auditable conclusion`, (await state()).messages.some((m) => m.role === "approval" && m.text.includes(name === "timeout" ? "已超时" : name === "allow" ? "你允许了" : "你没有允许")));
      if (name === "timeout") check("late approval cannot execute an expired request", !(await js(`window.fatfish.answerApproval(${JSON.stringify(approvalId)},'allowed-once')`)).ok && !fs.existsSync(target));
    }
    toolMode = false; fault = "hold";
    const before = proxy.requests.length; await send("停止中的请求"); await wait(() => proxy.requests.length > before);
    await wait(() => js("document.querySelector('#btn-chat-send').textContent === '停止'")); await click("#btn-chat-send"); await idle();
    check("stop cancels local execution without inventing a cancellation RPC", (await state()).messages.at(-1).text.includes("已停止"));
    fault = null; reply = "<img src=x onerror=window.injected=true>\n[站点](https://example.com/test)\n`代码`\n```text\n安全文本\n```";
    await send("安全格式测试"); await wait(async () => (await state()).messages.at(-1)?.text === reply); await idle();
    check("model HTML is text and no image resource is loaded", await js("!document.querySelector('#chat-messages img') && !window.injected && !!document.querySelector('#chat-messages pre code')"));
    await click("#chat-messages .chat-link"); await wait(() => clipboard.readText() === "https://example.com/test");
    check("model link is copied rather than opened", clipboard.readText() === "https://example.com/test");
    const oldSession = (await state()).sessionId; await click("#btn-chat-new"); await wait(async () => (await state()).sessionId !== oldSession);
    check("new conversation creates another session and preserves the old record", (await state()).messages.length === 0 && fs.existsSync(join(home, "chat", oldSession + ".json")));
    check("new session does not erase today's local statistics", Number((await js("window.fatfish.getStatus()")).activity.dm_today) >= 6);
    const indexFile = join(home, "chat/index.json"), savedIndex = fs.readFileSync(indexFile, "utf8"), count = proxy.requests.length;
    fs.writeFileSync(indexFile, "invalid-json"); await send("保存失败应保留输入");
    await wait(() => js("document.querySelector('#chat-input').value === '保存失败应保留输入'"));
    check("record save failure preserves input and does not call model", proxy.requests.length === count && fs.readFileSync(indexFile, "utf8") === "invalid-json");
    fs.writeFileSync(indexFile, savedIndex);
    await click('[data-page="settings"]'); await click("#qq-enabled");
    check("QQ is opt-in with a separate risk confirmation", !JSON.parse(fs.readFileSync(configFile)).channels.qq.enabled && await js("!document.querySelector('#qq-risk-panel').classList.contains('hidden') && document.querySelector('#btn-qq-enable-confirm').disabled"));
    await click("#btn-qq-enable-cancel"); check("cancelling channel setup leaves local-only mode", !services.readQqEnabled());
    const denied = await js("window.fatfish.setQqEnabled(true,false)"); check("main requires explicit channel risk acceptance", denied.error === "risk_confirmation_required");
    await click("#qq-enabled"); await click("#qq-risk-ok"); await click("#btn-qq-enable-confirm");
    await wait(() => services.readQqEnabled() && loginCalls > 0);
    await click("#btn-login-back"); await click('[data-page="settings"]'); await wait(() => js("document.querySelector('#qq-enabled').checked"));
    await click("#qq-enabled"); await wait(() => !services.readQqEnabled());
    check("explicit channel disable keeps local history and avoids real backend launch", spawns === 0 && (await state()).sessionId !== oldSession);
    await click('[data-page="chat"]'); reply = "仍可本机对话"; await send("关闭渠道后继续"); await wait(async () => (await state()).messages.at(-1)?.text === reply); await idle();
    check("local conversation remains usable after channel enable and disable", (await state()).messages.at(-1).text === "仍可本机对话");
    await shot("local-only-final", 800, 560);
    const logs = fs.readFileSync(join(home, "logs/core.log"), "utf8");
    check("only metadata enters Core logs", !logs.includes("工作区写入验收") && !logs.includes("approved-fixture") && !logs.includes("sk-local-ui"));
    const foreign = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, "../preload.js"), contextIsolation: true, sandbox: true } });
    await foreign.loadURL("about:blank"); const requestsBefore = proxy.requests.length;
    const foreignResult = await foreign.webContents.executeJavaScript("window.fatfish.sendChat('不应进入模型')");
    check("another window cannot start a local operation", foreignResult.error === "forbidden" && proxy.requests.length === requestsBefore);
    foreign.destroy();
    code = 0; console.log(`${results.length}/${results.length} local UI checks passed (no paid calls)`);
    if (process.argv.includes("--review")) {
      reply = "你好，想先聊点什么？"; toolMode = false; fault = null;
      await js("window.fatfish.newChat()"); await click('[data-page="home"]');
      win.setSize(960, 640); win.setTitle("肥鱼 · UX 走查"); win.show();
      console.log("local_ui_review_ready");
      await sleep(360000);
    }
  } catch (e) { console.error(e.stack); }
  finally {
    if (previousClipboard !== undefined && clipboard.readText() === "https://example.com/test") clipboard.writeText(previousClipboard);
    fs.writeFileSync(join(out, "local-report.json"), JSON.stringify({ results, paidCalls: 0 }, null, 2));
    if (services) await services.stopAll();
    if (backend) await new Promise((r) => { for (const c of backend.clients) c.terminate(); backend.close(r); });
    if (proxy) await proxy.close(); app.exit(code);
  }
});
