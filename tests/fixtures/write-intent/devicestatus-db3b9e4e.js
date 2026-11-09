// The pre-move lib/server/devicestatus.js at dev db3b9e4e, kept as the reference the
// write step is compared with (tests/write-intent.v1-collections.test.js).
// Only the require paths differ from that file. Not loaded by the server.
'use strict';

const writeStep = require('../../../lib/storage/write-step');

const READ_OPTIONS = require('../../../lib/storage/mongo-read-options');

var moment = require('moment');
var find_options = require('../../../lib/server/query');
var runWithCallback = require('../../../lib/storage/run-with-callback');
var purifyForStorage = require('../../../lib/server/storage-purifier');
var reads = require('../../../lib/server/storage-reads');
var writes = require('../../../lib/server/storage-writes');
var idForms = require('../../../lib/server/object-id-forms');
var srvDates = require('../../../lib/server/srv-dates');
var softDeleted = require('../../../lib/server/soft-deleted');

function truncatePredictions (obj, maxSize) {
  if (!maxSize || maxSize <= 0) return obj;
  
  if (obj && obj.openaps && obj.openaps.suggested && obj.openaps.suggested.predBGs) {
    var predBGs = obj.openaps.suggested.predBGs;
    var predictionTypes = ['IOB', 'COB', 'UAM', 'ZT'];
    
    predictionTypes.forEach(function(type) {
      if (Array.isArray(predBGs[type]) && predBGs[type].length > maxSize) {
        predBGs[type] = predBGs[type].slice(0, maxSize);
      }
    });
  }
  
  if (obj && obj.openaps && obj.openaps.enacted && obj.openaps.enacted.predBGs) {
    var enactedPredBGs = obj.openaps.enacted.predBGs;
    predictionTypes = ['IOB', 'COB', 'UAM', 'ZT'];
    
    predictionTypes.forEach(function(type) {
      if (Array.isArray(enactedPredBGs[type]) && enactedPredBGs[type].length > maxSize) {
        enactedPredBGs[type] = enactedPredBGs[type].slice(0, maxSize);
      }
    });
  }
  
  return obj;
}

