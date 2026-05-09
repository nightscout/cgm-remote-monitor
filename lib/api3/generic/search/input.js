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


function isFilterParameterStart(filterValue, index, operators) {
  const separator = filterValue.indexOf('=', index);
  if (separator === -1) {
    return false;
  }

  const parameter = filterValue.slice(index, separator);
  if (/\s/.test(parameter)) {
    return false;
  }

  const match = filterRegex.exec(parameter);
  return match != null && operators.includes(match[2]);
}


function parseFilterParameterString(value, operators) {
  if (!['boolean', 'number', 'string'].includes(typeof value)) {
    return [];
  }

  const filterValue = String(value);
  const starts = [];

  for (let index = 0; index < filterValue.length; index++) {
    if (index > 0 && !/\s/.test(filterValue[index - 1])) {
      continue;
    }

    if (isFilterParameterStart(filterValue, index, operators)) {
      starts.push(index);
    }
  }

  if (starts.length === 0) {
    return [filterValue];
  }

  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : undefined;
    return filterValue.slice(start, end).trim();
  }).filter(Boolean);
}


function addFilterParameter(processedQueryParams, filterValue) {
  const separator = filterValue.indexOf('=');
  if (separator === -1) {
    processedQueryParams[filterValue] = undefined;
    return;
  }

  processedQueryParams[filterValue.slice(0, separator)] = filterValue.slice(separator + 1);
}


/**
 * Parse filtering criteria from query string
 */
function parseFilter (req, res) {
  const filter = []
    , reservedParams = ['token', 'sort', 'sort$desc', 'limit', 'skip', 'fields', 'now']
    , operators = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 're']
    ;

  // filter_parameters query parameter needs to be split
  // into individual parameters before it can be processed
  const processedQueryParams = {};

  for (let param in req.query) {
    if (!Object.prototype.hasOwnProperty.call(req.query, param)
      || reservedParams.includes(param)) continue;

    if (param === 'filter_parameters') {
      const queryValues = Array.isArray(req.query[param]) ? req.query[param] : [req.query[param]];

      for (const queryValue of queryValues) {
        const filterValues = parseFilterParameterString(queryValue, operators);
        filterValues.forEach(filterValue => addFilterParameter(processedQueryParams, filterValue));
      }
    }
    else {
      processedQueryParams[param] = req.query[param];
    }
  }

  for (let param in processedQueryParams) {
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
    const value = parseValue(field, processedQueryParams[param]);

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
      skip = parseInt(req.query.skip, 10);
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
