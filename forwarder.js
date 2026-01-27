/**
 * BLE Shock Collar Forwarder
 *
 * A simplified version of the server that forwards commands to the BLE device.
 * Useful for relay scenarios when the device is out of range of the main server.
 */

const fs = require('fs');
const path = require('path');
const HciSocket = require('hci-socket');
const NodeBleHost = require('ble-host');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');

const { Logger } = require('./lib/logger');
const { BLE_UUIDS, PROTOCOL, LIMITS } = require('./lib/constants');
const { scanForDevices } = require('./lib/scanner');

const BleManager = NodeBleHost.BleManager;
const HciErrors = NodeBleHost.HciErrors;
const AttErrors = NodeBleHost.AttErrors;

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

// BLE transport and state
let transport;
let bleManager;
let bleDeviceCharacteristic = null;
let bleConn = null;
let batteryLevel = 100;

/**
 * Write data to the BLE device.
 */
function bleWrite(data) {
  if (!bleDeviceCharacteristic) {
    bleLogger.warn('Cannot write: device not connected');
    return false;
  }

  bleLogger.debug('Sending command', { hex: data.toString('hex') });
  bleDeviceCharacteristic.writeWithoutResponse(data, (err) => {
    if (err) {
      bleLogger.error('Write failed', { error: AttErrors.toString(err) });
      return false;
    }
  });
  return true;
}

/**
 * Send a command to the device.
 * @param {Object} commands - { shock: 0-100, vibro: 0-100, sound: 0-100, find: boolean }
 */
function sendCommand(commands) {
  // Clamp values to valid range
  for (const key in commands) {
    if (typeof commands[key] !== 'boolean') {
      const value = Number(commands[key]);
      if (!isNaN(value)) {
        commands[key] = Math.max(LIMITS.MIN_VALUE, Math.min(LIMITS.MAX_VALUE, Math.round(value)));
      } else {
        commands[key] = 0;
      }
    }
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
  }

  bleWrite(command);
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
 * Create and initialize the BLE manager.
 */
function createBleManager(callback) {
  transport = new HciSocket(0);

  BleManager.create(transport, {}, (err, manager) => {
    if (err) {
      bleLogger.error('Failed to create BLE manager', { error: err.message });
      return;
    }

    bleManager = manager;
    bleLogger.info('BLE manager initialized');
    callback(manager);
  });
}

/**
 * Connect to the BLE device and set up characteristic handlers.
 */
function connectToBleDevice(manager, addressType, address, options, callback) {
  bleLogger.info('Connecting to device', { address, addressType });

  manager.connect(addressType, address, options, (conn) => {
    bleLogger.info(`Connected to ${conn.peerAddress}`);
    bleConn = conn;

    conn.gatt.exchangeMtu((err) => {
      if (!err) {
        bleLogger.debug(`MTU exchanged: ${conn.gatt.currentMtu}`);
      }
    });

    conn.gatt.discoverServicesByUuid(BLE_UUIDS.UART_SERVICE, 1, (services) => {
      if (services.length === 0) {
        bleLogger.error('UART service not found on device');
        return;
      }

      const service = services[0];
      service.discoverCharacteristics((characteristics) => {
        characteristics.forEach((characteristic) => {
          // RX characteristic - subscribe for notifications
          if (characteristic.uuid === BLE_UUIDS.RX_CHARACTERISTIC) {
            characteristic.writeCCCD(true, false);
            characteristic.on('change', (value) => {
              if (
                value[0] === PROTOCOL.CMD_START &&
                value[1] === PROTOCOL.CMD_TYPE &&
                value[PROTOCOL.BATTERY_LEVEL_OFFSET] !== undefined
              ) {
                batteryLevel = value[PROTOCOL.BATTERY_LEVEL_OFFSET];
                bleLogger.info(`Battery level: ${batteryLevel}%`);
              }
            });
          }

          // TX characteristic - save for sending commands
          if (characteristic.uuid === BLE_UUIDS.TX_CHARACTERISTIC) {
            bleDeviceCharacteristic = characteristic;
            bleLogger.info('Device ready for commands');
            getBatteryLevel();
          }
        });
      });
    });

    conn.on('disconnect', () => {
      bleLogger.warn('Disconnected from device', { reason: conn.reason });
      bleDeviceCharacteristic = null;

      const reconnectDelay = config.ble?.reconnectDelay || 5000;
      bleLogger.info(`Reconnecting in ${reconnectDelay / 1000} seconds...`);
      setTimeout(() => {
        connectToBleDevice(manager, addressType, address, options, callback);
      }, reconnectDelay);
    });

    callback(conn);
  });
}

/**
 * Start the application.
 */
function start() {
  createBleManager((manager) => {
    const connectToDevice = () => {
      // Connect to configured device
      const { macAddress, addressType } = config.device;
      connectToBleDevice(manager, addressType || 'public', macAddress, {}, (conn) => {
        bleLogger.info(`Connected to ${conn.peerAddress}`);
      });
    };

    // Conditionally scan before connecting
    if (config.ble?.scanOnStart !== false) {
      // Scan for compatible devices before connecting
      const namePatterns = config.ble?.deviceNamePatterns || [];
      scanForDevices(manager, logger, config.ble?.scanDuration || 10000, namePatterns).then(
        (devices) => {
          if (devices.length > 0) {
            bleLogger.info('Compatible devices found during scan:', devices);
          }
          connectToDevice();
        }
      );
    } else {
      bleLogger.info('Scan on start disabled, connecting immediately');
      connectToDevice();
    }
  });
}

// Socket.io authentication middleware (skipped if auth disabled)
if (AUTH_ENABLED) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token || token !== AUTH_TOKEN) {
      wsLogger.warn('Unauthorized WebSocket connection attempt', { address: socket.handshake.address });
      return next(new Error('Unauthorized'));
    }
    next();
  });
}

