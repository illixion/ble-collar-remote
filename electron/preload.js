const { contextBridge } = require('electron');

// Minimal preload for the main window - just marks it as running in Electron
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
});
