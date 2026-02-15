/**
 * Node pool manager for forwarder connections.
 *
 * Manages a pool of forwarder nodes connected via WebSocket. Only one node
 * holds the BLE connection at any time. Implements scan-based handoff when
 * the active node loses its BLE connection.
 */

const { EventEmitter } = require('events');
const {
  MSG_STATUS,
  MSG_SCAN_RESULT,
  MSG_BATTERY,
  MSG_RSSI,
  MSG_COMMAND_RESULT,
  MSG_COMMAND,
  MSG_GET_BATTERY,
  MSG_GET_RSSI,
  MSG_SCAN,
  MSG_CONNECT,
  MSG_DISCONNECT_BLE,
  parseMessage,
  formatMessage,
} = require('./node-protocol');

class NodePool extends EventEmitter {
  /**
   * @param {Object} config
   * @param {number} [config.pingInterval=30000] - Ping interval in ms
   * @param {number} [config.staleTimeout=60000] - Stale node timeout in ms
   * @param {number} [config.scanDuration=10000] - Handoff scan duration in ms
   * @param {number} [config.handoffTimeout=30000] - Handoff retry timeout in ms
   * @param {Object} logger - Logger instance
   */
  constructor(config, logger) {
    super();

    this._config = {
      pingInterval: config?.pingInterval || 30000,
      staleTimeout: config?.staleTimeout || 60000,
      scanDuration: config?.scanDuration || 10000,
      handoffTimeout: config?.handoffTimeout || 30000,
    };

    this._logger = logger;
    this._poolLogger = logger.child('node-pool');
    this._nodes = new Map(); // nodeId -> NodeEntry
    this._activeNodeId = null;
    this._handoffInProgress = false;
    this._handoffTimer = null;
    this._pendingScanResults = null;
    this._commandCounter = 0;
    this._pendingCommands = new Map(); // id -> { resolve, reject, timer }
  }

