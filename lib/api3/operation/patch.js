'use strict';

/**
  * PATCH: Partially updates document in the collection
  */
function PatchOperation (ctx, env, app, col) {

  var self = this

  self.col = col;

  self.operation = function operation (req, res, next) {
    next();
  }
}

module.exports = PatchOperation;