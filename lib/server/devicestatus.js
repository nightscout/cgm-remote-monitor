'use strict';

var moment = require('moment');
var find_options = require('./query');
var runWithCallback = require('../storage/run-with-callback');
var purifyForStorage = require('./storage-purifier');
var countParam = require('./count');
var idForms = require('./object-id-forms');

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
    var stored = await api().find({ _id: { $in: forms } }, { projection: { _id: 1 } }).toArray();
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
      try {
        toInsert = await withoutStoredIds(statuses);
      } catch (err) {
        console.log('Error reading device status ids', err.message);
        throw err.message || err;
      }

      if (toInsert.length > 0) {
        var sentIds = toInsert.map(function (obj) { return obj._id !== undefined; });
        try {
          // Unordered, so a status another request stored meanwhile under the
          // same _id (an uploader retrying before its first POST returned)
          // does not stop the rest of the batch.
          insertResult = await api().insertMany(toInsert, { ordered: false });
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

  function query_for (opts) {
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

    // configure the limit portion of the current query
    function limit () {
      return countParam.applyCount(this, opts);
    }

    return runWithCallback(function () {
      return limit.call(api()
        .find(query_for(opts))
        .sort(sort())
      ).toArray();
    }, fn);
  }

  function remove (opts, fn) {
    // The id as asked: query_for rewrites opts.find._id into a filter.
    var asked = opts && opts.find ? opts.find._id : undefined;

    return runWithCallback(async function () {
      var stat = await api().deleteMany(query_for(opts));
      console.log('removed', null, stat);
      ctx.bus.emit('data-update', {
        type: 'devicestatus'
        , op: 'remove'
        , count: stat.deletedCount
        , changes: idForms.cacheRemoval(asked, stat.deletedCount)
      });

      return stat;
    }, fn);
  }

  function api () {
    return ctx.store.collection(collection);
  }

  api.list = list;
  api.create = create;
  api.query_for = query_for;
  api.last = last;
  api.remove = remove;
  api.aggregate = require('./aggregate')({}, api);
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
