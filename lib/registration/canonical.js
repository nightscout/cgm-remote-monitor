'use strict';

const crypto = require('crypto');

// RFC 8785 (JSON Canonicalization Scheme) for the values a registration
// holds: object members sorted by UTF-16 code units, no whitespace, strings
// and numbers as ECMAScript's JSON.stringify writes them (RFC 8785 §3.2.2
// takes both from ECMAScript). Undefined members are dropped, as in JSON.
function canonicalJSON (value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !isFinite(value)) {
      throw new TypeError('RFC 8785 has no form for ' + value);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(function (item) {
      return item === undefined ? 'null' : canonicalJSON(item);
    }).join(',') + ']';
  }
  const keys = Object.keys(value).filter(function (key) { return value[key] !== undefined; }).sort();
  return '{' + keys.map(function (key) {
    return JSON.stringify(key) + ':' + canonicalJSON(value[key]);
  }).join(',') + '}';
}

function sha256 (value) {
  return 'sha256:' + crypto.createHash('sha256').update(canonicalJSON(value), 'utf8').digest('hex');
}

// Registration §5.4: over {registration, state, boundTo}.
function etag (registration, state, boundTo) {
  return sha256({ registration: registration, state: state, boundTo: boundTo === undefined ? null : boundTo });
}

// Identity §2: a definition is content-addressed.
function definitionId (definition) {
  return sha256(definition);
}

function byteLength (value) {
  return Buffer.byteLength(canonicalJSON(value), 'utf8');
}

module.exports = { canonicalJSON, sha256, etag, definitionId, byteLength };
