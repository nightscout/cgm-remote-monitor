'use strict';

/**
  * SEARCH: Search documents from the collection
  */
function SearchOperation (ctx, env, app, col) {

  var self = this
    , apiConst = require('../const.json')
    , FieldsProjector = require('./fieldsProjector')
    , _each = require('lodash/each')
    , filterRegex = /(.*)\_([a-zA-Z]+)/;

  self.col = col;

  self.operation = function operation (req, res) {

    var fieldsProjector = new FieldsProjector(req.query.fields);


    /**
     * Parse filtering criteria from query string
     */
    function parseFilter () {
      var filter = [];

      for (var param in req.query) {
        if (!req.query.hasOwnProperty(param) 
          || param === 'token' || param === 'sort' || param === 'sort_desc' 
          || param === 'limit' || param === 'skip' || param === 'fields') continue;

        var value = req.query[param];
        value = col.isNumberInString(value) ? parseFloat(value) : value; // convert number from string

        // convert boolean from string
        if (value === 'true') 
          value = true;

        if (value === 'false')
          value = false;

        // unwrap string in single quotes
        if (typeof(value) === 'string' && value.startsWith('\'') && value.endsWith('\'')) {
          value = value.substr(1, value.length - 2);
        }

        var match = filterRegex.exec(param);
        if (match != null) {
          var operator = match[2];
          if (operator !== 'eq' && operator !== 'ne' && operator !== 'gt' && operator !== 'gte'
            && operator !== 'lt' && operator !== 'lte' && operator !== 'in' && operator !== 'nin'
            && operator !== 're') {
            res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, 
              apiConst.MSG.HTTP_400_UNSUPPORTED_FILTER_OPERATOR.replace('{0}', operator));
            return null;
          }

          filter.push({ field: match[1], operator: operator, value: value });
          continue;
        }

        filter.push({ field: param, operator: 'eq', value: value });
      }

      return filter;
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


    async function loadFromDb () {

      try {
        var filter = parseFilter()
          , sort = parseSort()
          , limit = col.parseLimit(req, res)
          , skip = parseSkip()
          , projection = parseFields()
          , onlyValid = true

        if (filter !== null && sort !== null && limit !== null && skip !== null && projection !== null) {

          const result = await col.storage.findMany(filter
            , sort
            , limit
            , skip
            , projection
            , onlyValid);

          if (!result) 
            throw 'empty result';

          _each(result, col.resolveDates);

          _each(result, fieldsProjector.applyProjection);

          res.status(apiConst.HTTP.OK).send(result);
        }
      } catch (err) {
        console.error(err);
        return res.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }

    col.authBuilder.authorizerFor('api:' + col.colName + ':read')(req, res, function authorized () {
      loadFromDb();
    });
  }
}

module.exports = SearchOperation;