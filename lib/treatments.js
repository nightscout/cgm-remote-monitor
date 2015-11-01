'use strict';

var find_options = require('./query');

function storage (env, ctx) {
  var ObjectID = require('mongodb').ObjectID;

  function create (obj, fn) {

    var results = prepareData(obj);

    api( ).insert(obj, function (err, doc) {
      fn(null, doc);

      if (obj.preBolus) {
        //create a new object to insert copying only the needed fields
        var pbTreat = {
          created_at: (new Date(results.created_at.getTime() + (obj.preBolus * 60000))).toISOString(),
          eventType: obj.eventType,
          carbs: results.preBolusCarbs
        };

        if (obj.notes) {
          pbTreat.notes = obj.notes;
        }

        api( ).insert(pbTreat, function() {
          //nothing to do here
        });
      }

      //TODO: this is triggering a read from Mongo, we can do better
      ctx.bus.emit('data-received');

    });
  }

  function list (opts, fn) {
    return ctx.store.limit.call(api()
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
    return ctx.store.db.collection(env.treatments_collection);
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

  return api;
}

function prepareData(obj) {

  //NOTE: the eventTime is sent by the client, but deleted, we only store created_at right now
  var results = {
    created_at: new Date()
    , preBolusCarbs: ''
  };

  obj.glucose = Number(obj.glucose);
  obj.carbs = Number(obj.carbs);
  obj.insulin = Number(obj.insulin);
  obj.duration = Number(obj.duration);
  obj.percent = Number(obj.percent);
  obj.absolute = Number(obj.absolute);
  obj.preBolus = Number(obj.preBolus);

  var eventTime;
  if (obj.eventTime) {
    eventTime = new Date(obj.eventTime);
    results.created_at = eventTime;
  }
  
  obj.created_at = results.created_at.toISOString();
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

  deleteIfEmpty('carbs');
  deleteIfEmpty('insulin');
  deleteIfEmpty('duration');
  deleteIfEmpty('percent');
  deleteIfEmpty('notes');
  deleteIfEmpty('preBolus');

  //special handling for absolute to support temp to 0
  if (isNaN(obj.absolute)) {
    delete obj.absolute;
  }

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

