'use strict';

/**
  * READ: Retrieves a single document from the collection
  */
function configure (ctx, env, app, col) {

  var obj = { }
    , authBuilder = require('../authBuilder')(app, env, ctx)

  obj.operation = function authorize (req, res, next) {
    
    function loadFromDb () {
      col.storage.findOne(req.params.identifier, function(err, results) {
        if (err) {
          return res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error');
        }
        console.log(results);
        next();
      });
    }

    authBuilder('api:' + col.colName + ':read')(req, res, function() {
      loadFromDb();
    });
  }

  return obj;
}

module.exports = configure;