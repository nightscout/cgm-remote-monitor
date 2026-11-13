'use strict';

// The JSON Schema keywords the deployment plan contract uses, and nothing else.
// The published schemas (./schema/*.schema.json) are JSON Schema draft 2020-12
// documents, so a plan author can check them with any validator in any
// language; this evaluator is what `nightscout plan check` runs, with no added
// dependency. A schema that uses a keyword outside this list is refused when it
// is compiled, so a published constraint is never silently unchecked.
//
//   annotations (ignored)  $schema $id $comment title description
//   any instance           type enum const
//   object                 properties required additionalProperties dependentRequired
//                          minProperties maxProperties
//   array                  items minItems maxItems uniqueItems
//   string                 pattern minLength maxLength
//   number                 minimum maximum
const ANNOTATIONS = ['$schema', '$id', '$comment', 'title', 'description'];
const KEYWORDS = ['type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'dependentRequired', 'minProperties', 'maxProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum'];
const TYPES = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];

class SchemaError extends Error {
  constructor (message) { super(message); this.code = 'PLAN_CONTRACT_SCHEMA_INVALID'; }
}
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function typeOf (value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}
function same (a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// Refuses a schema this evaluator cannot check in full.
function compile (schema, at = '#') {
  if (!isObject(schema)) throw new SchemaError(at + ': a schema is an object');
  for (const key of Object.keys(schema)) {
    if (!ANNOTATIONS.includes(key) && !KEYWORDS.includes(key)) throw new SchemaError(at + ': unsupported keyword ' + key);
  }
  if (schema.type !== undefined && !TYPES.includes(schema.type)) throw new SchemaError(at + ': unsupported type');
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) throw new SchemaError(at + ': properties is an object');
    for (const [key, child] of Object.entries(schema.properties)) compile(child, at + '/properties/' + key);
  }
  for (const key of ['required']) {
    if (schema[key] !== undefined && (!Array.isArray(schema[key]) || schema[key].some(name => typeof name !== 'string'))) throw new SchemaError(at + ': ' + key + ' is a list of names');
  }
  if (schema.dependentRequired !== undefined && (!isObject(schema.dependentRequired) ||
      Object.values(schema.dependentRequired).some(list => !Array.isArray(list) || list.some(name => typeof name !== 'string')))) throw new SchemaError(at + ': dependentRequired maps a name to a list of names');
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) compile(schema.additionalProperties, at + '/additionalProperties');
  if (schema.items !== undefined) compile(schema.items, at + '/items');
  // Patterns come from the schemas shipped beside this file, never from a plan.
  // eslint-disable-next-line security/detect-non-literal-regexp
  if (schema.pattern !== undefined) { try { new RegExp(schema.pattern, 'u'); } catch { throw new SchemaError(at + ': pattern is not a regular expression'); } }
  return schema;
}

// Findings as [{ path, message }]; path is a JSON Pointer into the instance.
function validate (schema, value, path = '', findings = []) {
  if (findings.length >= 64) return findings;
  const fail = message => { if (findings.length < 64) findings.push({ path: path || '/', message }); };
  const actual = typeOf(value);
  if (schema.type !== undefined && actual !== schema.type && !(schema.type === 'number' && actual === 'integer')) {
    fail('expected ' + schema.type + ', found ' + actual);
    return findings;
  }
  if (schema.const !== undefined && !same(schema.const, value)) fail('expected the constant ' + JSON.stringify(schema.const));
  if (schema.enum !== undefined && !schema.enum.some(option => same(option, value))) fail('expected one of ' + JSON.stringify(schema.enum));
  if (actual === 'object') {
    const properties = schema.properties || {};
    for (const name of schema.required || []) if (!Object.hasOwn(value, name)) fail('missing required field ' + name);
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) fail('fewer than ' + schema.minProperties + ' fields');
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) fail('more than ' + schema.maxProperties + ' fields');
    for (const [name, needs] of Object.entries(schema.dependentRequired || {})) {
      if (Object.hasOwn(value, name)) for (const other of needs) if (!Object.hasOwn(value, other)) fail('field ' + name + ' requires field ' + other);
    }
    for (const [name, child] of Object.entries(value)) {
      const pointer = path + '/' + name.replace(/~/g, '~0').replace(/\//g, '~1');
      if (Object.hasOwn(properties, name)) validate(properties[name], child, pointer, findings);
      else if (schema.additionalProperties === false && findings.length < 64) findings.push({ path: pointer, message: 'field is not part of the contract' });
      else if (schema.additionalProperties !== undefined) validate(schema.additionalProperties, child, pointer, findings);
    }
  }
  if (actual === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('fewer than ' + schema.minItems + ' items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('more than ' + schema.maxItems + ' items');
    if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail('items repeat');
    if (schema.items !== undefined) value.forEach((item, index) => validate(schema.items, item, path + '/' + index, findings));
  }
  if (actual === 'string') {
    // eslint-disable-next-line security/detect-non-literal-regexp
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) fail('does not match ' + schema.pattern);
    if (schema.minLength !== undefined && value.length < schema.minLength) fail('shorter than ' + schema.minLength);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail('longer than ' + schema.maxLength);
  }
  if (actual === 'integer' || actual === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('below ' + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) fail('above ' + schema.maximum);
  }
  return findings;
}

module.exports = { compile, validate, SchemaError, KEYWORDS, ANNOTATIONS };
