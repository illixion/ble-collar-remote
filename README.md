# BLE Shock Collar Controller

A Node.js application for controlling BLE shock collars based on the BK3633 SoC via the Nordic UART Service (NUS).

> **Warning**: This project is intended solely for research and educational purposes. Do not wear the device or use it on any animal while it is powered on. No warranty is provided or implied. Use at your own risk.

## Features

- Web-based control interface with real-time status
- REST API for integration with automation tools (e.g., iOS Shortcuts)
- WebSocket support for real-time bidirectional communication
- Automatic device scanning to find compatible devices
- Battery level monitoring
- Auto-reconnection on disconnect
- Configurable logging levels
- ESPHome configuration for Home Assistant integration

## Requirements

- Linux system with Bluetooth adapter (BlueZ)
- Node.js 16+
- Root privileges (for raw HCI socket access)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/illixion/ble-collar-remote.git
   cd ble-collar-remote
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create your configuration file:
   ```bash
   cp config.example.json config.json
   ```

4. Edit `config.json` and set your device's MAC address:
   ```json
   {
     "device": {
       "macAddress": "XX:XX:XX:XX:XX:XX",
       "addressType": "public"
     }
   }
   ```

## Finding Your Device's MAC Address

Run the server without a configured MAC address, or use the scan API endpoint. The application will scan for nearby devices advertising the Nordic UART Service and log their addresses:

```bash
sudo node server.js
```

Look for log entries like:
```
2024-01-15T12:00:00.000Z INFO  [scanner] Found compatible device: Unknown {"address":"XX:XX:XX:XX:XX:XX","addressType":"public","rssi":"-45 dBm"}
```

You can also trigger a scan via the API:
```bash
curl http://localhost:3000/api/scan
```

## Running

The application requires root privileges to access raw Bluetooth sockets:

```bash
sudo node server.js
```

Or using npm:
```bash
sudo npm start
```

The web interface will be available at `http://localhost:3000`.

## Configuration

Edit `config.json` to customize behavior:

| Setting | Description | Default |
|---------|-------------|---------|
| `device.macAddress` | BLE MAC address of your device | Required |
| `device.addressType` | BLE address type (`public` or `random`) | `public` |
| `server.port` | HTTP server port | `3000` |
| `ble.reconnectDelay` | Delay before reconnecting (ms) | `5000` |
| `ble.batteryCheckInterval` | Battery check interval (ms) | `1800000` |
| `ble.scanDuration` | Device scan duration (ms) | `10000` |
| `forwarder.url` | URL of a forwarder server for relay mode | `null` |
| `logging.level` | Log level (`debug`, `info`, `warn`, `error`) | `info` |

## API Reference

### Send Command
```
GET /api/command?shock=<0-100>&vibro=<0-100>&sound=<0-100>
```

Send a command to the device. All parameters are optional and default to 0.

### Find Device
```
GET /api/command?find=true
```

Make the device beep to help locate it.

### Get Battery Level
```
GET /api/battery
```

Returns the current battery level (0-100).

### Scan for Devices
```
GET /api/scan?duration=<ms>
```

Scan for compatible BLE devices. Returns JSON array of found devices.

### Progressive Shock
```
GET /api/shockandincrease
```

Send a shock at the current progressive value and increase it by 10. The value resets to 10 daily.

### Get/Set Progressive Value
```
GET /api/pValue
POST /api/pValue
Body: { "value": <0-100> }
```

## WebSocket Events

Connect to the server using Socket.io:

```javascript
const socket = io('http://localhost:3000');

// Send command
socket.emit('command', { shock: 50, vibro: 0, sound: 0 });

// Find device
socket.emit('command', { find: true });

// Get RSSI
socket.emit('getrssi');
socket.on('rssi', (rssi) => console.log('RSSI:', rssi));

// Get battery
socket.emit('getbattery');
socket.on('battery', (level) => console.log('Battery:', level));
```

## Protocol Details

The device uses the Nordic UART Service for communication:

| UUID | Purpose |
|------|---------|
| `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` | UART Service |
| `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` | TX Characteristic (write) |
| `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` | RX Characteristic (notify) |

### Command Format

| Command | Bytes |
|---------|-------|
| Normal | `[0xAA, 0x07, shock, vibro, sound, 0xBB]` |
| Find | `[0xEE, 0x02, 0xBB]` |
| Battery Request | `[0xDD, 0xAA, 0xBB]` |

### Battery Response

Battery level is returned in position 5 of the response: `[0xAA, 0x07, 0x00, 0x00, 0x1E, level, 0x00, 0x00, 0xBB]`

## Forwarder / Relay Mode

The forwarder feature allows the main server to relay commands through a secondary server when the BLE device is out of range. This is useful for extending range or running the main server on a device without Bluetooth.

### Setup

1. Run `forwarder.js` on a device near the BLE device:
   ```bash
   sudo node forwarder.js
   ```

2. Configure the main server to use the forwarder by setting `forwarder.url` in `config.json`:
   ```json
   {
     "forwarder": {
       "url": "http://192.168.1.100:3000"
     }
   }
   ```

3. The main server will automatically relay commands through the forwarder when:
   - The local BLE connection is unavailable
   - The forwarder is connected and reachable

Commands, battery level requests, and RSSI queries are all forwarded transparently.

## ESPHome Integration

The `espcollar.yml` file provides an ESPHome configuration for ESP32 devices, enabling Home Assistant integration. Copy and customize the file with your WiFi credentials and device MAC address.

## Project Structure

```
├── server.js           # Main application
├── forwarder.js        # Relay/forwarder server
├── config.json         # Configuration (create from example)
├── config.example.json # Example configuration
├── lib/
│   ├── logger.js       # Logging utility
│   ├── constants.js    # BLE UUIDs and protocol constants
│   └── scanner.js      # Device scanning functionality
├── public/
│   └── index.html      # Web interface
└── espcollar.yml       # ESPHome configuration
```

## Troubleshooting

### Permission Denied
The application requires root privileges. Run with `sudo`.

### Device Not Found
1. Ensure Bluetooth is enabled: `sudo hciconfig hci0 up`
2. Check the MAC address in your config
3. Make sure the device is powered on and in range
4. Try running a scan: `curl http://localhost:3000/api/scan`

### Connection Drops
The application will automatically attempt to reconnect. Check the logs for error messages. Adjust `ble.reconnectDelay` if needed.

## License

MIT License - See [LICENSE](LICENSE) file for details.

## Disclaimer

This software is provided for educational and research purposes only. The authors are not responsible for any misuse or damage caused by this software. Always prioritize safety and ethical considerations when working with such devices.
