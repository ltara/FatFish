"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fatfish", {
  getStatus: () => ipcRenderer.invoke("get-status"),
  getPorts: () => ipcRenderer.invoke("get-ports"),
  getServiceState: () => ipcRenderer.invoke("get-service-state"),
  restartServices: () => ipcRenderer.invoke("restart-services"),
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
  getAgentEngine: () => ipcRenderer.invoke("get-agent-engine"),
  setAgentEngineEnabled: (enabled) => ipcRenderer.invoke("set-agent-engine-enabled", enabled),
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximizeToggle: () => ipcRenderer.invoke("window-maximize-toggle"),
  windowClose: () => ipcRenderer.invoke("window-close"),
});
