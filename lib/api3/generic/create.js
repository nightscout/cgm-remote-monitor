'use strict';

/**
  * CREATE: Inserts a new document into the collection
  */
function CreateOperation (ctx, env, app, col) {

  var self = this
    , _ = require('lodash')
    , apiConst = require('../const.json')

  self.col = col;

  self.operation = function operation (req, res, next) {
    
    function create () {

      var doc = req.body;
      if (_.isEmpty(doc)) 
        return res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_REQUEST_BODY);

      var identifyingFilter = col.storage.identifyingFilter(null, doc, col.dedupFallbackFields);

      // TODO pokud nemám právo 'api:' + col.colName + ':update' a záznam už existuje, 
      // tak hodit chybu 403 nelze updatovat (deduplikace)
      next();
    }

    col.authBuilder.authorizerFor('api:' + col.colName + ':create')(req, res, function() {

      create();
    });
  }
}

module.exports = CreateOperation;