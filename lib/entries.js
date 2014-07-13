
function entries (name, storage) {
  var with_collection = storage.with_collection(name);
  function list (opts, fn) {
    with_collection(function (err, collection) {
      function find ( ) {
        var q = { };
        return this.find(q)
        ;
      }

      function sort ( ) {
        return this.sort({"date": -1});
      }

      function limit ( ) {
        if (opts && opts.count) {
          return this.limit(parseInt(opts.count));
        }
        return this;
      }

      function toArray (err, entries) {
        fn(err, entries);
      }

      limit.call(sort.call(find.call(collection))).toArray(toArray);

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
      with_collection(function(err, collection) {
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
      with_collection(function(err, collection) {
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
    storage.pool.db.collection(name);
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
