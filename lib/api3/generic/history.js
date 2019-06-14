'use strict';

const dateTools = require('../shared/dateTools')
  , apiConst = require('../const.json')
  , FieldsProjector = require('../shared/fieldsProjector')
  , _ = require('lodash')

/**
  * HISTORY: Retrieves incremental changes since timestamp
  */
function HistoryOperation (ctx, env, app, col) {

  const self = this;
  self.col = col;

  self.operation = function operation (req, res) {

    const fieldsProjector = new FieldsProjector(req.query.fields);


    /**
     * Parse history filtering criteria from Last-Modified header
     */
    function parseFilter () {

      let lastModified = null
        , lastModifiedParam = req.params.lastModified
        , operator = null;

      if (lastModifiedParam) {
        
        // using param in URL as a source of timestamp
        const m = dateTools.parseToMoment(lastModifiedParam);
        
        if (m === null || !m.isValid()) {
          res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_LAST_MODIFIED);
          return null;
        }

        lastModified = m.toDate();
        operator = 'gt';
      }
      else {
        // using request HTTP header as a source of timestamp
        const lastModifiedHeader = req.get('Last-Modified');
        if (!lastModifiedHeader) {
          res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_LAST_MODIFIED);
          return null;
        }

        try {
          lastModified = dateTools.floorSeconds(new Date(lastModifiedHeader));
        } catch (err) {
          res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_LAST_MODIFIED);
          return null;
        }
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
        let filter = parseFilter()
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
            return res.status(apiConst.HTTP.NO_CONTENT).end();
          }

          _.each(result, col.resolveDates);

          const srvModifiedValues = _.map(result, function mapSrvModified (item) { 
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

    if (col.colName === 'settings') {
      col.authorizers.admin(req, res, loadFromDb);  // listing of settings needs special permission
    } else {
      col.authorizers.read(req, res, loadFromDb);
    }
  }
}

module.exports = HistoryOperation;