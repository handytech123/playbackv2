const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("playbackShell", {
  selectWavFile: () => ipcRenderer.invoke("dialog:select-wav-file"),
  selectFolder: () => ipcRenderer.invoke("dialog:select-folder"),
  configureRemoteAccess: () => ipcRenderer.invoke("remote:configure-firewall")
});
