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
 * @param {Array<string>} namePatterns - Optional device name patterns to match as fallback
 * @returns {Promise<Array>} Array of discovered compatible devices
 */
function scanForDevices(manager, logger, duration = 10000, namePatterns = []) {
  return new Promise((resolve) => {
    const devices = new Map();
    let totalReports = 0;
    const scanLogger = logger.child('scanner');

    const uartServiceNorm = normalizeUuid(BLE_UUIDS.UART_SERVICE);
    scanLogger.info(`Starting BLE scan for ${duration / 1000} seconds...`);
    scanLogger.debug('Detection config', { 
      uartServiceNorm, 
      namePatterns,
      usesNameMatching: namePatterns.length > 0
    });

    // Start scanning - returns a scanner object with 'report' event
    const scanner = manager.startScan({});
    scanLogger.debug('Scanner started', { scannerType: typeof scanner });

    scanner.on('report', (report) => {
      totalReports += 1;
      const address = report.address;
      const addressType = report.addressType;
      const rssi = report.rssi;
      const name = report.parsedDataItems?.localName || 'Unknown';

      // Check if the device advertises the UART service
      const serviceUuids = report.parsedDataItems?.serviceUuids || [];
      const serviceUuidsNorm = serviceUuids.map((u) => normalizeUuid(u));
      const hasUartService = serviceUuidsNorm.some((u) => u === uartServiceNorm);

      // Fallback: check if device name matches any configured patterns
      const matchesNamePattern = namePatterns.length > 0 && 
        namePatterns.some(pattern => name.toLowerCase().includes(pattern.toLowerCase()));
      
      const isCompatible = hasUartService || matchesNamePattern;
      const detectionMethod = hasUartService ? 'service-uuid' : (matchesNamePattern ? 'name-pattern' : 'none');

      // Per-advert debug payload to aid troubleshooting
      scanLogger.debug('Advert report', {
        address,
        addressType,
        name,
        rssi,
        serviceUuids,
        serviceUuidsNorm,
        hasUartService,
        matchesNamePattern,
        isCompatible,
        detectionMethod,
        dataItemsKeys: Object.keys(report.parsedDataItems || {}),
      });

      if (isCompatible && !devices.has(address)) {
        devices.set(address, {
          address,
          addressType,
          name,
          rssi,
          timestamp: new Date().toISOString(),
          detectionMethod,
        });

        scanLogger.info(`Found compatible device: ${name}`, {
          address,
          addressType,
          rssi: `${rssi} dBm`,
          detectionMethod,
        });
      } else if (isCompatible && devices.has(address)) {
        scanLogger.debug('Duplicate compatible device; ignoring', { address, name });
      } else {
        scanLogger.debug('Device not compatible; ignoring', {
          address,
          name,
          rssi,
          serviceUuids,
          hasUartService,
          matchesNamePattern,
        });
      }
    });

    setTimeout(() => {
      // Stop scanning using the scanner's stopScan method
      let stopMethod = 'none';
      if (typeof scanner.stopScan === 'function') {
        scanner.stopScan();
        stopMethod = 'scanner.stopScan()';
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
