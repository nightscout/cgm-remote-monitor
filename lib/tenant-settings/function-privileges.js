'use strict';
// The CHECK validator executes as the settings writer, never the lifetime reader.
function quote (value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value) ||
      value.startsWith('pg_') || ['public', 'information_schema'].includes(value)) {
    throw new TypeError('Explicit settings validator namespace and writer role required');
  }
  return '"' + value + '"';
}
function writerGrants ({ namespace, role }) {
  return Object.freeze(['GRANT EXECUTE ON FUNCTION ' + quote(namespace) +
    '.tenant_settings_values_valid(jsonb) TO ' + quote(role)]);
}
module.exports = { writerGrants };
