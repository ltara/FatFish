/** Offline resource and actual Main-function checks; no native window or service. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { pathToFileURL, fileURLToPath } = require("node:url");
const root = path.resolve(__dirname, ".."), repo = path.resolve(root, "../..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const bytes = name => fs.readFileSync(path.join(root, name));
const hash = data => createHash("sha256").update(data).digest("hex");
const manifest = JSON.parse(read("assets/brand-assets.json"));
const pkg = JSON.parse(read("package.json"));
let count = 0;
function check(name, value) { assert.ok(value, name); count++; console.log("PASS " + name); }
function pngSize(data) {
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

check("approved source hash remains fixed", hash(fs.readFileSync(path.join(repo, manifest.source))) === manifest.sourceSha256 && manifest.sourceSha256 === "465633a4d2952b772added6fa48e64fbca715fb13f61ccaac6344ba6107e7636");
check("crop stays on the approved central icon", manifest.cropBox.join(",") === "555,244,990,685" && manifest.nativePaddedSize === 441);
check("export is deterministic crop/alpha/resize, not redrawing", manifest.method.includes("no redrawing") && manifest.alphaRecovery.outsidePixelsRemoved > 0);
for (const item of manifest.outputs) {
  check("resource hash matches export: " + item.file, hash(bytes("assets/" + item.file)) === item.sha256);
  if (item.file.endsWith(".png")) check("PNG dimensions match: " + item.file, pngSize(bytes("assets/" + item.file)).join() === [item.width, item.height].join());
}
check("all default and high-density tray states are exported", ["tray", "tray-ok", "tray-warn", "tray-bad", "tray-info"].every(name => manifest.outputs.some(x => x.file === name + ".png" && x.width === 16) && manifest.outputs.some(x => x.file === name + "@2x.png" && x.width === 32)));
check("state palette retains the established meanings", JSON.stringify(manifest.trayStatusPalette) === JSON.stringify({ ok: [47, 158, 100], warn: [201, 162, 39], bad: [196, 86, 74], info: [90, 143, 168] }));
const ico = bytes("assets/icon.ico"), sizes = [];
check("Windows icon has ICO image-directory header", ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1);
for (let i = 0; i < ico.readUInt16LE(4); i++) {
  const at = 6 + i * 16, size = ico[at] || 256, length = ico.readUInt32LE(at + 8), offset = ico.readUInt32LE(at + 12);
  assert.equal(ico[at + 1] || 256, size);
  assert.ok(offset + length <= ico.length);
  assert.deepEqual(pngSize(ico.subarray(offset, offset + length)), [size, size]);
  sizes.push(size);
}
check("ICO contains every requested native size", sizes.join() === "16,24,32,48,64,128,256");
check("application and installer icons use the approved ICO", pkg.build.win.icon === "assets/icon.ico" && pkg.build.nsis.installerIcon === "assets/icon.ico" && pkg.build.nsis.uninstallerIcon === "assets/icon.ico");
check("resources stay in the normal packaged asset directory", pkg.build.files.includes("assets/**/*") && !JSON.stringify(pkg.build).includes(".codex"));
check("desktop and start menu shortcuts retain their existing names", pkg.build.nsis.createDesktopShortcut && pkg.build.nsis.createStartMenuShortcut && pkg.build.nsis.shortcutName === "肥鱼");

const appSource = read("renderer-src/App.tsx"), html = read("renderer/index.html"), css = read("renderer/styles.css");
check("sidebar uses a local decorative image without duplicated spoken name", /<img className="brand-mark" src="\.\.\/assets\/icon\.png"[^>]*alt=""[^>]*aria-hidden="true"/.test(appSource));
check("static first frame contains the same approved logo", /<img[^>]*class="brand-mark"[^>]*src="\.\.\/assets\/icon\.png"/.test(html));
check("renderer-relative icon resolves to the packaged asset", fileURLToPath(new URL("../assets/icon.png", pathToFileURL(path.join(root, "renderer/index.html")))) === path.join(root, "assets/icon.png"));
check("standard and compact sidebar sizes are explicit", /\.brand-mark\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;[^}]*object-fit:\s*contain/.test(css) && /\.brand-mark\s*\{\s*width:\s*24px;\s*height:\s*24px;/.test(css));
check("old orange brand dot is no longer used", !/\.brand-mark\s*\{[^}]*background:\s*var\(--primary\)/.test(css));
check("brand name and original companion subtitle are retained", appSource.includes('className="brand-text">肥鱼') && appSource.includes("住在你电脑里的伙伴"));
check("static activation lock remains intact", html.includes('<body class="activation-locked">'));

