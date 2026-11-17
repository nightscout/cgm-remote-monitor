'use strict';

const validation = require('../server/write-validation');
const MAX_DATE = 8640000000000000;
// Diagnostic threshold, not a rejection rule: batches and clock rollback can
// legitimately put the monotonic history clock ahead of wall time.
const FUTURE_SKEW = 24 * 60 * 60 * 1000;

function number(value) {
  if (value !== null && typeof value === 'object') return NaN;
  return Number(value);
}

function date(value) {
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) return NaN;
  return new Date(value).getTime();
}

function identifier(value) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && value._bsontype === 'ObjectId' && typeof value.toHexString === 'function') return value.toHexString();
  return undefined;
}

// Compare stored identities without invoking a database object's coercion
// methods. Embedded BSON ids stay embedded; their ordered JSON representation
// is used only for equality, never exposed as a new client identifier.
function sameIdentity(a, b) {
  if (a == null || b == null || a === '' || b === '') return false;
  const left = identifier(a), right = identifier(b);
  if (left !== undefined || right !== undefined) return left !== undefined && left === right;
  return typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b);
}

// Pure and non-mutating. Only field/rule names leave the inspector; callers
// choose whether to expose aggregate diagnostics or run an operator report.
// partial avoids reporting absent fields in a projected API response.
function inspect(doc, {now = Date.now(), partial = false} = {}) {
  const issues = [];
  const add = (rule, field) => issues.push({rule, field});
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    add('record-shape', 'record');
    return issues;
  }
  if (doc._id != null && identifier(doc._id) === undefined) add('identity-shape', '_id');
  if (doc.identifier != null && typeof doc.identifier !== 'string') add('identity-shape', 'identifier');
  for (const field of ['srvModified', 'srvCreated']) {
    if (doc[field] === undefined) continue;
    const value = doc[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= MAX_DATE) {
      add('server-time-shape', field);
    } else if (value > now + FUTURE_SKEW) add('server-time-future', field);
  }
  for (const field of ['created_at', 'sysTime', 'startDate']) {
    if (doc[field] !== undefined && !Number.isFinite(date(doc[field]))) add('date-shape', field);
  }
  for (const field of ['mills', 'duration', 'durationInMilliseconds', 'endmills']) {
    if (doc[field] != null && !Number.isFinite(number(doc[field]))) add('number-shape', field);
  }
  if (doc.eventType === 'Temporary Target' && (!partial
    || validation.DOMAIN_FIELDS.every(field => Object.prototype.hasOwnProperty.call(doc, field)))) {
    validation.candidate(doc).problems.forEach(({rule, field}) => add(rule, field));
  }
  return issues;
}

function summarize(docs, options) {
  const rules = Object.create(null);
  let flagged = 0;
  for (const doc of docs) {
    const issues = inspect(doc, options);
    if (issues.length) flagged++;
    for (const {rule} of issues) rules[rule] = (rules[rule] || 0) + 1;
  }
  return {records: docs.length, flagged, rules};
}

// Invalid legacy values may still be returned for diagnosis, but cannot be
// used to fabricate an ETag such as W/"NaN" or an Invalid Date header.
function historyWatermark(docs) {
  let latest;
  for (const doc of docs) {
    const value = doc && doc.srvModified;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < MAX_DATE
      && (latest === undefined || value > latest)) latest = value;
  }
  return latest;
}

function setHeader(res, data, options = {partial: true}) {
  if (options.enabled !== true) return;
  const report = summarize(Array.isArray(data) ? data : [data], options);
  if (report.flagged && !(res.hasHeader && res.hasHeader('Nightscout-Data-Warnings'))) {
    res.setHeader('Nightscout-Data-Warnings', Object.entries(report.rules)
      .map(([rule, count]) => rule + '=' + count).join(', '));
  }
}

module.exports = {sameIdentity, historyWatermark, inspect, summarize, setHeader, number, date, identifier, FUTURE_SKEW};
