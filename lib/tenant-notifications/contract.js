'use strict';

const { createHash } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const SHORT = 30 * 1000, SUCCESS = 15 * 60 * 1000;
function integer (value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Explicit positive ' + name + ' required');
  return value;
}
function instant (value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Explicit nonnegative notification instant required');
  return value;
}
function tenant (value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('Notification tenant UUID required');
  return value;
}
function text (value, name, max = 1024) {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new TypeError('Notification ' + name + ' required');
  return value;
}
function digest (value) { return createHash('sha256').update(value).digest('hex'); }
function notification (input, maxBytes) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Notification object required');
  // The plugin implementation graph is not a delivery payload. Preserve its name.
  const data = { ...input, ...(input.plugin ? { plugin: { name: text(input.plugin.name, 'plugin', 256) } } : {}) };
  text(data.title, 'title');
  if (typeof data.message !== 'string') throw new TypeError('Notification message required');
  if (data.clear !== true && (!Number.isInteger(data.level) || !data.plugin)) throw new TypeError('Notification level/plugin required');
  data.group = data.group || 'default'; text(data.group, 'group', 256);
  if (data.notifyhash) text(data.notifyhash, 'notifyhash', 512);
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized) > integer(maxBytes, 'maxPayloadBytes')) throw new Error('NOTIFICATION_PAYLOAD_BOUND');
  return JSON.parse(serialized);
}
function key (data) {
  // Match pushnotify: clear is handled before normal dedup, and may omit level/plugin.
  if (data.clear === true) return 'clear:' + data.group;
  if (data.notifyhash) return String(data.notifyhash);
  if (!data.isAnnouncement && [1, 2].includes(data.level)) return data.plugin.name + '_' + data.level;
  return createHash('sha1').update(JSON.stringify({ title: data.title, message: data.message })).digest('hex');
}
function sameEffect (a, b) {
  return key(a) === key(b) && a.group === b.group && a.level === b.level && !!a.clear === !!b.clear;
}
module.exports = { UUID, NAME, SHORT, SUCCESS, integer, instant, tenant, text, digest, notification, key, sameEffect };
