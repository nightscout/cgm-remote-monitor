'use strict';
// Both server and CLI use the CLOSED published shape, never a second schema.
const schema = require('./openapi.json').components.schemas;
const json = require('../server/serve/plan-contract/json-schema');
const request = json.compile(schema.TenantEnsureRequest), result = json.compile(schema.TenantEnsureResult);
module.exports = {
  request: value => json.validate(request, value).length === 0,
  result: value => json.validate(result, value).length === 0
};
