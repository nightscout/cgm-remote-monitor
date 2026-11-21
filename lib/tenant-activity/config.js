'use strict';

// Operator selection of the activity reader: `{ connectionEnv, namespace }`.
// The connection string is read from the named environment variable; it is
// never carried in the configuration document.
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,127}$/;

function parse (value, source, { invalid, reserved = [] } = {}) {
  if (typeof invalid !== 'function') throw new TypeError('Activity configuration refusal required');
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'connectionEnv,namespace' ||
      typeof value.connectionEnv !== 'string' || !ENV.test(value.connectionEnv) ||
      typeof value.namespace !== 'string' || !NAME.test(value.namespace) || value.namespace.startsWith('pg_') ||
      ['public', 'information_schema'].includes(value.namespace) || reserved.includes(value.namespace)) invalid();
  if (source === undefined) return Object.freeze({ namespace: value.namespace, connectionEnv: value.connectionEnv });
  if (typeof source[value.connectionEnv] !== 'string' || !source[value.connectionEnv]) invalid();
  return Object.freeze({ namespace: value.namespace, connectionEnv: value.connectionEnv, connectionString: source[value.connectionEnv] });
}

module.exports = { parse };
