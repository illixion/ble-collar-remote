const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebSocketServer } = require('ws');
const bodyParser = require('body-parser');

const { Logger } = require('./lib/logger');
const { PROTOCOL, LIMITS } = require('./lib/constants');
const { BleDevice } = require('./lib/ble-device');
const { NodePool } = require('./lib/node-pool');
const { MSG_AUTH, MSG_AUTH_RESULT, parseMessage, formatMessage } = require('./lib/node-protocol');


/**
 * Extract real client IP from request, respecting X-Forwarded-For header.
 * @param {Object} req - Express request object
 * @returns {string} Client IP address
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
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
const nodeLogger = logger.child('nodes');

// Initialize Express and Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: true });
const port = process.env.PORT || config.server?.port || 3000;

// Node pool for forwarder connections
const nodesEnabled = config.nodes?.enabled !== false;
const nodePool = new NodePool(config.nodes || {}, logger);

// Local BLE device (used as fallback when no forwarder nodes are available)
const bleDevice = new BleDevice({
  macAddress: config.device.macAddress,
  addressType: config.device.addressType,
  hciInterface: config.ble?.hciInterface,
  reconnectDelay: config.ble?.reconnectDelay,
  deviceNamePatterns: config.ble?.deviceNamePatterns,
  scanDuration: config.ble?.scanDuration,
  batteryCheckInterval: config.ble?.batteryCheckInterval,
}, logger);

let batteryLevel = 100;

// Forward BLE device events
bleDevice.on('battery', (level) => {
  batteryLevel = level;
});

bleDevice.on('disconnected', () => {
  // If nodes are enabled, trigger handoff to remote nodes
  if (nodesEnabled && nodePool.hasNodes()) {
    nodeLogger.info('Local BLE disconnected, triggering node pool handoff');
    nodePool.triggerHandoff();
  }
});

// Forward node pool battery events
nodePool.on('battery', (level) => {
  batteryLevel = level;
});

/**
 * Build the node pool status payload for browser clients.
 */
function getNodesPayload() {
  return {
    enabled: nodesEnabled,
    nodes: nodePool.getNodes(),
    activeNodeId: nodePool.getActiveNode()?.nodeId || null,
    localBleConnected: bleDevice.isConnected(),
  };
}

/**
 * Broadcast node pool state to all connected browser clients.
 */
function broadcastNodes() {
  io.emit('nodes', getNodesPayload());
}

// Broadcast on node pool and local BLE state changes
nodePool.on('node:connected', broadcastNodes);
nodePool.on('node:disconnected', broadcastNodes);
nodePool.on('active:changed', broadcastNodes);
nodePool.on('no:active', broadcastNodes);
bleDevice.on('connected', broadcastNodes);
bleDevice.on('disconnected', broadcastNodes);

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
 * Write data to the BLE device or route via node pool.
 * Tries local BLE first, then falls back to the node pool.
 */
async function bleWriteAsync(data) {
  // Try local BLE first
  if (bleDevice.isConnected()) {
    return bleDevice.write(data);
  }

  // Fall back to node pool
  if (nodePool.getActiveNode()) {
    return nodePool.sendCommand(data);
  }

  bleLogger.warn('Cannot write: no local BLE and no active forwarder node');
  return false;
}

/**
 * Fire-and-forget write wrapper.
 */
