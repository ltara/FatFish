"use strict";
// Own isolated app only. Test controls observe/resize/stop; all form input is native Computer Use.
const fs = require("node:fs"), path = require("node:path");
const cfg = JSON.parse(fs.readFileSync(process.env.FATFISH_NATIVE_CONFIG, "utf8"));
let services, win;
const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("force-renderer-accessibility");
process.env.NODE_PATH = path.resolve(__dirname, "../node_modules"); require("node:module").Module._initPaths();
const send = message => fs.writeFileSync(path.join(cfg.home, "native-host-event.json"), JSON.stringify({ ...message, serial: Date.now() }));
process.on("uncaughtException", error => { send({ type: "host_error", startup: !win, code: !win ? String(error.message).replace(/sk-[A-Za-z0-9_-]+/g, "redacted").slice(0, 240) : "runtime_error" }); process.exit(1); });
process.on("unhandledRejection", error => { send({ type: "host_error", startup: !win, code: !win ? String(error?.message || "startup_rejection").slice(0, 240) : "runtime_rejection" }); process.exit(1); });
if (!path.resolve(cfg.home).startsWith(path.resolve(require("node:os").tmpdir()) + path.sep + "fatfish-m5-native-")) throw Error("isolated_native_root_required");
app.setPath("userData", path.join(cfg.home, "window-profile"));
process.env.FATFISH_APPDATA = cfg.home; delete process.env.FATFISH_SMOKE;
const mod = require(path.join(cfg.ui, "service-manager.js")), Original = mod.ServiceManager;
const attempts = { backend: 0, channelProbe: 0 };
mod.ServiceManager = class extends Original {
  constructor(options) { super(options); services = this; }
  spawnBackend() { attempts.backend++; throw Error("real_backend_forbidden_in_native_test"); }
  async probeTcp() { attempts.channelProbe++; throw Error("real_channel_probe_forbidden_in_native_test"); }
};
const originalQuit = app.quit.bind(app); let closing = false;
require(path.join(cfg.ui, "main.js"));
app.whenReady().then(async () => {
  win = BrowserWindow.getAllWindows()[0];
  win.on("page-title-updated", event => { event.preventDefault(); win.setTitle(cfg.title); });
  win.setTitle(cfg.title); win.setSize(cfg.width || 960, cfg.height || 640); win.webContents.setBackgroundThrottling(false);
  await new Promise(resolve => { if (!win.webContents.isLoading()) return resolve(); win.webContents.once("did-finish-load", resolve); });
  win.setTitle(cfg.title); win.show();
  send({ type: "ready", pid: process.pid });
});
async function stop() { if (closing) return; closing = true; await services?.stopAll(); app.quit = originalQuit; app.exit(0); }
async function command(message) {
  try {
    if (message.type === "shutdown") return await stop();
    if (message.type === "viewport") { win.setSize(message.width, message.height); win.webContents.setZoomFactor(message.zoom || 1); }
    if (message.type === "snapshot") {
      const data = await win.webContents.executeJavaScript(`(() => {
        const ids = ['activation-mask','risk-mask','first-setup','onboarding-model','onboarding-local','btn-activate','activation-code','risk-ok','risk-go','btn-onboarding-next','btn-onboarding-later','chat-input','btn-chat-send','about-license'];
        const visible = el => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
        return { viewport: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }, focusedId: document.activeElement?.id || null,
          elements: ids.map(id => { const el = document.getElementById(id), r = el?.getBoundingClientRect(); return { id, exists: !!el, visible: visible(el), disabled: el?.disabled === true,
            scroll: el ? { top:el.scrollTop, height:el.scrollHeight, client:el.clientHeight } : null, rect: r ? { x:r.x,y:r.y,width:r.width,height:r.height } : null }; }) };
      })()`);
      const screenshot = path.join(cfg.evidence, message.name + ".png");
      fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
      send({ type: "snapshot", name: message.name, data, attempts,
        serviceMeta: { corePresent: !!services?._children?.core && services._children.core.exitCode === null, qqEnabled: services?.readQqEnabled() === true },
        nativeWindow: { title: win.getTitle(), visible: win.isVisible(), minimized: win.isMinimized(), bounds: win.getBounds() } });
    }
  } catch { send({ type: "host_error" }); }
}
setInterval(() => { const file = path.join(cfg.home, "native-host-command.json"); if (fs.existsSync(file)) { const message = JSON.parse(fs.readFileSync(file, "utf8")); fs.unlinkSync(file); command(message); } }, 200);
