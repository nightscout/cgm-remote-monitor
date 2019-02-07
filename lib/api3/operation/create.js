'use strict';

/**
  * CREATE: Inserts a new document into the collection
  */
function configure (ctx, env, app, col) {

  var obj = { }

  obj.operation = function operation (req, res, next) {
    next();
  }

  return obj;
}

module.exports = configure;