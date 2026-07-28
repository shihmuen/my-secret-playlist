const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mp", {
  onNowPlaying: (cb) => ipcRenderer.on("now-playing", (_e, data) => cb(data)),
  onGlass: (cb) => ipcRenderer.on("glass", (_e, data) => cb(data)),
  control: (cmd) => ipcRenderer.send("control", cmd),
});
