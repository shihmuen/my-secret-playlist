const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mp", {
  onNowPlaying: (cb) => ipcRenderer.on("now-playing", (_e, data) => cb(data)),
  control: (cmd) => ipcRenderer.send("control", cmd),
  resizeTo: (w) => ipcRenderer.send("resize-to", w),
  resizeEnd: () => ipcRenderer.send("resize-end"),
});
