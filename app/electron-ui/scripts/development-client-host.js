"use strict";
// Explicit source-development entry, excluded from the shipped client.
const fs = require("node:fs"), path = require("node:path"), { app, BrowserWindow, ipcMain } = require("electron");
const config = JSON.parse(fs.readFileSync(process.env.FATFISH_DEVELOPMENT_CONFIG, "utf8"));
if (app.isPackaged || !path.isAbsolute(config.dataRoot) || !path.isAbsolute(config.ui) || !path.isAbsolute(config.repo)) throw Error("source_development_entry_required");
process.env.NODE_PATH = path.join(config.repo, "app/electron-ui/node_modules"); require("node:module").Module._initPaths();
process.env.FATFISH_APPDATA = config.dataRoot;
app.setPath("userData", path.join(config.dataRoot, "window-profile"));
const moduleRef = require(path.join(config.ui, "service-manager.js")), Original = moduleRef.ServiceManager;
let services, stopping = false;
moduleRef.ServiceManager = class extends Original {
  constructor(options) { super(options); services = this; }
  resolvePaths() {
    // Keep the copied Core/public anchor; only resolve bundled runtime resources from the repo.
    return { ...super.resolvePaths(), napcatDir: this.resolveBackendDir(config.repo), nodeExe: this.resolveNodeExe(config.repo) };
  }
};
require(path.join(config.ui, "main.js"));
const clientSource = fs.readFileSync(path.join(config.repo, "app/electron-ui/scripts/development-ui-client.js"), "utf8");
let mainWindow, readyForUpdates = false, dispatching = false, latestRevision = 0, lastSeen = 0, lastReload = 0, requestedReload = 0;
function reloadWhenSynchronized() {
  if (!requestedReload || stopping || !mainWindow || mainWindow.isDestroyed() || fs.existsSync(path.join(config.runRoot, "ui-sync-busy"))) return;
  let value; try { value = JSON.parse(fs.readFileSync(path.join(config.runRoot, "ui-update.json"), "utf8")); } catch { return; }
  if (!Number.isSafeInteger(value.revision) || value.revision < requestedReload) return;
  lastReload = value.revision; lastSeen = Math.max(lastSeen, value.revision); requestedReload = 0; readyForUpdates = false;
  mainWindow.webContents.reloadIgnoringCache();
}
ipcMain.on("development-ui-reload", (event, revision) => {
  if (stopping || !mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
      !Number.isSafeInteger(revision) || revision <= lastReload || revision > latestRevision) return;
  requestedReload = Math.max(requestedReload, revision); reloadWhenSynchronized();
});
app.whenReady().then(() => {
  const window = BrowserWindow.getAllWindows()[0]; if (!window) return;
  mainWindow = window;
  window.on("page-title-updated", event => { event.preventDefault(); window.setTitle("肥鱼 · 开发版"); });
  window.setTitle("肥鱼 · 开发版");
  const inject = async () => {
    if (stopping || window.isDestroyed()) return;
    try { await window.webContents.executeJavaScript(clientSource); readyForUpdates = true; }
    catch { readyForUpdates = false; }
  };
  window.webContents.on("did-start-loading", () => { readyForUpdates = false; });
  window.webContents.on("did-finish-load", inject);
  if (!window.webContents.isLoading()) inject();
});
const updateTimer = setInterval(async () => {
  reloadWhenSynchronized();
  if (stopping || !readyForUpdates || dispatching || !mainWindow || mainWindow.isDestroyed() || fs.existsSync(path.join(config.runRoot, "ui-sync-busy"))) return;
  let value;
  try { value = JSON.parse(fs.readFileSync(path.join(config.runRoot, "ui-update.json"), "utf8")); } catch { return; }
  if (!Number.isSafeInteger(value.revision) || value.revision <= lastSeen || typeof value.cssOnly !== "boolean" ||
      !Number.isSafeInteger(value.reloadRevision) || value.reloadRevision < 0 || value.reloadRevision > value.revision) return;
  latestRevision = value.revision; lastSeen = value.revision; dispatching = true;
  try { await mainWindow.webContents.executeJavaScript(`window.__fatfishDevelopmentUpdates?.apply(${JSON.stringify({ revision: value.revision, cssOnly: value.cssOnly && value.reloadRevision <= lastReload })})`); }
  catch { if (value.revision > lastReload) lastSeen = lastReload; }
  finally { dispatching = false; }
}, 250);
updateTimer.unref();
const timer = setInterval(async () => {
  const commandFile = path.join(config.runRoot, "stop-request.json");
  if (stopping || !fs.existsSync(commandFile)) return;
  let command; try { command = JSON.parse(fs.readFileSync(commandFile, "utf8")); } catch { return; }
  if (command.type !== "shutdown") return; stopping = true; clearInterval(timer); clearInterval(updateTimer);
  await services?.stopAll(); app.exit(0);
}, 300);
timer.unref();
app.on("before-quit", () => { stopping = true; clearInterval(timer); clearInterval(updateTimer); });
