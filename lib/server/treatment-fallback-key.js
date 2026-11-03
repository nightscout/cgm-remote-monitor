'use strict';

// The selector a treatment write is matched by when it carries no
// `identifier` and no `_id` (BF-121, issue #8185).
//
// It starts from created_at + eventType, which on its own lets two entries
// recorded at the same time with the same type replace each other. Two rules
// are added:
//
// - Client identity. A client that tells its records apart sends one of
//   CLIENT_IDS (Loop `syncIdentifier`, Trio `id`, xDrip+ `uuid`, NSClient
//   `NSCLIENT_ID`). Each one the write carries must equal the stored value, so
//   a re-send with the same identity still updates its record in place and an
//   entry with another identity is kept beside it. A write that carries none
//   matches only a record that has none, and no `identifier` either, so it
//   cannot replace a Loop, Trio or API v3 record.
// - Amounts (`withAmounts`). For a write with no client identity, `carbs` and
//   `insulin` must also be equal: an identical re-send still matches, and a
//   different amount at the same time is a second entry. Used by the API v1
//   storage only; the socket's dbAdd does not use it (see websocket.js).
//
// The client identity rule alone (`identityQuery`) is also part of the
// socket's "similar" match (BF-209), so a record with another identity
// within its window is not taken for this one. There, with `{ identifier:
// true }`, a write that carries an `identifier` matches only a record with the
// same `identifier`: the socket's exact match never matches such a write, so
// the similar match is what recognises its re-send.
//
// Values are compared as given: the API v1 storage calls this after
// prepareData, which makes carbs and insulin numbers and drops them when zero.

var CLIENT_IDS = ['syncIdentifier', 'id', 'uuid', 'NSCLIENT_ID'];
var AMOUNTS = ['carbs', 'insulin'];

function literal (value) {
  return { $eq: value };
}

function present (value) {
  return value !== undefined && value !== null && value !== '';
}

function clientIdentities (obj) {
  return CLIENT_IDS.filter(function (field) {
    return present(obj[field]);
  });
}

// The client identity part of the selector: each identity the write carries
// must be equal, and a write that carries none matches only a record that has
// none (and no `identifier`). With options.identifier, an `identifier` the
// write carries decides instead: only a record with the same one matches; and
// a write that carries none also matches a record whose `identifier` is
// options.computedIdentifier (BF-225).
function identityQuery (obj, options) {
  var query = {};
  if (options && options.identifier && present(obj.identifier)) {
    query.identifier = literal(obj.identifier);
    return query;
  }
  var identities = clientIdentities(obj);
  if (identities.length > 0) {
    identities.forEach(function (field) {
      query[field] = literal(obj[field]);
    });
    return query;
  }
  CLIENT_IDS.concat(['identifier']).forEach(function (field) {
    // Match the same empty forms present() recognises. Exclude arrays:
    // MongoDB's $in would otherwise match a genuine identity beside ''/null.
    query[field] = { $in: [null, ''], $not: { $type: 'array' } };
  });
  // BF-225: with options.computedIdentifier (the socket's similar match), a
  // record whose `identifier` is that value also matches: it is the one API
  // v3 computed for this same body, so the write is that record's re-send.
  if (options && options.identifier && present(options.computedIdentifier)) {
    query.identifier.$in.push(options.computedIdentifier);
  }
  return query;
}

function fallbackQuery (obj, createdAt, options) {
  var query = Object.assign({
    created_at: literal(createdAt)
    , eventType: literal(obj.eventType)
  }, identityQuery(obj));
  if (clientIdentities(obj).length > 0) {
    return query;
  }
  if (options && options.withAmounts) {
    AMOUNTS.forEach(function (field) {
      query[field] = literal(present(obj[field]) ? obj[field] : null);
    });
  }
  return query;
}

module.exports = {
  CLIENT_IDS: CLIENT_IDS
  , AMOUNTS: AMOUNTS
  , fallbackQuery: fallbackQuery
  , identityQuery: identityQuery
};
