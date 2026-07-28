const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("playbackShell", {
  selectWavFile: () => ipcRenderer.invoke("dialog:select-wav-file"),
  selectFolder: () => ipcRenderer.invoke("dialog:select-folder"),
  configureRemoteAccess: () => ipcRenderer.invoke("remote:configure-firewall"),
  saveSetPackage: (packagePayload) => ipcRenderer.invoke("set-package:save", packagePayload),
  openSetPackage: () => ipcRenderer.invoke("set-package:open"),
  onMenuCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on("menu:command", listener);
    return () => ipcRenderer.removeListener("menu:command", listener);
  }
});
