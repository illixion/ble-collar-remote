/**
 * Device module loader and validator.
 *
 * Loads a device module by name from the devices/ directory, validates its
 * exported interface, and prepares noble-format UUIDs for BLE operations.
 */

const path = require('path');
const { toNobleUuid } = require('./constants');

/**
 * Load and validate a device module by name.
 * @param {string} moduleName - Module name (e.g., "btt-xg"), resolved to devices/<name>
 * @returns {Object} Validated device module with _nobleUuids attached
 * @throws {Error} If module cannot be loaded or fails validation
 */
function loadDeviceModule(moduleName) {
  if (!moduleName) {
    throw new Error('No device module specified in config. Set device.module (e.g., "btt-xg").');
  }

  let deviceModule;
  const modulePath = path.join(__dirname, '..', 'devices', moduleName);

  try {
    deviceModule = require(modulePath);
  } catch (err) {
    throw new Error(`Failed to load device module "${moduleName}" from ${modulePath}: ${err.message}`);
  }

  // Validate required string fields
  for (const field of ['name', 'displayName', 'serviceUuid', 'txCharacteristicUuid', 'rxCharacteristicUuid']) {
    if (typeof deviceModule[field] !== 'string' || !deviceModule[field]) {
      throw new Error(`Device module "${moduleName}" missing required string field: ${field}`);
    }
  }

  // Validate controls array
  if (!Array.isArray(deviceModule.controls) || deviceModule.controls.length === 0) {
    throw new Error(`Device module "${moduleName}" must export a non-empty controls array`);
  }

  for (const ctrl of deviceModule.controls) {
    if (!ctrl.id || !ctrl.label || !ctrl.type) {
      throw new Error(`Device module "${moduleName}": each control must have id, label, and type`);
    }
    if (!['range', 'action'].includes(ctrl.type)) {
      throw new Error(`Device module "${moduleName}": control "${ctrl.id}" has invalid type "${ctrl.type}"`);
    }
    if (ctrl.type === 'range') {
      if (typeof ctrl.min !== 'number' || typeof ctrl.max !== 'number') {
        throw new Error(`Device module "${moduleName}": range control "${ctrl.id}" must have numeric min and max`);
      }
    }
  }

  // Validate required function
  if (typeof deviceModule.buildCommand !== 'function') {
    throw new Error(`Device module "${moduleName}" must export a buildCommand function`);
  }

  // Attach computed noble-format UUIDs
  deviceModule._nobleUuids = {
    service: toNobleUuid(deviceModule.serviceUuid),
    tx: toNobleUuid(deviceModule.txCharacteristicUuid),
    rx: toNobleUuid(deviceModule.rxCharacteristicUuid),
  };

  return deviceModule;
}

module.exports = { loadDeviceModule };
