'use strict';

/**
  * HISTORY: Retrieves incremental changes since timestamp
  */
function configure (ctx, env, app, col) {

  var obj = { }

  obj.operation = function operation (req, res, next) {
    next();
  }

  return obj;
}

module.exports = configure;