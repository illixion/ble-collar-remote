const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  getConfig: () => ipcRenderer.invoke('settings:get'),
  saveConfig: (config) => ipcRenderer.invoke('settings:save', config),
  getDevices: () => ipcRenderer.invoke('settings:getDevices'),
  restartServer: () => ipcRenderer.invoke('settings:restart'),
  openConfigDir: () => ipcRenderer.invoke('settings:openConfigDir'),
});
