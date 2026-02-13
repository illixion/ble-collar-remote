/**
 * BLE device scanner for finding compatible devices.
 */

const { BLE_UUIDS_NOBLE } = require('./constants');

/**
 * Scan for nearby BLE devices and log those with the UART service.
 * @param {Noble} noble - The noble instance
 * @param {Logger} logger - Logger instance
 * @param {number} duration - Scan duration in milliseconds
 * @param {Array<string>} namePatterns - Optional device name patterns to match as fallback
 * @returns {Promise<Array>} Array of discovered compatible devices
 */
function scanForDevices(noble, logger, duration = 10000, namePatterns = []) {
  return new Promise(async (resolve) => {
    const devices = new Map();
    let totalReports = 0;
    const scanLogger = logger.child('scanner');

    scanLogger.info(`Starting BLE scan for ${duration / 1000} seconds...`);
    scanLogger.debug('Detection config', {
      uartService: BLE_UUIDS_NOBLE.UART_SERVICE,
      namePatterns,
      usesNameMatching: namePatterns.length > 0,
    });

    try {
      await noble.waitForPoweredOnAsync();
    } catch (err) {
      scanLogger.error('Adapter not powered on', { error: err.message });
      resolve([]);
      return;
    }

    const onDiscover = (peripheral) => {
      totalReports += 1;
      const address = peripheral.address;
      const addressType = peripheral.addressType;
      const rssi = peripheral.rssi;
      const name = peripheral.advertisement?.localName || 'Unknown';

      // Noble provides service UUIDs in lowercase no-dash format
      const serviceUuids = peripheral.advertisement?.serviceUuids || [];
      const hasUartService = serviceUuids.includes(BLE_UUIDS_NOBLE.UART_SERVICE);

      const matchesNamePattern = namePatterns.length > 0 &&
        namePatterns.some(pattern => name.toLowerCase().includes(pattern.toLowerCase()));

      const isCompatible = hasUartService || matchesNamePattern;
      const detectionMethod = hasUartService ? 'service-uuid' : (matchesNamePattern ? 'name-pattern' : 'none');

      scanLogger.debug('Advert report', {
        address,
        addressType,
        name,
        rssi,
        serviceUuids,
        hasUartService,
        matchesNamePattern,
        isCompatible,
        detectionMethod,
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
      }
    };

    noble.on('discover', onDiscover);

    try {
      await noble.startScanningAsync([], false);
    } catch (err) {
      scanLogger.error('Failed to start scanning', { error: err.message });
      noble.removeListener('discover', onDiscover);
      resolve([]);
      return;
    }

    setTimeout(async () => {
      try {
        await noble.stopScanningAsync();
      } catch (err) {
        scanLogger.debug('Stop scanning error (non-fatal)', { error: err.message });
      }
      noble.removeListener('discover', onDiscover);

      const deviceList = Array.from(devices.values());
      scanLogger.info(`Scan complete. Found ${deviceList.length} compatible device(s)`);
      scanLogger.debug('Scan summary', {
        totalReports,
        uniqueCompatibleDevices: deviceList.length,
      });
      resolve(deviceList);
    }, duration);
  });
}

module.exports = { scanForDevices };
