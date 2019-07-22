'use strict';

const apiConst = require('../const.json')
  , dateTools = require('../shared/dateTools')
  , stringTools = require('../shared/stringTools')
  , FieldsProjector = require('../shared/fieldsProjector')
  , _each = require('lodash/each')

/**
  * SEARCH: Search documents from the collection
  */
function SearchOperation (ctx, env, app, col) {

  const self = this
    , filterRegex = /(.*)\$([a-zA-Z]+)/;

  self.col = col;

  self.operation = function operation (req, res) {

    const fieldsProjector = new FieldsProjector(req.query.fields);


    /**
     * Parse value of the parameter (to the correct data type)
     */
    function parseValue(param, value) {

      value = stringTools.isNumberInString(value) ? parseFloat(value) : value; // convert number from string

      // convert boolean from string
      if (value === 'true') 
        value = true;

      if (value === 'false')
        value = false;

      // unwrap string in single quotes
      if (typeof(value) === 'string' && value.startsWith('\'') && value.endsWith('\'')) {
        value = value.substr(1, value.length - 2);
      }

      if (param === 'date' || param === 'srvModified' || param === 'srvCreated') {
        let m = dateTools.parseToMoment(value);
        if (m && m.isValid()) {
          value = m.valueOf();
        }
      }

      if (param === 'created_at') {
        let m = dateTools.parseToMoment(value);
        if (m && m.isValid()) {
          value = m.toISOString();
        }
      }

      return value;
    }


    /**
     * Parse filtering criteria from query string
     */
    function parseFilter () {
      const filter = [];

      for (let param in req.query) {
        if (!Object.prototype.hasOwnProperty.call(req.query, param)
          || param === 'token' || param === 'sort' || param === 'sort$desc' 
          || param === 'limit' || param === 'skip' || param === 'fields'
          || param === 'now') continue;

        let field = param
          , operator = 'eq'
          ;

        const match = filterRegex.exec(param);
        if (match != null) {
          operator = match[2];
          field = match[1];

          if (operator !== 'eq' && operator !== 'ne' && operator !== 'gt' && operator !== 'gte'
            && operator !== 'lt' && operator !== 'lte' && operator !== 'in' && operator !== 'nin'
            && operator !== 're') {
            res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, 
              apiConst.MSG.HTTP_400_UNSUPPORTED_FILTER_OPERATOR.replace('{0}', operator));
            return null;
          }
        }
        const value = parseValue(field, req.query[param]);

        filter.push({ field, operator, value });
      }

      return filter;
    }


    /**
     * Parse sorting from query string
     */
    function parseSort () {
      let sort = {}
        , sortDirection = 1;

      if (req.query.sort && req.query.sort$desc) {
        res.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_SORT_SORT_DESC);
        return null;
      }

      if (req.query.sort$desc) {
        sortDirection = -1;
        sort[req.query.sort$desc] = sortDirection;
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
      let skip = 0;

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
        const filter = parseFilter()
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

    if (col.colName === 'settings') {
      col.authorizers.admin(req, res, loadFromDb);  // listing of settings needs special permission
    } else {
      col.authorizers.read(req, res, loadFromDb);
    }
  }
}

module.exports = SearchOperation;