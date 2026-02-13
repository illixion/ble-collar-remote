const fs = require('fs');
const path = require('path');
const { withBindings } = require('@stoprocent/noble');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const bodyParser = require('body-parser');

const { Logger } = require('./lib/logger');
const { BLE_UUIDS_NOBLE, PROTOCOL, LIMITS } = require('./lib/constants');
const { scanForDevices } = require('./lib/scanner');


/**
 * Extract real client IP from request, respecting X-Forwarded-For header.
 * @param {Object} req - Express request object
 * @returns {string} Client IP address
 */
function getClientIp(req) {
  // Check X-Forwarded-For header (set by reverse proxies like Tailscale serve)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // X-Forwarded-For can contain multiple IPs, first one is the original client
    return forwarded.split(',')[0].trim();
  }
  // Fallback to direct connection IP
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

/**
 * Extract real client IP from Socket.io handshake.
 * @param {Object} socket - Socket.io socket object
 * @returns {string} Client IP address
 */
function getSocketClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return socket.handshake.address || 'unknown';
}

// Load configuration
const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONFIG_EXAMPLE_PATH = path.join(__dirname, 'config.example.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Configuration file not found: ${CONFIG_PATH}`);
  console.error(`Please copy ${CONFIG_EXAMPLE_PATH} to ${CONFIG_PATH} and update with your device MAC address.`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// Authentication config - empty string or "none" disables authentication
const rawToken = config.server?.token;
const AUTH_ENABLED = rawToken && rawToken !== 'none' && rawToken.trim() !== '';
const AUTH_TOKEN = AUTH_ENABLED ? rawToken : null;

// Initialize logger
const logger = new Logger({ level: config.logging?.level || 'info' });
const bleLogger = logger.child('ble');
const httpLogger = logger.child('http');
const wsLogger = logger.child('websocket');

// Initialize Express and Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: true });
const port = process.env.PORT || config.server?.port || 3000;

// BLE state
let noble = null;
let blePeripheral = null;
let bleTxChar = null;
let batteryLevel = 100;

// Forwarder client for relay mode
let forwarderSocket = null;
let forwarderConnected = false;
const forwarderLogger = logger.child('forwarder');

/**
 * Initialize the forwarder client connection if configured.
 */
function initForwarder() {
  const forwarderUrl = config.forwarder?.url;
  if (!forwarderUrl) {
    return;
  }

  forwarderLogger.info(`Connecting to forwarder at ${forwarderUrl}`);
  forwarderSocket = ioClient(forwarderUrl, {
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionAttempts: Infinity,
    auth: { token: AUTH_TOKEN },
  });

  forwarderSocket.on('connect', () => {
    forwarderConnected = true;
    forwarderLogger.info('Connected to forwarder');
  });

  forwarderSocket.on('disconnect', () => {
    forwarderConnected = false;
    forwarderLogger.warn('Disconnected from forwarder');
  });

  forwarderSocket.on('connect_error', (err) => {
    forwarderLogger.error('Forwarder connection error', { error: err.message });
  });

  forwarderSocket.on('battery', (level) => {
    batteryLevel = level;
    forwarderLogger.debug(`Battery level from forwarder: ${level}%`);
  });

  forwarderSocket.on('rssi', (rssi) => {
    forwarderLogger.debug(`RSSI from forwarder: ${rssi} dBm`);
  });
}

/**
 * Check if we should use the forwarder for commands.
 */
function shouldUseForwarder() {
  return !bleTxChar && forwarderConnected && forwarderSocket;
}

// Key-value storage for persistent values
const KV_STORAGE_PATH = path.join(__dirname, 'kvStorage.json');

function loadKvStorage() {
  if (!fs.existsSync(KV_STORAGE_PATH)) {
    const initial = {
      pValue: 10,
      pValueDate: new Date().toISOString(),
      sValue: 0,
      sValueDate: new Date().toISOString(),
    };
    fs.writeFileSync(KV_STORAGE_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(KV_STORAGE_PATH, 'utf8'));
}

let kvStorage = loadKvStorage();

function getValue(key) {
  kvStorage = loadKvStorage();
  const today = new Date().getDate();

  if (key === 'pValue') {
    const storedDate = new Date(kvStorage.pValueDate).getDate();
    if (storedDate !== today) {
      kvStorage.pValue = 10;
      kvStorage.pValueDate = new Date().toISOString();
      saveKvStorage();
    }
    return kvStorage.pValue;
  } else if (key === 'sValue') {
    const storedDate = new Date(kvStorage.sValueDate).getDate();
    if (storedDate !== today) {
      kvStorage.sValue = 0;
      kvStorage.sValueDate = new Date().toISOString();
      saveKvStorage();
    }
    return kvStorage.sValue;
  }
  return null;
}

function setValue(key, value) {
  if (key === 'pValue') {
    kvStorage.pValue = Math.min(value, LIMITS.MAX_VALUE);
    kvStorage.pValueDate = new Date().toISOString();
  } else if (key === 'sValue') {
    kvStorage.sValue = value;
    kvStorage.sValueDate = new Date().toISOString();
  }
  saveKvStorage();
}

function saveKvStorage() {
  fs.writeFileSync(KV_STORAGE_PATH, JSON.stringify(kvStorage, null, 2));
}

/**
 * Write data to the BLE device (async), or forward to relay if not connected.
 */
async function bleWriteAsync(data) {
  if (bleTxChar) {
    try {
      await bleTxChar.writeAsync(data, true); // true = without response
    } catch (err) {
      bleLogger.error('Write failed', { error: err.message });
    }
    return true;
  }

  if (shouldUseForwarder()) {
    forwarderLogger.info('Relaying command via forwarder');
    forwarderSocket.emit('rawcommand', data.toString('hex'));
    return true;
  }

  bleLogger.warn('Cannot write: device not connected and no forwarder available');
  return false;
}

/**
 * Fire-and-forget write wrapper preserving sync call pattern.
 */
function bleWrite(data) {
  bleWriteAsync(data);
  return !!bleTxChar || shouldUseForwarder();
}

/**
 * Send a command to the device.
 * @param {Object} commands - { shock: 0-100, vibro: 0-100, sound: 0-100, find: boolean }
 * @param {string} originator - Source of the command for logging
 */
function sendCommand(commands, originator = 'server') {
  // Clamp values to valid range
  for (const key in commands) {
    if (typeof commands[key] !== 'boolean') {
      commands[key] = Math.max(
        LIMITS.MIN_VALUE,
        Math.min(LIMITS.MAX_VALUE, Math.round(commands[key]))
      );
    }
  }

  if (originator !== 'resend') {
    bleLogger.info(`Command from ${originator}`, commands);
  }

  let command;
  if (commands.find) {
    command = Buffer.from([PROTOCOL.FIND_START, PROTOCOL.FIND_TYPE, PROTOCOL.CMD_END]);
  } else {
    const shock = commands.shock || 0;
    const vibro = commands.vibro || 0;
    const sound = commands.sound || 0;
    command = Buffer.from([
      PROTOCOL.CMD_START,
      PROTOCOL.CMD_TYPE,
      shock,
      vibro,
      sound,
      PROTOCOL.CMD_END,
    ]);

    // Send command twice with delay for reliability
    setTimeout(() => bleWrite(command), 300);
  }

  return bleWrite(command);
}

/**
 * Request battery level from the device.
 */
function getBatteryLevel() {
  const command = Buffer.from([
    PROTOCOL.BATTERY_START,
    PROTOCOL.BATTERY_TYPE,
    PROTOCOL.CMD_END,
  ]);
  bleWrite(command);
}

/**
 * Initialize noble with platform-appropriate bindings.
 */
function initNoble() {
  if (process.platform === 'darwin') {
    noble = withBindings('default');
    bleLogger.info('Noble initialized with macOS native bindings');
  } else {
    const hciInterface = config.ble?.hciInterface || 0;
    noble = withBindings('hci', {
      hciDriver: 'native',
      deviceId: hciInterface,
    });
    bleLogger.info(`Noble initialized with HCI bindings (device: hci${hciInterface})`);
  }
}

/**
 * Find a peripheral by name pattern or UART service UUID (for macOS where MAC addresses are unavailable).
 */
async function findPeripheral(namePatterns, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      noble.stopScanningAsync().catch(() => {});
      noble.removeListener('discover', onDiscover);
      reject(new Error(`Device not found within ${timeout / 1000} seconds`));
    }, timeout);

    const onDiscover = (peripheral) => {
      const name = peripheral.advertisement?.localName || '';
      const serviceUuids = peripheral.advertisement?.serviceUuids || [];
      const hasUartService = serviceUuids.includes(BLE_UUIDS_NOBLE.UART_SERVICE);
      const matchesName = namePatterns.length > 0 &&
        namePatterns.some(pattern => name.toLowerCase().includes(pattern.toLowerCase()));

      if (hasUartService || matchesName) {
        clearTimeout(timer);
        noble.stopScanningAsync().catch(() => {});
        noble.removeListener('discover', onDiscover);
        resolve(peripheral);
      }
    };

    noble.on('discover', onDiscover);
    noble.startScanningAsync([], false).catch((err) => {
      clearTimeout(timer);
      noble.removeListener('discover', onDiscover);
      reject(err);
    });
  });
}

