/**
 * BLE protocol constants and UUIDs for the shock collar device.
 */

// Nordic UART Service UUIDs
const BLE_UUIDS = {
  UART_SERVICE: '6E400001-B5A3-F393-E0A9-E50E24DCCA9E',
  TX_CHARACTERISTIC: '6E400002-B5A3-F393-E0A9-E50E24DCCA9E', // Write to device
  RX_CHARACTERISTIC: '6E400003-B5A3-F393-E0A9-E50E24DCCA9E', // Receive from device
};

// Protocol command bytes
const PROTOCOL = {
  // Command packet structure: [START, TYPE, shock, vibro, sound, END]
  CMD_START: 0xaa,
  CMD_TYPE: 0x07,
  CMD_END: 0xbb,

  // Find/beep command: [FIND_START, FIND_TYPE, END]
  FIND_START: 0xee,
  FIND_TYPE: 0x02,

  // Battery request: [BATTERY_START, BATTERY_TYPE, END]
  BATTERY_START: 0xdd,
  BATTERY_TYPE: 0xaa,

  // Response parsing
  BATTERY_LEVEL_OFFSET: 5,
};

// Command value limits
const LIMITS = {
  MIN_VALUE: 0,
  MAX_VALUE: 100,
};

function toNobleUuid(uuid) {
  return uuid.replace(/-/g, '').toLowerCase();
}

// Noble requires UUIDs in lowercase, no-dash format
const BLE_UUIDS_NOBLE = {
  UART_SERVICE: toNobleUuid(BLE_UUIDS.UART_SERVICE),
  TX_CHARACTERISTIC: toNobleUuid(BLE_UUIDS.TX_CHARACTERISTIC),
  RX_CHARACTERISTIC: toNobleUuid(BLE_UUIDS.RX_CHARACTERISTIC),
};

module.exports = {
  BLE_UUIDS,
  BLE_UUIDS_NOBLE,
  PROTOCOL,
  LIMITS,
  toNobleUuid,
};
