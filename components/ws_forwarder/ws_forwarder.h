/**
 * WebSocket Forwarder Component for ESPHome
 *
 * Connects to the central server's /ws/node endpoint and implements the
 * node protocol for relaying BLE commands to/from the collar device.
 */

#pragma once

#include "esphome/core/component.h"
#include "esphome/core/log.h"
#include "esphome/components/ble_client/ble_client.h"
#include "esphome/components/sensor/sensor.h"
#include "esphome/components/binary_sensor/binary_sensor.h"
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

namespace esphome {
namespace ws_forwarder {

static const char *const TAG = "ws_forwarder";

class WsForwarder : public Component {
 public:
  void set_server_url(const std::string &url) { this->server_url_ = url; }
  void set_token(const std::string &token) { this->token_ = token; }
  void set_node_id(const std::string &node_id) { this->node_id_ = node_id; }
  void set_ble_client(ble_client::BLEClient *client) { this->ble_client_ = client; }
  void set_status_sensor(binary_sensor::BinarySensor *sensor) { this->status_sensor_ = sensor; }
  void set_battery_sensor(sensor::Sensor *sensor) { this->battery_sensor_ = sensor; }
  void set_rssi_sensor(sensor::Sensor *sensor) { this->rssi_sensor_ = sensor; }

  float get_setup_priority() const override { return setup_priority::AFTER_WIFI; }

  void setup() override {
    // Parse server URL: ws://host:port/path
    std::string url = this->server_url_;

    // Strip protocol prefix
    size_t proto_end = url.find("://");
    if (proto_end != std::string::npos) {
      url = url.substr(proto_end + 3);
    }

    size_t port_start = url.find(':');
    size_t path_start = url.find('/');

    if (port_start == std::string::npos || path_start == std::string::npos) {
      ESP_LOGE(TAG, "Invalid server URL: %s", this->server_url_.c_str());
      this->mark_failed();
      return;
    }

    this->host_ = url.substr(0, port_start);
    this->port_ = (uint16_t) atoi(url.substr(port_start + 1, path_start - port_start - 1).c_str());
    this->path_ = url.substr(path_start);

    ESP_LOGI(TAG, "Connecting to %s:%d%s", this->host_.c_str(), this->port_, this->path_.c_str());

    this->ws_client_.begin(this->host_.c_str(), this->port_, this->path_.c_str());
    this->ws_client_.onEvent([this](WStype_t type, uint8_t *payload, size_t length) {
      this->on_ws_event_(type, payload, length);
    });
    this->ws_client_.setReconnectInterval(5000);
  }

  void loop() override {
    this->ws_client_.loop();

    // Send periodic status every 10 seconds
    uint32_t now = millis();
    if (this->authenticated_ && now - this->last_status_time_ >= 10000) {
      this->send_status_();
      this->last_status_time_ = now;
    }

    // Deferred battery response (avoids delay() in message handler)
    if (this->battery_response_pending_ && now - this->battery_request_time_ >= 1000) {
      this->battery_response_pending_ = false;
      JsonDocument doc;
      doc["type"] = "battery";
      doc["level"] = (int) this->battery_sensor_->state;
      this->send_json_(doc);
    }
  }

  void dump_config() override {
    ESP_LOGCONFIG(TAG, "WebSocket Forwarder:");
    ESP_LOGCONFIG(TAG, "  Server: %s:%d%s", this->host_.c_str(), this->port_, this->path_.c_str());
    ESP_LOGCONFIG(TAG, "  Node ID: %s", this->node_id_.c_str());
  }

 protected:
  std::string server_url_;
  std::string token_;
  std::string node_id_;
  std::string host_;
  uint16_t port_{0};
  std::string path_;

  ble_client::BLEClient *ble_client_{nullptr};
  binary_sensor::BinarySensor *status_sensor_{nullptr};
  sensor::Sensor *battery_sensor_{nullptr};
  sensor::Sensor *rssi_sensor_{nullptr};

  WebSocketsClient ws_client_;
  bool authenticated_{false};
  uint32_t last_status_time_{0};
  bool battery_response_pending_{false};
  uint32_t battery_request_time_{0};

  void on_ws_event_(WStype_t type, uint8_t *payload, size_t length) {
    switch (type) {
      case WStype_CONNECTED:
        ESP_LOGI(TAG, "Connected to server");
        this->send_auth_();
        break;

      case WStype_DISCONNECTED:
        ESP_LOGW(TAG, "Disconnected from server");
        this->authenticated_ = false;
        break;

      case WStype_TEXT:
        this->handle_message_((char *) payload, length);
        break;

      default:
        break;
    }
  }

