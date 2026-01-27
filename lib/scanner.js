/**
 * BLE device scanner for finding compatible devices.
 */

const { BLE_UUIDS } = require('./constants');

function normalizeUuid(uuid) {
  return (uuid || '').replace(/-/g, '').toUpperCase();
}

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
    let totalReports = 0;
    const scanLogger = logger.child('scanner');

    const uartServiceNorm = normalizeUuid(BLE_UUIDS.UART_SERVICE);
    scanLogger.info(`Starting BLE scan for ${duration / 1000} seconds...`);
    scanLogger.debug('UART service (normalized) to match', { uartServiceNorm });

    // Start scanning; some implementations return a stop/cancel function
    const stopHandle = manager.startScan({}, (report) => {
      totalReports += 1;
      const address = report.address;
      const addressType = report.addressType;
      const rssi = report.rssi;
      const name = report.parsedDataItems?.localName || 'Unknown';

      // Check if the device advertises the UART service
      const serviceUuids = report.parsedDataItems?.serviceUuids || [];
      const serviceUuidsNorm = serviceUuids.map((u) => normalizeUuid(u));
      const hasUartService = serviceUuidsNorm.some((u) => u === uartServiceNorm);

      // Per-advert debug payload to aid troubleshooting
      scanLogger.debug('Advert report', {
        address,
        addressType,
        name,
        rssi,
        serviceUuids,
        serviceUuidsNorm,
        hasUartService,
        dataItemsKeys: Object.keys(report.parsedDataItems || {}),
      });

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
      } else if (hasUartService && devices.has(address)) {
        scanLogger.debug('Duplicate compatible device; ignoring', { address, name });
      } else if (!hasUartService) {
        scanLogger.debug('Device does not advertise required service; ignoring', {
          address,
          name,
          rssi,
          serviceUuids,
        });
      }
    });

    setTimeout(() => {
      // Stop scanning using whatever API is available
      let stopMethod = 'none';
      if (typeof stopHandle === 'function') {
        stopHandle();
        stopMethod = 'stopHandle()';
      } else if (typeof manager.stopScan === 'function') {
        manager.stopScan();
        stopMethod = 'manager.stopScan()';
      } else if (typeof manager.stopScanning === 'function') {
        manager.stopScanning();
        stopMethod = 'manager.stopScanning()';
      } else if (typeof manager.setScanEnable === 'function') {
        manager.setScanEnable(false);
        stopMethod = 'manager.setScanEnable(false)';
      }
      const deviceList = Array.from(devices.values());
      scanLogger.info(`Scan complete. Found ${deviceList.length} compatible device(s)`);
      scanLogger.debug('Scan summary', {
        totalReports,
        uniqueCompatibleDevices: deviceList.length,
        stopMethod,
      });
      resolve(deviceList);
    }, duration);
  });
}

module.exports = { scanForDevices };
