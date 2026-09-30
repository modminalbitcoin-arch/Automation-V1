"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("automationAPI", {
  start: () => ipcRenderer.invoke("start-automation"),
  onLog: (cb) => ipcRenderer.on("log", (_e, data) => cb(data)),
  onStatus: (cb) => ipcRenderer.on("status", (_e, data) => cb(data))
});
