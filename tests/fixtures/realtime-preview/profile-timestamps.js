'use strict';
// Oracle only: default socket profile replace semantics, unchanged JSON request.
// The actual handler prepares missing created_at on EVERY dbAdd before dedup.
const assert = require('node:assert/strict');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function canonical (value) {
  if (value?._bsontype === 'ObjectId') return { objectId: value.toHexString() };
  if (value instanceof Date) return { date: value.toISOString() };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function id (doc) { assert(doc && own(doc, '_id'), 'PROFILE_TIMESTAMP_ID_REQUIRED'); return String(doc._id); }
function isoInWindow (value, window) {
  assert(window && Number.isSafeInteger(window.startedAt) && Number.isSafeInteger(window.finishedAt) && window.startedAt <= window.finishedAt, 'PROFILE_TIMESTAMP_OBSERVATION_WINDOW');
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  assert(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, 'PROFILE_GENERATED_CREATED_AT_INVALID');
  assert(parsed >= window.startedAt && parsed <= window.finishedAt, 'PROFILE_GENERATED_CREATED_AT_OUTSIDE_OPERATION');
}
function side ({ producer, before, after, reply, window }) {
  assert(Array.isArray(reply) && Array.isArray(reply[0]) && reply[0].length === 1, 'PROFILE_TIMESTAMP_SINGLE_REPLY_DOCUMENT');
  const shown = reply[0][0], matches = after.filter(doc => id(doc) === id(shown));
  assert.equal(matches.length, 1, 'PROFILE_REPLY_TIMESTAMP_UNIQUE_PHYSICAL_RECORD');
  const stored = matches[0], generated = !own(producer.data, 'created_at');
  if (generated) {
    assert(own(stored, 'created_at'), 'PROFILE_GENERATED_CREATED_AT_MISSING');
    isoInWindow(stored.created_at, window);
  } else {
    assert(own(stored, 'created_at'), 'PROFILE_CLIENT_CREATED_AT_MISSING');
    assert.deepEqual(stored.created_at, producer.data.created_at, 'PROFILE_CLIENT_CREATED_AT_PRESERVED');
  }
  for (const key of ['created_at', 'srvCreated', 'srvModified']) {
    assert.equal(own(shown, key), own(stored, key), 'PROFILE_REPLY_PHYSICAL_TIMESTAMP_PRESENCE_' + key);
    assert.deepEqual(shown[key], stored[key], 'PROFILE_REPLY_PHYSICAL_TIMESTAMP_VALUE_' + key);
  }
  // The selected default replacement carries server creation, not created_at.
  const previous = before.find(doc => id(doc) === id(stored));
  if (previous) {
    assert.equal(own(stored, 'srvCreated'), own(previous, 'srvCreated'), 'PROFILE_SERVER_CREATION_CARRIED_PRESENCE');
    assert.deepEqual(stored.srvCreated, previous.srvCreated, 'PROFILE_SERVER_CREATION_CARRIED');
  }
  for (const key of ['srvCreated', 'srvModified']) if (own(stored, key)) assert(Number.isSafeInteger(stored[key]) && stored[key] >= 0, 'PROFILE_SERVER_TIMESTAMP_INVALID_' + key);
  if (own(stored, 'srvCreated') && own(stored, 'srvModified')) assert(stored.srvCreated <= stored.srvModified, 'PROFILE_SERVER_TIMESTAMP_ORDER');
  // Unmatched preseed rows retain even absence; never normalize their fields.
  for (const doc of after) if (id(doc) !== id(stored)) {
    const prior = before.find(row => id(row) === id(doc));
    assert(prior, 'PROFILE_UNEXPECTED_UNRETURNED_INSERT');
    assert.deepEqual(canonical(doc), canonical(prior), 'PROFILE_UNTOUCHED_RECORD_PRESERVED');
  }
  const normalizeDocument = doc => {
    const result = canonical(doc);
    if (id(doc) === id(stored)) {
      if (generated) result.created_at = { oracle: 'validated-server-created-at' };
      for (const key of ['srvCreated', 'srvModified']) if (Number.isFinite(doc[key]) && doc[key] > 1e12) result[key] = 'server-clock';
    }
    return result;
  };
  const normalizedReply = canonical(reply); normalizedReply[0] = reply[0].map(normalizeDocument);
  return { reply: normalizedReply, documents: after.map(normalizeDocument).sort((a, b) => JSON.stringify(a._id).localeCompare(JSON.stringify(b._id))) };
}
function compare (operation) {
  const expected = side({ producer: operation.producer, before: operation.before.mongoRaw, after: operation.mongoRaw,
    reply: operation.expected, window: operation.windows.mongo });
  const actual = side({ producer: operation.producer, before: operation.before.pgDocuments, after: operation.pgDocuments,
    reply: operation.actual, window: operation.windows.postgres });
  assert.deepEqual(actual.reply, expected.reply, 'PROFILE_CALLBACK_PARITY verified generated clocks only');
  assert.deepEqual(actual.documents, expected.documents, 'PROFILE_PHYSICAL_PARITY verified generated clocks only');
}
module.exports = { compare, side, isoInWindow };
