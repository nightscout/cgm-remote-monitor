'use strict';

const apiConst = require('../../const.json')
  , dateTools = require('../../shared/dateTools')
  , stringTools = require('../../shared/stringTools')
  , opTools = require('../../shared/operationTools')
  ;

const filterRegex = /(.*)\$([a-zA-Z]+)/;


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

  if (['date', 'srvModified', 'srvCreated'].includes(param)) {
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
function parseFilter (req, res) {
  const filter = []
    , reservedParams = ['token', 'sort', 'sort$desc', 'limit', 'skip', 'fields', 'now']
    , operators = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 're']
    ;

  for (let param in req.query) {
    if (!Object.prototype.hasOwnProperty.call(req.query, param)
      || reservedParams.includes(param)) continue;

    let field = param
      , operator = 'eq'
    ;

    const match = filterRegex.exec(param);
    if (match != null) {
      operator = match[2];
      field = match[1];

      if (!operators.includes(operator)) {
        opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST,
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
function parseSort (req, res) {
  let sort = {}
    , sortDirection = 1;

  if (req.query.sort && req.query.sort$desc) {
    opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_SORT_SORT_DESC);
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
function parseSkip (req, res) {
  let skip = 0;

  if (req.query.skip) {
    if (!isNaN(req.query.skip) && req.query.skip >= 0) {
      skip = parseInt(req.query.skip);
    }
    else {
      opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_SKIP);
      return null;
    }
  }

  return skip;
}


module.exports = {
  parseFilter,
  parseSort,
  parseSkip
};