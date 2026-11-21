'use strict';

// Deliberately bounded JSON Schema 2020-12 vocabulary for the checked-in service
// contracts. Unsupported keywords fail during compilation instead of silently
// weakening a contract. Values at this boundary are serialized JSON wire values.
const { isDeepStrictEqual } = require('node:util');
const compiled = new WeakMap();
const keywords = new Set(['$schema', '$id', 'title', 'description', 'type', 'const', 'enum', 'oneOf', 'anyOf',
  'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum']);
const types = new Set(['null', 'boolean', 'string', 'number', 'integer', 'object', 'array']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function refuse () { throw Object.assign(new Error('INTERNAL_API_SCHEMA_REFUSED'), { code: 'INTERNAL_API_SCHEMA_REFUSED' }); }
function schemaError () { throw new TypeError('Unsupported internal API schema'); }
function compile (schema) {
  if (schema === true) return () => true;
  if (schema === false) return () => false;
  if (!record(schema)) schemaError();
  if (compiled.has(schema)) return compiled.get(schema);
  if (Object.keys(schema).some(key => !keywords.has(key)) ||
      schema.type !== undefined && !types.has(schema.type)) schemaError();
  for (const key of ['minProperties', 'maxProperties', 'minItems', 'maxItems', 'minLength', 'maxLength']) {
    if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) schemaError();
  }
  for (const key of ['minimum', 'maximum']) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) schemaError();
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string') || new Set(schema.required).size !== schema.required.length)) schemaError();
  if (schema.properties !== undefined && !record(schema.properties) || schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length) ||
      schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') schemaError();
  const properties = new Map(Object.entries(schema.properties || {}).map(([key, child]) => [key, compile(child)]));
  const additional = schema.additionalProperties === undefined ? () => true : compile(schema.additionalProperties);
  const items = schema.items === undefined ? () => true : compile(schema.items);
  const branches = {};
  for (const key of ['oneOf', 'anyOf']) {
    if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key]) || !schema[key].length) schemaError();
      branches[key] = schema[key].map(compile);
    }
  }
  if (schema.pattern !== undefined && typeof schema.pattern !== 'string') schemaError();
  // Patterns are trusted checked-in contract definitions, never request values.
  // eslint-disable-next-line security/detect-non-literal-regexp
  const pattern = schema.pattern === undefined ? null : new RegExp(schema.pattern, 'u');
  const matches = value => {
    if (Object.hasOwn(schema, 'const') && !isDeepStrictEqual(value, schema.const)) return false;
    if (schema.enum && !schema.enum.some(item => isDeepStrictEqual(value, item))) return false;
    if (branches.oneOf && branches.oneOf.filter(check => check(value)).length !== 1) return false;
    if (branches.anyOf && !branches.anyOf.some(check => check(value))) return false;
    if (schema.type) {
      const type = schema.type;
      if (type === 'null' ? value !== null : type === 'array' ? !Array.isArray(value) : type === 'object' ? !record(value)
        : type === 'integer' ? !Number.isSafeInteger(value) : type === 'number' ? typeof value !== 'number' || !Number.isFinite(value)
          : typeof value !== type) return false;
    }
    if (typeof value === 'string') {
      const length = Array.from(value).length;
      if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength || pattern && !pattern.test(value)) return false;
    }
    if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) return false;
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems || !value.every(items)) return false;
      if (schema.uniqueItems && value.some((item, index) => value.slice(0, index).some(prior => isDeepStrictEqual(prior, item)))) return false;
    }
    if (record(value)) {
      const keys = Object.keys(value);
      if (schema.minProperties !== undefined && keys.length < schema.minProperties || schema.maxProperties !== undefined && keys.length > schema.maxProperties ||
          schema.required && schema.required.some(key => !Object.hasOwn(value, key))) return false;
      if (!keys.every(key => (properties.get(key) || additional)(value[key]))) return false;
    }
    return true;
  };
  compiled.set(schema, matches);
  return matches;
}
function validate (schema, value) {
  if (!compile(schema)(value)) refuse();
  return value;
}
module.exports = { validate, compile };