/**
 * Connect to the BLE device and set up characteristic handlers.
 */
async function connectToBleDevice(address, addressType) {
  bleLogger.info('Connecting to device', { address, addressType });

  try {
    await noble.waitForPoweredOnAsync();

    // macOS: scan to find device (CoreBluetooth doesn't expose MAC addresses)
    // Linux: connect directly by MAC address
    if (process.platform === 'darwin') {
      const namePatterns = config.ble?.deviceNamePatterns || [];
      bleLogger.info('macOS detected: scanning to find device...');
      blePeripheral = await findPeripheral(namePatterns);
      bleLogger.info(`Found device: ${blePeripheral.advertisement?.localName || blePeripheral.address}`);
      await blePeripheral.connectAsync();
    } else {
      blePeripheral = await noble.connectAsync(address);
    }

    bleLogger.info(`Connected to ${blePeripheral.address}`);

    // Discover UART service and characteristics
    const { characteristics } = await blePeripheral.discoverSomeServicesAndCharacteristicsAsync(
      [BLE_UUIDS_NOBLE.UART_SERVICE],
      [BLE_UUIDS_NOBLE.TX_CHARACTERISTIC, BLE_UUIDS_NOBLE.RX_CHARACTERISTIC]
    );

    for (const char of characteristics) {
      // RX characteristic - subscribe for notifications
      if (char.uuid === BLE_UUIDS_NOBLE.RX_CHARACTERISTIC) {
        await char.subscribeAsync();
        char.on('data', (data, isNotification) => {
          if (!isNotification) return;
          if (
            data[0] === PROTOCOL.CMD_START &&
            data[1] === PROTOCOL.CMD_TYPE &&
            data[PROTOCOL.BATTERY_LEVEL_OFFSET] !== undefined
          ) {
            batteryLevel = data[PROTOCOL.BATTERY_LEVEL_OFFSET];
            bleLogger.info(`Battery level: ${batteryLevel}%`);
          }
        });
      }

      // TX characteristic - save for sending commands
      if (char.uuid === BLE_UUIDS_NOBLE.TX_CHARACTERISTIC) {
        bleTxChar = char;
        bleLogger.info('Device ready for commands');
        getBatteryLevel();
      }
    }

    if (!bleTxChar) {
      bleLogger.error('TX characteristic not found on device');
    }

    // Handle disconnect with auto-reconnect
    blePeripheral.on('disconnect', () => {
      bleLogger.warn('Disconnected from device');
      bleTxChar = null;
      blePeripheral = null;

      const reconnectDelay = config.ble?.reconnectDelay || 5000;
      bleLogger.info(`Reconnecting in ${reconnectDelay / 1000} seconds...`);
      setTimeout(() => {
        connectToBleDevice(address, addressType).catch((err) => {
          bleLogger.error('Reconnection failed', { error: err.message });
        });
      }, reconnectDelay);
    });

  } catch (err) {
    bleLogger.error('Connection failed', { error: err.message });
    const reconnectDelay = config.ble?.reconnectDelay || 5000;
    bleLogger.info(`Retrying connection in ${reconnectDelay / 1000} seconds...`);
    setTimeout(() => {
      connectToBleDevice(address, addressType).catch(() => {});
    }, reconnectDelay);
  }
}

