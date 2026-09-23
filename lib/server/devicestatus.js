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
      // A devicestatus _id is an ObjectId: store a 24-hex string _id as the
      // ObjectId it names, as treatments do, so find[_id] and DELETE by id
      // find the record that was created. There is no check for the same id
      // already stored as a string: it would add a read to every create that
      // carries its own _id, which is every batch a Nightscout-to-Nightscout
      // connector writes. A record re-sent after its first copy was stored as
      // a string is stored beside it; find[_id] returns both and DELETE by id
      // removes both.
      if (idForms.isHexId(obj._id)) { obj._id = idForms.toStoredId(obj._id); }
    });

    return runWithCallback(async function () {
      var insertResult;

      try {
        // Use insertMany for batch insert
        insertResult = await api().insertMany(statuses, { ordered: true });
      } catch (err) {
        console.log('Error inserting device status objects', err.message);
        throw err.message || err;
      }

      // Assign _ids from insertMany result
      if (insertResult && insertResult.insertedIds) {
        Object.keys(insertResult.insertedIds).forEach(function(index) {
          statuses[index]._id = insertResult.insertedIds[index];
        });
      }

      // Emit data-update for all inserted documents
      ctx.bus.emit('data-update', {
        type: 'devicestatus'
        , op: 'update'
        , changes: ctx.ddata.processRawDataForRuntime(statuses)
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

    return runWithCallback(async function () {
      var stat = await api().deleteMany(query_for(opts));
      console.log('removed', null, stat);
      ctx.bus.emit('data-update', {
        type: 'devicestatus'
        , op: 'remove'
        , count: stat.deletedCount
        , changes: opts.find._id
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
