'use strict';
// A typed index for the identifier lookup bound (postgres-filter.js). The
// generated identifier column is NULL for an array value, so the MongoDB
// element match (identifier: [..., p]) has no index of its own; this partial
// index holds only those rows (none in ordinary use) and lets an identifier
// equality read an index range instead of every row the tenant holds.
// Like the storage-size operation, it is independent of the optional ordering
// conversion (postgres-check.js), so a v1 ledger can still adopt socket order.
const DOMAINS = Object.freeze(require('../tenant-lifecycle/clinical-catalogue').CLINICAL.filter(domain => domain !== 'settings'));
const NAME = domain => '0098_' + domain + '_identifier_arrays';
const INDEX = domain => domain + '_tenant_identifier_array';
// The bound's array arm; it must stay textually identical to the index
// predicate so the planner can prove the partial index applies.
const PREDICATE = "jsonb_typeof(doc -> 'identifier') = 'array'";

function build ({ namespace, domain }) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || namespace.startsWith('pg_') ||
      ['public', 'information_schema'].includes(namespace) || !DOMAINS.includes(domain)) {
    throw new TypeError('IDENTIFIER_ARRAY_INDEX_BINDING');
  }
  return ['CREATE INDEX "' + INDEX(domain) + '" ON "' + namespace + '"."' + domain + '" (tenant_id) WHERE ' + PREDICATE];
}

module.exports = { build, DOMAINS, NAME, INDEX, PREDICATE };
