'use strict';

function configure (collection, storage) {

  function pop (fn) {
    return function (err, results) {
      if (err) fn(err);
      fn(err, results.pop( ));
    }
  }

  function create (obj, fn) {
    obj.created_at = (new Date( )).toISOString( );
    api( ).insert(obj, function (err, doc) {
      fn(null, doc);
    });
  }

  function list (fn) {
    return api( ).find({ }).toArray(pop(fn));
  }

  function api ( ) {
    return storage.pool.db.collection(collection);
  }

  api.list = list;
  api.create = create;
  return api;
}
module.exports = configure;