function storage (env, ctx) {

  var collection = env.devicestatus_collection;
  var predictionsMaxSize = env.predictionsMaxSize || null;

  // A devicestatus _id is an ObjectId: a 24-hex string _id is stored as the
  // ObjectId it names, as treatments do, so find[_id] and DELETE by id find
  // the record that was created. An id already stored, in either form (a
  // string before this conversion, or by the websocket), names a record that
  // is already there: a re-sent status is answered with the id it is stored
  // under and not written again, and the other statuses in the same batch are
  // stored. The re-sent copy's fields are not written: a status is a snapshot,
  // and its _id names the one already stored. Re-sending a status is how an
  // uploader retries; before, the copy either collided and failed the whole
  // batch, or was stored a second time beside the first. One indexed read per
  // batch, only for a batch that carries 24-hex _ids. Returns the statuses to
  // insert.
  async function withoutStoredIds (statuses) {
    var hexIds = statuses.map(function (obj) { return obj._id; }).filter(idForms.isHexId);
    if (hexIds.length === 0) return statuses;

    var forms = [];
    hexIds.forEach(function (id) { forms.push.apply(forms, idForms.idForms(id)); });
    var stored = await reads.findAll(store(), { _id: { $in: forms } }, { projection: { _id: 1 } });
    var storedAs = {};
    stored.forEach(function (doc) {
      var key = String(doc._id);
      // Prefer the ObjectId form when both halves of a twin are stored.
      if (!Object.prototype.hasOwnProperty.call(storedAs, key) || typeof doc._id !== 'string') {
        storedAs[key] = doc._id;
      }
    });

    var seen = {};
    return statuses.filter(function (obj) {
      if (!idForms.isHexId(obj._id)) return true;
      var kept = idForms.stringIdForms(obj._id).filter(function (form) {
        return Object.prototype.hasOwnProperty.call(storedAs, form);
      });
      var hex = obj._id.toLowerCase();
      if (kept.length > 0) {
        obj._id = storedAs[kept[0]];
        return false;
      }
      obj._id = idForms.toStoredId(obj._id);
      // The same new id twice in one batch: store the first.
      if (seen[hex]) return false;
      seen[hex] = true;
      return true;
    });
  }

  // A client identifier a status can be matched on: a non-empty string.
  function hasIdentifier (obj) {
    return typeof obj.identifier === 'string' && obj.identifier !== '';
  }

  // A status that carries an identifier already stored names a status that is
  // already there: it is acknowledged with the stored _id and not written
  // again, as a re-sent _id is (withoutStoredIds). Nothing is merged, no
  // record is added and the stored status's srvModified is unchanged: a
  // status is a snapshot, and its identifier names the one already stored
  // (ID-SIMPLE-MATCH, devicestatus option (b), decided 2026-10-26). A status
  // whose identifier an earlier status in the same batch carries is answered
  // with that status's _id once it is stored. Every other status, including
  // one with a new identifier, goes through withoutStoredIds and is inserted
  // as before. One indexed read per batch, only for a batch that carries
  // identifiers. Returns { insert, repeats }: the statuses to insert, and the
  // in-batch repeats with the status each repeats.
  async function withoutStoredIdentifiers (statuses) {
    var identifiers = [];
    statuses.forEach(function (obj) {
      if (hasIdentifier(obj) && identifiers.indexOf(obj.identifier) === -1) identifiers.push(obj.identifier);
    });
    if (identifiers.length === 0) return { insert: statuses, repeats: [] };

    var stored = await reads.findAll(store(), { identifier: { $in: identifiers } }
      , { projection: { _id: 1, identifier: 1 }, sort: { _id: 1 } });
    var storedAs = {};
    stored.forEach(function (doc) {
      if (!Object.prototype.hasOwnProperty.call(storedAs, doc.identifier)) storedAs[doc.identifier] = doc._id;
    });

    var firstInBatch = {};
    var insert = [];
    var repeats = [];
    statuses.forEach(function (obj) {
      if (!hasIdentifier(obj)) {
        insert.push(obj);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(storedAs, obj.identifier)) {
        obj._id = storedAs[obj.identifier];
        return;
      }
      if (Object.prototype.hasOwnProperty.call(firstInBatch, obj.identifier)) {
        repeats.push({ status: obj, first: firstInBatch[obj.identifier] });
        return;
      }
      firstInBatch[obj.identifier] = obj;
      insert.push(obj);
    });
    return { insert: insert, repeats: repeats };
  }

  function create (statuses, fn) {

    if (!Array.isArray(statuses)) { statuses = [statuses]; }

    if (statuses.length === 0) {
      if (typeof fn === 'function') return fn(null, []);
      return Promise.resolve([]);
    }

    try {
      purifyForStorage(ctx, statuses);
    } catch (err) {
      if (typeof fn === 'function') return fn(err, []);
      return Promise.reject(err);
    }

    // Prepare all documents before insert
    statuses.forEach(function(obj) {
      var d = moment(obj.created_at).isValid() ? moment.parseZone(obj.created_at) : moment();
      obj.created_at = d.toISOString();
      obj.utcOffset = d.utcOffset();
      truncatePredictions(obj, predictionsMaxSize);
    });

    return runWithCallback(async function () {
      var insertResult;

      var toInsert;
      var repeats;
      try {
        var split = await withoutStoredIdentifiers(statuses);
        repeats = split.repeats;
        toInsert = await withoutStoredIds(split.insert);
      } catch (err) {
        console.log('Error reading device status ids', err.message);
        throw err.message || err;
      }

      if (toInsert.length > 0) {
        // API v3 history reads these (see srv-dates).
        toInsert.forEach(srvDates.stampCreated);
        var sentIds = toInsert.map(function (obj) { return obj._id !== undefined; });
        try {
          // Unordered, so a status another request stored meanwhile under the
          // same _id (an uploader retrying before its first POST returned)
          // does not stop the rest of the batch.
          insertResult = await store().insertMany(toInsert, { ordered: false });
        } catch (err) {
          var writeErrors = [].concat(err.writeErrors || []);
          var alreadyStored = writeErrors.length > 0 && writeErrors.every(function (writeError) {
            return writeError.code === 11000 && sentIds[writeError.index];
          });
          if (!alreadyStored) {
            console.log('Error inserting device status objects', err.message);
            throw err.message || err;
          }
          var stored = writeErrors.map(function (writeError) { return writeError.index; });
          toInsert = toInsert.filter(function (obj, index) { return stored.indexOf(index) === -1; });
          insertResult = null;
        }

        // Assign _ids from insertMany result
        if (insertResult && insertResult.insertedIds) {
          Object.keys(insertResult.insertedIds).forEach(function(index) {
            toInsert[index]._id = insertResult.insertedIds[index];
          });
        }
      }

      repeats.forEach(function (repeat) {
        repeat.status._id = repeat.first._id;
      });

      if (toInsert.length === 0) {
        return statuses;
      }

      // Emit data-update for all inserted documents
      ctx.bus.emit('data-update', {
        type: 'devicestatus'
        , op: 'update'
        , changes: ctx.ddata.processRawDataForRuntime(toInsert)
      });

      ctx.bus.emit('data-received');
      return statuses;
    }, fn);
  }

  function last (fn) {
    return list({ count: 1 }, function(err, entries) {
      if (entries && entries.length > 0) {
        fn(err, entries[0]);
      } else {
        fn(err, null);
      }
    });
  }

  // Reads leave out deleted records (isValid: false; see soft-deleted).
  function query_for (opts) {
    return softDeleted.visible(stored_query_for(opts), opts);
  }

  // Every stored record the query names, deleted or not: what DELETE removes.
  function stored_query_for (opts) {
    var asked = opts && opts.find && opts.find._id;
    // find[_id]=<hex> (also used by DELETE /devicestatus/:id) comes back as
    // an ObjectId; also match a record stored with the same id as a string.
    return idForms.matchEitherForm(find_options(opts, storage.queryOpts), asked);
  }

  function list (opts, fn) {
    // these functions, find, sort, and limit, are used to
    // dynamically configure the request, based on the options we've
    // been given

    // determine sort options
    function sort () {
      return opts && opts.sort || { created_at: -1 };
    }

    // Through the storage interface; count, sort and read options as before
    // (lib/server/storage-reads.js).
    return runWithCallback(function () {
      return reads.list(store(), query_for(opts)
        , { sort: sort(), count: opts && opts.count, readOptions: READ_OPTIONS });
    }, fn);
  }

  function remove (opts, fn) {
    // The id as asked: query_for rewrites opts.find._id into a filter.
    var asked = opts && opts.find ? opts.find._id : undefined;

    return runWithCallback(async function () {
      var stat = await writes.remove(store(), stored_query_for(opts));
      console.log('removed', null, stat);
      ctx.bus.emit('data-update', {
        type: 'devicestatus'
        , op: 'remove'
        , count: stat.deletedCount
        , changes: idForms.cacheRemoval(asked, stat.deletedCount)
      });

      // CHANGED with the dev 305a6533 merge (#8880, BF-214): a remove
      // reloads, as dev's devicestatus.js does.
      ctx.bus.emit('data-received');
      return stat;
    }, fn);
  }

  // Reads and writes go through the storage interface, labelled 'v1/internal'
  // (lib/server/storage-reads.js, lib/server/storage-writes.js).
  function store () {
    return reads.collection(ctx, env, collection, 'devicestatus');
  }

  // The handle tests seed through; lib/server/aggregate.js counts through store().
  function api () {
    return writeStep.collection(ctx.store.collection(collection), {name: 'devicestatus',
      source: 'v1/internal', bus: ctx.bus});
  }

  api.list = list;
  api.create = create;
  api.query_for = query_for;
  api.last = last;
  api.remove = remove;
  api.aggregate = require('../../../lib/server/aggregate')(api, store);
  api.indexedFields = [
    'created_at'



  
    , 'NSCLIENT_ID'
    , { 'created_at': -1, 'identifier': -1, 'date': -1 }
  ];
  return api;
}

storage.queryOpts = {
  collection: 'devicestatus'
  , dateField: 'created_at'
};

module.exports = storage;
