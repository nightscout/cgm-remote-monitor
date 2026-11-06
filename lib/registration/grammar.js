'use strict';

const Ajv2020 = require('ajv/dist/2020');

// The registration grammar (nightscout.dev/sync/v1) as vendored under
// ./schemas. Formats are not asserted: the grammar uses `format` as an
// annotation, as JSON Schema 2020-12 does by default.

const GRAMMAR = require('./schemas/controller-state-model.schema.json');
const STRICT = require('./schemas/controller-state-model-strict.schema.json');
const SETTINGS = require('./schemas/controller-settings.schema.json');
const INSTANCE = require('./schemas/controller-instance.schema.json');

const TYPE_REF_TARGETS = {};
TYPE_REF_TARGETS[SETTINGS.$id] = SETTINGS;

function compiler () {
  return new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
}

const ajv = compiler();
ajv.addSchema(GRAMMAR);
const validateGrammar = ajv.getSchema(GRAMMAR.$id);
const validateExtension = ajv.compile({ $ref: GRAMMAR.$id + '#/$defs/extension' });
const validateNamespace = ajv.compile({ $ref: GRAMMAR.$id + '#/$defs/namespace' });
const validateStrict = compiler().compile(STRICT);
const validateInstance = compiler().compile(INSTANCE);

function pathOf (instancePath) {
  return instancePath.split('/').slice(1).map(function (part) {
    return part.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}

function comparePaths (a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) { return a[i] < b[i] ? -1 : 1; }
  }
  return a.length - b.length;
}

// The first grammar error, by instance path, or null when valid.
function firstError (validate, value) {
  if (validate(value)) { return null; }
  const errors = validate.errors.map(function (error) {
    return { path: pathOf(error.instancePath), message: error.message };
  }).sort(function (a, b) { return comparePaths(a.path, b.path); });
  return { path: errors[0].path.join('.'), message: errors[0].message };
}

// Rule G1: the members a v1 reader does not know, as dotted paths.
function unknownMembers (registration) {
  const found = new Set();
  if (!validateStrict(registration)) {
    validateStrict.errors.forEach(function (error) {
      if (error.keyword === 'unevaluatedProperties') {
        const where = pathOf(error.instancePath).join('.');
        const name = error.params.unevaluatedProperty;
        found.add(where ? where + '.' + name : name);
      }
    });
  }
  return Array.from(found).sort();
}

// A typeRef's target with its `x-` members removed, or undefined.
function resolveTypeRef (ref) {
  if (typeof ref !== 'string' || ref.indexOf('#') < 0) { return undefined; }
  const base = ref.slice(0, ref.indexOf('#'));
  let node = TYPE_REF_TARGETS[base];
  if (!node) { return undefined; }
  const parts = ref.slice(ref.indexOf('#') + 1).replace(/^\/+|\/+$/g, '').split('/');
  for (const part of parts) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key)) {
      return undefined;
    }
    node = node[key];
  }
  if (!node || typeof node !== 'object') { return undefined; }
  const out = {};
  Object.keys(node).forEach(function (key) {
    if (key.indexOf('x-') !== 0) { out[key] = node[key]; }
  });
  return out;
}

module.exports = {
  apiVersion: 'nightscout.dev/sync/v1',
  grammarError: function (value) { return firstError(validateGrammar, value); },
  extensionError: function (value) { return firstError(validateExtension, value); },
  namespaceError: function (value) { return firstError(validateNamespace, value); },
  instanceError: function (value) { return firstError(validateInstance, value); },
  unknownMembers,
  resolveTypeRef
};
