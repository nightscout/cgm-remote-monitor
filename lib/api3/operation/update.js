'use strict';

/**
  * UPDATE: Updates a document in the collection
  */
function UpdateOperation (ctx, env, app, col) {

  var self = this

  self.col = col;

  self.operation = function operation (req, res, next) {
    next();
  }
}

module.exports = UpdateOperation;