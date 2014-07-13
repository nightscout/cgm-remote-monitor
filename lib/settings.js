

var utils = require('./utils');
var ObjectID = require('mongodb').ObjectID;
function configure (collection, storage) {
  var DEFAULT_SETTINGS_JSON = {
          "units": "mg/dl"
  }; // possible future settings: "theme": "subdued", "websockets": false

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
                      console.log(settings);
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

  function updateSettings (json, fn) {
    getSettings(function last (err, older) {
      console.log('got old', older);
      var result = merge(older, json);
      var deltas = Object.keys(result);
      if (deltas.length < 1) {
        fn("Bad Keys");
        return;
      }
      result.updated_at = (new Date( )).toISOString( );
      console.log('merged', result);
      with_collection(function(err, collection) {
          if (err) {
              console.log('error', result);
              return fn(err);
          } else if (older && older._id && Object.keys(deltas).length > 0) {
            console.log('updating mongo');
            collection.update(
                { '_id' : new ObjectID(older._id) },
                { $set: result },
                function (err, stats) {
                    // Return to the calling function to display our success.
                    console.log("updated", arguments);
                    fn(err, result);
                }
            );
          } else {
            console.log('inseting mongo');
            collection.insert(result, function (err, doc) {
              console.log('inserted mongo', arguments);
              fn(null, result);

            });

          }
      });
    });
  }

  function remove (fn) {
    with_collection(function (err, collection) {
      collection.remove({ }, fn);
    });
  }

  function api ( ) {
    storage.pool.db.collection(collection);
  }
  api.getSettings = getSettings;
  api.updateSettings = updateSettings;
  api.remove = remove;
  return api;
}
module.exports = configure;
