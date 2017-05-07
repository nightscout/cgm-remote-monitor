'use strict';

var _ = require('lodash');
var async = require('async');

var find_options = require('./query');

function storage (env, ctx) {
  var ObjectID = require('mongodb').ObjectID;

  function create (objOrArray, fn) {

    function done (err, result) {
      ctx.bus.emit('data-received');
      fn(err, result);
    }

    if (_.isArray(objOrArray)) {
      async.eachSeries(objOrArray, function (obj, callback) {
        upsert(obj, function upserted (err, docs) {
          callback(err, docs)
        });
      }, function (err, docs) {
        done(err, docs);
      });
    } else {
      upsert(objOrArray, function upserted (err, docs) {
        done(err, docs);
      });
    }


  }

  function upsert (obj, fn) {

    var results = prepareData(obj);

    var query  = {
      created_at: results.created_at
      , eventType: obj.eventType
    };

    api( ).update(query, obj, {upsert: true}, function complete (err, updateResults) {
      if (!err) {
        if (updateResults.result.upserted) {
          obj._id = updateResults.result.upserted[0]._id
        }
      }

      if (!err && obj.preBolus) {
        //create a new object to insert copying only the needed fields
        var pbTreat = {
          created_at: (new Date(new Date(results.created_at).getTime() + (obj.preBolus * 60000))).toISOString(),
          eventType: obj.eventType,
          carbs: results.preBolusCarbs
        };

        if (obj.notes) {
          pbTreat.notes = obj.notes;
        }

        query.created_at = pbTreat.created_at;
        api( ).update(query, pbTreat, {upsert: true}, function pbComplete (err) {
          var treatments = _.compact([obj, pbTreat]);
          fn(err, treatments);
        });
      } else {
        fn(err, [obj]);
      }

    });
  }

  function list (opts, fn) {

    function limit ( ) {
      if (opts && opts.count) {
        return this.limit(parseInt(opts.count));
      }
      return this;
    }

    return limit.call(api()
      .find(query_for(opts))
      .sort(opts && opts.sort || {created_at: -1}), opts)
      .toArray(fn);
  }

  function query_for (opts) {
    return find_options(opts, storage.queryOpts);
  }


  function remove (_id, fn) {
    api( ).remove({ '_id': new ObjectID(_id) }, fn);

    ctx.bus.emit('data-received');
  }

  function save (obj, fn) {
    obj._id = new ObjectID(obj._id);
    prepareData(obj);
    api().save(obj, fn);

    ctx.bus.emit('data-received');
  }

  function api ( ) {
    return ctx.store.collection(env.treatments_collection);
  }

  api.list = list;
  api.create = create;
  api.query_for = query_for;
  api.indexedFields = [
    'created_at'
    , 'eventType'
    , 'insulin'
    , 'carbs'
    , 'glucose'
    , 'enteredBy'
    , 'boluscalc.foods._id'
    , 'notes'
  ];

  api.remove = remove;
  api.save = save;
  api.aggregate = require('./aggregate')({ }, api);

  return api;
}

function prepareData(obj) {

  var results = {
    //TODO: validate format of created_at
    created_at: obj.created_at || new Date().toISOString()
    , preBolusCarbs: ''
  };

  obj.glucose = Number(obj.glucose);
  obj.targetTop = Number(obj.targetTop);
  obj.targetBottom = Number(obj.targetBottom);
  obj.carbs = Number(obj.carbs);
  obj.insulin = Number(obj.insulin);
  obj.duration = Number(obj.duration);
  obj.percent = Number(obj.percent);
  obj.absolute = Number(obj.absolute);
  obj.relative = Number(obj.relative);
  obj.preBolus = Number(obj.preBolus);

  //NOTE: the eventTime is sent by the client, but deleted, we only store created_at right now
  var eventTime;
  if (obj.eventTime) {
    eventTime = new Date(obj.eventTime).toISOString();
    results.created_at = eventTime;
  }

  obj.created_at = results.created_at;
  if (obj.preBolus && obj.preBolus !== 0 && obj.carbs) {
    results.preBolusCarbs = obj.carbs;
    delete obj.carbs;
  }

  if (obj.eventType === 'Announcement') {
    obj.isAnnouncement = true;
  }

  // clean data
  delete obj.eventTime;

  function deleteIfEmpty (field) {
    if (!obj[field] || obj[field] === 0) {
      delete obj[field];
    }
  }

  function deleteIfNaN (field) {
    if (isNaN(obj[field])) {
      delete obj[field];
    }
  }

  deleteIfEmpty('targetTop');
  deleteIfEmpty('targetBottom');
  deleteIfEmpty('carbs');
  deleteIfEmpty('insulin');
  deleteIfEmpty('percent');
  deleteIfEmpty('relative');
  deleteIfEmpty('notes');
  deleteIfEmpty('preBolus');

  deleteIfNaN('absolute');
  deleteIfNaN('duration');

  if (obj.glucose === 0 || isNaN(obj.glucose)) {
    delete obj.glucose;
    delete obj.glucoseType;
    delete obj.units;
  }

  return results;
}

storage.queryOpts = {
  walker: {
    insulin: parseInt
    , carbs: parseInt
    , glucose: parseInt
    , notes: find_options.parseRegEx
    , eventType: find_options.parseRegEx
    , enteredBy: find_options.parseRegEx
  }
  , dateField: 'created_at'
};

module.exports = storage;
