const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { fork } = require('child_process');

// Paths
const appRoot = path.join(__dirname, '..');
const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'config.json');
const kvStoragePath = path.join(userDataPath, 'kvStorage.json');
const configExamplePath = path.join(appRoot, 'config.example.json');

let mainWindow = null;
let settingsWindow = null;
let serverProcess = null;
let serverPort = 3000;

/**
 * Ensure a config.json exists in user data directory.
 * Copies from config.example.json with safe defaults for desktop use.
 */
function ensureConfig() {
  if (!fs.existsSync(configPath)) {
    const defaultConfig = JSON.parse(fs.readFileSync(configExamplePath, 'utf8'));
    // Safe defaults for desktop app
    defaultConfig.server.host = '127.0.0.1';
    defaultConfig.server.token = '';
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

/**
 * Read the current config.
 */
function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

/**
 * Write updated config.
 */
function writeConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Get available device modules from the devices/ directory.
 */
function getAvailableDevices() {
  const devicesDir = path.join(appRoot, 'devices');
  return fs.readdirSync(devicesDir)
    .filter(f => f.endsWith('.js'))
    .map(f => {
      const mod = require(path.join(devicesDir, f));
      return { value: mod.name, label: mod.displayName || mod.name };
    });
}

/**
 * Poll a URL until it responds (or timeout).
 * @returns {Promise<boolean>} true if server responded, false on timeout
 */
function waitForServer(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve) => {
    function check() {
      if (Date.now() - start > timeoutMs) {
        return resolve(false);
      }
      const req = http.get(`http://127.0.0.1:${port}/api/auth/status`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        setTimeout(check, 300);
      });
      req.setTimeout(1000, () => {
        req.destroy();
        setTimeout(check, 300);
      });
    }
    check();
  });
}

/**
 * Start the embedded server as a child process.
 */
function startServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }

  const config = readConfig();
  serverPort = config.server?.port || 3000;

  serverProcess = fork(path.join(appRoot, 'server.js'), [], {
    env: {
      ...process.env,
      CONFIG_PATH: configPath,
      KV_STORAGE_PATH: kvStoragePath,
      ELECTRON: '1',
    },
    silent: true,
  });

  serverProcess.stdout.on('data', (data) => {
    process.stdout.write(`[server] ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
    process.stderr.write(`[server] ${data}`);
  });

  serverProcess.on('exit', (code) => {
    console.log(`Server process exited with code ${code}`);
    serverProcess = null;
  });
}

/**
 * Restart the server (after settings change).
 */
async function restartServer() {
  startServer();
  const config = readConfig();
  serverPort = config.server?.port || 3000;
  await waitForServer(serverPort);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 700,
    title: 'BLE Collar Remote',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 600,
    height: 700,
    title: 'Settings',
    parent: mainWindow,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => createSettingsWindow(),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'BLE Scanner',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.loadURL(`http://127.0.0.1:${serverPort}/scan.html`);
            }
          },
        },
        {
          label: 'Controller',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
            }
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// IPC handlers for settings
ipcMain.handle('settings:get', () => {
  return readConfig();
});

ipcMain.handle('settings:save', (_event, config) => {
  writeConfig(config);
  return true;
});

ipcMain.handle('settings:getDevices', () => {
  return getAvailableDevices();
});

ipcMain.handle('settings:restart', async () => {
  await restartServer();
  return true;
});

ipcMain.handle('settings:openConfigDir', () => {
  require('electron').shell.openPath(userDataPath);
});

// App lifecycle
app.whenReady().then(async () => {
  ensureConfig();
  buildMenu();
  createMainWindow();

  startServer();
  const ready = await waitForServer(serverPort);

  if (ready) {
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  } else {
    // Server didn't start in time — show settings so the user can fix config
    mainWindow.loadFile(path.join(__dirname, 'server-error.html'));
    mainWindow.show();
  }
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
  app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
});
