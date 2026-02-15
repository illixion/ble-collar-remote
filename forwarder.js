/**
 * BLE Collar Forwarder Node
 *
 * Headless bridge that connects to the central server via WebSocket and
 * relays commands to the BLE collar device. Managed by the server's node pool.
 *
 * Usage: node forwarder.js [config-path]
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const { Logger } = require('./lib/logger');
const { BleDevice } = require('./lib/ble-device');
const {
  MSG_AUTH,
  MSG_AUTH_RESULT,
  MSG_STATUS,
  MSG_SCAN_RESULT,
  MSG_BATTERY,
  MSG_RSSI,
  MSG_COMMAND,
  MSG_COMMAND_RESULT,
  MSG_GET_BATTERY,
  MSG_GET_RSSI,
  MSG_SCAN,
  MSG_CONNECT,
  MSG_DISCONNECT_BLE,
  parseMessage,
  formatMessage,
} = require('./lib/node-protocol');

// Load configuration
const configPath = process.argv[2] || path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error(`Configuration file not found: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (!config.node?.serverUrl) {
  console.error('Missing required config: node.serverUrl');
  process.exit(1);
}

// Initialize logger
const logger = new Logger({ level: config.logging?.level || 'info' });
const mainLogger = logger.child('forwarder');

// Initialize BLE device
const bleDevice = new BleDevice({
  macAddress: config.device?.macAddress,
  addressType: config.device?.addressType,
  hciInterface: config.ble?.hciInterface,
  reconnectDelay: config.ble?.reconnectDelay,
  deviceNamePatterns: config.ble?.deviceNamePatterns,
  scanDuration: config.ble?.scanDuration,
}, logger);

// WebSocket connection state
let ws = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let statusInterval = null;

/**
 * Send a message to the server.
 */
function send(type, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(formatMessage(type, payload));
  }
}

/**
 * Send current status to the server.
 */
function sendStatus() {
  send(MSG_STATUS, {
    bleConnected: bleDevice.isConnected(),
    battery: bleDevice.getBatteryLevel(),
  });
}

/**
 * Connect to the central server via WebSocket.
 */
function connectToServer() {
  const url = config.node.serverUrl;
  mainLogger.info(`Connecting to server at ${url}`);

  ws = new WebSocket(url);

  ws.on('open', () => {
    mainLogger.info('Connected to server, authenticating...');
    reconnectDelay = 1000; // Reset backoff

    // Authenticate
    send(MSG_AUTH, {
      token: config.node.token || '',
      nodeId: config.node.id || `node-${require('os').hostname()}`,
    });
  });

  ws.on('message', (raw) => {
    const msg = parseMessage(raw.toString());
    if (!msg) return;

    switch (msg.type) {
      case MSG_AUTH_RESULT:
        if (msg.success) {
          mainLogger.info('Authenticated successfully');
          // Start periodic status updates
          if (statusInterval) clearInterval(statusInterval);
          statusInterval = setInterval(sendStatus, 10000);
          sendStatus();
        } else {
          mainLogger.error('Authentication failed');
          ws.close();
        }
        break;

      case MSG_COMMAND:
        handleCommand(msg);
        break;

      case MSG_GET_BATTERY:
        bleDevice.requestBattery();
        // Battery result arrives via event, send current known value immediately
        setTimeout(() => {
          send(MSG_BATTERY, { level: bleDevice.getBatteryLevel() });
        }, 1000);
        break;

      case MSG_GET_RSSI:
        handleGetRssi();
        break;

      case MSG_SCAN:
        handleScan(msg.duration);
        break;

      case MSG_CONNECT:
        handleConnect();
        break;

      case MSG_DISCONNECT_BLE:
        handleDisconnect();
        break;
    }
  });

  ws.on('close', () => {
    mainLogger.warn('Disconnected from server');
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    mainLogger.error('WebSocket error', { error: err.message });
  });
}

/**
 * Schedule a reconnection with exponential backoff.
 */
function scheduleReconnect() {
  mainLogger.info(`Reconnecting in ${reconnectDelay / 1000}s...`);
  setTimeout(connectToServer, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

/**
 * Handle a command from the server.
 */
async function handleCommand(msg) {
  const data = Buffer.from(msg.data, 'hex');
  const success = await bleDevice.write(data);
  send(MSG_COMMAND_RESULT, { id: msg.id, success });
}

/**
 * Handle an RSSI request from the server.
 */
async function handleGetRssi() {
  const rssi = await bleDevice.getRssi();
  if (rssi !== null) {
    send(MSG_RSSI, { value: rssi });
  }
}

/**
 * Handle a scan request from the server (for handoff election).
 */
async function handleScan(duration) {
  mainLogger.info(`Scanning for ${(duration || 10000) / 1000}s (handoff)...`);
  try {
    const devices = await bleDevice.scan(duration);
    send(MSG_SCAN_RESULT, { devices });
  } catch (err) {
    mainLogger.error('Scan failed', { error: err.message });
    send(MSG_SCAN_RESULT, { devices: [] });
  }
}

/**
 * Handle a connect request from the server (handoff: we won the election).
 */
async function handleConnect() {
  mainLogger.info('Server requested BLE connect');
  try {
    await bleDevice.connect();
  } catch (err) {
    mainLogger.error('BLE connect failed', { error: err.message });
  }
}

/**
 * Handle a disconnect request from the server.
 */
async function handleDisconnect() {
  mainLogger.info('Server requested BLE disconnect');
  await bleDevice.disconnect();
  sendStatus();
}

// Forward BLE events to server
bleDevice.on('connected', () => {
  mainLogger.info('BLE device connected');
  sendStatus();
});

bleDevice.on('disconnected', () => {
  mainLogger.warn('BLE device disconnected');
  sendStatus();
});

bleDevice.on('battery', (level) => {
  send(MSG_BATTERY, { level });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  mainLogger.info('Shutting down...');
  if (statusInterval) clearInterval(statusInterval);
  if (ws) ws.close();
  await bleDevice.destroy();
  process.exit();
});

// Start
mainLogger.info(`Forwarder node: ${config.node.id || 'auto'}`);
connectToServer();
