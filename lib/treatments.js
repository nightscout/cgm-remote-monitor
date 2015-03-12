'use strict';

function storage (collection, storage, pushover) {

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

      if (pushover) {

        //since we don't know the time zone on the device viewing the push messeage
        //we can only show the amount of adjustment
        var timeAdjustment = calcTimeAdjustment(eventTime);

        var text = (obj.glucose ? 'BG: ' + obj.glucose + ' (' + obj.glucoseType + ')' : '') +
          (obj.carbs ? '\nCarbs: ' + obj.carbs : '') +
          (preBolusCarbs ? '\nCarbs: ' + preBolusCarbs + ' (in ' + obj.preBolus + ' minutes)' : '')+
          (obj.insulin ? '\nInsulin: ' + obj.insulin : '')+
          (obj.enteredBy ? '\nEntered By: ' + obj.enteredBy : '') +
          (timeAdjustment ? '\nEvent Time: ' + timeAdjustment : '') +
          (obj.notes ? '\nNotes: ' + obj.notes : '');

        var msg = {
          expire: 14400, // 4 hours
          message: text,
          title: obj.eventType,
          sound: 'gamelan',
          timestamp: new Date( ),
          priority: (obj.eventType == 'Note' ? -1 : 0),
          retry: 30
        };

        pushover.send( msg, function( err, result ) {
          console.log(result);
        });
      }

    });
  }

  function calcTimeAdjustment(eventTime) {

    if (!eventTime) return null;

    var now = (new Date()).getTime(),
      other = eventTime.getTime(),
      past = other < now,
      offset = Math.abs(now - other);

    var MINUTE = 60 * 1000,
      HOUR = 3600 * 1000;

    var parts = {};

    if (offset <= MINUTE)
      return 'now';
    else if (offset < (HOUR * 2))
      parts = { value: Math.round(Math.abs(offset / MINUTE)), label: 'mins' };
    else
      parts = { value: Math.round(Math.abs(offset / HOUR)), label: 'hrs' };

    if (past)
      return parts.value + ' ' + parts.label + ' ago';
    else
      return 'in ' + parts.value + ' ' + parts.label;
  }

  function list (opts, fn) {
    function find ( ) {
      var q = opts && opts.find ? opts.find : { };
      return q;
    }

    return api( ).find(find()).sort({created_at: -1}).toArray(fn);
  }

  function api ( ) {
    return storage.pool.db.collection(collection);
  }

  api.list = list;
  api.create = create;
  return api;
}

function ensureIndexes(name, storage) {
  storage.with_collection(name)(function (err, collection) {
    if (err) {
      console.error("ensureIndexes, unable to get collection for: " + name + " - " + err);
    } else {
      storage.ensureIndexes(collection, ['created_at', 'eventType']);
    }
  });
}

module.exports = {
  storage: storage,
  ensureIndexes: ensureIndexes
};
