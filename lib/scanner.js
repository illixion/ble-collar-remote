/**
 * BLE device scanner for finding compatible devices.
 */

const { BLE_UUIDS } = require('./constants');

/**
 * Scan for nearby BLE devices and log those with the UART service.
 * @param {BleManager} manager - The BLE manager instance
 * @param {Logger} logger - Logger instance
 * @param {number} duration - Scan duration in milliseconds
 * @returns {Promise<Array>} Array of discovered compatible devices
 */
function scanForDevices(manager, logger, duration = 10000) {
  return new Promise((resolve) => {
    const devices = new Map();
    const scanLogger = logger.child('scanner');

    scanLogger.info(`Starting BLE scan for ${duration / 1000} seconds...`);

    manager.startScan({}, (report) => {
      const address = report.address;
      const addressType = report.addressType;
      const rssi = report.rssi;
      const name = report.parsedDataItems?.localName || 'Unknown';

      // Check if the device advertises the UART service
      const serviceUuids = report.parsedDataItems?.serviceUuids || [];
      const hasUartService = serviceUuids.some(
        (uuid) => uuid.toUpperCase() === BLE_UUIDS.UART_SERVICE
      );

      if (hasUartService && !devices.has(address)) {
        devices.set(address, {
          address,
          addressType,
          name,
          rssi,
          timestamp: new Date().toISOString(),
        });

        scanLogger.info(`Found compatible device: ${name}`, {
          address,
          addressType,
          rssi: `${rssi} dBm`,
        });
      }
    });

    setTimeout(() => {
      manager.stopScan();
      const deviceList = Array.from(devices.values());
      scanLogger.info(`Scan complete. Found ${deviceList.length} compatible device(s)`);
      resolve(deviceList);
    }, duration);
  });
}

module.exports = { scanForDevices };
