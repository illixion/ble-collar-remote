/**
 * Node protocol constants and helpers for forwarder communication.
 *
 * Defines the raw WebSocket JSON protocol used between the central server
 * and forwarder nodes (Node.js or ESP32).
 */

// Node -> Server message types
const MSG_AUTH = 'auth';
const MSG_STATUS = 'status';
const MSG_SCAN_RESULT = 'scan_result';
const MSG_BATTERY = 'battery';
const MSG_RSSI = 'rssi';
const MSG_COMMAND_RESULT = 'command_result';

// Server -> Node message types
const MSG_AUTH_RESULT = 'auth_result';
const MSG_COMMAND = 'command';
const MSG_GET_BATTERY = 'get_battery';
const MSG_GET_RSSI = 'get_rssi';
const MSG_SCAN = 'scan';
const MSG_CONNECT = 'connect';
const MSG_DISCONNECT_BLE = 'disconnect_ble';

/**
 * Parse a raw WebSocket message into a typed object.
 * @param {string} raw - Raw JSON string from WebSocket
 * @returns {{ type: string, [key: string]: any } | null} Parsed message or null if invalid
 */
function parseMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    if (!msg || typeof msg.type !== 'string') {
      return null;
    }
    return msg;
  } catch {
    return null;
  }
}

/**
 * Format a message for sending over WebSocket.
 * @param {string} type - Message type constant
 * @param {Object} [payload={}] - Additional message fields
 * @returns {string} JSON string ready to send
 */
function formatMessage(type, payload = {}) {
  return JSON.stringify({ type, ...payload });
}

module.exports = {
  // Node -> Server
  MSG_AUTH,
  MSG_STATUS,
  MSG_SCAN_RESULT,
  MSG_BATTERY,
  MSG_RSSI,
  MSG_COMMAND_RESULT,

  // Server -> Node
  MSG_AUTH_RESULT,
  MSG_COMMAND,
  MSG_GET_BATTERY,
  MSG_GET_RSSI,
  MSG_SCAN,
  MSG_CONNECT,
  MSG_DISCONNECT_BLE,

  parseMessage,
  formatMessage,
};
