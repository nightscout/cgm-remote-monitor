

var utils = require('./utils');
function configure (collection, storage) {
  var with_settings_collection = storage.with_collection(collection);
  function getSettings(fn) {
      with_settings_collection(function(err, collection) {
          if (err)
              fn(err);
          else
              // Retrieve the existing settings record.
              collection.find().toArray(function(err, settings) {
                  if (err)
                      fn(err);
                  else
                      // Strip the record of the enclosing square brackets.
                      settings = utils.cleanSingleRecord(settings);
                      fn(null, settings);
              });
      });
  }

  function updateSettings(fn, json) {
      with_settings_collection(function(err, collection) {
          if (err)
              fn(err);
          else
              // Retrieve the existing settings record.
              collection.find().toArray(function(err, settings) {
                  if (err)
                      fn(err);
                  else {
                      // Strip the record of the enclosing square brackets.
                      settings = utils.cleanSingleRecord(settings);
                      //console.log(settings._id);
                      
                      // Send the updated record to mongodb.
                      collection.update(
                          { '_id' : new ObjectID(settings._id) },
                          { $set: json },
                          function (err, result) {
                              if (err) return err;
                              return result;
                          }
                      );
                      
                      // Return to the calling function to display our success.
                      fn(null, json);
                  }
              });
      });
  }


  function api ( ) {
    storage.pool.db.collection(collection);
  }
  api.getSettings = getSettings;
  api.updateSettings = updateSettings;
  return api;
}
module.exports = configure;