// Socket.io event handlers
io.on('connection', (socket) => {
  wsLogger.info('Client connected', { address: socket.handshake.address });

  socket.on('command', (data) => {
    sendCommand(data);
  });

  socket.on('rawcommand', (data) => {
    bleWrite(Buffer.from(data, 'hex'));
  });

  socket.on('getrssi', () => {
    if (!bleConn) return;
    bleConn.readRssi((err, rssi) => {
      if (err) {
        bleLogger.error('Failed to read RSSI', { error: HciErrors.toString(err) });
        return;
      }
      socket.emit('rssi', rssi);
    });
  });

  socket.on('getbattery', () => {
    getBatteryLevel();
    setTimeout(() => socket.emit('battery', batteryLevel), 1000);
  });

  socket.on('shutdown', () => {
    wsLogger.info('Shutdown requested');
    process.exit();
  });

  socket.on('disconnect', () => {
    wsLogger.debug('Client disconnected', { address: socket.handshake.address });
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
    httpLogger.warn('Unauthorized API request', { ip: req.ip, path: req.path });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

// API routes (all require authentication)
app.get('/api/command', validateToken, (req, res) => {
  sendCommand(req.query);
  res.send('OK');
});

app.get('/api/battery', validateToken, (req, res) => {
  res.send(batteryLevel.toString());
});

app.get('/api/auth/status', (req, res) => {
  res.json({ enabled: AUTH_ENABLED });
});

app.get('/api/scan', validateToken, (req, res) => {
  if (!bleManager) {
    res.status(503).json({ error: 'BLE manager not initialized' });
    return;
  }
  const duration = parseInt(req.query.duration, 10) || 10000;
  const namePatterns = config.ble?.deviceNamePatterns || [];
  scanForDevices(bleManager, logger, duration, namePatterns);
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
  if (bleConn) {
    bleConn.disconnect();
  }
  process.exit();
});

// Start the application
start();
