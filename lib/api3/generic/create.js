'use strict';

/**
  * CREATE: Inserts a new document into the collection
  */
function CreateOperation (ctx, env, app, col) {

  var self = this

  self.col = col;

  self.operation = function operation (req, res, next) {
    next();
  }
}

module.exports = CreateOperation;