/**
 * Start the application.
 */
async function start() {
  initNoble();

  const { macAddress, addressType } = config.device;

  // Conditionally scan before connecting
  if (config.ble?.scanOnStart !== false) {
    try {
      const namePatterns = config.ble?.deviceNamePatterns || [];
      const devices = await scanForDevices(noble, logger, config.ble?.scanDuration || 10000, namePatterns);
      if (devices.length > 0) {
        bleLogger.info('Compatible devices found during scan:', devices);
      }
    } catch (err) {
      bleLogger.error('Scan failed', { error: err.message });
    }
  } else {
    bleLogger.info('Scan on start disabled, connecting immediately');
  }

  // Connect to configured device
  await connectToBleDevice(macAddress, addressType || 'public');

  // Set up battery check interval
  const batteryInterval = config.ble?.batteryCheckInterval || 30 * 60 * 1000;
  setInterval(getBatteryLevel, batteryInterval);
}

// Socket.io authentication middleware (skipped if auth disabled)
if (AUTH_ENABLED) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token || token !== AUTH_TOKEN) {
      wsLogger.warn('Unauthorized WebSocket connection attempt', { address: getSocketClientIp(socket) });
      return next(new Error('Unauthorized'));
    }
    next();
  });
}

// Socket.io event handlers
io.on('connection', (socket) => {
  const clientIp = getSocketClientIp(socket);
  wsLogger.info(`Client connected`, { address: clientIp });

  socket.on('command', (data) => {
    sendCommand(data, clientIp);
  });

  socket.on('sendandincrease', () => {
    let pValue = getValue('pValue');
    sendCommand({ shock: pValue }, clientIp);
    pValue += 10;
    setValue('pValue', pValue);
  });

  socket.on('getrssi', async () => {
    if (blePeripheral) {
      try {
        const rssi = await blePeripheral.updateRssiAsync();
        socket.emit('rssi', rssi);
      } catch (err) {
        bleLogger.error('Failed to read RSSI', { error: err.message });
      }
    } else if (shouldUseForwarder()) {
      forwarderSocket.emit('getrssi');
      forwarderSocket.once('rssi', (rssi) => socket.emit('rssi', rssi));
    }
  });

  socket.on('getbattery', () => {
    if (bleTxChar) {
      getBatteryLevel();
      setTimeout(() => socket.emit('battery', batteryLevel), 1000);
    } else if (shouldUseForwarder()) {
      forwarderSocket.emit('getbattery');
      forwarderSocket.once('battery', (level) => {
        batteryLevel = level;
        socket.emit('battery', level);
      });
    } else {
      socket.emit('battery', batteryLevel);
    }
  });

  socket.on('shutdown', () => {
    wsLogger.info('Shutdown requested');
    process.exit();
  });

  socket.on('disconnect', () => {
    wsLogger.debug('Client disconnected', { address: clientIp });
  });
});

