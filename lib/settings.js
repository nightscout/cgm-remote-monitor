'use strict';


var ObjectID = require('mongodb').ObjectID;
function defaults ( ) {
  var DEFAULT_SETTINGS_JSON = {
          "units": "mg/dl"
  }; // possible future settings: "theme": "subdued", "websockets": false, alertLow: 80, alertHigh: 180
  return DEFAULT_SETTINGS_JSON;
}

function configure (collection, storage) {
  var DEFAULT_SETTINGS_JSON = {
          "units": "mg/dl"
  };

  function pop (fn) {
    return function (err, results) {
      if (err) fn(err);
      fn(err, results.pop( ));
    }
  }

  function alias (alias, fn) {
    return api( ).find({ alias: alias }).toArray(pop(fn));
  }

  function create (obj, fn) {
    var result = merge(DEFAULT_SETTINGS_JSON, obj);
    result.alias = obj.alias;
    result.created_at = (new Date( )).toISOString( );
    api( ).insert(result, function (err, doc) {
      fn(null, doc);
    });
  }

  function lint (obj) {
    var result = merge(DEFAULT_SETTINGS_JSON, json);
    if (result.alias) return result;
  }

  function list (fn) {
    return api( ).find({ }, { alias: 1, nick: 1 }).toArray(pop(fn));
  }

  function remove (alias, fn) {
    return api( ).remove({ alias: alias }, fn);
  }

  var with_collection = storage.with_collection(collection);
  function getSettings (fn) {
      with_collection(function(err, collection) {
          if (err)
              fn(err);
          else
              // Retrieve the existing settings record.
              collection.find().toArray(function(err, settings) {
                  if (err)
                      fn(err);
                  else
                      // Strip the record of the enclosing square brackets.
                      settings = settings.pop( );
                      if (!settings) {
                        settings = DEFAULT_SETTINGS_JSON;
                      }
                      fn(null, settings);
              });
      });
  }
  var whitelist = [ 'units', 'data' ];

  function merge (older, newer) {
    var update = { };
    whitelist.forEach(function (prop) {
      if (prop in newer) {
        update[prop] = newer[prop];
      }
    });
    return update;
  }

  function update (json, fn) {
    var updated = (new Date( )).toISOString( );
    alias(json.alias, function last (err, older) {
      if (err) { return fn(err); }
      var result;
      if (older && older._id) {
        // result = merge(older, json);
        result = json;
        result.updated_at = updated;
        var deltas = Object.keys(result);
        if (deltas.length < 1) {
          fn("Bad Keys");
          return;
        }
        api( ).update(
            { '_id' : new ObjectID(older._id) },
            { $set: result },
            function (err, res) {
                // Return to the calling function to display our success.
                fn(err, res);
            }
        );
      } else {
        create(json, fn);
      }
    });
  }

  function updateSettings (json, fn) {
    getSettings(function last (err, older) {
      var result = merge(older, json);
      var deltas = Object.keys(result);
      if (deltas.length < 1) {
        fn("Bad Keys");
        return;
      }
      result.updated_at = (new Date( )).toISOString( );
      with_collection(function(err, collection) {
          if (err) {
              console.log('error', result);
              return fn(err);
          } else if (older && older._id && Object.keys(deltas).length > 0) {
            collection.update(
                { '_id' : new ObjectID(older._id) },
                { $set: result },
                function (err, stats) {
                    // Return to the calling function to display our success.
                    fn(err, result);
                }
            );
          } else {
            collection.insert(result, function (err, doc) {
              fn(null, result);

            });

          }
      });
    });
  }

  function clear (fn) {
    with_collection(function (err, collection) {
      collection.remove({ }, fn);
    });
  }

  function api ( ) {
    return storage.pool.db.collection(collection);
  }

  api.getSettings = getSettings;
  api.updateSettings = updateSettings;
  api.remove = remove;
  api.clear = clear;
  api.list = list;
  api.create = create;
  api.lint = lint;
  api.alias = alias;
  api.update = update;
  return api;
}
module.exports = configure;
