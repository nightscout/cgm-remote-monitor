'use strict';

// The server's own write times, `srvModified` and `srvCreated`, on every write
// to a collection that API v3 serves (treatments, entries, devicestatus,
// profile and food), whichever API or process makes the write.
//
// API v3 history (GET /api/v3/<collection>/history/<ms>) returns the documents
// whose STORED `srvModified` is later than the reader's cursor, sorted by it,
// and the reader takes the largest value it received as its next cursor
// (lib/api3/generic/history/operation.js). A document written without the
// field is never returned by history, so a client that syncs by history (such
// as AndroidAPS NSClientV3) never receives it. The v3 handlers set the fields;
// the v1 routes, the websocket and in-process writers such as
// nightscout-connect write through lib/server/<collection>.js and
// lib/server/websocket.js, which use these helpers.
//
// Both fields are numbers: milliseconds since the epoch, as v3 sets them.
// `srvCreated` is written only when the server creates the document; a write
// that changes a stored document keeps the value it has (or its absence, for a
// document stored before this). A value a client sends for either field is
// replaced: the server owns them.
//
// `next()` never returns the same value twice in this process and never goes
// backwards, even when the clock does. History pages with `srvModified >
// cursor`, so two documents with the same value on either side of a page
// boundary would lose the second; a v1 batch stamped with one clock reading
// would lose everything past the first page. Consecutive values in a large
// batch can run ahead of the clock by one millisecond per document; later
// writes continue from there, so a reader's cursor never passes a value still
// to be assigned in this process. Boot restores the clock from stored records
// before any uploader or API can write, including after a clock rollback.

var last = 0;

async function restore (store, env) {
  var names = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'settings'];
  var latest = await Promise.all(names.map(async function (name) {
    var collection = store.collection(env[name + '_collection'] || name);
    // API v3 already indexes srvModified. Read at most one numeric timestamp
    // per collection; malformed legacy values must not hide the latest one.
    var doc = await collection.findOne({ srvModified: {
      $type: 'number', $gte: 0, $lt: 8640000000000000, $not: { $type: 'array' }
    } }, {
      projection: { srvModified: 1 }, sort: { srvModified: -1 }
    });
    return doc && doc.srvModified;
  }));
  latest.forEach(function (value) {
    if (Number.isFinite(value) && value > last) last = Math.ceil(value);
  });
}

function next () {
  var t = Date.now();
  if (t <= last) t = last + 1;
  last = t;
  return t;
}

// A document the server is about to insert.
function stampCreated (doc) {
  var t = next();
  doc.srvModified = t;
  doc.srvCreated = t;
  return t;
}

// The fields of an update ($set) to a stored document: a new srvModified, and
// no srvCreated, so the stored one is kept.
function stampModified (fields) {
  var t = next();
  fields.srvModified = t;
  delete fields.srvCreated;
  return t;
}

// The API v3 fields a replacement must keep from the document it replaces. A
// v1 PUT sends the whole document; a v1 client that does not know v3 fields
// leaves them out, and MongoDB's replaceOne would drop them. `identifier` is
// how a v3 client knows the record: without it v3 names the record by its
// _id, and the client would take it for a new record.
function carry (doc, stored, t) {
  doc.srvModified = t;
  if (stored) {
    if (stored.srvCreated !== undefined) {
      doc.srvCreated = stored.srvCreated;
    } else {
      delete doc.srvCreated;
    }
    if (stored.identifier !== undefined && stored.identifier !== null
      && (doc.identifier === undefined || doc.identifier === null)) {
      doc.identifier = stored.identifier;
    }
  } else {
    doc.srvCreated = t;
  }
}

