
var es = require('event-stream');

function entries (name, storage) {
  var with_collection = storage.with_collection(name);
  function list (opts, fn) {
    with_collection(function (err, collection) {
      function find ( ) {
        var q = opts && opts.find ? opts.find : { };
        return q;
        return this.find(q)
        ;
      }

      function sort ( ) {
        return {"date": -1};
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

      limit.call(collection
        .find(find( ))
        .sort(sort( )))
        // .limit(limit( ))
        .toArray(toArray)
      ;
      // limit.call(sort.call(find.call(collection))).toArray(toArray);

    });
  }

  function echo (record) {
    var res = {
      svg: record.svg
    , dateString: record.dateString || ''
    , date: parseInt(record.date)
    , device: record.device || ''
    , direction: record.direction || ''
    };
    if (res.svg && isFinite(res.date)) {
      return res;
    }
  }
  
  function map ( ) {
    return es.map(function (item, next) {
      var record = echo(item);
      if (record) next(null, echo(item));
      else next(null);
    });
  }


  function update (fn) {
  }
  function remove (fn) {
  }

  function create (docs, fn) {
      with_collection(function(err, collection) {
        if (err) { fn(err); return; }
        collection.insert(docs, function (err, stats) {
          console.log('finished inserting', stats, arguments);
          fn(err, stats, docs);
        });
      });
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
    return storage.pool.db.collection(name);
  }
  api.list = list;
  api.echo = echo;
  api.map = map;
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