// HTTP middleware
app.use(bodyParser.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  next();
});

/**
 * Validate authentication token from request.
 * Checks Authorization header (Bearer token) or query parameter.
 * Skips validation if authentication is disabled.
 */
function validateToken(req, res, next) {
  if (!AUTH_ENABLED) {
    return next();
  }

  const authHeader = req.headers.authorization;
  const queryToken = req.query.token;

  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (queryToken) {
    token = queryToken;
  }

  if (!token || token !== AUTH_TOKEN) {
    httpLogger.warn('Unauthorized API request', { ip: getClientIp(req), path: req.path });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

// API routes (all require authentication)
app.get('/api/command', validateToken, (req, res) => {
  sendCommand(req.query, getClientIp(req));
  res.send('OK');
});

app.get('/api/shockandincrease', validateToken, (req, res) => {
  let pValue = getValue('pValue') + 10;
  sendCommand({ shock: pValue }, getClientIp(req));
  setValue('pValue', pValue);
  res.send('OK');
});

app.get('/api/battery', validateToken, (req, res) => {
  res.send(batteryLevel.toString());
});

app.get('/api/pValue', validateToken, (req, res) => {
  res.send(getValue('pValue').toString());
});

app.post('/api/pValue', validateToken, (req, res) => {
  setValue('pValue', parseInt(req.body.value, 10) || 0);
  res.send('OK');
});

app.get('/api/sValue', validateToken, (req, res) => {
  res.send(getValue('sValue').toString());
});

app.post('/api/sValue', validateToken, (req, res) => {
  setValue('sValue', parseInt(req.body.value, 10) || 0);
  res.send('OK');
});

app.get('/api/auth/status', (req, res) => {
  res.json({ enabled: AUTH_ENABLED });
});

app.get('/api/scan', validateToken, (req, res) => {
  if (!noble) {
    res.status(503).json({ error: 'BLE not initialized' });
    return;
  }
  const duration = parseInt(req.query.duration, 10) || 10000;
  const namePatterns = config.ble?.deviceNamePatterns || [];
  scanForDevices(noble, logger, duration, namePatterns);
  res.send('OK');
});

// Serve static files
app.use(express.static('public'));

// Start server
const host = config.server?.host || '0.0.0.0';
server.listen(port, host, () => {
  httpLogger.info(`Server listening on ${host}:${port}`);
  if (!AUTH_ENABLED) {
    httpLogger.warn('Authentication is DISABLED - server is publicly accessible');
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  const cleanup = async () => {
    if (blePeripheral) {
      try { await blePeripheral.disconnectAsync(); } catch (e) { /* ignore */ }
    }
    if (noble) {
      noble.stop();
    }
    process.exit();
  };
  cleanup();
});

// Initialize forwarder connection if configured
initForwarder();

// Start the application
start().catch((err) => {
  logger.error('Failed to start application', { error: err.message });
  process.exit(1);
});
