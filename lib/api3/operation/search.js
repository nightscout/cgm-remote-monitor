'use strict';

/**
  * SEARCH: Search documents from the collection
  */
function SearchOperation (ctx, env, app, col) {

  var self = this

  self.col = col;

  self.operation = function operation (req, res, next) {
    next();
  }
}

module.exports = SearchOperation;