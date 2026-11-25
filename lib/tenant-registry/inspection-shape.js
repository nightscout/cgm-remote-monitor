'use strict';

// Validate the operator response against its published OpenAPI description.
// References come only from this trusted local document. Unsupported schema
// keywords or reference shapes refuse instead of silently widening CLI output.
const schemas = require('./openapi.json').components.schemas;
const jsonSchema = require('../util/json-schema');

function expand (value, ancestors = new Set()) {
  if (Array.isArray(value)) return value.map(item => expand(item, ancestors));
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, '$ref')) {
    const name = /^#\/components\/schemas\/([A-Za-z][A-Za-z0-9]*)$/.exec(value.$ref)?.[1];
    if (Object.keys(value).length !== 1 || !name || !Object.hasOwn(schemas, name) || ancestors.has(name)) {
      throw new TypeError('unsupported inspection response schema reference');
    }
    return expand(schemas[name], new Set([...ancestors, name]));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, ancestors)]));
}

const description = jsonSchema.compile(expand(schemas.ProvisioningInspection));
module.exports = value => jsonSchema.validate(description, value).length === 0;