// Equality as a MongoDB {$eq} filter sees it, for the values these filters
// hold: strings, numbers, ObjectIds and Dates. A string never equals an
// ObjectId, as in BSON.
function sameValue (a, b) {
  if (a === b) return true;
  // MongoDB's equality to null also matches an absent field.
  if (b === null && a === undefined) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  var aOid = typeof a === 'object' && a._bsontype === 'ObjectId';
  var bOid = typeof b === 'object' && b._bsontype === 'ObjectId';
  if (aOid || bOid) return aOid && bOid && String(a) === String(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return false;
}

// Whether a stored document matches a filter made of field equalities
// (`value` or `{$eq: value}`), `$or`, and the scalar empty-identity filter.
// Returns undefined for any other shape, so the caller asks MongoDB instead.
function matches (stored, filter) {
  var keys = Object.keys(filter);
  var result = true;
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var want = filter[key];
    var hit;
    if (key === '$or' && Array.isArray(want)) {
      hit = false;
      for (var j = 0; j < want.length; j++) {
        var branch = matches(stored, want[j]);
        if (branch === undefined) return undefined;
        if (branch) { hit = true; break; }
      }
    } else if (key.charAt(0) === '$' || key.indexOf('.') !== -1) {
      return undefined;
    } else {
      if (want !== null && typeof want === 'object' && !(want instanceof Date) && want._bsontype !== 'ObjectId') {
        var ops = Object.keys(want);
        if (ops.length === 2 && Array.isArray(want.$in)
          && want.$in.every(function (value) { return value === null || typeof value === 'string'; })
          && want.$not && Object.keys(want.$not).length === 1 && want.$not.$type === 'array') {
          // The fallback treatment key accepts null, absent and empty string,
          // but never an array containing an empty element.
          hit = !Array.isArray(stored[key]) && want.$in.some(function (value) {
            return sameValue(stored[key], value);
          });
          if (!hit) result = false;
          continue;
        }
        if (ops.length !== 1 || ops[0] !== '$eq') return undefined;
        want = want.$eq;
      }
      // Array equality also has element-matching semantics in MongoDB.
      if (Array.isArray(stored[key]) || Array.isArray(want)) return undefined;
      hit = sameValue(stored[key], want);
    }
    if (!hit) result = false;
  }
  return result;
}

function filterFields (filter, into) {
  Object.keys(filter).forEach(function (key) {
    if (key === '$or' && Array.isArray(filter[key])) {
      filter[key].forEach(function (branch) { filterFields(branch, into); });
    } else if (key.charAt(0) !== '$') {
      into[key] = 1;
    }
  });
  return into;
}

var CHUNK = 500;

// Stamp the replacement documents of replaceOne upserts. `items` is a list of
// { filter, doc }: the filter the replaceOne uses and the replacement it
// writes. The documents the filters name now are read first (one query per
// 500 items), and each replacement keeps their `srvCreated` and `identifier`
// (see carry) and gets a new `srvModified`. Call it right before the write, so
// the time between taking srvModified and storing it stays short.
async function carryForReplace (collection, items) {
  if (items.length === 0) return;

  var found = new Array(items.length);
  for (var start = 0; start < items.length; start += CHUNK) {
    var chunk = items.slice(start, start + CHUNK);
    var projection = { srvCreated: 1, identifier: 1 };
    chunk.forEach(function (item) { filterFields(item.filter, projection); });
    var stored = await collection.find(
      { $or: chunk.map(function (item) { return item.filter; }) }
      , { projection: projection }
    ).toArray();

    for (var k = 0; k < chunk.length; k++) {
      var index = start + k;
      var filter = chunk[k].filter;
      var hit = null;
      var exact = true;
      for (var s = 0; s < stored.length; s++) {
        var m = matches(stored[s], filter);
        if (m === undefined) { exact = false; break; }
        if (m) { hit = stored[s]; break; }
      }
      if (!exact) {
        hit = await collection.findOne(filter, { projection: { srvCreated: 1, identifier: 1 } });
      }
      found[index] = hit;
    }
  }

  items.forEach(function (item, index) {
    carry(item.doc, found[index], next());
  });
}

module.exports = {
  restore: restore,
  next: next,
  stampCreated: stampCreated,
  stampModified: stampModified,
  carry: carry,
  carryForReplace: carryForReplace,
  // exported for tests
  matches: matches
};