  /**
   * Add a new authenticated node to the pool.
   * @param {WebSocket} ws - WebSocket connection
   * @param {string} nodeId - Unique node identifier
   * @returns {Object} NodeEntry
   */
  addNode(ws, nodeId) {
    // Remove existing node with same ID if reconnecting
    if (this._nodes.has(nodeId)) {
      this._poolLogger.info(`Node ${nodeId} reconnecting, removing old entry`);
      this.removeNode(nodeId);
    }

    const entry = {
      nodeId,
      ws,
      bleConnected: false,
      lastBattery: null,
      lastSeen: Date.now(),
      isActive: false,
      pingTimer: null,
      pongReceived: true,
    };

    // Set up ping/pong
    entry.pingTimer = setInterval(() => {
      if (!entry.pongReceived) {
        this._poolLogger.warn(`Node ${nodeId} stale (no pong), removing`);
        this.removeNode(nodeId);
        return;
      }
      entry.pongReceived = false;
      try {
        ws.ping();
      } catch {
        this.removeNode(nodeId);
      }
    }, this._config.pingInterval);

    ws.on('pong', () => {
      entry.pongReceived = true;
      entry.lastSeen = Date.now();
    });

    // Handle incoming messages
    ws.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg) return;
      this._handleNodeMessage(nodeId, msg);
    });

    ws.on('close', () => {
      this._poolLogger.info(`Node ${nodeId} WebSocket closed`);
      this.removeNode(nodeId);
    });

    ws.on('error', (err) => {
      this._poolLogger.error(`Node ${nodeId} WebSocket error`, { error: err.message });
      this.removeNode(nodeId);
    });

    this._nodes.set(nodeId, entry);
    this._poolLogger.info(`Node ${nodeId} added to pool (${this._nodes.size} total)`);
    this.emit('node:connected', nodeId);

    return entry;
  }

  /**
   * Remove a node from the pool.
   * @param {string} nodeId
   */
  removeNode(nodeId) {
    const entry = this._nodes.get(nodeId);
    if (!entry) return;

    if (entry.pingTimer) clearInterval(entry.pingTimer);

    try {
      entry.ws.close();
    } catch {
      // ignore close errors
    }

    const wasActive = entry.isActive;
    this._nodes.delete(nodeId);

    if (wasActive) {
      this._activeNodeId = null;
      this._poolLogger.warn(`Active node ${nodeId} removed, triggering handoff`);
      this.triggerHandoff();
    }

    this._poolLogger.info(`Node ${nodeId} removed from pool (${this._nodes.size} total)`);
    this.emit('node:disconnected', nodeId);
  }

  /**
   * Handle a parsed message from a node.
   * @param {string} nodeId
   * @param {Object} msg - Parsed message
   */
  _handleNodeMessage(nodeId, msg) {
    const entry = this._nodes.get(nodeId);
    if (!entry) return;

    entry.lastSeen = Date.now();

    switch (msg.type) {
      case MSG_STATUS: {
        const wasConnected = entry.bleConnected;
        entry.bleConnected = !!msg.bleConnected;
        if (msg.battery !== undefined) entry.lastBattery = msg.battery;

        // Node just connected to BLE
        if (!wasConnected && entry.bleConnected) {
          this._poolLogger.info(`Node ${nodeId} connected to BLE device`);
          this._tryPromoteNode(nodeId);
        }

        // Active node lost BLE connection
        if (wasConnected && !entry.bleConnected && entry.isActive) {
          this._poolLogger.warn(`Active node ${nodeId} lost BLE connection`);
          entry.isActive = false;
          this._activeNodeId = null;
          this.triggerHandoff();
        }
        break;
      }

      case MSG_SCAN_RESULT: {
        if (this._pendingScanResults) {
          this._pendingScanResults.set(nodeId, msg.devices || []);
        }
        break;
      }

      case MSG_BATTERY: {
        entry.lastBattery = msg.level;
        if (entry.isActive) {
          this.emit('battery', msg.level);
        }
        break;
      }

      case MSG_RSSI: {
        if (entry.isActive) {
          this.emit('rssi', msg.value);
        }
        break;
      }

      case MSG_COMMAND_RESULT: {
        const pending = this._pendingCommands.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this._pendingCommands.delete(msg.id);
          pending.resolve(msg.success);
        }
        break;
      }
    }
  }

  /**
   * Attempt to promote a node to active status.
   * Only succeeds if no other node is currently active.
   * @param {string} nodeId
   */
  _tryPromoteNode(nodeId) {
    const entry = this._nodes.get(nodeId);
    if (!entry || !entry.bleConnected) return;

    // If no active node, promote this one
    if (!this._activeNodeId) {
      entry.isActive = true;
      this._activeNodeId = nodeId;
      this._handoffInProgress = false;
      if (this._handoffTimer) {
        clearTimeout(this._handoffTimer);
        this._handoffTimer = null;
      }
      this._poolLogger.info(`Node ${nodeId} promoted to active`);
      this.emit('active:changed', nodeId);
      return;
    }

    // Another node is already active - tell this one to disconnect BLE
    // (collar only supports one connection)
    if (this._activeNodeId !== nodeId) {
      this._poolLogger.info(`Node ${nodeId} has BLE but ${this._activeNodeId} is active, disconnecting`);
      this._sendToNode(nodeId, MSG_DISCONNECT_BLE);
    }
  }

  /**
   * Trigger the handoff process when the active node loses BLE.
   *
   * Flow:
   * 1. Send scan to ALL nodes
   * 2. Wait for scan_result from all (with timeout)
   * 3. Pick node with best (strongest) RSSI
   * 4. Send connect to elected node
   * 5. Wait for status { bleConnected: true }
   */
  triggerHandoff() {
    if (this._handoffInProgress) return;
    if (this._nodes.size === 0) {
      this._poolLogger.warn('No nodes available for handoff');
      this.emit('no:active');
      return;
    }

    this._handoffInProgress = true;
    this._pendingScanResults = new Map();

    this._poolLogger.info(`Starting handoff scan (${this._config.scanDuration / 1000}s) on ${this._nodes.size} node(s)`);

    // Send scan command to all nodes
    for (const [nodeId] of this._nodes) {
      this._sendToNode(nodeId, MSG_SCAN, { duration: this._config.scanDuration });
    }

    // Wait for scan results to arrive, then elect
    const scanWaitTime = this._config.scanDuration + 3000; // extra 3s for network latency
    setTimeout(() => this._electNode(), scanWaitTime);

    // Set handoff retry timer
    this._handoffTimer = setTimeout(() => {
      if (!this._activeNodeId && this._nodes.size > 0) {
        this._poolLogger.warn('Handoff timeout, retrying');
        this._handoffInProgress = false;
        this.triggerHandoff();
      }
    }, this._config.handoffTimeout + scanWaitTime);
  }

  /**
   * Elect the best node based on scan results and instruct it to connect.
   */
  _electNode() {
    if (!this._pendingScanResults) return;

    let bestNodeId = null;
    let bestRssi = -Infinity;

    for (const [nodeId, devices] of this._pendingScanResults) {
      if (!this._nodes.has(nodeId)) continue; // node disconnected during scan

      // Find the best RSSI among discovered devices for this node
      for (const device of devices) {
        const rssi = device.rssi;
        if (typeof rssi === 'number' && rssi > bestRssi) {
          bestRssi = rssi;
          bestNodeId = nodeId;
        }
      }
    }

    this._pendingScanResults = null;

    if (!bestNodeId) {
      this._poolLogger.warn('No node found the device during scan');
      // Handoff retry timer will trigger another attempt
      return;
    }

    this._poolLogger.info(`Elected node ${bestNodeId} (RSSI: ${bestRssi} dBm), sending connect`);
    this._sendToNode(bestNodeId, MSG_CONNECT);
    // Node will report status { bleConnected: true } which triggers _tryPromoteNode
  }

  /**
   * Get the currently active node.
   * @returns {Object|null} NodeEntry or null
   */
  getActiveNode() {
    if (!this._activeNodeId) return null;
    return this._nodes.get(this._activeNodeId) || null;
  }

  /**
   * Get all nodes with their status.
   * @returns {Array<Object>}
   */
  getNodes() {
    return Array.from(this._nodes.values()).map(entry => ({
      nodeId: entry.nodeId,
      bleConnected: entry.bleConnected,
      lastBattery: entry.lastBattery,
      lastSeen: entry.lastSeen,
      isActive: entry.isActive,
    }));
  }

  /**
   * Send a BLE command via the active node.
   * @param {Buffer} data - Raw command data
   * @returns {Promise<boolean>} True if command was sent successfully
   */
  async sendCommand(data) {
    const active = this.getActiveNode();
    if (!active) {
      this._poolLogger.warn('Cannot send command: no active node');
      return false;
    }

    const id = ++this._commandCounter;
    const hex = data.toString('hex');

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pendingCommands.delete(id);
        this._poolLogger.warn(`Command ${id} timed out`);
        resolve(false);
      }, 5000);

      this._pendingCommands.set(id, { resolve, timer });
      this._sendToNode(active.nodeId, MSG_COMMAND, { id, data: hex });
    });
  }

  /**
   * Request battery level via the active node.
   * @returns {Promise<number|null>} Battery level or null
   */
  async requestBattery() {
    const active = this.getActiveNode();
    if (!active) return null;

    return new Promise((resolve) => {
      const handler = (level) => {
        clearTimeout(timer);
        resolve(level);
      };
      const timer = setTimeout(() => {
        this.removeListener('battery', handler);
        resolve(active.lastBattery);
      }, 3000);
      this.once('battery', handler);
      this._sendToNode(active.nodeId, MSG_GET_BATTERY);
    });
  }

  /**
   * Request RSSI via the active node.
   * @returns {Promise<number|null>} RSSI value or null
   */
  async requestRssi() {
    const active = this.getActiveNode();
    if (!active) return null;

    return new Promise((resolve) => {
      const handler = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        this.removeListener('rssi', handler);
        resolve(null);
      }, 3000);
      this.once('rssi', handler);
      this._sendToNode(active.nodeId, MSG_GET_RSSI);
    });
  }

  /**
   * Send a message to a specific node.
   * @param {string} nodeId
   * @param {string} type - Message type
   * @param {Object} [payload={}]
   */
  _sendToNode(nodeId, type, payload = {}) {
    const entry = this._nodes.get(nodeId);
    if (!entry) return;

    try {
      entry.ws.send(formatMessage(type, payload));
    } catch (err) {
      this._poolLogger.error(`Failed to send to node ${nodeId}`, { error: err.message });
    }
  }

  /**
   * Check if any nodes are connected to the pool.
   * @returns {boolean}
   */
  hasNodes() {
    return this._nodes.size > 0;
  }

  /**
   * Clean up all resources.
   */
  destroy() {
    if (this._handoffTimer) {
      clearTimeout(this._handoffTimer);
      this._handoffTimer = null;
    }

    for (const [nodeId] of this._nodes) {
      this.removeNode(nodeId);
    }

    for (const [id, pending] of this._pendingCommands) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this._pendingCommands.clear();
  }
}

module.exports = { NodePool };
