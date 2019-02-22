'use strict';

/**
  * HISTORY: Retrieves incremental changes since timestamp
  */
function HistoryOperation (ctx, env, app, col) {

  var self = this

  self.col = col;

  self.operation = function operation (req, res, next) {
    next();
  }
}

module.exports = HistoryOperation;