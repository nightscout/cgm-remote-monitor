'use strict';

function configure (collection, storage) {

  function create (obj, fn) {
    obj.created_at = (new Date( )).toISOString( );
    api( ).insert(obj, function (err, doc) {
      fn(null, doc);
    });
  }

  function last(fn) {
      return api( ).find({ }).sort({created_at: -1}).limit(1).toArray(function(err, entries) {
          if (entries && entries.length > 0)
            fn(err, entries[0]);
          else
              fn(err, null);
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
  api.last = last;
  return api;
}
module.exports = configure;
