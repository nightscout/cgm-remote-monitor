'use strict';

function storage (collection, storage, pushover) {

  function create (obj, fn) {
    obj.created_at = (new Date( )).toISOString( );
    api( ).insert(obj, function (err, doc) {
      fn(null, doc);

      if (pushover) {

        var text = (obj.glucose ? 'BG: ' + obj.glucose + ' (' + obj.glucoseType + ')' : '') +
          (obj.carbs ? '\nCarbs: ' + obj.carbs : '') +
          (obj.insulin ? '\nInsulin: ' + obj.insulin : '')+
          (obj.enteredBy ? '\nEntered By: ' + obj.enteredBy : '') +
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

    });
  }

  function list (fn) {
    return api( ).find({ }).sort({created_at: -1}).toArray(fn);
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
