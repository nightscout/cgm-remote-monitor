'use strict';

/**
  * SEARCH: Search documents from the collection
  */
function SearchOperation (ctx, env, app, col) {

  var self = this
    , apiConst = require('../const.json')
    , FieldsProjector = require('../fieldsProjector')
    , _each = require('lodash/each')

  self.col = col;

  self.operation = function operation (req, res, next) {

    var fieldsProjector = new FieldsProjector(req.query.fields);


    /**
     * Parse filtering criteria from query string
     */
    function parseFilter () {
      return { };
    }


    /**
     * Parse sorting from query string
     */
    function parseSort () {
      var sort = {}
        , sortDirection = 1;

      if (req.query.sort && req.query.sort_desc) {
        res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_SORT_SORT_DESC);
        return null;
      }

      if (req.query.sort_desc) {
        sortDirection = -1;
        sort[req.query.sort_desc] = sortDirection;
      }
      else {
        if (req.query.sort) {
          sort[req.query.sort] = sortDirection;
        }
      }

      sort.identifier = sortDirection;
      sort.created_at = sortDirection;
      sort.date = sortDirection;    

      return sort;
    }


    /**
     * Parse limit (max document count) from query string
     */
    function parseLimit () {
      var maxLimit = app.get('API3_MAX_LIMIT');
      var limit = maxLimit;

      if (req.query.limit) {
        if (!isNaN(req.query.limit) && req.query.limit > 0 && req.query.limit <= maxLimit) {
          limit = parseInt(req.query.limit);
        }
        else {
          res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_LIMIT);
          return null;
        }
      }

      return limit;
    }


    /**
     * Parse skip (offset) from query string
     */
    function parseSkip () {
      var skip = 0;

      if (req.query.skip) {
        if (!isNaN(req.query.skip) && req.query.skip >= 0) {
          skip = parseInt(req.query.skip);
        }
        else {
          res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_SKIP);
          return null;
        }
      }

      return skip;
    }


    /**
     * Parse fields projection from query string
     */
    function parseFields () {
      
      return fieldsProjector.storageProjection();
    }


    function loadFromDb() {

      var filter = parseFilter()
        , sort = parseSort()
        , limit = parseLimit()
        , skip = parseSkip()
        , projection = parseFields()

      if (filter !== null && sort !== null && limit !== null && skip !== null && projection !== null) {

        col.storage.findMany(filter
          , sort
          , limit
          , skip
          , projection
          , function findManyDone(err, result) {

            if (err || !result) {
              console.error(err);
              return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
            }

            _each(result, col.resolveDates);

            _each(result, fieldsProjector.applyProjection);

            res.status(apiConst.HTTP.OK).send(result);
          });
      }
    }

    col.authBuilder.authorizerFor('api:' + col.colName + ':read')(req, res, function () {
      loadFromDb();
    });
  }
}

module.exports = SearchOperation;