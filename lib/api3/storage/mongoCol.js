'use strict';

/**
 * Storage implementation using mongoDB
 * @param {string} colName - name of the collection in mongo database
 */
function configure (ctx, env, colName) {

  var storage = { }
    , ObjectID = require('mongodb').ObjectID
    , checkForHexRegExp = new RegExp("^[0-9a-fA-F]{24}$")

  storage.colName = colName;

  storage.col = ctx.store.collection(colName);

  storage.findOne = function findOne (identifier, done) {
    
    var filterOpts = [ { identifier: identifier } ];
    
    // fallback to "identifier = _id"
    if (checkForHexRegExp.test(identifier)) {
        filterOpts.push({ _id: ObjectID(identifier) });
    }

    storage.col.find({ $or: filterOpts })
      .toArray(function loaded (err, result) {

          done(err, result);
      });
  }

  return storage;
}

module.exports = configure;