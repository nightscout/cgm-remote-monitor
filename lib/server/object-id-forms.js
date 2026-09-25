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
// Limit: the string forms matched are the lower-case hex and the spelling the
// caller used. A string _id stored in upper (or mixed) case is found when it
// is asked for in that same spelling, and not when it is asked for in lower
// case; the ObjectId form of the same id is found either way. Upper-case
// string _ids exist only where a client sent upper-case hex before a
// collection converted it. Adding more spellings here would widen every
// lookup that uses these forms.
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
// - the websocket (lib/server/websocket.js) keeps it as given and matches it
//   exactly.
// - API v3 addresses records by `identifier`; an identifier also matches a
//   record without one by `_id`: a 24-hex identifier in either form, any other
//   string exactly (lib/api3/storage/mongoCollection/utils.js).

var ObjectID = require('mongodb').ObjectId;

var OBJECT_ID_HEX_RE = /^[0-9a-fA-F]{24}$/;

function isHexId (id) {
  return typeof id === 'string' && OBJECT_ID_HEX_RE.test(id);
}

// A record sent with `_id: null`, an empty string, a number, a boolean, or an
// object that is not an ObjectId has no usable id. Drop the field so storage
// assigns one: an upsert, unlike an insert, stores the _id it is given, a
// stored null _id cannot be read back as a record's id, and no id route can
// address the others. An ObjectId made by another copy of the bson package
// (`_bsontype`, as the driver itself checks) is kept, and an Extended JSON
// `{"$oid": "<24 hex>"}` becomes the ObjectId it names.
function isObjectIdLike (id) {
  return id instanceof ObjectID || (id !== null && typeof id === 'object' && id._bsontype === 'ObjectId');
}

function dropEmptyId (doc) {
  // Extended JSON, as mongoexport writes it: {"$oid": "<24 hex>"} names that
  // ObjectId, so a restored record keeps its id.
  if (doc && doc._id !== null && typeof doc._id === 'object' && !isObjectIdLike(doc._id)
    && Object.keys(doc._id).length === 1 && isHexId(doc._id.$oid)) {
    doc._id = new ObjectID(doc._id.$oid);
  }
  if (doc && Object.prototype.hasOwnProperty.call(doc, '_id')
    && (doc._id === '' || (typeof doc._id !== 'string' && !isObjectIdLike(doc._id)))) {
    delete doc._id;
  }
  return doc;
}

// A 24-hex string _id becomes the ObjectId it names; anything else is kept.
function toStoredId (id) {
  return isHexId(id) ? new ObjectID(id) : id;
}

// Every form the same id can have on disk:
// [ObjectId, lower-case hex, the string as given if it differs].
// `id` is an ObjectId or a 24-hex string; anything else throws. The check is
// here and not left to `new ObjectId(id)`, which also accepts any
// 12-character string as 12 raw bytes.
function idForms (id) {
  if (!(id instanceof ObjectID) && !isHexId(id)) {
    throw new TypeError('not an ObjectId or a 24-hex string: ' + String(id));
  }
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

// The filter for one record by its `_id`: every form of a hex or ObjectId
// id, and any other value matched exactly as given.
function idFilter (id) {
  return (id instanceof ObjectID || isHexId(id)) ? { $in: idForms(id) } : { $eq: id };
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

// What a delete by `asked` reports to the in-memory cache
// (lib/server/cache.js) as the `changes` of its 'remove' event: the id of the
// one record removed, spelled as the cache holds it, or undefined, which makes
// the cache drop what it holds and reload. The cache removes only the first
// entry whose _id == the id, and an ObjectId compares equal to its lower-case
// hex, so a delete that removed more than one record (both copies of an id
// stored twice), an upper-case hex id, and an id that is not a string all
// reload. `asked` is the id as the caller sent it, before query.js turned it
// into a filter.
function cacheRemoval (asked, deletedCount) {
  if (deletedCount === 0) return asked;
  if (deletedCount !== 1) return undefined;
  if (asked instanceof ObjectID) return asked.toHexString();
  if (typeof asked !== 'string' || asked === '') return undefined;
  if (isHexId(asked) && asked !== asked.toLowerCase()) return undefined;
  return asked;
}

module.exports = {
  OBJECT_ID_HEX_RE: OBJECT_ID_HEX_RE
  , isHexId: isHexId
  , dropEmptyId: dropEmptyId
  , toStoredId: toStoredId
  , idForms: idForms
  , stringIdForms: stringIdForms
  , idFilter: idFilter
  , matchEitherForm: matchEitherForm
  , staleStringForms: staleStringForms
  , withStaleStringsRemoved: withStaleStringsRemoved
  , cacheRemoval: cacheRemoval
};
