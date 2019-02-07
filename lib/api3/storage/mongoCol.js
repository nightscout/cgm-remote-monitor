'use strict';

/**
 * Storage implementation using mongoDB
 * @param {string} colName - name of the collection in mongo database
 */
function configure (ctx, env, colName) {

  var storage = { colName }
    , col = ctx.store.collection(colName)

  return storage;
}

module.exports = configure;