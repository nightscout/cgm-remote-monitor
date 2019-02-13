'use strict';

/**
  * READ: Retrieves a single document from the collection
  */
function configure (ctx, env, app, col) {

  var obj = { }
    , authBuilder = require('../authBuilder')(app, env, ctx)
    , apiConst = require('../const.json')

  obj.operation = function authorize (req, res, next) {
    
    function loadFromDb () {
      col.storage.findOne(req.params.identifier, function(err, result) {
        if (err) {
          return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
        }

        if (result.length === 0) {
          return res.sendJSONStatus(res, apiConst.HTTP.NOT_FOUND);
        }

        var doc = result[0];
        if (doc.isValid === false) {
          return res.sendJSONStatus(res, apiConst.HTTP.GONE);
        }

        res.status(apiConst.HTTP.OK).send(doc);
      });
    }

    authBuilder('api:' + col.colName + ':read')(req, res, function() {
      loadFromDb();
    });
  }

  return obj;
}

module.exports = configure;