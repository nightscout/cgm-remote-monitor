'use strict';

/**
  * HISTORY: Retrieves incremental changes since timestamp
  */
function HistoryOperation (ctx, env, app, col) {

  var self = this
    , apiConst = require('../const.json')
    , FieldsProjector = require('./fieldsProjector')
    , _ = require('lodash')

  self.col = col;

  self.operation = function operation (req, res) {

    var fieldsProjector = new FieldsProjector(req.query.fields);


    /**
     * Parse history filtering criteria from Last-Modified header
     */
    function parseFilterHistory () {

      var lastModifiedHeader = req.get('Last-Modified');
      if (!lastModifiedHeader) {
        res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_LAST_MODIFIED);
        return null;
      }

      var lastModified = col.floorSeconds(new Date(lastModifiedHeader));

      return [
        { field: 'srvModified', value: lastModified.getTime() },
        { field: 'created_at', value: lastModified.toISOString() },
        { field: 'date', value: lastModified.getTime() }
      ];
    }


    /**
     * Prepare sorting for storage query
     */
    function prepareSort () {
      return {
        srvModified: 1,
        created_at: 1,
        date: 1
      };
    }


    function loadFromDb () {

      var filterHistory = parseFilterHistory()
        , limit = col.parseLimit(req, res)
        , projection = fieldsProjector.storageProjection()
        , sort = prepareSort()
        , skip = 0

      if (filterHistory !== null && sort !== null && limit !== null && skip !== null && projection !== null) {

        col.storage.findManyFrom(filterHistory
          , sort
          , limit
          , skip
          , projection
          , function findManyDone (err, result) {

            if (err || !result) {
              console.error(err);
              return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
            }

            if (result.length === 0) {
              return res.sendJSONStatus(res, apiConst.HTTP.NO_CONTENT);
            }

            _.each(result, col.resolveDates);

            var srvModifiedValues = _.map(result, function mapSrvModified (item) { 
                return item.srvModified;
              })
              , maxSrvModified = new Date(_.max(srvModifiedValues));

            res.setHeader('Last-Modified', maxSrvModified.toUTCString());

            _.each(result, fieldsProjector.applyProjection);

            res.status(apiConst.HTTP.OK).send(result);
          });
      }
    }

    col.authBuilder.authorizerFor('api:' + col.colName + ':read')(req, res, function authorized () {
      loadFromDb();
    });
  }
}

module.exports = HistoryOperation;