function bleWrite(data) {
  bleWriteAsync(data);
  return bleDevice.isConnected() || !!nodePool.getActiveNode();
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

// WebSocket server for forwarder nodes (raw WebSocket, not Socket.io)
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  let authenticated = false;
  let nodeId = null;

  // Require auth within 5 seconds
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      nodeLogger.warn('Node connection timed out waiting for auth');
      ws.close();
    }
  }, 5000);

  ws.on('message', (raw) => {
    const msg = parseMessage(raw.toString());
    if (!msg) return;

    // First message must be auth
    if (!authenticated) {
      if (msg.type !== MSG_AUTH) {
        ws.send(formatMessage(MSG_AUTH_RESULT, { success: false }));
        ws.close();
        return;
      }

      // Validate token
      if (AUTH_ENABLED && msg.token !== AUTH_TOKEN) {
        nodeLogger.warn('Node auth failed', { nodeId: msg.nodeId });
        ws.send(formatMessage(MSG_AUTH_RESULT, { success: false }));
        ws.close();
        return;
      }

      authenticated = true;
      nodeId = msg.nodeId || `node-${Date.now()}`;
      clearTimeout(authTimeout);

      ws.send(formatMessage(MSG_AUTH_RESULT, { success: true }));
      nodeLogger.info(`Node ${nodeId} authenticated`);

      // Add to pool (pool handles all subsequent messages)
      nodePool.addNode(ws, nodeId);
      return;
    }
    // After auth, messages are handled by NodePool via its own ws.on('message')
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
  });
});

// Handle HTTP upgrade requests - route /ws/node to raw WebSocket, let Socket.io handle the rest
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/ws/node') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
  // Socket.io handles its own upgrade on the default path
});

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

// Socket.io event handlers (browser clients)
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
    // Try local BLE first
    if (bleDevice.isConnected()) {
      const rssi = await bleDevice.getRssi();
      if (rssi !== null) socket.emit('rssi', rssi);
      return;
    }

    // Fall back to node pool
    if (nodePool.getActiveNode()) {
      const rssi = await nodePool.requestRssi();
      if (rssi !== null) socket.emit('rssi', rssi);
    }
  });

  socket.on('getnodes', () => {
    socket.emit('nodes', getNodesPayload());
  });

  socket.on('getbattery', async () => {
    // Try local BLE first
    if (bleDevice.isConnected()) {
      bleDevice.requestBattery();
      setTimeout(() => socket.emit('battery', bleDevice.getBatteryLevel()), 1000);
      return;
    }

    // Fall back to node pool
    if (nodePool.getActiveNode()) {
      const level = await nodePool.requestBattery();
      if (level !== null) {
        batteryLevel = level;
        socket.emit('battery', level);
      } else {
        socket.emit('battery', batteryLevel);
      }
      return;
    }

    socket.emit('battery', batteryLevel);
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

app.get('/api/scan', validateToken, async (req, res) => {
  const duration = parseInt(req.query.duration, 10) || 10000;
  try {
    const devices = await bleDevice.scan(duration);
    res.json(devices);
  } catch (err) {
    res.status(503).json({ error: 'BLE scan failed', message: err.message });
  }
});

// Node pool status endpoint
app.get('/api/nodes', validateToken, (req, res) => {
  res.json({
    nodes: nodePool.getNodes(),
    activeNodeId: nodePool.getActiveNode()?.nodeId || null,
    localBleConnected: bleDevice.isConnected(),
  });
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
  if (nodesEnabled) {
    nodeLogger.info('Forwarder node support enabled on /ws/node');
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  const cleanup = async () => {
    nodePool.destroy();
    await bleDevice.destroy();
    process.exit();
  };
  cleanup();
});

/**
 * Start the application.
 * Connects local BLE automatically. If forwarder nodes are enabled,
 * they can take over when they connect and have better proximity.
 */
async function start() {
  // Always try to connect local BLE (acts as fallback)
  if (config.ble?.scanOnStart !== false) {
    try {
      const devices = await bleDevice.scan();
      if (devices.length > 0) {
        bleLogger.info('Compatible devices found during scan:', devices);
      }
    } catch (err) {
      bleLogger.error('Scan failed', { error: err.message });
    }
  } else {
    bleLogger.info('Scan on start disabled, connecting immediately');
  }

  await bleDevice.connect();
}

start().catch((err) => {
  logger.error('Failed to start application', { error: err.message });
  process.exit(1);
});
