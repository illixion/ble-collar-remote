/**
 * BLE device connection manager.
 *
 * Encapsulates all Noble BLE logic for connecting to, communicating with,
 * and managing the lifecycle of a BLE device. Device-specific protocol
 * details (UUIDs, command format, response parsing) are provided by the
 * device module passed to the constructor.
 *
 * Used by both the central server (local BLE fallback) and headless forwarder nodes.
 */

const { EventEmitter } = require('events');
const { withBindings } = require('@stoprocent/noble');
const { scanForDevices } = require('./scanner');

class BleDevice extends EventEmitter {
  /**
   * @param {Object} config
   * @param {string} config.macAddress - BLE MAC address of the device
   * @param {string} [config.addressType='public'] - BLE address type
   * @param {number} [config.hciInterface=0] - HCI device index (Linux only)
   * @param {number} [config.reconnectDelay=5000] - Delay before reconnect (ms)
   * @param {string[]} [config.deviceNamePatterns=[]] - Name patterns for scanning
   * @param {number} [config.scanDuration=10000] - Scan duration (ms)
   * @param {number} [config.batteryCheckInterval=1800000] - Battery check interval (ms)
   * @param {Object} logger - Logger instance
   * @param {Object} deviceModule - Device module providing UUIDs, commands, and parsing
   */
  constructor(config, logger, deviceModule) {
    super();

    this._config = {
      macAddress: config.macAddress,
      addressType: config.addressType || 'public',
      hciInterface: config.hciInterface || 0,
      reconnectDelay: config.reconnectDelay || 5000,
      deviceNamePatterns: config.deviceNamePatterns || [],
      scanDuration: config.scanDuration || 10000,
      batteryCheckInterval: config.batteryCheckInterval || 30 * 60 * 1000,
    };

    this._logger = logger;
    this._bleLogger = logger.child('ble');
    this._deviceModule = deviceModule;

    this._noble = null;
    this._peripheral = null;
    this._txChar = null;
    this._batteryLevel = 100;
    this._isConnecting = false;
    this._autoReconnect = true;
    this._batteryTimer = null;
    this._nobleInitialized = false;
  }

  /**
   * Initialize noble with platform-appropriate bindings.
   */
  _initNoble() {
    if (this._nobleInitialized) return;

    if (process.platform === 'darwin') {
      this._noble = withBindings('default');
      this._bleLogger.info('Noble initialized with macOS native bindings');
    } else {
      this._noble = withBindings('hci', {
        hciDriver: 'native',
        deviceId: this._config.hciInterface,
      });
      this._bleLogger.info(`Noble initialized with HCI bindings (device: hci${this._config.hciInterface})`);
    }

    this._nobleInitialized = true;
  }

