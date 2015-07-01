'use strict';

function storage (env, ctx) {

  function create (obj, fn) {

    //NOTE: the eventTime is sent by the client, but deleted, we only store created_at right now
    var created_at = new Date();
    var eventTime;

    if (obj.eventTime) {
      eventTime = new Date(obj.eventTime);
      created_at = eventTime;
    }

    obj.created_at = created_at.toISOString();

    var preBolusCarbs = '';
    if (obj.preBolus > 0 && obj.carbs) {
      preBolusCarbs = obj.carbs;
      delete obj.carbs;
    }

    // clean data
    delete obj.eventTime;
    if (!obj.carbs) delete obj.carbs;
    if (!obj.insulin) delete obj.insulin;
    if (!obj.notes) delete obj.notes;
    if (!obj.preBolus || obj.preBolus == 0) delete obj.preBolus;
    if (!obj.glucose) {
      delete obj.glucose;
      delete obj.glucoseType;
      delete obj.units;
    }

    api( ).insert(obj, function (err, doc) {
      fn(null, doc);

      if (obj.preBolus > 0) {
        //create a new object to insert copying only the needed fields
        var pbTreat = {
          created_at: (new Date(created_at.getTime() + (obj.preBolus * 60000))).toISOString(),
          eventType: obj.eventType,
          carbs: preBolusCarbs
        };

        if (obj.notes) pbTreat.notes = obj.notes;

        api( ).insert(pbTreat, function() {
          //nothing to do here
        });
      }

      //TODO: this is triggering a read from Mongo, we can do better
      ctx.bus.emit('data-received');

    });
  }

  function list (opts, fn) {
    function find ( ) {
      return opts && opts.find ? opts.find : { };
    }

    return ctx.store.limit.call(api().find(find( )).sort({created_at: -1}), opts).toArray(fn);
  }

  function api ( ) {
    return ctx.store.db.collection(env.treatments_collection);
  }

  api.list = list;
  api.create = create;
  api.indexedFields = indexedFields;
  return api;
}

var indexedFields = ['created_at', 'eventType'];

module.exports = storage;

