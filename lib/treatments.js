'use strict';

function storage (collection, storage, pushover) {

  function create (obj, fn) {

    //NOTE: the eventTime is sent by the client, but deleted, we only store created_at right now
    var created_at = new Date();
    var eventTime = obj.eventTime;

    if (obj.eventTime) {
      created_at = new Date(obj.eventTime);
    }

    obj.created_at = created_at.toISOString();

    var preBolusCarbs = '';
    if (obj.preBolus > 0) {
      preBolusCarbs = obj.carbs;
      obj.carbs = '';
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

      if (pushover) {

        var text = (obj.glucose ? 'BG: ' + obj.glucose + ' (' + obj.glucoseType + ')' : '') +
          (obj.carbs ? '\nCarbs: ' + obj.carbs : '') +
          (obj.insulin ? '\nInsulin: ' + obj.insulin : '')+
          (obj.preBolus > 0 ? '\nPre-Bolus: ' + obj.preBolus + "  minutes" : '')+
          (obj.enteredBy ? '\nEntered By: ' + obj.enteredBy : '') +
          //TODO: show adjusted diff since ee don't know the time zone of the device that we get the notification
          (eventTime ? '\nEvent Time: adjusted' : '') +
          (obj.notes ? '\nNotes: ' + obj.notes : '');

        var msg = {
          expire: 14400, // 4 hours
          message: text,
          title: obj.eventType,
          sound: 'gamelan',
          timestamp: new Date( ),
          priority: 0,
          retry: 30
        };

        pushover.send( msg, function( err, result ) {
          console.log(result);
        });
      }

      if (obj.preBolus > 0) {
        obj.created_at = (new Date(eventTime.getTime() + (obj.preBolus * 60000))).toISOString();
        obj.carbs = preBolusCarbs;
        obj.preBolus = 0;
        delete obj.glucose;
        delete obj.insulin;
        obj._id = null;
        api( ).insert(obj, function() {
          //nothing to do here
        });
      }

    });
  }

  //TODO: use moment
  function formatDate(date) {
    var hours = date.getHours();
    var minutes = date.getMinutes();
    var ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    minutes = minutes < 10 ? '0'+minutes : minutes;
    var strTime = hours + ':' + minutes + ' ' + ampm;
    return date.getMonth()+1 + "/" + date.getDate() + "/" + date.getFullYear() + "  " + strTime;
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