  /**
   * Find a peripheral by name pattern or service UUID.
   * Used on macOS where CoreBluetooth doesn't expose MAC addresses.
   * @param {number} [timeout=30000] - Discovery timeout in ms
   * @returns {Promise<Object>} Noble peripheral object
   */
  async _findPeripheral(timeout = 30000) {
    const namePatterns = this._config.deviceNamePatterns;
    const serviceUuid = this._deviceModule._nobleUuids.service;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._noble.stopScanningAsync().catch(() => {});
        this._noble.removeListener('discover', onDiscover);
        reject(new Error(`Device not found within ${timeout / 1000} seconds`));
      }, timeout);

      const onDiscover = (peripheral) => {
        const name = peripheral.advertisement?.localName || '';
        const serviceUuids = peripheral.advertisement?.serviceUuids || [];
        const hasMatchingService = serviceUuids.includes(serviceUuid);
        const matchesName = namePatterns.length > 0 &&
          namePatterns.some(pattern => name.toLowerCase().includes(pattern.toLowerCase()));

        if (hasMatchingService || matchesName) {
          clearTimeout(timer);
          this._noble.stopScanningAsync().catch(() => {});
          this._noble.removeListener('discover', onDiscover);
          resolve(peripheral);
        }
      };

      this._noble.on('discover', onDiscover);
      this._noble.startScanningAsync([], false).catch((err) => {
        clearTimeout(timer);
        this._noble.removeListener('discover', onDiscover);
        reject(err);
      });
    });
  }

  /**
   * Connect to the BLE device and set up characteristic handlers.
   * Emits 'connected' when ready for commands, 'disconnected' on loss.
   */
  async connect() {
    if (this._isConnecting) {
      this._bleLogger.debug('Connection attempt already in progress, skipping');
      return;
    }
    this._isConnecting = true;
    this._autoReconnect = true;

    this._initNoble();

    const { macAddress, addressType } = this._config;
    const nobleUuids = this._deviceModule._nobleUuids;
    this._bleLogger.info('Connecting to device', { address: macAddress, addressType });

    try {
      await this._noble.waitForPoweredOnAsync();

      if (process.platform === 'darwin') {
        this._bleLogger.info('macOS detected: scanning to find device...');
        this._peripheral = await this._findPeripheral();
        this._bleLogger.info(`Found device: ${this._peripheral.advertisement?.localName || this._peripheral.address}`);
        await this._peripheral.connectAsync();
      } else {
        this._peripheral = await this._noble.connectAsync(macAddress);
      }

      this._bleLogger.info(`Connected to ${this._peripheral.advertisement?.localName || this._peripheral.address}`);

      // Discover service and characteristics using device module UUIDs
      const { characteristics } = await this._peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [nobleUuids.service],
        [nobleUuids.tx, nobleUuids.rx]
      );

      for (const char of characteristics) {
        // RX characteristic - subscribe for notifications
        if (char.uuid === nobleUuids.rx) {
          await char.subscribeAsync();
          char.removeAllListeners('data');
          char.on('data', (data, isNotification) => {
            if (!isNotification) return;
            if (typeof this._deviceModule.parseNotification === 'function') {
              const result = this._deviceModule.parseNotification(data);
              if (result && result.type === 'battery') {
                this._batteryLevel = result.level;
                this._bleLogger.info(`Battery level: ${this._batteryLevel}%`);
                this.emit('battery', this._batteryLevel);
              } else if (result) {
                this.emit('notification', result);
              }
            }
          });
        }

        // TX characteristic - save for sending commands
        if (char.uuid === nobleUuids.tx) {
          this._txChar = char;
          this._bleLogger.info('Device ready for commands');
          this.requestBattery();
        }
      }

      if (!this._txChar) {
        this._bleLogger.error('TX characteristic not found on device');
      }

      this._isConnecting = false;

      // Start battery check interval
      if (this._batteryTimer) clearInterval(this._batteryTimer);
      this._batteryTimer = setInterval(() => this.requestBattery(), this._config.batteryCheckInterval);

      this.emit('connected');

      // Handle disconnect
      this._peripheral.once('disconnect', () => {
        this._bleLogger.warn('Disconnected from device');
        this._txChar = null;
        this._peripheral = null;
        if (this._batteryTimer) {
          clearInterval(this._batteryTimer);
          this._batteryTimer = null;
        }

        this.emit('disconnected');

        if (this._autoReconnect) {
          const delay = this._config.reconnectDelay;
          this._bleLogger.info(`Reconnecting in ${delay / 1000} seconds...`);
          setTimeout(() => {
            this.connect().catch((err) => {
              this._bleLogger.error('Reconnection failed', { error: err.message });
            });
          }, delay);
        }
      });

    } catch (err) {
      this._isConnecting = false;
      this._bleLogger.error('Connection failed', { error: err.message });

      if (this._autoReconnect) {
        const delay = this._config.reconnectDelay;
        this._bleLogger.info(`Retrying connection in ${delay / 1000} seconds...`);
        setTimeout(() => {
          this.connect().catch(() => {});
        }, delay);
      }
    }
  }

  /**
   * Disconnect from the BLE device. Does NOT auto-reconnect.
   */
  async disconnect() {
    this._autoReconnect = false;

    if (this._batteryTimer) {
      clearInterval(this._batteryTimer);
      this._batteryTimer = null;
    }

    if (this._peripheral) {
      try {
        await this._peripheral.disconnectAsync();
      } catch (e) {
        // ignore disconnect errors
      }
    }

    this._txChar = null;
    this._peripheral = null;
    this._isConnecting = false;
  }

  /**
   * Check if the BLE device is connected and ready for commands.
   * @returns {boolean}
   */
  isConnected() {
    return !!this._txChar;
  }

  /**
   * Write data to the BLE TX characteristic.
   * @param {Buffer} data - Data to write
   * @returns {Promise<boolean>} True if write succeeded
   */
  async write(data) {
    if (!this._txChar) {
      this._bleLogger.warn('Cannot write: device not connected');
      return false;
    }

    try {
      await this._txChar.writeAsync(data, true); // true = without response
      return true;
    } catch (err) {
      this._bleLogger.error('Write failed', { error: err.message });
      return false;
    }
  }

  /**
   * Read the current RSSI value from the connected peripheral.
   * @returns {Promise<number|null>} RSSI in dBm, or null if unavailable
   */
  async getRssi() {
    if (!this._peripheral) return null;
    try {
      return await this._peripheral.updateRssiAsync();
    } catch (err) {
      this._bleLogger.error('Failed to read RSSI', { error: err.message });
      return null;
    }
  }

  /**
   * Request battery level from the device (fire-and-forget).
   * Result arrives asynchronously via the 'battery' event.
   * Only works if the device module provides buildBatteryRequest().
   */
  requestBattery() {
    if (!this._txChar) return;
    if (typeof this._deviceModule.buildBatteryRequest !== 'function') return;
    const command = this._deviceModule.buildBatteryRequest();
    if (command) {
      this.write(command);
    }
  }

  /**
   * Get the last known battery level.
   * @returns {number} Battery percentage (0-100)
   */
  getBatteryLevel() {
    return this._batteryLevel;
  }

  /**
   * Scan for compatible BLE devices without connecting.
   * @param {number} [duration] - Scan duration in ms (defaults to config value)
   * @returns {Promise<Array<{ address: string, name: string, rssi: number }>>}
   */
  async scan(duration) {
    this._initNoble();
    const scanDuration = duration || this._config.scanDuration;
    return scanForDevices(
      this._noble,
      this._logger,
      scanDuration,
      this._config.deviceNamePatterns,
      this._deviceModule._nobleUuids.service
    );
  }

  /**
   * Get the noble instance (for advanced use cases).
   * @returns {Object|null}
   */
  getNoble() {
    this._initNoble();
    return this._noble;
  }

  /**
   * Clean up all resources.
   */
  async destroy() {
    await this.disconnect();
    if (this._noble) {
      this._noble.stop();
    }
  }
}

module.exports = { BleDevice };