const source = read("main.js");
function functionSource(name, next) {
  const start = source.indexOf("function " + name + "("), end = source.indexOf("\nfunction " + next + "(", start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
const loaded = [], windows = [], trays = [], identities = [];
let kind = "ok";
const nativeImage = {
  createFromPath(file) {
    loaded.push(file);
    return { file, isEmpty: () => !fs.existsSync(file), getSize: () => ({ width: pngSize(fs.readFileSync(file))[0] }) };
  },
  createFromBuffer() { return { file: "fallback", isEmpty: () => false }; },
};
class Window {
  constructor(options) { this.options = options; windows.push(this); this.webContents = { setWindowOpenHandler() {}, on() {} }; }
  on() {}
  loadFile(file) { this.file = file; }
}
class Tray {
  constructor(image) { this.image = image; trays.push(this); }
  setToolTip(text) { this.tooltip = text; }
  setImage(image) { this.image = image; }
  setContextMenu(menu) { this.menu = menu; }
  on() {}
}
const context = vm.createContext({ __dirname: root, fs, path, Buffer, nativeImage, BrowserWindow: Window, Tray,
  app: { setAppUserModelId: value => identities.push(value) },
  Menu: { buildFromTemplate: items => items }, process: { platform: "win32" },
  showMainWindow() {}, statusSnapshot: () => ({ outbound_paused: false, qq_online: false, qq_enabled: false,
    presentation: { kind, label: "fixture " + kind, trayText: "肥鱼 · fixture " + kind } }) });
vm.runInContext('let mainWindow = null, tray = null; const isSmoke = false, stopping = false;\n' +
  functionSource("configureAppIdentity", "resolveTrayIcon") +
  functionSource("resolveTrayIcon", "showMainWindow") + functionSource("stateTrayIcon", "statusSnapshot") +
  functionSource("createTray", "createWindow") + functionSource("createWindow", "loginPort"), context);
vm.runInContext("configureAppIdentity();", context);
const readyAt = source.indexOf("app.whenReady().then");
check("Windows identity matches the installer before window creation", identities.join() === pkg.build.appId && source.indexOf("configureAppIdentity();", readyAt) < source.indexOf("createWindow();", readyAt));
vm.runInContext('process.platform = "linux"; configureAppIdentity();', context);
check("non-Windows identity is unchanged", identities.length === 1);
vm.runInContext('process.platform = "win32"; app.setAppUserModelId = undefined; configureAppIdentity();', context);
check("isolated hosts without native identity API remain supported", identities.length === 1);
vm.runInContext("createWindow(); createTray();", context);
check("actual Main window constructor gets the approved ICO", windows.length === 1 && windows[0].options.icon === path.join(root, "assets/icon.ico"));
check("window sizing and sandbox flags are unchanged", windows[0].options.width === 960 && windows[0].options.minWidth === 800 && windows[0].options.webPreferences.contextIsolation && windows[0].options.webPreferences.sandbox && !windows[0].options.webPreferences.nodeIntegration);
check("actual Main still loads the local renderer", windows[0].file === path.join(root, "renderer/index.html"));
vm.runInContext('process.platform = "linux"; createWindow(); process.platform = "win32";', context);
check("non-Windows preview keeps the compatible PNG icon", windows.at(-1).options.icon === path.join(root, "assets/icon.png"));
check("actual Main creates one tray, not a new one on each state", trays.length === 1);
const stateHashes = new Set();
for (kind of ["ok", "warn", "bad", "info"]) {
  trays[0]._rebuild();
  const image = trays[0].image;
  check("Main keeps the brand with state badge: " + kind, image.file === path.join(root, "assets", "tray-" + kind + ".png"));
  check("tooltip and menu still share the same status: " + kind, trays[0].tooltip === "肥鱼 · fixture " + kind && trays[0].menu[1].label === "状态：fixture " + kind);
  stateHashes.add(hash(fs.readFileSync(image.file)));
}
check("status images are visibly distinct files", stateHashes.size === 4);
check("unknown status has bounded info fallback", vm.runInContext('stateTrayIcon("../../not-an-asset")', context).file === path.join(root, "assets/tray-info.png"));
check("all actual icon reads stay inside the local asset directory", loaded.every(file => path.dirname(file) === path.join(root, "assets")));

const shortcutFile = path.join(repo, "scripts/create-development-shortcut.ps1"), shortcutBytes = fs.readFileSync(shortcutFile), shortcut = shortcutBytes.toString("utf8");
check("shortcut creator uses the approved icon rather than the runtime default", shortcut.includes('$Icon = Join-Path $Root "app\\electron-ui\\assets\\icon.ico"') && shortcut.includes('$Shortcut.IconLocation = $Icon + ",0"'));
check("shortcut creator remains UTF-8 BOM and does not start the app", shortcutBytes.subarray(0, 3).toString("hex") === "efbbbf" && !/Start-Process|Invoke-Item/.test(shortcut));
console.log(`${count}/${count} brand resource/Main VM checks passed (no native windows, services, packaging or network)`);
