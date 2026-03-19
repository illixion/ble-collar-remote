/**
 * Device module for BEITUTU BTT-XG shock collar.
 *
 * Protocol: Nordic UART Service (NUS) over BLE
 * SoC: Beken BK3633
 *
 * Command format: [0xAA, 0x07, shock, vibro, sound, 0xBB]
 * Find command:   [0xEE, 0x02, 0xBB]
 * Battery request: [0xDD, 0xAA, 0xBB]
 * Battery response: byte[5] when byte[0]==0xAA && byte[1]==0x07
 */

module.exports = {
  name: 'btt-xg',
  displayName: 'BEITUTU BTT-XG',

  serviceUuid: '6E400001-B5A3-F393-E0A9-E50E24DCCA9E',
  txCharacteristicUuid: '6E400002-B5A3-F393-E0A9-E50E24DCCA9E',
  rxCharacteristicUuid: '6E400003-B5A3-F393-E0A9-E50E24DCCA9E',

  controls: [
    { id: 'shock', label: 'Shock', type: 'range', min: 0, max: 100, default: 0 },
    { id: 'vibro', label: 'Vibro', type: 'range', min: 0, max: 100, default: 0 },
    { id: 'sound', label: 'Sound', type: 'range', min: 0, max: 100, default: 0 },
    { id: 'find',  label: 'Find',  type: 'action' },
  ],

  progressiveControlId: 'shock',

  buildCommand(values) {
    if (values.find) {
      return { buffer: Buffer.from([0xEE, 0x02, 0xBB]), repeat: false };
    }
    const shock = Math.max(0, Math.min(100, Math.round(values.shock || 0)));
    const vibro = Math.max(0, Math.min(100, Math.round(values.vibro || 0)));
    const sound = Math.max(0, Math.min(100, Math.round(values.sound || 0)));
    return {
      buffer: Buffer.from([0xAA, 0x07, shock, vibro, sound, 0xBB]),
      repeat: true,
      repeatDelay: 300,
    };
  },

  buildBatteryRequest() {
    return Buffer.from([0xDD, 0xAA, 0xBB]);
  },

  parseNotification(data) {
    if (data.length >= 6 && data[0] === 0xAA && data[1] === 0x07) {
      return { type: 'battery', level: data[5] };
    }
    return null;
  },
};
