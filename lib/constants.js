/**
 * UUID format conversion utility.
 */

function toNobleUuid(uuid) {
  return uuid.replace(/-/g, '').toLowerCase();
}

module.exports = { toNobleUuid };
