'use strict';

/**
  * READ: Retrieves a single document from the collection
  */
function configure (ctx, env, app, col) {

  var obj = { }
    , authBuilder = require('../authBuilder')(app, env, ctx)
    , apiConst = require('../const.json')
    , FieldsProjector = require('../fieldsProjector')


  /**
   * Fetches modified date from document (with possible fallback and back-fill to srvModified/srvCreated) 
   * @param {any} doc - document loaded from database
   */
  obj.resolveDates = function resolveDates (doc, fallbackGetDate) {
    var modifiedDate;
    try
    {
      if (doc.srvModified) {
        modifiedDate = new Date(doc.srvModified);
      }
      else {
        if (typeof(fallbackGetDate) === 'function') {
          modifiedDate = fallbackGetDate(doc);
          doc.srvModified = modifiedDate.getTime();
        }
      }

      if (doc.srvModified && !doc.srvCreated) {
        doc.srvCreated = modifiedDate.getTime();
      }
    }
    catch (error) 
    {
      console.warn(error);
    }
    return modifiedDate;
  }


  obj.operation = function operation (req, res) {
    
    function loadFromDb () {
      var fieldsProjector = new FieldsProjector(req.query.fields);

      col.storage.findOne(req.params.identifier
        , fieldsProjector.storageProjection()
        , function findOneDone (err, result) {

        if (err || !result) {
          console.error(err);
          return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
        }

        if (result.length === 0) {
          return res.sendJSONStatus(res, apiConst.HTTP.NOT_FOUND);
        }

        var doc = result[0];
        if (doc.isValid === false) {
          return res.sendJSONStatus(res, apiConst.HTTP.GONE);
        }

        
        var modifiedDate = obj.resolveDates(doc, col.fallbackGetDate);
        if (modifiedDate) {
          res.setHeader('Last-Modified', modifiedDate.toUTCString())

          var ifModifiedSince = req.get('If-Modified-Since');

          if (ifModifiedSince 
            && col.floorSeconds(modifiedDate) <= col.floorSeconds(new Date(ifModifiedSince))) {
            return res.sendJSONStatus(res, apiConst.HTTP.NOT_MODIFIED);
          }
        }

        fieldsProjector.applyProjection(doc);

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