  void send_auth_() {
    JsonDocument doc;
    doc["type"] = "auth";
    doc["token"] = this->token_;
    doc["nodeId"] = this->node_id_;
    this->send_json_(doc);
  }

  void send_status_() {
    JsonDocument doc;
    doc["type"] = "status";
    doc["bleConnected"] = this->status_sensor_->state;
    doc["battery"] = (int) this->battery_sensor_->state;
    this->send_json_(doc);
  }

  void send_json_(JsonDocument &doc) {
    char buffer[512];
    size_t len = serializeJson(doc, buffer, sizeof(buffer));
    this->ws_client_.sendTXT(buffer, len);
  }

  void handle_message_(char *payload, size_t length) {
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload, length);
    if (err) {
      ESP_LOGW(TAG, "JSON parse error: %s", err.c_str());
      return;
    }

    const char *type = doc["type"];
    if (!type)
      return;

    if (strcmp(type, "auth_result") == 0) {
      if (doc["success"].as<bool>()) {
        ESP_LOGI(TAG, "Authenticated successfully");
        this->authenticated_ = true;
        this->send_status_();
      } else {
        ESP_LOGE(TAG, "Authentication failed");
      }
    } else if (strcmp(type, "command") == 0) {
      this->handle_command_(doc);
    } else if (strcmp(type, "get_battery") == 0) {
      // Write battery request directly to BLE TX characteristic, defer response to loop()
      this->ble_write_({0xdd, 0xaa, 0xbb});
      this->battery_request_time_ = millis();
      this->battery_response_pending_ = true;
    } else if (strcmp(type, "get_rssi") == 0) {
      JsonDocument resp;
      resp["type"] = "rssi";
      resp["value"] = (int) this->rssi_sensor_->state;
      this->send_json_(resp);
    } else if (strcmp(type, "scan") == 0) {
      JsonDocument resp;
      resp["type"] = "scan_result";
      JsonArray devices = resp["devices"].to<JsonArray>();

      if (!isnan(this->rssi_sensor_->state)) {
        JsonObject dev = devices.add<JsonObject>();
        dev["name"] = "collar";
        dev["rssi"] = (int) this->rssi_sensor_->state;
      }

      this->send_json_(resp);
    } else if (strcmp(type, "connect") == 0) {
      ESP_LOGI(TAG, "Server requested BLE connect");
      this->ble_client_->set_enabled(true);
    } else if (strcmp(type, "disconnect_ble") == 0) {
      ESP_LOGI(TAG, "Server requested BLE disconnect");
      this->ble_client_->set_enabled(false);
    }
  }

  void handle_command_(JsonDocument &doc) {
    const char *hex_data = doc["data"];
    int cmd_id = doc["id"] | 0;

    if (!hex_data) {
      this->send_command_result_(cmd_id, false);
      return;
    }

    // Parse hex string into bytes
    size_t hex_len = strlen(hex_data);
    size_t byte_len = hex_len / 2;
    std::vector<uint8_t> data(byte_len);

    for (size_t i = 0; i < byte_len; i++) {
      char byte_str[3] = {hex_data[i * 2], hex_data[i * 2 + 1], 0};
      data[i] = (uint8_t) strtol(byte_str, nullptr, 16);
    }

    // Write to BLE characteristic
    if (this->status_sensor_->state) {
      this->send_command_result_(cmd_id, this->ble_write_(data));
    } else {
      this->send_command_result_(cmd_id, false);
    }
  }

  bool ble_write_(std::vector<uint8_t> data) {
    auto *chr = this->ble_client_->get_characteristic(
        esp32_ble_tracker::ESPBTUUID::from_raw("6e400001-b5a3-f393-e0a9-e50e24dcca9e"),
        esp32_ble_tracker::ESPBTUUID::from_raw("6e400002-b5a3-f393-e0a9-e50e24dcca9e"));
    if (chr) {
      chr->write_value(data.data(), data.size());
      return true;
    }
    return false;
  }

  void send_command_result_(int cmd_id, bool success) {
    JsonDocument doc;
    doc["type"] = "command_result";
    doc["id"] = cmd_id;
    doc["success"] = success;
    this->send_json_(doc);
  }
};

}  // namespace ws_forwarder
}  // namespace esphome
