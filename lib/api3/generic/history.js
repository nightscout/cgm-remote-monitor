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
    function parseFilter () {

      var lastModified = null
        , lastModifiedParam = req.params.lastModified
        , lastModifiedNumber = null
        , operator = null;

      if (lastModifiedParam) {
        
        // using param in URL as a source of timestamp
        if (col.isNumberInString(lastModifiedParam)) {
          lastModifiedNumber = parseFloat(lastModifiedParam);
        }
        
        if (lastModifiedNumber === null || lastModifiedNumber < 0) {
          res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_LAST_MODIFIED);
          return null;
        }

        lastModified = new Date(lastModifiedNumber);
        operator = 'gt';
      }
      else {
        // using request HTTP header as a source of timestamp
        var lastModifiedHeader = req.get('Last-Modified');
        if (!lastModifiedHeader) {
          res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_LAST_MODIFIED);
          return null;
        }

        lastModified = col.floorSeconds(new Date(lastModifiedHeader));
        operator = 'gte';
      }

      return [
        { field: 'srvModified', operator: operator, value: lastModified.getTime() },
        { field: 'created_at', operator: operator, value: lastModified.toISOString() },
        { field: 'date', operator: operator, value: lastModified.getTime() }
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


    async function loadFromDb () {

      try {
        var filter = parseFilter()
          , limit = col.parseLimit(req, res)
          , projection = fieldsProjector.storageProjection()
          , sort = prepareSort()
          , skip = 0
          , onlyValid = false
          , logicalOperator = 'or'

        if (filter !== null && sort !== null && limit !== null && skip !== null && projection !== null) {

          const result = await col.storage.findMany(filter
            , sort
            , limit
            , skip
            , projection
            , onlyValid
            , logicalOperator);

          if (!result)
            throw 'empty result';

          if (result.length === 0) {
            return res.sendJSONStatus(res, apiConst.HTTP.NO_CONTENT);
          }

          _.each(result, col.resolveDates);

          var srvModifiedValues = _.map(result, function mapSrvModified (item) { 
              return item.srvModified;
            })
            , maxSrvModified = _.max(srvModifiedValues);

          res.setHeader('Last-Modified', (new Date(maxSrvModified)).toUTCString());
          res.setHeader('ETag', 'W/"' + maxSrvModified + '"');

          _.each(result, fieldsProjector.applyProjection);

          res.status(apiConst.HTTP.OK).send(result);
        }

      } catch (err) {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }

    col.authorizers.read(req, res, loadFromDb);
  }
}

module.exports = HistoryOperation;