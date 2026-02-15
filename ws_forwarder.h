/**
 * WebSocket Forwarder Custom Component for ESPHome
 *
 * Connects to the central server's /ws/node endpoint and implements the
 * node protocol for relaying BLE commands to/from the collar device.
 *
 * Uses the links2004/WebSockets library for WebSocket client support
 * and ArduinoJson for JSON message parsing/formatting.
 */

#pragma once

#include "esphome.h"
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

class WsForwarder : public Component {
 public:
  WsForwarder(const char *server_url, const char *token, const char *node_id)
      : server_url_(server_url), token_(token), node_id_(node_id) {}

  void setup() override {
    // Parse server URL: ws://host:port/path
    String url(server_url_);
    url.replace("ws://", "");
    url.replace("wss://", "");

    int port_start = url.indexOf(':');
    int path_start = url.indexOf('/');

    if (port_start < 0 || path_start < 0) {
      ESP_LOGE("ws_forwarder", "Invalid server URL: %s", server_url_);
      return;
    }

    host_ = url.substring(0, port_start);
    port_ = url.substring(port_start + 1, path_start).toInt();
    path_ = url.substring(path_start);

    ESP_LOGI("ws_forwarder", "Connecting to %s:%d%s", host_.c_str(), port_, path_.c_str());

    ws_client_.begin(host_.c_str(), port_, path_.c_str());
    ws_client_.onEvent([this](WStype_t type, uint8_t *payload, size_t length) {
      this->on_ws_event(type, payload, length);
    });
    ws_client_.setReconnectInterval(5000);
  }

  void loop() override {
    ws_client_.loop();

    // Send periodic status every 10 seconds
    uint32_t now = millis();
    if (now - last_status_time_ >= 10000 && authenticated_) {
      send_status();
      last_status_time_ = now;
    }
  }

 private:
  const char *server_url_;
  const char *token_;
  const char *node_id_;
  String host_;
  uint16_t port_ = 0;
  String path_;

  WebSocketsClient ws_client_;
  bool authenticated_ = false;
  uint32_t last_status_time_ = 0;

  void on_ws_event(WStype_t type, uint8_t *payload, size_t length) {
    switch (type) {
      case WStype_CONNECTED:
        ESP_LOGI("ws_forwarder", "Connected to server");
        send_auth();
        break;

      case WStype_DISCONNECTED:
        ESP_LOGW("ws_forwarder", "Disconnected from server");
        authenticated_ = false;
        break;

      case WStype_TEXT:
        handle_message((char *)payload, length);
        break;

      case WStype_PING:
        // Library handles pong automatically
        break;

      default:
        break;
    }
  }

  void send_auth() {
    StaticJsonDocument<256> doc;
    doc["type"] = "auth";
    doc["token"] = token_;
    doc["nodeId"] = node_id_;
    send_json(doc);
  }

  void send_status() {
    StaticJsonDocument<256> doc;
    doc["type"] = "status";
    doc["bleConnected"] = id(shock_collar_status).state;
    doc["battery"] = (int)id(shock_collar_battery).state;
    send_json(doc);
  }

  void send_json(JsonDocument &doc) {
    char buffer[512];
    size_t len = serializeJson(doc, buffer, sizeof(buffer));
    ws_client_.sendTXT(buffer, len);
  }

  void handle_message(char *payload, size_t length) {
    StaticJsonDocument<512> doc;
    DeserializationError err = deserializeJson(doc, payload, length);
    if (err) {
      ESP_LOGW("ws_forwarder", "JSON parse error: %s", err.c_str());
      return;
    }

    const char *type = doc["type"];
    if (!type) return;

    if (strcmp(type, "auth_result") == 0) {
      if (doc["success"].as<bool>()) {
        ESP_LOGI("ws_forwarder", "Authenticated successfully");
        authenticated_ = true;
        send_status();
      } else {
        ESP_LOGE("ws_forwarder", "Authentication failed");
      }
    }
    else if (strcmp(type, "command") == 0) {
      handle_command(doc);
    }
    else if (strcmp(type, "get_battery") == 0) {
      // Trigger battery read and send current value
      id(get_battery_level).execute();
      delay(1000);
      StaticJsonDocument<128> resp;
      resp["type"] = "battery";
      resp["level"] = (int)id(shock_collar_battery).state;
      send_json(resp);
    }
    else if (strcmp(type, "get_rssi") == 0) {
      StaticJsonDocument<128> resp;
      resp["type"] = "rssi";
      resp["value"] = (int)id(collar_rssi).state;
      send_json(resp);
    }
    else if (strcmp(type, "scan") == 0) {
      // ESP32 BLE tracker handles scanning automatically
      // Report what we know from the BLE tracker
      StaticJsonDocument<512> resp;
      resp["type"] = "scan_result";
      JsonArray devices = resp.createNestedArray("devices");

      // If the collar RSSI sensor has a value, report it
      if (!isnan(id(collar_rssi).state)) {
        JsonObject dev = devices.createNestedObject();
        dev["name"] = "collar";
        dev["rssi"] = (int)id(collar_rssi).state;
      }

      send_json(resp);
    }
    else if (strcmp(type, "connect") == 0) {
      ESP_LOGI("ws_forwarder", "Server requested BLE connect");
      id(shock_collar).set_enabled(true);
    }
    else if (strcmp(type, "disconnect_ble") == 0) {
      ESP_LOGI("ws_forwarder", "Server requested BLE disconnect");
      id(shock_collar).set_enabled(false);
    }
  }

  void handle_command(JsonDocument &doc) {
    const char *hex_data = doc["data"];
    int cmd_id = doc["id"] | 0;

    if (!hex_data) {
      send_command_result(cmd_id, false);
      return;
    }

    // Parse hex string into bytes
    size_t hex_len = strlen(hex_data);
    size_t byte_len = hex_len / 2;
    std::vector<uint8_t> data(byte_len);

    for (size_t i = 0; i < byte_len; i++) {
      char byte_str[3] = { hex_data[i * 2], hex_data[i * 2 + 1], 0 };
      data[i] = (uint8_t)strtol(byte_str, nullptr, 16);
    }

    // Write to BLE characteristic
    if (id(shock_collar_status).state) {
      auto *ble = id(shock_collar).get_characteristic(
        esp32_ble_tracker::ESPBTUUID::from_raw("6e400002-b5a3-f393-e0a9-e50e24dcca9e"));
      if (ble) {
        ble->write_value(data);
        send_command_result(cmd_id, true);
      } else {
        send_command_result(cmd_id, false);
      }
    } else {
      send_command_result(cmd_id, false);
    }
  }

  void send_command_result(int cmd_id, bool success) {
    StaticJsonDocument<128> doc;
    doc["type"] = "command_result";
    doc["id"] = cmd_id;
    doc["success"] = success;
    send_json(doc);
  }
};
