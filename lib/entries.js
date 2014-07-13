
function entries (collection, storage) {
  var with_entries_collection = storage.with_collection(collection);
  function list (opts, fn) {
    storage.with_collection(collection, function (coll) {
    });
  }
  function create (fn) {
  }
  function update (fn) {
  }
  function remove (fn) {
  }

  function getEntry(fn, id) {
      console.info("trying to find entry for id: " + id);
      with_entries_collection(function(err, collection) {
          if (err)
              fn(err);
          else
              collection.findOne({"_id": ObjectID(id)}, function (err, entry) {
                  if (err)
                      fn(err);
                  else
                      fn(null, entry);
              });
      });
  }

  function getEntries(fn, count) {
      with_entries_collection(function(err, collection) {
          if (err)
              fn(err);
          else
              collection.find({ }).sort({"date": -1}).limit(count).toArray(function (err, entries) {
                  if (err)
                      fn(err);
                  else
                      fn(null, entries);
              });
      });
  }

  function api ( ) {
    storage.pool.db.collection(collection);
  }
  api.list = list;
  api.create = create;
  api.getEntries = getEntries;
  api.getEntry = getEntry;
  return api;
}

module.exports = entries;

if (!module.parent) {
  var env = require('../env');
  var store = require('./storage')(env);
  var api = entries(env.mongo_collection, store);

}
