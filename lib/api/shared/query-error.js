'use strict';

const consts = require('../../constants');

// Every API v1 endpoint that accepts `find[...]` builds its filter through
// lib/server/query.js, so they all share one class of caller error: a query the
// v1 query guards refuse. Each of them reports that today as HTTP 500 under a
// name that blames the database -- 'Mongo Error', 'Query Error' -- or, in two
// cases, does not check `err` at all and formats a null result set. A refused
// filter is the caller's problem, not an outage, and the caller has to be able
// to tell the two apart: in this application a 500 on a read is
// indistinguishable from the server being down, and the operator that was
// actually refused never reaches the client.
//
// res.status().json() rather than res.sendJSONStatus() so this works from any
// handler, including ones whose router has not installed that middleware.

function isQueryValidationError (err) {
  return !!err && err.name === 'MongoQueryValidationError';
}

// Answers the request and returns true when `err` is a refused query;
// returns false and touches nothing otherwise, so callers keep their own
// error handling for real failures.
function sendQueryValidationError (res, err) {
  if (!isQueryValidationError(err)) return false;
  res.status(consts.HTTP_BAD_REQUEST).json({
    status: consts.HTTP_BAD_REQUEST
    , message: err.message
  });
  return true;
}

module.exports = sendQueryValidationError;
module.exports.isQueryValidationError = isQueryValidationError;
