# BLE Shock Collar Controller

A Node.js application for controlling the [BEITUTU BTT-XG](https://manuals.plus/beitutu/btt-xg-electronic-dog-training-collar-manual), a BLE shock collar based on the BK3633 SoC via the Nordic UART Service (NUS).

The following app was used when researching the protocol: [App Store](https://apps.apple.com/us/app/宠物智能/id1587636746)

> **Warning**: This project is intended solely for research and educational purposes. Do not wear the device or use it on any animal while it is powered on. No warranty is provided or implied. Use at your own risk.

## Features

- **Desktop app** via Electron with built-in settings UI and BLE scanner
- Web-based control interface with real-time status
- REST API for integration with automation tools (e.g., iOS Shortcuts)
- WebSocket support for real-time bidirectional communication
- BLE scanner page for discovering and selecting devices
- Automatic device scanning to find compatible devices
- Battery level monitoring
- Auto-reconnection on disconnect
- Configurable logging levels
- **Multi-node forwarder support** with automatic RSSI-based handoff
- **macOS, Linux, and Windows support** via `@stoprocent/noble`

## Desktop App (Electron)

Pre-built binaries are available on the [Releases](../../releases) page for Windows (x64), macOS (arm64), and Linux (x64).

The desktop app wraps the Node.js server in Electron, providing:

- A **Settings** window (File > Settings or Ctrl+,) to configure the server, device, BLE, and forwarder node settings
- A **BLE Scanner** page (View > BLE Scanner) to discover nearby devices and select one to use with a single click
- An **Expose publicly** toggle to control whether the server is accessible from the network or only from localhost

Config and data files are stored in the Electron user data directory (e.g., `%APPDATA%/ble-collar-remote` on Windows, `~/Library/Application Support/ble-collar-remote` on macOS, `~/.config/ble-collar-remote` on Linux).

### Building from source

```bash
npm install
npm run dist        # Build for current platform
npm run dist:win    # Build for Windows
```

## Requirements

- Node.js 16+
- **Linux**: Bluetooth adapter (BlueZ), root privileges for raw HCI socket access
- **macOS**: Built-in Bluetooth or compatible adapter (no root required, uses CoreBluetooth via `@stoprocent/noble`)
- **Windows**: Bluetooth adapter (uses WinRT bindings via `@stoprocent/noble`)

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

4. Edit `config.json` with your device settings:
   ```json
   {
     "device": {
       "macAddress": "XX:XX:XX:XX:XX:XX",
       "addressType": "public"
     }
   }
   ```

   **macOS**: The MAC address is optional. CoreBluetooth does not expose MAC addresses, so the server discovers devices by scanning for the Nordic UART Service UUID or by matching name patterns configured in `ble.deviceNamePatterns`. You can use the BLE Scanner page to find and select your device automatically.

   **Linux**: You may need to change your HCI interface number if you have multiple Bluetooth adapters. Run `btmgmt info` to see available interfaces, then update `ble.hciInterface` in `config.json` accordingly.

5. Set your authentication token in `config.json`:
   ```json
   {
     "server": {
       "token": "YOUR_SECURE_TOKEN"
     }
   }
   ```

6. Start the server:
   ```bash
   # Linux (requires root for HCI access)
   sudo node server.js

   # macOS (no root needed)
   node server.js

   # Windows
   node server.js
   ```

7. (optional) Add an nginx reverse proxy for easier access and HTTPS. This is **required** if you want to expose the server to the internet, and using authentication is strongly encouraged. For non-technical users, I recommend using Tailscale since it issues certificates automatically, run `tailscale serve --bg http://127.0.0.1:3000` to allow access within your Tailnet only or `tailscale funnel --bg http://127.0.0.1:3000` to allow public access with HTTPS.

## Finding Your Device

The easiest way to find your device is to use the **BLE Scanner** page available at `http://localhost:3000/scan.html`. It allows you to scan for all nearby BLE devices and select the one you want to use, which will automatically update the configuration.

You can also trigger a scan via the API:
```bash
curl http://localhost:3000/api/scan
```

Or from the server logs on startup, look for entries like:
```
2024-01-15T12:00:00.000Z INFO  [scanner] Found compatible device: Unknown {"address":"XX:XX:XX:XX:XX:XX","addressType":"public","rssi":"-45 dBm"}
```

## Running

```bash
# Linux
sudo node server.js

# macOS / Windows
node server.js
```

Or using npm:
```bash
sudo npm start  # Linux
npm start        # macOS / Windows
```

The web interface will be available at `http://localhost:3000`.

## Configuration

Edit `config.json` to customize behavior:

| Setting | Description | Default |
|---------|-------------|---------|
| `device.macAddress` | BLE MAC address of your device (optional on macOS) | `""` |
| `device.addressType` | BLE address type (`public` or `random`) | `public` |
| `server.host` | Bind address (`127.0.0.1` for local, `0.0.0.0` for public) | `0.0.0.0` |
| `server.port` | HTTP server port | `3000` |
| `server.token` | Authentication token (set to `""` or `"none"` to disable) | Optional |
| `nodes.enabled` | Enable forwarder node support | `true` |
| `nodes.pingInterval` | Ping interval for node health checks (ms) | `30000` |
| `nodes.staleTimeout` | Timeout before removing unresponsive nodes (ms) | `60000` |
| `nodes.scanDuration` | Duration of handoff scans (ms) | `10000` |
| `nodes.handoffTimeout` | Timeout before retrying handoff (ms) | `30000` |
| `ble.hciInterface` | HCI device index (Linux only) | `0` |
| `ble.reconnectDelay` | Delay before reconnecting (ms) | `5000` |
| `ble.batteryCheckInterval` | Battery check interval (ms) | `1800000` |
| `ble.scanDuration` | Device scan duration (ms) | `10000` |
| `ble.deviceNamePatterns` | Name substrings to match during scan | `["btt_xg_"]` |
| `ble.scanOnStart` | Run a scan before connecting on startup | `true` |
| `logging.level` | Log level (`debug`, `info`, `warn`, `error`) | `info` |

## Authentication

Authentication can be enabled by setting a token in `config.json`. When enabled, all API endpoints, WebSocket connections, and forwarder node connections require the token.

To disable authentication, set the token to an empty string `""` or `"none"`:
```json
{
  "server": {
    "token": ""
  }
}
```

When authentication is disabled, the server will log a warning on startup.

### HTTP API Authentication

Include the token in one of these ways:

1. **Authorization header** (recommended):
   ```bash
   curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3000/api/battery
   ```

2. **Query parameter**:
   ```bash
   curl "http://localhost:3000/api/battery?token=YOUR_TOKEN"
   ```

### WebSocket Authentication

When connecting via Socket.io, provide the token in the auth object:

```javascript
const socket = io('http://localhost:3000', {
  auth: { token: 'YOUR_TOKEN' }
});
```

### Web Interface

The web interface includes a token input field. Enter your token and click "Connect" to authenticate. The token is saved to localStorage for convenience.

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
GET /api/scan?duration=<ms>&showAll=true
```

Scan for BLE devices. By default, only compatible devices (matching service UUID or name patterns) are returned. Set `showAll=true` to return all nearby BLE devices.

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

### Update Device Configuration
```
POST /api/config/device
Body: { "macAddress": "XX:XX:XX:XX:XX:XX", "addressType": "public", "name": "device_name" }
```

Updates the device MAC address, address type, and optionally adds the device name to `ble.deviceNamePatterns`. Requires a server restart to take effect.

### Node Pool Status
```
GET /api/nodes
```

Returns the current status of all connected forwarder nodes, active node ID, and local BLE connection state.

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

## Forwarder Nodes

The forwarder system allows the server to relay commands through remote nodes when the BLE device is out of range of the server's local Bluetooth. Multiple nodes can be connected simultaneously, with automatic RSSI-based handoff when the active node loses its BLE connection.

### Architecture

```
Browser clients ─── Socket.io ───> [Central Server (+ local BLE fallback)]
                                      │
                         Raw WebSocket │ /ws/node
                                      │
            ┌─────────────────────────┼─────────────────────────┐
            │                         │                         │
    [Node.js Forwarder]     [Node.js Forwarder]       [Other Forwarder]
         │                         │                         │
       Noble                     Noble                  BLE Client
         │                         │                         │
                    [Collar] (one connection at a time)
```

- **The server always uses local BLE first.** If no local BLE connection is available, commands are routed to the active forwarder node.
- **If no forwarder nodes are configured**, the server works standalone using local BLE only (the same behavior as before forwarder support was added).
- **Only one node holds the BLE connection** at any time, since the collar accepts a single connection and becomes invisible once paired.

### Handoff

When the active node loses its BLE connection:

1. The server sends a scan request to **all** connected forwarder nodes
2. Each node scans for the collar for 10 seconds and reports discovered devices with RSSI
3. The server picks the node with the **strongest RSSI** (closest to the device)
4. That node is instructed to connect and becomes the new active node

### Node.js Forwarder Setup

1. Create a forwarder config file (see `config.forwarder.example.json`):
   ```json
   {
     "node": {
       "id": "forwarder-living-room",
       "serverUrl": "ws://192.168.1.100:3000/ws/node",
       "token": "YOUR_SECRET_TOKEN"
     },
     "device": {
       "macAddress": "XX:XX:XX:XX:XX:XX",
       "addressType": "public"
     },
     "ble": {
       "deviceNamePatterns": ["btt_xg_"]
     }
   }
   ```

2. Run the forwarder on a device near the BLE collar:
   ```bash
   # Linux
   sudo node forwarder.js /path/to/forwarder-config.json

   # macOS
   node forwarder.js /path/to/forwarder-config.json
   ```

3. The forwarder connects to the server via WebSocket, authenticates, and waits for instructions. The server's node pool manages which forwarder holds the active BLE connection.

### Node Protocol

Forwarder nodes communicate with the server over raw WebSocket (not Socket.io) at the `/ws/node` endpoint using JSON text frames. The protocol includes:

- **Authentication**: First message must be `{ "type": "auth", "token": "...", "nodeId": "..." }`
- **Status updates**: Nodes send `{ "type": "status", "bleConnected": true, "battery": 85 }` every 10 seconds
- **Commands**: Server sends `{ "type": "command", "id": 1, "data": "aa070a0000bb" }` (hex-encoded BLE data)
- **Scan/handoff**: Server sends `{ "type": "scan", "duration": 10000 }`, node responds with `{ "type": "scan_result", "devices": [...] }`
- **Health checks**: WebSocket-level ping/pong (30s interval, 60s stale timeout)

## Platform Support

### macOS

macOS support is provided via `@stoprocent/noble`, which uses CoreBluetooth bindings. No root privileges are required. Note that CoreBluetooth does not expose device MAC addresses, so the server discovers devices by scanning for the Nordic UART Service UUID or by matching name patterns configured in `ble.deviceNamePatterns`. The MAC address field in the config can be left empty on macOS.

### Linux

Linux support uses HCI bindings via `@stoprocent/noble`. Root privileges are required for raw HCI socket access. Devices are connected directly by MAC address.

### Windows

Windows support is provided via `@stoprocent/noble` using WinRT bindings. The Electron desktop app is the recommended way to use the application on Windows.

## Project Structure

```
├── server.js                       # Central server (HTTP API, Socket.io, node pool, local BLE)
├── forwarder.js                    # Headless forwarder node (WebSocket client + BLE bridge)
├── config.json                     # Server configuration (create from example)
├── config.example.json             # Example server configuration
├── config.forwarder.example.json   # Example forwarder node configuration
├── electron/
│   ├── main.js                     # Electron main process
│   ├── preload.js                  # Preload script for main window
│   ├── preload-settings.js         # Preload script for settings window
│   └── settings.html               # Electron settings UI
├── lib/
│   ├── ble-device.js               # BLE device connection manager (shared by server & forwarder)
│   ├── device-loader.js            # Device module loader and validator
│   ├── node-pool.js                # Forwarder node pool with handoff logic
│   ├── node-protocol.js            # WebSocket protocol constants and helpers
│   ├── constants.js                # BLE UUIDs and protocol constants
│   ├── logger.js                   # Logging utility
│   └── scanner.js                  # Device scanning functionality
├── devices/
│   └── btt-xg.js                   # BEITUTU BTT-XG device module
├── public/
│   ├── index.html                  # Web interface (controller)
│   └── scan.html                   # BLE scanner page
└── package.json
```

## Troubleshooting

### Permission Denied (Linux)
The application requires root privileges on Linux. Run with `sudo`.

### Device Not Found
1. Ensure Bluetooth is enabled: `sudo hciconfig hci0 up` (Linux)
2. Check the MAC address in your config (Linux) or name patterns (macOS)
3. Make sure the device is powered on and in range
4. Use the BLE Scanner page at `/scan.html` with "Show all devices" enabled
5. On macOS, ensure `ble.deviceNamePatterns` includes a matching pattern

### Connection Drops
The application will automatically attempt to reconnect. Check the logs for error messages. Adjust `ble.reconnectDelay` if needed. If using forwarder nodes, the node pool will trigger a handoff scan on disconnect.

### Forwarder Not Connecting
1. Verify the server URL and port in the forwarder config
2. Ensure the auth token matches the server's `server.token`
3. Check that the `/ws/node` endpoint is reachable from the forwarder
4. Check the server logs for auth failures

## License

MIT License - See [LICENSE](LICENSE) file for details.

## Disclaimer

This software is provided for educational and research purposes only. The authors are not responsible for any misuse or damage caused by this software. Always prioritize safety and ethical considerations when working with such devices.
