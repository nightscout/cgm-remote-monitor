'use strict';

function storage (collection, storage) {

    function create(obj, fn) {
        if (! obj.hasOwnProperty("created_at")){
            obj.created_at = (new Date()).toISOString();
        }
        api().insert(obj, function (err, doc) {
            fn(null, doc);
        });
    }

    function create_date_included(obj, fn) {
        api().insert(obj, function (err, doc) {
            fn(null, doc);
        });

    }

    function last(fn) {
        return api().find({}).sort({created_at: -1}).limit(1).toArray(function (err, entries) {
            if (entries && entries.length > 0)
                fn(err, entries[0]);
            else
                fn(err, null);
        });
    }

    function list(fn) {
        return api().find({}).sort({created_at: -1}).toArray(fn);
    }

    function api() {
        return storage.pool.db.collection(collection);
    }


  api.list = list;
  api.create = create;
  api.last = last;
  api.indexedFields = indexedFields;
  return api;
}

var indexedFields = ['created_at'];

module.exports = storage;
