'use strict';

// One rule for a record's `_id` when it is a 24-hex id.
//
// A record's `_id` is a MongoDB ObjectId. A client may send its own `_id` as
// the 24-hex string form of one; storage keeps it as the ObjectId it names
// (`toStoredId`). Records stored before a collection did that may hold the
// same id as the string itself. Reads, edits and deletes by id match either
// form (`idForms`, `matchEitherForm`), and an edit that upserts the ObjectId
// form then removes the string form (`staleStringForms`,
// `withStaleStringsRemoved`), so those records can be found, replaced and
// removed with no database step.
//
// This module covers 24-hex ids only. What happens to an `_id` that is a
// string but NOT 24-hex (for example a UUID) differs by collection, on
// purpose, and stays in each collection:
//
// - treatments and entries (REQ-SYNC-072): the string is dropped from `_id`
//   so the server makes an ObjectId, and it is moved to `identifier` when
//   UUID_HANDLING is on.
// - profile, devicestatus, food and activity: the v1 routes refuse it with
//   400 before storage (lib/api/shared/objectid-validation.js); a storage call
//   from inside the server keeps it as given.
// - API v3 addresses records by `identifier`; a 24-hex identifier also
//   matches a record by `_id` (lib/api3/storage/mongoCollection/utils.js).

var ObjectID = require('mongodb').ObjectId;

var OBJECT_ID_HEX_RE = /^[0-9a-fA-F]{24}$/;

function isHexId (id) {
  return typeof id === 'string' && OBJECT_ID_HEX_RE.test(id);
}

// A 24-hex string _id becomes the ObjectId it names; anything else is kept.
function toStoredId (id) {
  return isHexId(id) ? new ObjectID(id) : id;
}

// Every form the same id can have on disk:
// [ObjectId, lower-case hex, the string as given if it differs].
// `id` is an ObjectId or a 24-hex string; anything else throws, as
// `new ObjectId(id)` does.
function idForms (id) {
  var objId = id instanceof ObjectID ? id : new ObjectID(id);
  var hex = objId.toHexString();
  var forms = [objId, hex];
  if (typeof id === 'string' && id !== hex) {
    forms.push(id);
  }
  return forms;
}

function stringIdForms (id) {
  return idForms(id).filter(function (form) { return typeof form === 'string'; });
}

// For a query built by lib/server/query.js: find[_id]=<hex> comes back as
// an ObjectId equality. Widen it to also match the same id stored as a
// string. `asked` is the caller's own value, so an upper-case string on
// disk is matched too. Any other query is returned unchanged.
function matchEitherForm (query, asked) {
  if (query && query._id instanceof ObjectID) {
    query._id = { $in: idForms(isHexId(asked) ? asked : query._id) };
  }
  return query;
}

// The string forms to delete after upserting records by these ids. An upsert
// by the ObjectId form cannot see a record whose _id is the string, so the
// write would otherwise leave the old record beside the new one. Delete after
// the upsert, so the record is never absent between the two writes. Ids that
// are neither 24-hex strings nor ObjectIds are skipped.
function staleStringForms (ids) {
  var stale = [];
  ids.forEach(function (id) {
    if (isHexId(id) || id instanceof ObjectID) {
      stale.push.apply(stale, stringIdForms(id));
    }
  });
  return stale;
}

// Append that delete to a bulkWrite, after the upserts it follows.
function withStaleStringsRemoved (bulkOps, ids) {
  var stale = staleStringForms(ids);
  if (stale.length > 0) {
    bulkOps.push({ deleteMany: { filter: { _id: { $in: stale } } } });
  }
  return bulkOps;
}

module.exports = {
  OBJECT_ID_HEX_RE: OBJECT_ID_HEX_RE
  , isHexId: isHexId
  , toStoredId: toStoredId
  , idForms: idForms
  , stringIdForms: stringIdForms
  , matchEitherForm: matchEitherForm
  , staleStringForms: staleStringForms
  , withStaleStringsRemoved: withStaleStringsRemoved
};
