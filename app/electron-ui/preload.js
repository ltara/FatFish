"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fatfish", {
  getLicense: () => ipcRenderer.invoke("get-license"), // 验签状态与可选显示尾号；尾号不是权限凭据。
  activateLicense: (code) => ipcRenderer.invoke("activate-license", code),
  getOnboarding: () => ipcRenderer.invoke("get-onboarding"),
  deferOnboarding: (deferred) => ipcRenderer.invoke("defer-onboarding", deferred),
  startQqOnboarding: () => ipcRenderer.invoke("start-qq-onboarding"),
  onOnboardingChanged: (callback) => {
    const listener = () => callback(); ipcRenderer.on("onboarding-changed", listener);
    return () => ipcRenderer.removeListener("onboarding-changed", listener);
  },
  getStatus: () => ipcRenderer.invoke("get-status"),
  onStatusChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("status-changed", listener);
    return () => ipcRenderer.removeListener("status-changed", listener);
  },
  getPorts: () => ipcRenderer.invoke("get-ports"),
  setQqEnabled: (enabled, confirmed) => ipcRenderer.invoke("set-qq-enabled", enabled, confirmed),
  getChat: () => ipcRenderer.invoke("chat-get"),
  getModel: () => ipcRenderer.invoke("model-get"),
  saveModel: (args) => ipcRenderer.invoke("model-save", args),
  testModel: (args) => ipcRenderer.invoke("model-test", args),
  onModelChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("model-changed", listener);
    return () => ipcRenderer.removeListener("model-changed", listener);
  },
  getWorkspace: () => ipcRenderer.invoke("workspace-get"),
  chooseWorkspace: () => ipcRenderer.invoke("workspace-choose"),
  resetWorkspace: () => ipcRenderer.invoke("workspace-reset"),
  onWorkspaceChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("workspace-changed", listener);
    return () => ipcRenderer.removeListener("workspace-changed", listener);
  },
  markRemindersShown: (ids) => ipcRenderer.invoke("reminders-shown", ids),
  onRemindersChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("reminders-changed", listener);
    return () => ipcRenderer.removeListener("reminders-changed", listener);
  },
  newChat: () => ipcRenderer.invoke("chat-new"),
  sendChat: (text) => ipcRenderer.invoke("chat-send", text),
  cancelChat: () => ipcRenderer.invoke("chat-cancel"),
  copyText: (text) => ipcRenderer.invoke("copy-text", text),
  memoryList: (scope, offset) => ipcRenderer.invoke("memory-list", scope, offset),
  forgetMemory: (scope, id, confirmed) => ipcRenderer.invoke("memory-forget", scope, id, confirmed),
  clearMemory: (scope, total, confirmed) => ipcRenderer.invoke("memory-clear", scope, total, confirmed),
  exportMemory: () => ipcRenderer.invoke("memory-export"),
  getPublicProfile: () => ipcRenderer.invoke("public-profile-get"),
  savePublicProfile: (text) => ipcRenderer.invoke("public-profile-save", text),
  onMemoryChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("memory-changed", listener);
    return () => ipcRenderer.removeListener("memory-changed", listener);
  },
  answerApproval: (id, outcome) => ipcRenderer.invoke("approval-answer", id, outcome),
  onChatChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("chat-changed", listener);
    return () => ipcRenderer.removeListener("chat-changed", listener);
  },
  getServiceState: () => ipcRenderer.invoke("get-service-state"),
  restartServices: () => ipcRenderer.invoke("restart-services"),
  getOwners: () => ipcRenderer.invoke("owners-get"),
  startPairing: () => ipcRenderer.invoke("pairing-start"),
  cancelPairing: (pairingId) => ipcRenderer.invoke("pairing-cancel", pairingId),
  removeOwner: (channel, account, confirmed) => ipcRenderer.invoke("owner-remove", channel, account, confirmed),
  onIdentityEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("identity-event", listener);
    return () => ipcRenderer.removeListener("identity-event", listener);
  },
  saveApiKey: (key) => ipcRenderer.invoke("save-api-key", key),
  isRiskAccepted: () => ipcRenderer.invoke("is-risk-accepted"),
  acceptRisk: () => ipcRenderer.invoke("accept-risk"),
  getLoginSession: () => ipcRenderer.invoke("get-login-session"),
  pollLoginStatus: () => ipcRenderer.invoke("poll-login-status"),
  refreshLoginQr: () => ipcRenderer.invoke("refresh-login-qr"),
  getAbout: () => ipcRenderer.invoke("get-about"),
  getOutboundPaused: () => ipcRenderer.invoke("get-outbound-paused"),
  setOutboundPaused: (paused) => ipcRenderer.invoke("set-outbound-paused", paused),
  getPersona: () => ipcRenderer.invoke("get-persona"),
  savePersona: (text) => ipcRenderer.invoke("save-persona", text),
  personaList: () => ipcRenderer.invoke("persona-list"),
  personaGet: (id) => ipcRenderer.invoke("persona-get", id),
  personaCreate: (payload) => ipcRenderer.invoke("persona-create", payload),
  personaUpdate: (id, payload) => ipcRenderer.invoke("persona-update", id, payload),
  personaDelete: (id, confirmed) => ipcRenderer.invoke("persona-delete", id, confirmed),
  personaApply: (id) => ipcRenderer.invoke("persona-apply", id),
  personaImportText: (text) => ipcRenderer.invoke("persona-import-text", text),
  getAutostart: () => ipcRenderer.invoke("get-autostart"),
  setAutostart: (enabled) => ipcRenderer.invoke("set-autostart", enabled),
  openDataFolder: () => ipcRenderer.invoke("open-data-folder"),
  exportSettings: () => ipcRenderer.invoke("export-settings"),
  getDataClearPlan: (options) => ipcRenderer.invoke("get-data-clear-plan", options),
  clearLocalData: (options) => ipcRenderer.invoke("clear-local-data", options),
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximizeToggle: () => ipcRenderer.invoke("window-maximize-toggle"),
  windowClose: () => ipcRenderer.invoke("window-close"),
});
