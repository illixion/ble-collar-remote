import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.const import CONF_ID
from esphome.components import sensor, binary_sensor, ble_client

DEPENDENCIES = ["esp32_ble_tracker", "ble_client"]
CODEOWNERS = []

CONF_SERVER_URL = "server_url"
CONF_TOKEN = "token"
CONF_NODE_ID = "node_id"
CONF_BLE_CLIENT_ID = "ble_client_id"
CONF_STATUS_SENSOR = "status_sensor"
CONF_BATTERY_SENSOR = "battery_sensor"
CONF_RSSI_SENSOR = "rssi_sensor"

ws_forwarder_ns = cg.esphome_ns.namespace("ws_forwarder")
WsForwarder = ws_forwarder_ns.class_("WsForwarder", cg.Component)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(WsForwarder),
        cv.Required(CONF_SERVER_URL): cv.string,
        cv.Required(CONF_TOKEN): cv.string,
        cv.Optional(CONF_NODE_ID, default="esp32-ble-bridge"): cv.string,
        cv.Required(CONF_BLE_CLIENT_ID): cv.use_id(ble_client.BLEClient),
        cv.Required(CONF_STATUS_SENSOR): cv.use_id(binary_sensor.BinarySensor),
        cv.Required(CONF_BATTERY_SENSOR): cv.use_id(sensor.Sensor),
        cv.Required(CONF_RSSI_SENSOR): cv.use_id(sensor.Sensor),
    }
).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)

    cg.add(var.set_server_url(config[CONF_SERVER_URL]))
    cg.add(var.set_token(config[CONF_TOKEN]))
    cg.add(var.set_node_id(config[CONF_NODE_ID]))

    client = await cg.get_variable(config[CONF_BLE_CLIENT_ID])
    cg.add(var.set_ble_client(client))

    status = await cg.get_variable(config[CONF_STATUS_SENSOR])
    cg.add(var.set_status_sensor(status))

    battery = await cg.get_variable(config[CONF_BATTERY_SENSOR])
    cg.add(var.set_battery_sensor(battery))

    rssi = await cg.get_variable(config[CONF_RSSI_SENSOR])
    cg.add(var.set_rssi_sensor(rssi))

    cg.add_library("links2004/WebSockets", "^2.7.2")
    cg.add_library("bblanchon/ArduinoJson", "^7.4.2")
