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

function fallbackQuery (obj, createdAt, options) {
  var query = {
    created_at: literal(createdAt)
    , eventType: literal(obj.eventType)
  };
  var identities = CLIENT_IDS.filter(function (field) {
    return present(obj[field]);
  });
  if (identities.length > 0) {
    identities.forEach(function (field) {
      query[field] = literal(obj[field]);
    });
    return query;
  }
  CLIENT_IDS.concat(['identifier']).forEach(function (field) {
    query[field] = literal(null);
  });
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
};
